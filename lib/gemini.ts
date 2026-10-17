import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AgentDecision } from "./types";

const apiKey = process.env.GEMINI_API_KEY!;
if (!apiKey) {
  console.warn("GEMINI_API_KEY is not set");
}

const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.8-flash";

function client() {
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");
  return new GoogleGenerativeAI(apiKey);
}

const BASE_SYSTEM_PROMPT = `You are ParcelPilot, an operations agent that triages parcel delivery exceptions.

You will receive an incident report. It may be:
- a text or voice-transcript description from a rider or customer,
- an audio clip (voice note),
- an image (photo of location, parcel, or damage),
- any combination of the above.

The incident has a known SOURCE and may have a user-picked CATEGORY. Use them as strong hints
but override if the content clearly contradicts.

Produce STRICT JSON with:

{
  "incidentType": "address_unclear" | "customer_unavailable" | "location_inaccessible"
                 | "rider_issue" | "damaged_parcel" | "not_delivered" | "wrong_item" | "unknown",
  "orderCode": string | null,
  "summary": string,
  "missingInformation": string[],
  "recommendedAction": "request_location" | "request_clarification" | "reschedule_delivery"
                      | "propose_reassignment" | "verify_with_rider" | "offer_refund_or_reship"
                      | "escalate",
  "urgency": "low" | "medium" | "high",
  "reasoning": string
}

Guidance per action:
- request_clarification / request_location: the customer can resolve it (missing address, landmark, phone).
- reschedule_delivery: customer currently unavailable but reachable; needs a new slot.
- propose_reassignment: rider cannot physically complete; another rider must take over.
- verify_with_rider: a customer complaint (e.g. "not delivered") where we need the rider's version first.
- offer_refund_or_reship: a confirmed customer-impact issue (damaged / wrong item).
- escalate: anything requiring a human (safety, legal, repeated failures).

Output JSON only. No prose, no markdown fences.`;

type FeedbackExample = {
  incidentSummary: string;
  wrongAction: string;
  correctAction: string;
  comment: string | null;
};

export type GeminiPart =
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: string; base64: string }
  | { kind: "audio"; mimeType: string; base64: string };

export type AnalyzeInput = {
  parts: GeminiPart[];
  // extra structured context the UI already captured
  source?: "rider_report" | "customer_complaint";
  issueCategory?: string | null;
  orderCode?: string | null;
  feedbackExamples?: FeedbackExample[];
};

export async function analyzeIncident(input: AnalyzeInput): Promise<AgentDecision> {
  const systemInstruction = buildSystemPrompt(input.feedbackExamples ?? []);

  const model = client().getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
    systemInstruction,
  });

  const header: string[] = [];
  if (input.source) header.push(`SOURCE: ${input.source}`);
  if (input.issueCategory) header.push(`USER-PICKED CATEGORY: ${input.issueCategory}`);
  if (input.orderCode) header.push(`ORDER REFERENCE: ${input.orderCode}`);
  const headerText = header.length ? header.join("\n") + "\n\n" : "";

  const parts: Array<
    | { text: string }
    | { inlineData: { data: string; mimeType: string } }
  > = [];
  if (headerText) parts.push({ text: headerText });

  for (const p of input.parts) {
    if (p.kind === "text") parts.push({ text: p.text });
    else parts.push({ inlineData: { data: p.base64, mimeType: p.mimeType } });
  }

  if (parts.length === 0) {
    parts.push({ text: "No details were provided. Classify as unknown and escalate." });
  }

  const result = await model.generateContent({
    contents: [{ role: "user", parts }],
  });

  const text = result.response.text();
  return parseDecision(text);
}

function buildSystemPrompt(examples: FeedbackExample[]): string {
  if (examples.length === 0) return BASE_SYSTEM_PROMPT;

  const bullets = examples
    .map(
      (e, i) =>
        `  ${i + 1}. Incident: ${e.incidentSummary}\n` +
        `     You chose: ${e.wrongAction}\n` +
        `     Correct call: ${e.correctAction}` +
        (e.comment ? `\n     Reviewer note: ${e.comment}` : ""),
    )
    .join("\n");

  return (
    BASE_SYSTEM_PROMPT +
    "\n\nFEEDBACK FROM OPS REVIEWS (apply these corrections to new, similar incidents):\n" +
    bullets
  );
}

function parseDecision(raw: string): AgentDecision {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);

  const allowedActions = new Set([
    "request_location",
    "request_clarification",
    "reschedule_delivery",
    "propose_reassignment",
    "verify_with_rider",
    "offer_refund_or_reship",
    "escalate",
  ]);
  const allowedTypes = new Set([
    "address_unclear",
    "customer_unavailable",
    "location_inaccessible",
    "rider_issue",
    "damaged_parcel",
    "not_delivered",
    "wrong_item",
    "unknown",
  ]);

  return {
    incidentType: allowedTypes.has(parsed.incidentType) ? parsed.incidentType : "unknown",
    orderCode: parsed.orderCode ?? null,
    summary: String(parsed.summary ?? ""),
    missingInformation: Array.isArray(parsed.missingInformation)
      ? parsed.missingInformation.map(String)
      : [],
    recommendedAction: allowedActions.has(parsed.recommendedAction)
      ? parsed.recommendedAction
      : "escalate",
    urgency: ["low", "medium", "high"].includes(parsed.urgency) ? parsed.urgency : "medium",
    reasoning: String(parsed.reasoning ?? ""),
  };
}

export async function fetchRecentFeedback(limit = 5): Promise<FeedbackExample[]> {
  // Lazy import to avoid pulling supabase into cold-start if unused.
  const { supabaseAdmin } = await import("./supabase");
  const { data } = await supabaseAdmin()
    .from("decision_feedback")
    .select("verdict, suggested_action, comment, incidents(description, analysis, masked_input, issue_category)")
    .eq("verdict", "wrong_call")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!data) return [];

  type Row = {
    verdict: string;
    suggested_action: string | null;
    comment: string | null;
    incidents:
      | {
          description: string | null;
          analysis: AgentDecision | null;
          masked_input: string | null;
          issue_category: string | null;
        }
      | Array<{
          description: string | null;
          analysis: AgentDecision | null;
          masked_input: string | null;
          issue_category: string | null;
        }>
      | null;
  };

  return (data as unknown as Row[])
    .map((r) => {
      const inc = Array.isArray(r.incidents) ? r.incidents[0] ?? null : r.incidents;
      return { r, inc };
    })
    .filter(({ r, inc }) => r.suggested_action && inc?.analysis)
    .map(({ r, inc }) => ({
      incidentSummary: (inc?.masked_input ?? inc?.description ?? "").slice(0, 300),
      wrongAction: inc?.analysis?.recommendedAction ?? "unknown",
      correctAction: r.suggested_action!,
      comment: r.comment,
    }));
}

/** Convert feedback examples to the A2A sidecar's `FeedbackExample` shape. */
export function feedbackForA2A(items: FeedbackExample[]) {
  return items.map((e) => ({
    masked_input: e.incidentSummary,
    issue_category: null,
    wrong_action: e.wrongAction,
    correct_action: e.correctAction,
    comment: e.comment,
  }));
}
