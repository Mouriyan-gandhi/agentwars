# ParcelPilot Agent Service

Google ADK multi-agent sidecar. Runs the "brain" of ParcelPilot: receives an
incident payload from Next.js, pushes it through a chain of specialized ADK
agents communicating via **A2A** (Agent-to-Agent), returns the decision +
masked trace + eval scores. The Next.js side executes the decision via **MCP**
tools (Supabase, Resend).

## Pipeline

```
POST /analyze
    │
    ▼  (A2A handoff)
┌───────────────────────────────────────────────────────────────────┐
│ Orchestrator (ADK SequentialAgent)                                │
│   1. PII Guardian   → masks all PII; produces masked_text + map   │
│   2. Classifier     → picks IncidentType  (sees masked only)      │
│   3. Planner        → picks RecoveryAction (sees masked only)     │
│   4. Evaluator      → scores truthfulness/hallucination/grounded  │
│   5. SelfHealLoop   → retries Planner if score < 0.7              │
└───────────────────────────────────────────────────────────────────┘
    │
    ▼
{decision, masked_input, pii_map, trace[], eval}
```

Only the orchestrator holds `pii_map`. Classifier / Planner / Evaluator *never*
see the real name, email, phone, address, or notify_email. Next.js reattaches
real identifiers at the DB and email-send boundary.

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

- `POST /analyze` — body: `{incident_id, raw_input, image_b64?, audio_b64?, source, issue_category, order_context, feedback_examples}`
- `GET /healthz`
- `GET /a2a/agents` — A2A card listing the agents + their skills (standard A2A discovery)
