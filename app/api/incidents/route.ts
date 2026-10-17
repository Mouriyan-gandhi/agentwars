import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { runWorkflow } from "@/lib/workflow";
import { getSession } from "@/lib/session";
import { sendEmail } from "@/lib/resend";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  input_type: z.enum(["text", "voice_transcript", "audio", "image"]),
  source: z.enum(["rider_report", "customer_complaint"]).default("rider_report"),
  raw_input: z.string().optional().nullable(),
  image_url: z.string().url().optional().nullable(),
  audio_url: z.string().url().optional().nullable(),
  order_code: z.string().optional().nullable(),
  issue_category: z.string().optional().nullable(),
  // For customer complaints without a session: proves the submitter owns the order.
  customer_email: z.string().email().optional().nullable(),
  // "Other" category: user-provided title for an issue that doesn't fit a chip.
  custom_issue_title: z.string().max(200).optional().nullable(),
  // Optional additional recipient the reporter wants a copy of this issue sent to.
  notify_email: z.string().email().optional().nullable(),
});

export async function POST(req: NextRequest) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const {
    input_type,
    source,
    raw_input,
    image_url,
    audio_url,
    order_code,
    issue_category,
    customer_email,
    custom_issue_title,
    notify_email,
  } = parsed.data;

  // If "other" is picked, prepend the user's own title to the raw_input so Gemini
  // and the admin view both see the user's framing. Keeps raw_input the single
  // source of truth for the text payload.
  const effectiveRawInput =
    issue_category === "other" && custom_issue_title
      ? `[${custom_issue_title.trim()}] ${raw_input?.trim() ?? ""}`.trim()
      : raw_input ?? null;

  const session = await getSession();

  // Customer-complaint path: no session, but we require order_code + email match.
  // Rider/admin path: must be authenticated.
  if (source === "customer_complaint") {
    if (!order_code || !customer_email) {
      return NextResponse.json(
        { error: "Customer complaints require order_code + customer_email" },
        { status: 400 },
      );
    }
  } else {
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Must have at least one modality of actual content.
  const hasText = typeof raw_input === "string" && raw_input.trim().length > 0;
  const hasImage = !!image_url;
  const hasAudio = !!audio_url;
  if (!hasText && !hasImage && !hasAudio) {
    return NextResponse.json(
      { error: "Provide text, an image, or an audio recording." },
      { status: 400 },
    );
  }

  // Order lookup + authorization.
  let orderId: string | null = null;
  let riderIdForIncident: string | null = session?.rider_id ?? null;
  let reportedByUserId: string | null = session?.user_id ?? null;

  if (order_code) {
    const { data: order } = await supabaseAdmin()
      .from("orders")
      .select("id, rider_id, customer_email")
      .eq("order_code", order_code)
      .maybeSingle();

    if (!order) {
      return NextResponse.json({ error: `Order ${order_code} not found` }, { status: 404 });
    }

    if (source === "customer_complaint") {
      // Email must match the order's customer_email (case-insensitive).
      if (
        !customer_email ||
        order.customer_email.toLowerCase().trim() !== customer_email.toLowerCase().trim()
      ) {
        return NextResponse.json(
          { error: "That email does not match the order on file." },
          { status: 403 },
        );
      }
      // The incident's rider_id becomes the order's current rider (so they see the complaint).
      riderIdForIncident = order.rider_id ?? null;
    } else if (session?.role === "rider") {
      // Rider can only report on their own assigned orders.
      if (order.rider_id !== session.rider_id) {
        return NextResponse.json(
          { error: "This order is not assigned to you" },
          { status: 403 },
        );
      }
      riderIdForIncident = order.rider_id;
    } else if (order.rider_id) {
      riderIdForIncident = order.rider_id;
    }

    orderId = order.id;
  }

  const { data, error } = await supabaseAdmin()
    .from("incidents")
    .insert({
      input_type,
      source,
      issue_category: issue_category ?? null,
      raw_input: effectiveRawInput,
      image_url: image_url ?? null,
      audio_url: audio_url ?? null,
      order_id: orderId,
      rider_id: riderIdForIncident,
      reported_by_user_id: reportedByUserId,
      notify_email: notify_email ?? null,
      status: "received",
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (notify_email) {
    await notifyExtraRecipient({
      incidentId: data.id,
      recipient: notify_email,
      source,
      orderCode: order_code ?? null,
      issueTitle:
        custom_issue_title?.trim() ||
        issue_category ||
        "Delivery issue reported",
      rawInput: effectiveRawInput,
    });
  }

  const result = await runWorkflow(data.id);
  return NextResponse.json({ incident: result.incident, decision: result.decision ?? null });
}

async function notifyExtraRecipient(opts: {
  incidentId: string;
  recipient: string;
  source: "rider_report" | "customer_complaint";
  orderCode: string | null;
  issueTitle: string;
  rawInput: string | null;
}) {
  const subject = opts.orderCode
    ? `New issue on ${opts.orderCode}: ${opts.issueTitle}`
    : `New delivery issue: ${opts.issueTitle}`;
  const sourceLabel =
    opts.source === "customer_complaint" ? "Customer complaint" : "Rider report";
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
      <h2 style="margin:0 0 12px 0">ParcelPilot · ${sourceLabel}</h2>
      ${opts.orderCode ? `<p><b>Order:</b> ${escapeHtml(opts.orderCode)}</p>` : ""}
      <p><b>Issue:</b> ${escapeHtml(opts.issueTitle)}</p>
      ${
        opts.rawInput
          ? `<p><b>Details:</b></p><p style="white-space:pre-wrap">${escapeHtml(opts.rawInput)}</p>`
          : ""
      }
      <p style="font-size:12px;color:#666">
        Our AI operations agent is already investigating. Reference ${opts.incidentId.slice(0, 8)}.
      </p>
    </div>`;

  const send = await sendEmail({
    to: opts.recipient,
    subject,
    html,
    idempotencyKey: `incident-${opts.incidentId}-notify-extra`,
  });

  await supabaseAdmin()
    .from("notifications")
    .insert({
      incident_id: opts.incidentId,
      recipient: opts.recipient,
      subject,
      body: html,
      status: send.ok ? "sent" : "failed",
      email_id: send.ok ? send.id : null,
      error: send.ok ? null : send.error,
      sent_at: send.ok ? new Date().toISOString() : null,
    });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
