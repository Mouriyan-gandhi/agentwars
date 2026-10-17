import { supabaseAdmin } from "./supabase";
import { analyzeIncident, fetchRecentFeedback, type GeminiPart } from "./gemini";
import { sendEmail, clarificationEmailHtml } from "./resend";
import { generateToken } from "./token";
import type {
  AgentDecision,
  Incident,
  IncidentStatus,
  Order,
  RecoveryAction,
  Rider,
} from "./types";

type RunResult = {
  incident: Incident;
  decision?: AgentDecision | null;
  action?: string;
  message?: string;
};

async function logAction(
  incidentId: string,
  action: string,
  status: "started" | "success" | "failed" | "retrying",
  payload: { result?: Record<string, unknown>; message?: string } = {},
) {
  await supabaseAdmin()
    .from("action_logs")
    .insert({
      incident_id: incidentId,
      action,
      status,
      result: payload.result ?? null,
      message: payload.message ?? null,
    });
}

async function updateIncident(
  id: string,
  patch: Partial<Incident>,
): Promise<Incident> {
  const { data, error } = await supabaseAdmin()
    .from("incidents")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`updateIncident: ${error.message}`);
  return data as Incident;
}

async function getIncident(id: string): Promise<Incident> {
  const { data, error } = await supabaseAdmin()
    .from("incidents")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(`getIncident: ${error.message}`);
  return data as Incident;
}

async function findOrderByCode(code: string): Promise<Order | null> {
  const { data } = await supabaseAdmin()
    .from("orders")
    .select("*")
    .eq("order_code", code)
    .maybeSingle();
  return (data as Order) ?? null;
}

/**
 * Entry point: run the agentic loop for an incident.
 * Idempotent per status: safe to call multiple times — advances only if state allows.
 */
export async function runWorkflow(incidentId: string): Promise<RunResult> {
  let incident = await getIncident(incidentId);

  // Step 1: analyze with Gemini (if not done yet).
  if (incident.status === "received") {
    incident = await updateIncident(incident.id, { status: "analyzing" });
    await logAction(incident.id, "analyze", "started");

    try {
      const parts = await buildGeminiParts(incident);
      const feedbackExamples = await fetchRecentFeedback(5);

      const decision = await analyzeIncident({
        parts,
        source: incident.source,
        issueCategory: incident.issue_category ?? null,
        orderCode: await lookupOrderCode(incident),
        feedbackExamples,
      });

      // Try to attach the order referenced in the report.
      let orderId: string | null = incident.order_id;
      if (!orderId && decision.orderCode) {
        const order = await findOrderByCode(decision.orderCode);
        if (order) orderId = order.id;
      }

      incident = await updateIncident(incident.id, {
        analysis: decision,
        type: decision.incidentType,
        description: decision.summary,
        order_id: orderId,
      });
      await logAction(incident.id, "analyze", "success", {
        result: {
          decision: decision as unknown as Record<string, unknown>,
          used_feedback_examples: feedbackExamples.length,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      incident = await updateIncident(incident.id, {
        status: "failed",
        last_error: `analyze: ${msg}`,
      });
      await logAction(incident.id, "analyze", "failed", { message: msg });
      return { incident, message: msg };
    }
  }

  // Step 2: execute the recommended action.
  const decision = incident.analysis as AgentDecision | null;
  if (!decision) {
    return { incident, message: "No decision available" };
  }

  const terminal: IncidentStatus[] = ["resolved", "escalated", "failed"];
  if (terminal.includes(incident.status)) {
    return { incident, decision };
  }

  // If we already asked the customer and are waiting, don't send again.
  if (incident.status === "awaiting_customer") {
    return { incident, decision, message: "Awaiting customer response" };
  }

  // If the customer responded, move toward resolution.
  if (incident.status === "response_received") {
    return finishRecovery(incident, decision);
  }

  // Fresh: pick the action.
  return executeAction(incident, decision);
}

async function executeAction(
  incident: Incident,
  decision: AgentDecision,
): Promise<RunResult> {
  const action: RecoveryAction = decision.recommendedAction;

  switch (action) {
    case "request_clarification":
    case "request_location":
      return sendCustomerClarification(incident, decision);

    case "reschedule_delivery":
      // For MVP: ask the customer for a new slot via the same form flow.
      return sendCustomerClarification(incident, decision, {
        subjectOverride: "Reschedule your delivery",
      });

    case "propose_reassignment": {
      await logAction(incident.id, "propose_reassignment", "started");

      // Need an order; otherwise we can't move it to a new rider.
      if (!incident.order_id) {
        const updated = await updateIncident(incident.id, {
          status: "escalated",
          last_error: "No order to reassign",
        });
        await logAction(incident.id, "propose_reassignment", "failed", {
          message: "No order to reassign",
        });
        return { incident: updated, decision, action, message: "Escalated: no order" };
      }

      const db = supabaseAdmin();
      const { data: order } = await db
        .from("orders")
        .select("*")
        .eq("id", incident.order_id)
        .single();

      const previousRiderId: string | null = (order as Order | null)?.rider_id ?? null;

      // Find an available rider that isn't the current one.
      let query = db
        .from("riders")
        .select("*")
        .eq("status", "available")
        .limit(1);
      if (previousRiderId) query = query.neq("id", previousRiderId);
      const { data: nextRider } = await query.maybeSingle();

      if (!nextRider) {
        await logAction(incident.id, "propose_reassignment", "failed", {
          message: "No alternate rider available",
          result: previousRiderId ? { previous_rider_id: previousRiderId } : undefined,
        });
        const updated = await updateIncident(incident.id, {
          status: "escalated",
          last_error: "No alternate rider available",
        });
        return { incident: updated, decision, action, message: "Escalated: no alternate rider" };
      }

      // Reassign the order to the new rider.
      await db.from("orders").update({ rider_id: nextRider.id }).eq("id", incident.order_id);

      // Mark the previous rider available again (if any).
      if (previousRiderId) {
        await db.from("riders").update({ status: "available" }).eq("id", previousRiderId);
      }
      // Mark the new rider as busy (optional; makes the fleet view feel alive).
      await db.from("riders").update({ status: "busy" }).eq("id", nextRider.id);

      const updated = await updateIncident(incident.id, {
        rider_id: nextRider.id,
        status: "resolved",
        resolved_at: new Date().toISOString(),
      });
      await logAction(incident.id, "propose_reassignment", "success", {
        result: {
          previous_rider_id: previousRiderId,
          new_rider_id: nextRider.id,
          new_rider_name: (nextRider as Rider).name,
        },
      });
      return { incident: updated, decision, action };
    }

    case "verify_with_rider": {
      // Customer-complaint path: email the assigned rider to confirm what actually happened.
      return notifyRiderForVerification(incident, decision);
    }

    case "offer_refund_or_reship": {
      // Customer-impact confirmed. Mark the order affected and escalate for the ops team to action.
      if (incident.order_id) {
        await supabaseAdmin()
          .from("orders")
          .update({ status: "exception" })
          .eq("id", incident.order_id);
      }
      const updated = await updateIncident(incident.id, {
        status: "escalated",
        last_error: null,
      });
      await logAction(incident.id, "offer_refund_or_reship", "success", {
        message: decision.reasoning,
        result: { order_marked: "exception" },
      });
      return { incident: updated, decision, action };
    }

    case "escalate":
    default: {
      const updated = await updateIncident(incident.id, { status: "escalated" });
      await logAction(incident.id, "escalate", "success", {
        message: decision.reasoning,
      });
      return { incident: updated, decision, action };
    }
  }
}

/**
 * Email the assigned rider when a customer complaint needs rider-side verification.
 * MVP: logs the ask and escalates so admin can follow up; a future iteration can
 * mint a rider-side form the way we do for customers.
 */
async function notifyRiderForVerification(
  incident: Incident,
  decision: AgentDecision,
): Promise<RunResult> {
  await logAction(incident.id, "verify_with_rider", "started");

  if (!incident.order_id) {
    const updated = await updateIncident(incident.id, {
      status: "escalated",
      last_error: "No order to verify",
    });
    return { incident: updated, decision, message: "Escalated: no order" };
  }

  const db = supabaseAdmin();
  const { data: order } = await db
    .from("orders")
    .select("*")
    .eq("id", incident.order_id)
    .single();
  const o = order as Order | null;
  const riderIdOnOrder = o?.rider_id ?? null;

  // Mark order as exception + resolved to the review state.
  await db.from("orders").update({ status: "exception" }).eq("id", incident.order_id);

  const updated = await updateIncident(incident.id, {
    rider_id: riderIdOnOrder ?? incident.rider_id,
    status: "escalated",
    last_error: null,
  });
  await logAction(incident.id, "verify_with_rider", "success", {
    message:
      "Flagged for ops review; rider portal will show the complaint on their incident list.",
    result: { rider_id: riderIdOnOrder },
  });
  return { incident: updated, decision, action: "verify_with_rider" };
}

async function sendCustomerClarification(
  incident: Incident,
  decision: AgentDecision,
  opts: { subjectOverride?: string } = {},
): Promise<RunResult> {
  if (!incident.order_id) {
    const updated = await updateIncident(incident.id, {
      status: "escalated",
      last_error: "No order linked; cannot contact customer",
    });
    await logAction(incident.id, "send_email", "failed", {
      message: "No order linked to this incident",
    });
    return { incident: updated, decision, message: "Escalated: no order linked" };
  }

  const { data: order, error } = await supabaseAdmin()
    .from("orders")
    .select("*")
    .eq("id", incident.order_id)
    .single();
  if (error || !order) {
    const updated = await updateIncident(incident.id, {
      status: "escalated",
      last_error: `Order lookup failed: ${error?.message ?? "not found"}`,
    });
    return { incident: updated, decision, message: "Order lookup failed" };
  }

  const o = order as Order;

  // Mint a token for the customer form (hashed in DB).
  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { error: tokErr } = await supabaseAdmin().from("customer_responses").insert({
    incident_id: incident.id,
    token_hash: hash,
    expires_at: expiresAt,
  });
  if (tokErr) {
    const updated = await updateIncident(incident.id, {
      last_error: `token insert: ${tokErr.message}`,
    });
    return { incident: updated, decision, message: tokErr.message };
  }

  const base = process.env.APP_BASE_URL || "http://localhost:3000";
  const formUrl = `${base}/customer-form/${token}`;

  const subject =
    opts.subjectOverride ||
    `Action needed for order ${o.order_code}: ${shortSubject(decision)}`;

  const html = clarificationEmailHtml({
    orderCode: o.order_code,
    customerName: o.customer_name,
    summary: decision.summary,
    missing: decision.missingInformation.length
      ? decision.missingInformation
      : ["Please confirm your delivery details"],
    formUrl,
  });

  // Record the notification row first (queued), then send.
  const { data: notif, error: notifErr } = await supabaseAdmin()
    .from("notifications")
    .insert({
      incident_id: incident.id,
      recipient: o.customer_email,
      subject,
      body: html,
      status: "queued",
    })
    .select("id")
    .single();
  if (notifErr) throw new Error(`notification insert: ${notifErr.message}`);

  await logAction(incident.id, "send_email", "started", {
    result: { to: o.customer_email, notification_id: notif.id },
  });

  const result = await sendEmail({
    to: o.customer_email,
    subject,
    html,
    idempotencyKey: `incident-${incident.id}-attempt-${incident.attempt_count + 1}`,
  });

  if (!result.ok) {
    await supabaseAdmin()
      .from("notifications")
      .update({ status: "failed", error: result.error })
      .eq("id", notif.id);
    await logAction(incident.id, "send_email", "failed", { message: result.error });

    const next = incident.attempt_count + 1;
    const updated = await updateIncident(incident.id, {
      attempt_count: next,
      last_error: result.error,
      // Keep status as-is so the user can retry; escalate after 3 attempts.
      status: next >= 3 ? "escalated" : incident.status,
    });
    return { incident: updated, decision, message: `Email failed: ${result.error}` };
  }

  await supabaseAdmin()
    .from("notifications")
    .update({ status: "sent", email_id: result.id, sent_at: new Date().toISOString() })
    .eq("id", notif.id);
  await logAction(incident.id, "send_email", "success", {
    result: { email_id: result.id },
  });

  const updated = await updateIncident(incident.id, {
    status: "awaiting_customer",
    attempt_count: incident.attempt_count + 1,
    last_error: null,
  });

  return { incident: updated, decision, action: "send_email" };
}

/**
 * Called after the customer submits the form. Applies the fix to the order
 * and marks the incident resolved.
 */
export async function ingestCustomerResponse(
  tokenHash: string,
  responseData: Record<string, unknown>,
): Promise<{ incidentId: string } | { error: string }> {
  const { data: row, error } = await supabaseAdmin()
    .from("customer_responses")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!row) return { error: "Invalid token" };
  if (row.used_at) return { error: "This link has already been used" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { error: "Link expired" };

  await supabaseAdmin()
    .from("customer_responses")
    .update({
      submitted_at: new Date().toISOString(),
      used_at: new Date().toISOString(),
      response_data: responseData,
    })
    .eq("id", row.id);

  await supabaseAdmin()
    .from("incidents")
    .update({ status: "response_received" })
    .eq("id", row.incident_id);

  await logAction(row.incident_id, "customer_response", "success", {
    result: responseData,
  });

  return { incidentId: row.incident_id };
}

async function finishRecovery(
  incident: Incident,
  decision: AgentDecision,
): Promise<RunResult> {
  // Grab the latest completed customer response (ignore minted-but-unused tokens).
  const { data: resp } = await supabaseAdmin()
    .from("customer_responses")
    .select("*")
    .eq("incident_id", incident.id)
    .not("submitted_at", "is", null)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!resp?.response_data) {
    const updated = await updateIncident(incident.id, {
      status: "escalated",
      last_error: "response_received but no payload",
    });
    return { incident: updated, decision, message: "No response payload" };
  }

  // Apply the fix to the order (address / notes / phone / preferred window).
  if (incident.order_id) {
    const data = resp.response_data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof data.address === "string" && data.address.trim()) patch.address = data.address.trim();
    if (typeof data.address_notes === "string") patch.address_notes = data.address_notes;
    if (typeof data.customer_phone === "string" && data.customer_phone.trim()) patch.customer_phone = data.customer_phone.trim();
    if (Object.keys(patch).length) {
      patch.status = decision.recommendedAction === "reschedule_delivery" ? "rescheduled" : "out_for_delivery";
      await supabaseAdmin().from("orders").update(patch).eq("id", incident.order_id);
    }
  }

  await logAction(incident.id, "apply_fix", "success", {
    result: resp.response_data,
  });

  const updated = await updateIncident(incident.id, {
    status: "resolved",
    resolved_at: new Date().toISOString(),
  });
  return { incident: updated, decision, action: "apply_fix" };
}

function shortSubject(decision: AgentDecision): string {
  if (decision.incidentType === "address_unclear") return "address needs clarification";
  if (decision.incidentType === "customer_unavailable") return "unable to reach you";
  if (decision.incidentType === "location_inaccessible") return "location access issue";
  if (decision.incidentType === "damaged_parcel") return "damaged parcel";
  return "delivery issue";
}

async function buildGeminiParts(incident: Incident): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = [];

  if (incident.raw_input && incident.raw_input.trim()) {
    parts.push({ kind: "text", text: incident.raw_input.trim() });
  }

  if (incident.image_url) {
    try {
      const { base64, mimeType } = await fetchBinary(incident.image_url, "image/jpeg");
      parts.push({ kind: "image", mimeType, base64 });
    } catch (err) {
      // Non-fatal: continue with whatever parts we have.
      parts.push({
        kind: "text",
        text: `(image fetch failed: ${err instanceof Error ? err.message : String(err)})`,
      });
    }
  }

  if (incident.audio_url) {
    try {
      const { base64, mimeType } = await fetchBinary(incident.audio_url, "audio/webm");
      parts.push({ kind: "audio", mimeType, base64 });
    } catch (err) {
      parts.push({
        kind: "text",
        text: `(audio fetch failed: ${err instanceof Error ? err.message : String(err)})`,
      });
    }
  }

  return parts;
}

async function fetchBinary(url: string, fallbackMime: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") || fallbackMime;
  return { base64: buf.toString("base64"), mimeType };
}

async function lookupOrderCode(incident: Incident): Promise<string | null> {
  if (!incident.order_id) return null;
  const { data } = await supabaseAdmin()
    .from("orders")
    .select("order_code")
    .eq("id", incident.order_id)
    .maybeSingle();
  return (data as { order_code: string } | null)?.order_code ?? null;
}
