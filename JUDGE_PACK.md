# ParcelPilot — Judge Pack

One page. Every criterion → the exact file / click / endpoint that proves it.

## Problem

**PS 1 — Logistics handler / supply-chain exceptions.** A delivery agent that
takes rider or customer reports (text + voice + photo), decides what to do,
emails the customer for missing info, reassigns riders, applies the fix to
the order. Three portals (`/rider`, `/customer`, `/admin`) over the same
agent brain.

---

## Round-1 criteria

| Criterion | Where it lives |
|---|---|
| **MCP (used)** | `lib/mcp.ts` (tool registry + handler) · `app/api/mcp/route.ts` (JSON-RPC endpoint; `GET /api/mcp` is the manifest). The executor calls `callTool("send_clarification_email", …)`, `callTool("reassign_order", …)`, etc. |
| **Multimodal agents** | `app/components/IssueReporter.tsx` captures text + 🎙 voice + 📷 photo. The ADK Guardian + Classifier agents consume all three. |
| **API calls** | Supabase, Gemini (via ADK), Resend, Google AI Studio multimodal. Every tool call is a logged `agent_trace` row. |
| **Conversational + automation** | Customer-form flow (`/customer-form/<token>`) is conversational; the rest is pure automation. |
| **Google ADK (mandatory)** | `agent_service/` — Python ADK app with `LlmAgent`, `SequentialAgent`, `LoopAgent`. `GET http://localhost:8787/a2a/agents` returns the A2A agent card. |
| **Fastest flow / submit / self-healing** | Self-heal lives in `agent_service/orchestrator.py` — if the Evaluator verdict is `retry` or overall < 0.7, the Planner retries up to twice with higher temperature and admin-corrected few-shots. Visible in the admin panel as an "N self-heal retries" counter. |

---

## Round-2 criteria

| Criterion | Where to see it |
|---|---|
| **Guardrail — don't enter personal info** | `agent_service/pii.py` — Guardian agent runs *first*. Regex + known-value substitution + LLM pass. All downstream agents receive the masked text only. |
| **Multiagent system, any protocol** | **A2A (Agent-to-Agent, Google's open protocol)** between Next.js and the sidecar, and **ADK's workflow agents** inside the sidecar. **MCP** between Executor and Supabase/Resend. |
| **Agent evaluation (truthfulness / hallucination / working)** | `agent_service/agents.py::EVALUATOR_INSTRUCTION`. Scores stored in `agent_evaluations`. Rendered as a scorecard on `/admin/incidents/<id>` with four big numbers: Overall / Truthfulness / Hallucination / Grounded. |
| **PII masked so the agent doesn't know, yet still does the job** | On `/admin/incidents/<id>`, the "What the brain agents saw" panel shows the masked text. Click **Reveal real values** — side-by-side comparison. The Planner's reasoning references `<<ADDR_1>>`, never the real address. |

---

## Multi-agent architecture

```
Rider or customer files a report
    ↓
Next.js /api/incidents inserts incident row
    ↓
Next.js workflow → A2A /analyze → ADK sidecar
                                     │
                                     ├─ 1. pii_guardian          (masks)
                                     ├─ 2. classifier            (masked only)
                                     ├─ 3. planner_attempt_1     (masked only)
                                     ├─ 4. evaluator_attempt_1   (scores)
                                     ├─ 5. planner_attempt_2     (self-heal if needed)
                                     └─ 6. evaluator_attempt_2   (final verdict)
                                     ↓
                             returns {decision, masked_input, pii_map,
                                       trace[], evaluation, heal_attempts}
    ↓
Next.js Executor → MCP tools → Supabase + Resend
    ↓
Resolved. Admin can click "Wrong call → suggest X" to teach the Planner.
```

**Separation of trust:** Classifier / Planner / Evaluator never see the real
customer name, email, phone, address, or `notify_email`. Those values live
only in the orchestrator's `pii_map`, which Next.js uses at the final
boundary (email `to:`, order patch) and nowhere else.

---

## Demo script (fastest path to a convincing run)

**Prereqs:** `.env` filled, migrations 001-005 run in Supabase, dev server up,
ADK sidecar up (`cd agent_service && uvicorn main:app --port 8787`).

1. `/rider` → log in as **arjun@parcelpilot.dev / rider123**.
2. Open **PP-1001** → **Report issue** → *Can't find address*.
3. Say "I'm at the main gate of Lotus Residency but I can't tell which
   building is 3B. Call Caanush at +91 90000 11111." Add the extra
   recipient `your-email@example.com`. **File incident →**.
4. `/admin` → open the new incident. Scroll to **Multi-agent chain**:
   - Chain strip: `pii_guardian → classifier → planner_attempt_1 → evaluator_attempt_1`
   - Click **Reveal real values** — see the real name/phone come back from the token map.
   - Eval card: Overall ≈ 0.85 · Hallucination ≈ 0.05 · Verdict `pass`.
5. Open the customer email, click the link, submit the clarified address.
   Incident flips to `resolved`; order address updates.
6. Fire a second report *Vehicle / personal issue* on PP-1004 → trigger
   reassignment via MCP tool (`callTool("reassign_order", …)`). The order
   moves to a different rider in the admin fleet view.
7. **The feedback flex:** on any incident, click **Wrong call → should have
   been `offer_refund_or_reship`** and comment. File the next similar incident
   — the Planner picks the corrected action because `fetchRecentFeedback`
   injects it as a few-shot via `feedback_examples` in the A2A request.

---

## File tour (for code review)

```
agent_service/                   # Python ADK sidecar
  main.py                        # FastAPI /analyze + /a2a/agents (A2A card)
  orchestrator.py                # Sequential pipeline + self-heal loop
  agents.py                      # LlmAgent definitions + prompts
  pii.py                         # Guardian: regex + known-value + LLM mask

lib/
  agentA2A.ts                    # TS client for the sidecar (A2A over HTTP)
  mcp.ts                         # In-process MCP server + tool registry
  workflow.ts                    # Executor; calls A2A for the brain and MCP for actions
  gemini.ts                      # fetchRecentFeedback + feedbackForA2A

app/api/mcp/route.ts             # Public MCP HTTP endpoint (judges can hit this)
app/api/incidents/route.ts       # Ingest; adds notify_email + custom_issue_title
app/admin/incidents/[id]/
  page.tsx                       # Admin incident detail (now with eval panel)
  AgentChainPanel.tsx            # The new ADK multi-agent / eval UI
  FeedbackPanel.tsx              # Admin → wrong_call → teaches the Planner

supabase/migrations/
  005_agent_trace_and_evals.sql  # agent_trace, agent_evaluations, pii_map, scores
```
