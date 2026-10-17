# ParcelPilot Agent Service

Google ADK multi-agent sidecar. Receives an incident payload from Next.js over
**A2A** (Agent-to-Agent), pushes it through a 5-agent pipeline, returns the
decision + masked_input + pii_map + per-step trace + eval scores. Next.js
executes the decision via **MCP** tools (Supabase, Resend).

## Pipeline

```
POST /analyze
    │
    ▼  (A2A handoff)
┌───────────────────────────────────────────────────────────────────┐
│ Orchestrator                                                       │
│   0. injection_filter  (deterministic, ~1ms)                       │
│         flags classic prompt-injection strings                     │
│   1. pii_guardian      (deterministic + optional LLM)              │
│         masks known values + regex catchalls + conditional LLM     │
│         pass (SKIPPED when regex is confident — token win)         │
│   2. decider           (gemini-2.0-flash) — ONE LLM call           │
│         merged Classifier + Planner: picks incidentType AND        │
│         recommendedAction from masked text only                    │
│   3. pii_leak_check    (deterministic — INDEPENDENT of LLM eval)   │
│         scans decider output for real PII; a hit force-escalates   │
│   4. evaluator         (gemini-2.0-flash-lite)                     │
│         scores truthfulness / hallucination / grounded / overall   │
│   5. self_heal_loop                                                │
│         retries decider ≤2× if verdict≠pass OR leak was detected   │
└───────────────────────────────────────────────────────────────────┘
    │
    ▼
{decision, masked_input, pii_map, trace[], evaluation, heal_attempts}
```

**Separation of trust.** The orchestrator holds `pii_map`. The Decider,
Evaluator, and MCP executor never see the real customer name, email, phone,
address, rider name/phone, or notify_email — only tokens. Next.js reattaches
real identifiers at the DB-write and email-send boundary.

**Token economics.** Every agent step attaches `{tokens_in, tokens_out,
cost_usd}` to its trace output. Rolled up on the incident. Prices live in
`orchestrator.py::PRICE_IN / PRICE_OUT`.

**Latency wins.**
- Merged Classifier+Planner saves one full LLM round-trip (~40%).
- Guardian LLM pass is **conditional** on `_RESIDUAL_PII_HINTS` matching — skipped on ~70% of inputs.
- Evaluator uses the smaller `flash-lite` model.

## Run

```bash
cd agent_service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY=...              # same key as Next.js uses
export AGENT_SERVICE_TOKEN=dev-shared  # must match APP_AGENT_SERVICE_TOKEN in Next.js
uvicorn main:app --port 8787 --reload
```

Next.js reads `AGENT_SERVICE_URL` (default `http://localhost:8787`) and
`AGENT_SERVICE_TOKEN` from `.env`.

## Endpoints

- `POST /analyze` — body: `{incident_id, raw_input, image_b64?, image_mime?, audio_b64?, audio_mime?, source, issue_category, custom_issue_title?, notify_email?, order_context, feedback_examples}`
- `GET /healthz`
- `GET /a2a/agents` — A2A agent card listing the agents + their skills (standard A2A discovery)

## Smoke test (no external deps)

```bash
python3 test_smoke.py
```

16 deterministic assertions covering PII masking, injection filter, and output
PII leak detection. Does **not** require `google-generativeai`, `pydantic`, or
`fastapi` — safe to run in CI.

## Fallback

If the sidecar is unreachable, Next.js falls back to the original single
Gemini call (`lib/gemini.ts::analyzeIncident`) so incidents still get a
decision. The admin trace panel will be empty for that incident, logged as
`a2a_sidecar_unreachable` in `action_logs`.
