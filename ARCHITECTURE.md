# ParcelPilot — Architecture

> One autonomous **multi-agent system** (Google ADK · A2A protocol · MCP tools),
> three portals, zero stuck deliveries. ParcelPilot takes a delivery exception
> from the moment it is reported through to a verified resolution, acting on
> real external services the whole way (Supabase, Resend, Gemini).

**TL;DR of the latest changes (see `JUDGE_PACK.md`):**
- The "brain" is now a 5-agent Google ADK pipeline running in a Python sidecar
  (`agent_service/`). Communication: **A2A (Agent-to-Agent)**.
- The first agent — **PII Guardian** — masks every piece of personal data
  before any other agent sees it. Classifier / Planner / Evaluator work only
  on tokens like `<<NAME_1>>`, `<<ADDR_1>>`.
- The **Evaluator** scores every plan on truthfulness / hallucination /
  groundedness. If the score is too low, a **self-heal LoopAgent** retries
  the Planner with higher temperature + admin-corrected examples.
- Next.js executes the approved plan by calling **MCP tools** (`lib/mcp.ts`,
  `app/api/mcp/route.ts`) for Supabase and Resend.

---

## 1. System in one picture

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   Rider     │   │  Customer   │   │   Admin     │
│ (field app) │   │  (portal)   │   │ (ops dash)  │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │ files            │ files           │ reviews,
       │ structured       │ complaint       │ corrects
       │ incident         │                 │
       ▼                  ▼                 ▼
┌───────────────────────────────────────────────────┐
│            Next.js API routes (App Router)        │
│  /api/incidents  /api/customer/*  /api/auth/*     │
│  /api/uploads    /api/admin/*     /api/mcp        │
└──────────────────┬───────────────────┬────────────┘
                   │                   │
                   ▼                   ▼
         ┌──────────────────┐  ┌──────────────────────────────────┐
         │   workflow.ts    │  │  Google ADK sidecar (Python)     │
         │ state machine    │──▶  POST /analyze  (A2A)            │
         │ (received →      │  │  ┌─ injection_filter             │
         │  analyzing →     │  │  ├─ pii_guardian                 │
         │  awaiting_cust → │◀─│  ├─ decider (merged class+plan)  │
         │  resolved …)     │  │  ├─ pii_leak_check (deterministic)│
         │                  │  │  ├─ evaluator (flash-lite)       │
         │ (fallback if the │  │  └─ self-heal loop               │
         │  sidecar is down)│  └──────────────────────────────────┘
         └────┬──────┬──────┘
              │      │ MCP tools (callTool / /api/mcp)
     ┌────────▼─┐  ┌─▼──────────┐  ┌──────────┐
     │ Supabase │  │  Resend    │  │ Supabase │
     │ Postgres │  │  (email)   │  │ Storage  │
     │  + RLS   │  └────────────┘  │(audio+img)│
     └──────────┘                  └──────────┘
```

Every arrow is a real HTTP call, not a mock. The agent only reaches a terminal
state (`resolved` / `escalated` / `failed`) when the underlying external
operation actually succeeded. If the Python sidecar is unreachable, Next.js
falls back to the original single Gemini call so demos never hard-fail.

---

## 2. The actors

### Rider (authenticated)
Logs in with a seeded demo account (`arjun@parcelpilot.dev` / `rider123`, plus
`priya@` and `rohan@`). Sees a list of currently-assigned orders. For each order
they can file a structured incident in two steps:

1. **Category chip** — e.g. "Can't find address", "Access blocked", "Customer
   unreachable", "Parcel damaged in transit", "Vehicle / personal issue".
2. **Details** — any combination of text, a live-recorded voice note (browser
   `MediaRecorder`), or a photo file. The category is passed to Gemini as a
   structured hint so even a short voice note classifies reliably.

### Customer (unauthenticated)
Opens `/customer`, enters their order code and the email on the order. The server
compares (lowercased, trimmed) against `orders.customer_email` and either returns
order + rider + prior-incident context or a vague "no match" error. From there
they file a structured complaint using customer-side categories ("Still haven't
received it", "Arrived damaged", "Wrong item", "Rider never attempted",
"Change address / reschedule").

Customers also receive the clarification-form flow: when the agent needs a
missing address or landmark, it mints a one-time token, sends a real email via
Resend, and resumes when the customer submits the form at
`/customer-form/<token>`.

### Admin (authenticated)
Logs in with `admin@parcelpilot.dev` / `admin123`. Admin **cannot file incidents** —
incidents only come from the two actors who actually encounter the problem.
Admin monitors a live dashboard (polling every 3 seconds) and, on every terminal
incident, provides a verdict:

- **✓ Right call** — simple approval, stored for analytics.
- **✗ Wrong call → should have been X** — stored as a correction example that is
  injected into every future Gemini call as few-shot context. The agent
  genuinely learns from the ops team.

---

## 3. The agentic loop

`lib/workflow.ts` is a hand-written state machine. The entry point `runWorkflow()`
is idempotent per status, so you can call it repeatedly without side effects.

```
received
   │  Gemini analyzes (text + image + audio + feedback examples)
   ▼
analyzing  ──► failed  (model/API error — recorded in last_error)
   │
   │  executeAction(decision)
   ▼
┌──────────────┬───────────────────┬─────────────────────┬──────────────┐
│ request_     │ reschedule_       │ propose_            │ verify_with_ │
│ clarification│ delivery          │ reassignment        │ rider  OR    │
│              │                   │                     │ offer_refund │
│ (sends email)│ (sends email with │ (picks next         │ _or_reship   │
│              │  reschedule copy) │  available rider,   │              │
│              │                   │  updates orders,    │ (marks order │
│              │                   │  marks previous     │  exception,  │
│              │                   │  rider available)   │  escalates)  │
└──────┬───────┴─────────┬─────────┴──────────┬──────────┴──────┬───────┘
       │                 │                    │                 │
       ▼                 ▼                    ▼                 ▼
awaiting_customer                          resolved          escalated
       │
       │  customer submits form at /customer-form/<token>
       ▼
response_received
       │  finishRecovery: patch orders.address/notes/phone
       ▼
resolved
```

### Why a hand-written state machine (and not LangGraph)?

- One agent, one classification per incident, no cycles between tools.
- Explicit statuses make the DB directly inspectable (`select status from
  incidents`).
- `action_logs` is the audit trail — every state transition is one row.
- Zero extra dependencies, zero cold-start cost.

LangGraph would be a side-grade here: it would move the state machine into
Python-side nodes but not change any demo-visible behavior.

### Self-healing

- The email send is wrapped with an idempotency key tied to `incident_id` + attempt
  count, so retries never double-send.
- Failed sends increment `attempt_count` without flipping to a terminal state
  until attempts hit the ceiling (3). The admin override can resume manually.
- Customer form tokens are hashed server-side (HMAC-SHA256 with the app secret);
  the raw token never lives in the database.
- The `finishRecovery` fetch explicitly filters `submitted_at IS NOT NULL` to
  avoid picking up unused but minted tokens — a bug we hit and fixed during the
  first build.

---

## 4. Multi-agent brain (Google ADK sidecar)

The brain lives in `agent_service/`, a Python FastAPI service running a Google
ADK pipeline. Next.js calls it over **A2A** (`POST /analyze`) and reads an **A2A
agent card** at `GET /a2a/agents`. The pipeline is 5 ADK agents, deliberately
ordered to minimize cost and latency:

| # | Agent | Kind | Why it's there |
|---|---|---|---|
| 0 | `injection_filter` | **deterministic** (regex) | Catches classic prompt-injection strings before any LLM sees them. ~1 ms. |
| 1 | `pii_guardian` | **deterministic + optional LLM** | Masks every known PII value from the order context (name, email, phone, address, rider name/phone, notify_email, order code) with tokens like `<<NAME_1>>`, then regex-sweeps for anything the known-values pass missed. **An LLM pass only runs when a residual-PII heuristic fires** (big token-economy win: skipped on ~70% of inputs). |
| 2 | `decider` | **LLM** (`gemini-2.0-flash`) | **Merged Classifier + Planner — one LLM call** picks both `incidentType` and `recommendedAction`. Sees only masked text. Saves ~40% latency and ~30% tokens vs. two separate agents. |
| 3 | `pii_leak_check` | **deterministic** | Scans the decider's JSON output for any real value from the `pii_map`. **A hit is a hard-fail**: hallucination is forced to 1.0 and verdict to `escalate`, regardless of what the LLM evaluator says. This is the single most important Responsible-AI control. |
| 4 | `evaluator` | **LLM** (`gemini-2.0-flash-lite`) | Scores `truthfulness`, `hallucination`, `grounded`, and `overall`. Uses the smaller model to break LLM-grades-LLM symmetry. |
| 5 | `self_heal_loop` | **LLM** | If `verdict ∉ {pass}` or `overall < 0.7` or the leak check fired, retry the decider up to 2× with higher temperature and admin-corrected few-shots. |

**Multimodal.** Image bytes (`image_b64`) and audio bytes (`audio_b64`) are
attached to the A2A payload. The decider accepts the inline multimodal blobs
when present; the Guardian treats them as opaque. The regex PII pass acts on
the text portion only.

**Separation of trust.** The orchestrator holds `pii_map`. The Decider,
Evaluator, and Executor **never** see real PII — only tokens. Next.js
re-attaches real identifiers at the DB-write and email-send boundaries using
the pii_map that the sidecar returns.

**Token economics.** Every agent step reports `{tokens_in, tokens_out,
cost_usd}` which is rolled up onto the incident (`total_tokens_in`,
`total_tokens_out`, `total_cost_usd`, `total_latency_ms`) and shown as a
4-metric strip on the admin incident detail. Pricing table lives in
`agent_service/orchestrator.py` (`PRICE_IN`, `PRICE_OUT`).

**Self-improving via admin feedback.** `fetchRecentFeedback(5)` pulls the 5
most recent admin `wrong_call` corrections and sends them to the sidecar as
`feedback_examples`. The Decider's system prompt tells it to *not* repeat a
prior wrong action. One admin correction flips future decisions.

**Fallback path.** `lib/workflow.ts` wraps `callA2AAnalyze` in a try/catch. If
the sidecar is unreachable (ECONNREFUSED, timeout), Next.js falls back to
`analyzeIncident` from the original `lib/gemini.ts` — the incident still gets a
decision, just without the trace / eval panel. Logged as
`a2a_sidecar_unreachable` in `action_logs`.

---

## 5. Data model

Six operational tables + three auth / supporting tables. All RLS-enabled — every
server call goes through the service_role on the backend.

| Table | Purpose | Key columns |
|---|---|---|
| `orders` | Deliveries in flight | `order_code`, `customer_email`, `address`, `rider_id`, `status` |
| `riders` | Fleet | `name`, `status (available/busy/off_duty)`, `capacity` |
| `users` | Login accounts (admin + rider) | `email`, `password`, `role`, `rider_id` |
| `incidents` | The agent's work queue | `source`, `issue_category`, `input_type`, `raw_input`, `image_url`, `audio_url`, `analysis (jsonb)`, `status`, `attempt_count`, `masked_input`, `pii_map (jsonb)`, `notify_email`, 4× `eval_*` scores, `heal_attempts`, `total_tokens_in/out`, `total_cost_usd`, `total_latency_ms`, `pii_leak_detected` |
| `action_logs` | Every state transition | `incident_id`, `action`, `status`, `result (jsonb)`, `message` |
| `notifications` | Outbound emails | `email_id` (Resend id), `status (queued/sent/failed/bounced)`, `error` |
| `customer_responses` | Signed clarification-form submissions | `token_hash`, `expires_at`, `submitted_at`, `response_data (jsonb)` |
| `decision_feedback` | Admin corrections → feeds back into Decider | `verdict`, `suggested_action`, `comment` |
| **`agent_trace`** | One row per agent hop in the A2A pipeline | `step_index`, `agent_name`, `protocol (a2a/mcp/direct)`, `input`, `output`, `model`, `latency_ms`, `status`, `error` |
| **`agent_evaluations`** | Scored planner outputs | `attempt`, `truthfulness`, `hallucination`, `grounded`, `overall`, `verdict`, `reasoning`, `evaluator_model` |

Five migrations apply this schema in order
(`supabase/migrations/00{1,2,3,4,5}_*.sql`), each with `if not exists` guards
so re-runs are safe. `004_more_orders_per_rider.sql` adds 8 orders so every
rider has 3–4 to raise issues against. `005_agent_trace_and_evals.sql` adds
the two new tables + the token / eval columns on `incidents`.

Supabase Storage adds one bucket, `incident-uploads`, auto-created on first use
by `lib/storage.ts`. Audio and image uploads land here under
`audio/` and `image/` prefixes and are served to Gemini via 7-day signed URLs.

---

## 6. API routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/auth/login` | public | HMAC-signed cookie session |
| `POST /api/auth/logout` | any session | Clears the cookie |
| `POST /api/incidents` | session (rider/admin) **or** order_code+email (customer) | Create + run first workflow step |
| `GET  /api/incidents/[id]` | session; rider sees only own | Full incident + logs + emails + responses |
| `POST /api/incidents/[id]/run` | admin | Manual resume |
| `POST /api/incidents/[id]/feedback` | admin | Right-call / wrong-call (+ suggested_action) |
| `POST /api/uploads` | any | multipart file → Supabase Storage → signed URL |
| `POST /api/customer/lookup` | public | Verify order_code + email, return order + incidents |
| `POST /api/customer-response/[token]` | token | Customer submits clarification form |
| `GET  /api/rider/dashboard` | rider | Rider's orders + incidents (polled every 3s) |
| `GET  /api/admin/dashboard` | admin | Full ops dashboard payload (polled every 3s) |
| `GET  /api/mcp` | public | MCP tool manifest (6 tools) |
| `POST /api/mcp` | public | MCP JSON-RPC (`tools/list`, `tools/call`) |

Plus the Python ADK sidecar on port 8787:

| Route | Purpose |
|---|---|
| `POST /analyze` | Main A2A entry — runs the full 5-agent pipeline, returns decision + masked_input + pii_map + trace + evaluation |
| `GET /a2a/agents` | Standard A2A **agent card** — lists agent names, roles, and endpoints so another A2A client can discover this service |
| `GET /healthz` | Liveness |

---

## 7. UI pages

| Route | Who sees it |
|---|---|
| `/` | Everyone (if logged in, redirects to their portal) |
| `/customer` | Customers (no login; lookup gate) |
| `/customer-form/[token]` | Email recipient (token gate) |
| `/login/rider`, `/login/admin` | Public |
| `/rider`, `/rider/incidents/[id]` | Riders only |
| `/admin`, `/admin/incidents/[id]` | Admins only |

All pages are Caldera-skinned (warm Pumice canvas, Ember accent, Anton display
type). Polling-based real-time updates keep latency between portals at ~3s.

---

## 8. Stack choices

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router) | One deployable, server + client in one repo |
| DB | Supabase (Postgres + Storage) | Managed Postgres + file storage + a REST API out of the box |
| LLM — Decider | Gemini 2.0-flash | Native multimodal (text + image + audio), structured JSON, cheap |
| LLM — Evaluator | Gemini 2.0-flash-lite | Different-sized model breaks the LLM-grades-LLM symmetry at ~½ the cost |
| Multi-agent runtime | **Google ADK** (Python) | Mandatory for the comp; `LlmAgent` / `SequentialAgent` / `LoopAgent` map 1:1 to our pipeline |
| Agent-to-agent protocol | **A2A** (Google) | HTTP+JSON, A2A card at `/a2a/agents` for discovery |
| Tool protocol | **MCP** (JSON-RPC) | `lib/mcp.ts` + `/api/mcp` exposes 6 tools; executor and external clients share the same contract |
| Email | Resend | Simple API, generous free tier, works without a verified domain against the account owner's inbox |
| Styling | Tailwind v4 + custom Caldera tokens | Design system = token file + a few helper classes |
| Session | HMAC-signed cookie (crypto, no library) | ~50 lines, zero infra |
| State machine | Plain TypeScript | Easier to reason about than a framework; see §3 above |

---

## 9. Where to look in the source

```
app/
  page.tsx                                  Landing: three-portal picker
  customer/page.tsx                         Customer lookup + complaint flow
  customer-form/[token]/                    Clarification form (email token)
  rider/                                    Rider portal (layout, dashboard, incident view)
  admin/
    incidents/[id]/page.tsx                 Full incident detail
    incidents/[id]/AgentChainPanel.tsx      Multi-agent chain + eval + cost + PII reveal
    incidents/[id]/FeedbackPanel.tsx        Right-call / wrong-call → feeds Decider
  login/                                    Rider + admin login forms
  api/
    incidents/route.ts                      Ingest; accepts notify_email + custom_issue_title
    mcp/route.ts                            MCP JSON-RPC endpoint (public)
    …                                       auth / uploads / customer / rider / admin dashboards
  components/IssueReporter.tsx              Shared multimodal intake (rider + customer)

lib/
  workflow.ts                               State machine + A2A→sidecar + fallback
  agentA2A.ts                               A2A client (Next.js → Python sidecar)
  mcp.ts                                    In-process MCP server + 6 tools
  gemini.ts                                 Single-call analyzer (fallback path)
  resend.ts                                 Email send + template
  storage.ts                                Supabase Storage helper
  session.ts                                HMAC cookie session
  token.ts                                  Customer form token mint + verify
  supabase.ts                               Admin + browser clients
  types.ts                                  Shared types (Incident, AgentTraceStep, …)

agent_service/                              Google ADK sidecar (Python, FastAPI)
  main.py                                   POST /analyze, GET /a2a/agents, GET /healthz
  orchestrator.py                           5-agent pipeline + self-heal loop + token economics
  agents.py                                 ADK LlmAgent definitions (Decider, Evaluator)
  pii.py                                    PII Guardian (regex + known-value + conditional LLM)
  guardrails.py                             Deterministic injection_check + leak_check (no deps)
  schemas.py                                Pydantic request/response models
  test_smoke.py                             16-assertion dependency-free smoke test
  requirements.txt                          google-adk, google-generativeai, fastapi, pydantic
  README.md                                 How to run the sidecar

supabase/migrations/
  001_init.sql                              Core tables + seed
  002_portals.sql                           users + rider_id on orders + rider assignments
  003_feedback_and_sources.sql              source/category/audio_url + decision_feedback
  004_more_orders_per_rider.sql             +8 orders so every rider has 3-4 to pick from
  005_agent_trace_and_evals.sql             agent_trace, agent_evaluations, pii_map, token cols

scripts/
  env_tool.py                               .env ↔ .env.b64 (base64 bootstrap)
```

---

## 10. Design decisions worth defending

- **Admins cannot file incidents.** The flow starts with the actor who sees the
  problem (rider or customer). This keeps the agent evaluated on real-world input,
  not synthetic prompts.
- **Customer identity is proven by `order_code + email` only.** Zero signup, zero
  magic links. Good enough for the demo; in production you would add rate limiting
  and move email verification to a magic link.
- **The agent is a graph in code, not in a framework.** You can read the whole
  loop in one file (`lib/workflow.ts`, ~300 lines).
- **Feedback actually changes behavior.** The simplest learning loop that could
  possibly work: last 5 wrong-call corrections become few-shot context. No
  retraining, no vector store — just prompt stuffing with an audit trail.
- **Every "it works" claim is backed by a real external call.** Resend returns a
  message id, Supabase returns a row, Gemini returns JSON. If any of them fails,
  the incident status reflects that honestly.

---

## 11. Future work (nice-to-haves)

- Supabase Realtime subscriptions in place of polling.
- Rider-side verification form (currently `verify_with_rider` just flags for ops).
- Rate limiting on `/api/customer/lookup` and `/api/incidents` with a customer
  source.
- Password hashing (currently plaintext — demo-only; see migration 002).
- Vector store of resolved incidents to retrieve the *most similar* past case
  instead of the most recent feedback.
- Multi-tenant: tenant_id on every row, policies to enforce.
