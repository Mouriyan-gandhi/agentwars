import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { runWorkflow } from "@/lib/workflow";
import { getSession } from "@/lib/session";

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
  } = parsed.data;

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
      raw_input: raw_input ?? null,
      image_url: image_url ?? null,
      audio_url: audio_url ?? null,
      order_id: orderId,
      rider_id: riderIdForIncident,
      reported_by_user_id: reportedByUserId,
      status: "received",
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const result = await runWorkflow(data.id);
  return NextResponse.json({ incident: result.incident, decision: result.decision ?? null });
}
