import { supabaseAdmin } from "./supabase";
import { fetchRecentFeedback, feedbackForA2A } from "./gemini";
import { callA2AAnalyze, type A2AAnalyzeRequest } from "./agentA2A";
import { callTool } from "./mcp";
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
  // Routed through the MCP tool so every executor side-effect goes through
  // the same contract the brain would use if it were calling us remotely.
  await callTool("log_action", {
    incident_id: incidentId,
    action,
    status,
    message: payload.message,
    result: payload.result,
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

  // Step 1: multi-agent analysis via Google ADK sidecar (A2A).
  // The sidecar runs: PII Guardian → Classifier → Planner → Evaluator → Self-heal loop.
  // Next.js never passes raw PII to the brain — it goes in once (so Guardian
  // can learn the known values), and from the sidecar's response we persist
  // the masked_input + pii_map. Only Next.js (this process) can unmask.
  if (incident.status === "received") {
    incident = await updateIncident(incident.id, { status: "analyzing" });
    await logAction(incident.id, "analyze", "started");

    try {
      const orderContext = await loadOrderContext(incident);
      const feedbackExamples = await fetchRecentFeedback(5);

      const req: A2AAnalyzeRequest = {
        incident_id: incident.id,
        source: incident.source,
        raw_input: incident.raw_input,
        issue_category: incident.issue_category ?? null,
        notify_email: incident.notify_email ?? null,
        order_context: orderContext,
        feedback_examples: feedbackForA2A(feedbackExamples),
      };

      // Attach image / audio bytes if present (multimodal).
      if (incident.image_url) {
        try {
          const { base64, mimeType } = await fetchBinary(incident.image_url, "image/jpeg");
          req.image_b64 = base64;
          req.image_mime = mimeType;
        } catch { /* non-fatal */ }
      }
      if (incident.audio_url) {
        try {
          const { base64, mimeType } = await fetchBinary(incident.audio_url, "audio/webm");
          req.audio_b64 = base64;
          req.audio_mime = mimeType;
        } catch { /* non-fatal */ }
      }

      const a2aStart = Date.now();
      const res = await callA2AAnalyze(req);
      const a2aLatency = Date.now() - a2aStart;
      const decision = res.decision as unknown as AgentDecision;

      // Roll up token economics across every agent step. The sidecar embeds
      // {_usage: {tokens_in, tokens_out, cost_usd}} in each step's output.
      let totalTokensIn = 0;
      let totalTokensOut = 0;
      let totalCost = 0;
      let piiLeak = false;
      for (const s of res.trace) {
        const u = (s.output as { _usage?: { tokens_in?: number; tokens_out?: number; cost_usd?: number } } | null)?._usage;
        if (u) {
          totalTokensIn += u.tokens_in ?? 0;
          totalTokensOut += u.tokens_out ?? 0;
          totalCost += u.cost_usd ?? 0;
        }
        const leak = (s.output as { pii_leak?: { leaked?: boolean } } | null)?.pii_leak;
        if (leak?.leaked) piiLeak = true;
      }

      // Persist the trace + evaluation. Each row of agent_trace represents one
      // A2A hop between agents in the pipeline.
      await supabaseAdmin()
        .from("agent_trace")
        .insert(
          res.trace.map((s) => ({
            incident_id: incident.id,
            step_index: s.step_index,
            agent_name: s.agent_name,
            protocol: s.protocol,
            input: s.input ?? null,
            output: s.output ?? null,
            model: s.model,
            latency_ms: s.latency_ms,
            status: s.status,
            error: s.error,
          })),
        );
      await supabaseAdmin().from("agent_evaluations").insert({
        incident_id: incident.id,
        attempt: res.heal_attempts + 1,
        truthfulness: res.evaluation.truthfulness,
        hallucination: res.evaluation.hallucination,
        grounded: res.evaluation.grounded,
        overall: res.evaluation.overall,
        verdict: res.evaluation.verdict,
        reasoning: res.evaluation.reasoning,
        evaluator_model: "gemini-2.0-flash",
      });

      // The planner may still produce an orderCode token (e.g. <<ORDER_1>>);
      // unmask it before using it to look up the order.
      let orderCodeReal: string | null = null;
      if (decision.orderCode) {
        orderCodeReal = res.pii_map[decision.orderCode] ?? decision.orderCode;
      }

      let orderId: string | null = incident.order_id;
      if (!orderId && orderCodeReal) {
        const order = await findOrderByCode(orderCodeReal);
        if (order) orderId = order.id;
      }

      incident = await updateIncident(incident.id, {
        analysis: { ...decision, orderCode: orderCodeReal },
        type: decision.incidentType,
        description: decision.summary,
        masked_input: res.masked_input,
        pii_map: res.pii_map,
        eval_score: res.evaluation.overall,
        eval_hallucination: res.evaluation.hallucination,
        eval_truthfulness: res.evaluation.truthfulness,
        eval_grounded: res.evaluation.grounded,
        heal_attempts: res.heal_attempts,
        total_tokens_in: totalTokensIn,
        total_tokens_out: totalTokensOut,
        total_cost_usd: Number(totalCost.toFixed(6)),
        total_latency_ms: a2aLatency,
        pii_leak_detected: piiLeak,
        order_id: orderId,
      });
      await logAction(incident.id, "analyze", "success", {
        result: {
          decision: decision as unknown as Record<string, unknown>,
          used_feedback_examples: feedbackExamples.length,
          agents_run: res.trace.length,
          heal_attempts: res.heal_attempts,
          eval_overall: res.evaluation.overall,
          eval_verdict: res.evaluation.verdict,
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

      // All I/O goes through MCP tools now — same contract the brain would hit remotely.
      const order = (await callTool<Order | null>("get_order_by_code", {
        order_code: (incident.analysis?.orderCode ?? "") || "",
      })) ||
        // Fallback: direct id-based lookup is also wrapped in a tool call.
        (await (async () => {
          const { data } = await supabaseAdmin()
            .from("orders")
            .select("*")
            .eq("id", incident.order_id!)
            .single();
          return data as Order | null;
        })());

      const previousRiderId: string | null = order?.rider_id ?? null;

      const nextRider = await callTool<Rider | null>("find_available_rider", {
        exclude_rider_id: previousRiderId ?? undefined,
      });

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

      await callTool("reassign_order", {
        order_id: incident.order_id,
        new_rider_id: nextRider.id,
        previous_rider_id: previousRiderId ?? undefined,
      });

      const updated = await updateIncident(incident.id, {
        rider_id: nextRider.id,
        status: "resolved",
        resolved_at: new Date().toISOString(),
      });
      await logAction(incident.id, "propose_reassignment", "success", {
        result: {
          previous_rider_id: previousRiderId,
          new_rider_id: nextRider.id,
          new_rider_name: nextRider.name,
          via: "mcp:reassign_order",
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

  await logAction(incident.id, "send_email", "started", {
    result: { to: o.customer_email, via: "mcp:send_clarification_email" },
  });

  // Send + notification row persist via MCP tool.
  const result = await callTool<{ ok: true; email_id: string } | { ok: false; error: string }>(
    "send_clarification_email",
    {
      incident_id: incident.id,
      to: o.customer_email,
      order_code: o.order_code,
      customer_name: o.customer_name,
      summary: decision.summary,
      missing: decision.missingInformation.length
        ? decision.missingInformation
        : ["Please confirm your delivery details"],
      form_url: formUrl,
      subject,
      idempotency_key: `incident-${incident.id}-attempt-${incident.attempt_count + 1}`,
    },
  );

  if (!result.ok) {
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

  await logAction(incident.id, "send_email", "success", {
    result: { email_id: result.email_id, via: "mcp:send_clarification_email" },
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

async function fetchBinary(url: string, fallbackMime: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") || fallbackMime;
  return { base64: buf.toString("base64"), mimeType };
}

async function loadOrderContext(incident: Incident) {
  if (!incident.order_id) return null;
  const { data: order } = await supabaseAdmin()
    .from("orders")
    .select(
      "order_code, customer_name, customer_email, customer_phone, address, address_notes, rider_id",
    )
    .eq("id", incident.order_id)
    .maybeSingle();
  if (!order) return null;

  let rider: { name: string; phone: string | null } | null = null;
  if (order.rider_id) {
    const { data: r } = await supabaseAdmin()
      .from("riders")
      .select("name, phone")
      .eq("id", order.rider_id)
      .maybeSingle();
    rider = (r as { name: string; phone: string | null } | null) ?? null;
  }

  return {
    order_code: order.order_code,
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    customer_phone: order.customer_phone,
    address: order.address,
    address_notes: order.address_notes,
    rider_name: rider?.name ?? null,
    rider_phone: rider?.phone ?? null,
  };
}

