/**
 * A2A client for the Google ADK multi-agent sidecar.
 *
 * Next.js owns ingestion + execution (DB writes, email send via MCP). The
 * "brain" — PII masking, classification, planning, evaluation, self-healing —
 * runs in the Python ADK service and we call it over A2A.
 */

export type A2AAgentDecision = {
  incidentType: string;
  orderCode: string | null;
  summary: string;
  missingInformation: string[];
  recommendedAction: string;
  urgency: "low" | "medium" | "high";
  reasoning: string;
};

export type A2AEvaluation = {
  truthfulness: number;
  hallucination: number;
  grounded: number;
  overall: number;
  verdict: "pass" | "retry" | "escalate";
  reasoning: string;
};

export type A2ATraceStep = {
  step_index: number;
  agent_name: string;
  protocol: "a2a" | "mcp" | "direct";
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  model: string | null;
  latency_ms: number | null;
  status: "ok" | "error";
  error: string | null;
};

export type A2AAnalyzeRequest = {
  incident_id: string;
  source: "rider_report" | "customer_complaint";
  raw_input: string | null;
  image_b64?: string | null;
  image_mime?: string | null;
  audio_b64?: string | null;
  audio_mime?: string | null;
  issue_category: string | null;
  custom_issue_title?: string | null;
  notify_email?: string | null;
  order_context: {
    order_code?: string | null;
    customer_name?: string | null;
    customer_email?: string | null;
    customer_phone?: string | null;
    address?: string | null;
    address_notes?: string | null;
    rider_name?: string | null;
    rider_phone?: string | null;
  } | null;
  feedback_examples: Array<{
    masked_input: string;
    issue_category: string | null;
    wrong_action: string;
    correct_action: string;
    comment: string | null;
  }>;
};

export type A2AAnalyzeResponse = {
  incident_id: string;
  masked_input: string;
  pii_map: Record<string, string>;
  decision: A2AAgentDecision;
  evaluation: A2AEvaluation;
  trace: A2ATraceStep[];
  heal_attempts: number;
};

const BASE = process.env.AGENT_SERVICE_URL || "http://localhost:8787";
const TOKEN = process.env.AGENT_SERVICE_TOKEN || "";

export async function callA2AAnalyze(
  req: A2AAnalyzeRequest,
): Promise<A2AAnalyzeResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/analyze`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
    // Multi-agent chain can take ~15s on cold path. Allow room.
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`A2A analyze ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as A2AAnalyzeResponse;
}

export async function fetchA2ACard(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${BASE}/a2a/agents`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Unmask tokens in a string using the pii_map returned by Guardian. */
export function unmaskWithMap(
  text: string | null | undefined,
  piiMap: Record<string, string> | null | undefined,
): string {
  if (!text || !piiMap) return text ?? "";
  let out = text;
  for (const [tok, real] of Object.entries(piiMap)) {
    if (real) out = out.split(tok).join(real);
  }
  return out;
}
