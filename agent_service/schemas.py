"""Pydantic request/response schemas shared across the ADK pipeline + the
Next.js integration. The field names mirror the TypeScript types in
`lib/types.ts` so the A2A contract is obvious on both sides.
"""

from __future__ import annotations

from pydantic import BaseModel, Field
from typing import Any, Literal


IncidentType = Literal[
    "address_unclear",
    "customer_unavailable",
    "location_inaccessible",
    "rider_issue",
    "damaged_parcel",
    "not_delivered",
    "wrong_item",
    "unknown",
]

RecoveryAction = Literal[
    "request_location",
    "request_clarification",
    "reschedule_delivery",
    "propose_reassignment",
    "verify_with_rider",
    "offer_refund_or_reship",
    "escalate",
]


class OrderContext(BaseModel):
    order_code: str | None = None
    customer_name: str | None = None
    customer_email: str | None = None
    customer_phone: str | None = None
    address: str | None = None
    address_notes: str | None = None
    rider_name: str | None = None
    rider_phone: str | None = None


class FeedbackExample(BaseModel):
    """A past admin correction, used as few-shot context for self-healing."""
    masked_input: str
    issue_category: str | None = None
    wrong_action: str
    correct_action: str
    comment: str | None = None


class AnalyzeRequest(BaseModel):
    incident_id: str
    source: Literal["rider_report", "customer_complaint"]
    raw_input: str | None = None
    image_b64: str | None = None
    image_mime: str | None = None
    audio_b64: str | None = None
    audio_mime: str | None = None
    issue_category: str | None = None
    custom_issue_title: str | None = None
    notify_email: str | None = None
    order_context: OrderContext | None = None
    feedback_examples: list[FeedbackExample] = Field(default_factory=list)


class AgentDecision(BaseModel):
    incidentType: IncidentType
    orderCode: str | None = None  # may be a token like <<ORDER_1>>
    summary: str
    missingInformation: list[str] = Field(default_factory=list)
    recommendedAction: RecoveryAction
    urgency: Literal["low", "medium", "high"] = "medium"
    reasoning: str


class AgentEvaluation(BaseModel):
    truthfulness: float   # 0..1 — plan references only facts actually present
    hallucination: float  # 0..1 — share of invented facts (higher = worse)
    grounded: float       # 0..1 — plan is consistent with the input
    overall: float
    verdict: Literal["pass", "retry", "escalate"]
    reasoning: str


class TraceStep(BaseModel):
    step_index: int
    agent_name: str
    protocol: Literal["a2a", "mcp", "direct"] = "a2a"
    input: dict[str, Any] | None = None
    output: dict[str, Any] | None = None
    model: str | None = None
    latency_ms: int | None = None
    status: Literal["ok", "error"] = "ok"
    error: str | None = None


class AnalyzeResponse(BaseModel):
    incident_id: str
    masked_input: str
    pii_map: dict[str, str]           # token → real value; held outside the brain
    decision: AgentDecision
    evaluation: AgentEvaluation
    trace: list[TraceStep]
    heal_attempts: int
