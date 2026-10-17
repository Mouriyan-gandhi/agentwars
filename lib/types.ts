export type IncidentStatus =
  | "received"
  | "analyzing"
  | "awaiting_customer"
  | "response_received"
  | "ready_for_recovery"
  | "recovery_pending"
  | "resolved"
  | "escalated"
  | "failed";

export type IncidentType =
  | "address_unclear"
  | "customer_unavailable"
  | "location_inaccessible"
  | "rider_issue"
  | "damaged_parcel"
  | "not_delivered"
  | "wrong_item"
  | "unknown";

export type RecoveryAction =
  | "request_location"
  | "request_clarification"
  | "reschedule_delivery"
  | "propose_reassignment"
  | "verify_with_rider"
  | "offer_refund_or_reship"
  | "escalate";

export type InputType = "text" | "voice_transcript" | "audio" | "image";

export type IncidentSource = "rider_report" | "customer_complaint";

export type IssueCategory =
  | "cant_find_address"
  | "access_blocked"
  | "customer_unreachable"
  | "customer_refused"
  | "parcel_damaged_transit"
  | "vehicle_personal_issue"
  | "weather_safety"
  | "not_delivered"
  | "arrived_damaged"
  | "wrong_item"
  | "no_attempt_notified"
  | "reschedule_address_change"
  | "other";

export type AgentDecision = {
  incidentType: IncidentType;
  orderCode: string | null;
  summary: string;
  missingInformation: string[];
  recommendedAction: RecoveryAction;
  urgency: "low" | "medium" | "high";
  reasoning: string;
};

export type Order = {
  id: string;
  order_code: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  address: string;
  address_notes: string | null;
  deadline: string | null;
  status: string;
  rider_id: string | null;
  created_at: string;
};

export type User = {
  id: string;
  email: string;
  role: "admin" | "rider";
  display_name: string;
  rider_id: string | null;
  created_at: string;
};

export type Rider = {
  id: string;
  name: string;
  phone: string | null;
  status: "available" | "busy" | "off_duty";
  capacity: number;
  created_at: string;
};

export type Session = {
  user_id: string;
  email: string;
  role: "admin" | "rider";
  display_name: string;
  rider_id: string | null;
  exp: number;
};

export type Incident = {
  id: string;
  order_id: string | null;
  rider_id: string | null;
  input_type: InputType;
  raw_input: string | null;
  image_url: string | null;
  audio_url: string | null;
  type: IncidentType | null;
  description: string | null;
  status: IncidentStatus;
  attempt_count: number;
  source: IncidentSource;
  issue_category: IssueCategory | null;
  analysis: AgentDecision | null;
  last_error: string | null;
  reported_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  masked_input: string | null;
  pii_map: Record<string, string> | null;
  notify_email: string | null;
  eval_score: number | null;
  eval_hallucination: number | null;
  eval_truthfulness: number | null;
  eval_grounded: number | null;
  heal_attempts: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  total_latency_ms: number;
  pii_leak_detected: boolean;
};

export type AgentTraceStep = {
  id: string;
  incident_id: string;
  step_index: number;
  agent_name: string;
  protocol: "a2a" | "mcp" | "direct";
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  model: string | null;
  latency_ms: number | null;
  status: "ok" | "error";
  error: string | null;
  created_at: string;
};

export type AgentEvaluationRow = {
  id: string;
  incident_id: string;
  attempt: number;
  truthfulness: number | null;
  hallucination: number | null;
  grounded: number | null;
  overall: number | null;
  verdict: "pass" | "retry" | "escalate" | null;
  reasoning: string | null;
  evaluator_model: string | null;
  created_at: string;
};

export type DecisionFeedback = {
  id: string;
  incident_id: string;
  verdict: "right_call" | "wrong_call";
  suggested_action: string | null;
  comment: string | null;
  reviewer_user_id: string | null;
  created_at: string;
};

export type ActionLog = {
  id: string;
  incident_id: string;
  action: string;
  status: "started" | "success" | "failed" | "retrying";
  result: Record<string, unknown> | null;
  message: string | null;
  created_at: string;
};

export type Notification = {
  id: string;
  incident_id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string | null;
  email_id: string | null;
  status: "queued" | "sent" | "bounced" | "failed" | "opened";
  error: string | null;
  sent_at: string | null;
  created_at: string;
};

export type CustomerResponse = {
  id: string;
  incident_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  submitted_at: string | null;
  response_data: Record<string, unknown> | null;
  created_at: string;
};
