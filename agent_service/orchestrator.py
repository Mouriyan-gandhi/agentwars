"""Orchestrator: wires the ADK agents into a cost-aware, latency-aware pipeline
with an independent output-PII leak detector and a self-heal loop.

Pipeline:
  0. injection_filter (deterministic) — flag prompt-injection attempts
  1. pii_guardian                      — mask PII (regex, optional LLM pass)
  2. decider (merged Classifier+Planner) — one LLM call picks type AND action
  3. pii_leak_check (deterministic)    — verify decider output has no real PII
  4. evaluator                         — score truthfulness / hallucination
  5. self-heal loop                    — retry decider up to 2x if verdict≠pass

Latency: 1 required LLM call (decider) + 1 required (evaluator) + 1 optional
(guardian LLM pass). ~40% faster than the earlier Guardian→Classifier→Planner
→Evaluator sequence.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from agents import (
    make_decider,
    make_evaluator,
    run_agent,
    parse_json,
    count_tokens,
    DEFAULT_MODEL,
    EVAL_MODEL,
)
from pii import guardian_mask, MaskResult
from schemas import (
    AgentDecision,
    AgentEvaluation,
    AnalyzeRequest,
    AnalyzeResponse,
    TraceStep,
)


MAX_HEAL_ATTEMPTS = 2
PASS_THRESHOLD = 0.7

# Gemini 2.0 flash prices (public, as of 2026-01):
#   input  $0.075 / 1M tokens
#   output $0.30  / 1M tokens
# flash-lite is ~half that. These are only used for the admin cost estimate.
PRICE_IN = {"gemini-2.0-flash": 0.075, "gemini-2.0-flash-lite": 0.04}
PRICE_OUT = {"gemini-2.0-flash": 0.30, "gemini-2.0-flash-lite": 0.15}


def _usd(model: str, tin: int, tout: int) -> float:
    pin = PRICE_IN.get(model, 0.075)
    pout = PRICE_OUT.get(model, 0.30)
    return round((tin * pin + tout * pout) / 1_000_000, 6)


# -----------------------------------------------------------------------------
# Prompt-injection filter — detects classic attack strings and marks them.
# Not a hard reject (that would be user-hostile); surfaces a signal the
# Evaluator can factor in.
# -----------------------------------------------------------------------------
_INJECTION_PATTERNS = [
    r"ignore (all |previous |above )?instructions?",
    r"disregard (the )?(system|above|previous)",
    r"you are now",
    r"reveal (the|your) (system )?prompt",
    r"print the (pii|map|token)s?",
    r"<<[A-Z]+_\d+>>\s*=",
    r"act as (an? )?(admin|developer)",
]


def injection_check(text: str) -> dict[str, Any]:
    if not text:
        return {"flagged": False, "hits": []}
    hits = []
    for pat in _INJECTION_PATTERNS:
        if re.search(pat, text, flags=re.IGNORECASE):
            hits.append(pat)
    return {"flagged": bool(hits), "hits": hits}


# -----------------------------------------------------------------------------
# Independent output-side PII leak detector. Deterministic — not an LLM. If
# a real PII value from the pii_map appears in the agent's output, that's a
# guardrail failure regardless of what the Evaluator LLM said.
# -----------------------------------------------------------------------------
def leak_check(output_payload: dict[str, Any] | None, pii_map: dict[str, str]) -> dict[str, Any]:
    if not output_payload:
        return {"leaked": False, "hits": []}
    blob = json.dumps(output_payload, ensure_ascii=False)
    hits = []
    for tok, real in pii_map.items():
        if not real:
            continue
        if len(real) < 4:
            # too short to be a reliable match (initials, "SM" etc.)
            continue
        if real in blob:
            hits.append({"token": tok, "value_preview": real[:3] + "***"})
    return {"leaked": bool(hits), "hits": hits}


def _trace(
    steps: list[TraceStep],
    *,
    agent_name: str,
    input_payload: dict[str, Any],
    output_payload: dict[str, Any] | None,
    latency_ms: int,
    model: str | None,
    tokens_in: int = 0,
    tokens_out: int = 0,
    cost_usd: float = 0.0,
    error: str | None = None,
    protocol: str = "a2a",
) -> None:
    enriched_output = dict(output_payload or {})
    if tokens_in or tokens_out:
        enriched_output["_usage"] = {
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "cost_usd": cost_usd,
        }
    steps.append(
        TraceStep(
            step_index=len(steps),
            agent_name=agent_name,
            protocol=protocol,  # type: ignore[arg-type]
            input=input_payload,
            output=enriched_output,
            model=model,
            latency_ms=latency_ms,
            status="ok" if not error else "error",
            error=error,
        )
    )


def _format_feedback(examples: list[Any]) -> str:
    if not examples:
        return "(none)"
    lines = []
    for i, ex in enumerate(examples, 1):
        lines.append(
            f"[{i}] masked_input: {ex.masked_input}\n"
            f"    issue_category: {ex.issue_category or 'n/a'}\n"
            f"    wrong_action: {ex.wrong_action}  →  correct_action: {ex.correct_action}\n"
            f"    comment: {ex.comment or 'n/a'}"
        )
    return "\n".join(lines)


def _decider_prompt(
    masked_input: str,
    source: str,
    issue_category: str | None,
    feedback_block: str,
    injection: dict[str, Any],
    temperature_hint: str,
) -> str:
    return (
        f"source: {source}\n"
        f"issue_category (user-picked): {issue_category or 'none'}\n"
        f"injection_flagged: {injection['flagged']}  hits: {injection['hits']}\n"
        f"temperature_hint: {temperature_hint}\n"
        f"feedbackExamples:\n{feedback_block}\n\n"
        f"masked_input:\n---\n{masked_input}\n---\n"
    )


def _evaluator_prompt(masked_input: str, plan: dict[str, Any], leak: dict[str, Any]) -> str:
    return (
        f"masked_input:\n---\n{masked_input}\n---\n\n"
        f"decider_output_json:\n{json.dumps(plan)}\n\n"
        f"pii_leak_report:\n{json.dumps(leak)}\n"
    )


def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    steps: list[TraceStep] = []

    # ------------------------------------------------------------------
    # Step -1: deterministic prompt-injection filter (no LLM, ~1ms).
    # ------------------------------------------------------------------
    t0 = time.perf_counter()
    base_text = req.raw_input or ""
    if req.custom_issue_title:
        base_text = f"[{req.custom_issue_title}] {base_text}".strip()
    injection = injection_check(base_text)
    _trace(
        steps,
        agent_name="injection_filter",
        input_payload={"text_len": len(base_text)},
        output_payload=injection,
        model=None,
        latency_ms=int((time.perf_counter() - t0) * 1000),
        protocol="direct",
    )

    # ------------------------------------------------------------------
    # Step 0: Guardian — regex + known-value masking (deterministic).
    # LLM fallback only runs when regex didn't match anything novel.
    # ------------------------------------------------------------------
    t0 = time.perf_counter()
    order_ctx = req.order_context.model_dump() if req.order_context else {}
    mask: MaskResult = guardian_mask(
        raw_text=base_text,
        order_context=order_ctx,
        notify_email=req.notify_email,
        model_name=DEFAULT_MODEL,
    )
    guardian_ms = int((time.perf_counter() - t0) * 1000)
    _trace(
        steps,
        agent_name="pii_guardian",
        input_payload={
            "raw_input_len": len(base_text),
            "order_context_fields": list((order_ctx or {}).keys()),
            "notify_email_provided": bool(req.notify_email),
        },
        output_payload={
            "masked_input": mask.masked_text,
            "pii_token_count": len(mask.pii_map),
            "llm_pass_used": mask.llm_used,
        },
        model=DEFAULT_MODEL if mask.llm_used else None,
        latency_ms=guardian_ms,
        tokens_in=mask.llm_tokens_in,
        tokens_out=mask.llm_tokens_out,
        cost_usd=_usd(DEFAULT_MODEL, mask.llm_tokens_in, mask.llm_tokens_out),
    )

    # ------------------------------------------------------------------
    # Step 1 + 2: Decider + Evaluator in a self-healing loop.
    # ------------------------------------------------------------------
    decider = make_decider()
    evaluator = make_evaluator()
    feedback_block = _format_feedback(req.feedback_examples)

    attempt = 0
    plan: dict[str, Any] | None = None
    eval_json: dict[str, Any] | None = None
    leak_report: dict[str, Any] = {"leaked": False, "hits": []}

    while attempt <= MAX_HEAL_ATTEMPTS:
        temperature_hint = "normal" if attempt == 0 else "higher_variety"
        prompt = _decider_prompt(
            masked_input=mask.masked_text,
            source=req.source,
            issue_category=req.issue_category,
            feedback_block=feedback_block,
            injection=injection,
            temperature_hint=temperature_hint,
        )

        p_text, p_ms = run_agent(decider, prompt)
        tokens_in = count_tokens(DEFAULT_MODEL, prompt)
        tokens_out = count_tokens(DEFAULT_MODEL, p_text)
        try:
            plan = parse_json(p_text)
        except Exception as e:
            _trace(
                steps,
                agent_name=f"decider_attempt_{attempt + 1}",
                input_payload={"temperature_hint": temperature_hint, "prompt_len": len(prompt)},
                output_payload={"raw": p_text[:400]},
                model=DEFAULT_MODEL,
                latency_ms=p_ms,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                cost_usd=_usd(DEFAULT_MODEL, tokens_in, tokens_out),
                error=f"parse: {e}",
            )
            plan = None
            attempt += 1
            continue

        # Deterministic leak check (step 3) — this is the independent axis
        # that catches hallucinated real PII in the decider's own output.
        leak_report = leak_check(plan, mask.pii_map)
        _trace(
            steps,
            agent_name=f"decider_attempt_{attempt + 1}",
            input_payload={"temperature_hint": temperature_hint, "prompt_len": len(prompt)},
            output_payload={**plan, "pii_leak": leak_report},
            model=DEFAULT_MODEL,
            latency_ms=p_ms,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=_usd(DEFAULT_MODEL, tokens_in, tokens_out),
        )
        # A leak is a hard-fail. Force a retry regardless of what the LLM
        # evaluator says.
        if leak_report["leaked"] and attempt < MAX_HEAL_ATTEMPTS:
            attempt += 1
            continue

        e_prompt = _evaluator_prompt(mask.masked_text, plan, leak_report)
        e_text, e_ms = run_agent(evaluator, e_prompt)
        e_tin = count_tokens(EVAL_MODEL, e_prompt)
        e_tout = count_tokens(EVAL_MODEL, e_text)
        try:
            eval_json = parse_json(e_text)
        except Exception as err:
            eval_json = {
                "truthfulness": 0.5,
                "hallucination": 0.5,
                "grounded": 0.5,
                "overall": 0.5,
                "verdict": "retry",
                "reasoning": f"evaluator parse failure: {err}",
            }

        # Combine LLM eval with the deterministic leak check — a leak forces
        # hallucination to 1.0 and verdict to escalate.
        if leak_report["leaked"]:
            eval_json["hallucination"] = 1.0
            eval_json["overall"] = 0.0
            eval_json["verdict"] = "escalate"
            eval_json["reasoning"] = (
                "PII leak detected in decider output: "
                + str(leak_report["hits"])
                + " · " + str(eval_json.get("reasoning", ""))
            )

        _trace(
            steps,
            agent_name=f"evaluator_attempt_{attempt + 1}",
            input_payload={"plan_action": plan.get("recommendedAction") if plan else None},
            output_payload=eval_json,
            model=EVAL_MODEL,
            latency_ms=e_ms,
            tokens_in=e_tin,
            tokens_out=e_tout,
            cost_usd=_usd(EVAL_MODEL, e_tin, e_tout),
        )

        verdict = (eval_json or {}).get("verdict", "retry")
        overall = float((eval_json or {}).get("overall", 0.0))
        if verdict == "pass" or overall >= PASS_THRESHOLD or attempt == MAX_HEAL_ATTEMPTS:
            break
        attempt += 1

    if plan is None:
        plan = {
            "incidentType": "unknown",
            "orderCode": None,
            "summary": "Pipeline failed to produce a plan",
            "missingInformation": [],
            "recommendedAction": "escalate",
            "urgency": "high",
            "reasoning": "Decider did not return parseable JSON after retries.",
        }
    if eval_json is None:
        eval_json = {
            "truthfulness": 0.0,
            "hallucination": 1.0,
            "grounded": 0.0,
            "overall": 0.0,
            "verdict": "escalate",
            "reasoning": "No evaluator output.",
        }

    decision = AgentDecision(**{
        "incidentType": plan.get("incidentType", "unknown"),
        "orderCode": plan.get("orderCode"),
        "summary": plan.get("summary", ""),
        "missingInformation": plan.get("missingInformation", []) or [],
        "recommendedAction": plan.get("recommendedAction", "escalate"),
        "urgency": plan.get("urgency", "medium"),
        "reasoning": plan.get("reasoning", ""),
    })

    evaluation = AgentEvaluation(
        truthfulness=float(eval_json.get("truthfulness", 0.0)),
        hallucination=float(eval_json.get("hallucination", 1.0)),
        grounded=float(eval_json.get("grounded", 0.0)),
        overall=float(eval_json.get("overall", 0.0)),
        verdict=eval_json.get("verdict", "escalate"),
        reasoning=eval_json.get("reasoning", ""),
    )

    return AnalyzeResponse(
        incident_id=req.incident_id,
        masked_input=mask.masked_text,
        pii_map=mask.pii_map,
        decision=decision,
        evaluation=evaluation,
        trace=steps,
        heal_attempts=attempt,
    )
