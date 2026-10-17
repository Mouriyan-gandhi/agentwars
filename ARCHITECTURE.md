# ParcelPilot — Architecture

> One autonomous agent, three portals, zero stuck deliveries. ParcelPilot takes a
> delivery exception from the moment it is reported through to a verified resolution,
> acting on real external services the whole way (Supabase, Resend, Gemini).

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
│  /api/uploads    /api/admin/*     /api/incidents/[id]/feedback │
└──────────────────┬───────────────────┬────────────┘
                   │                   │
                   ▼                   ▼
         ┌──────────────────┐  ┌──────────────────┐
         │   workflow.ts    │  │   gemini.ts      │
         │ state machine    │──▶ multimodal LLM   │
         │ (received →      │  │ (text + image +  │
         │  analyzing →     │◀─│  audio + feedback│
         │  awaiting_cust → │  │  few-shots)      │
         │  resolved …)     │  └──────────────────┘
         └────┬──────┬──────┘
              │      │
     ┌────────▼─┐  ┌─▼──────────┐  ┌──────────┐
     │ Supabase │  │  Resend    │  │ Supabase │
     │ Postgres │  │  (email)   │  │ Storage  │
     │  + RLS   │  └────────────┘  │(audio+img)│
     └──────────┘                  └──────────┘
```

Every arrow in that diagram is a real HTTP call, not a mock. The agent only reaches
a terminal state (`resolved` / `escalated` / `failed`) when the underlying external
operation actually succeeded.

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

## 4. Gemini pipeline — multimodal + self-improving

`lib/gemini.ts` exposes a single `analyzeIncident({ parts, source, issueCategory,
orderCode, feedbackExamples })`.

- **parts[]** is an ordered mix of `text`, `image`, and `audio` chunks. Gemini
  3.8-flash accepts audio inline (base64 WebM/MP3/WAV) and transcribes +
  classifies in one call — no separate STT service.
- **source** (`rider_report` vs `customer_complaint`) is injected into the user
  message as `SOURCE: ...` so the agent's playbook branches correctly.
- **issueCategory** is the user-picked chip (`access_blocked`, `arrived_damaged`,
  …). Gemini is told to treat it as a strong hint but override on contradictory
  evidence.
- **feedbackExamples** come from `fetchRecentFeedback(5)` — the 5 most recent
  admin `wrong_call` rows that have a `suggested_action`. These are formatted as:

  ```
  FEEDBACK FROM OPS REVIEWS (apply these corrections to new, similar incidents):
    1. Incident: <description>
       You chose: <old action>
       Correct call: <admin's suggestion>
       Reviewer note: <admin's comment>
  ```

  …and appended to the base system prompt before each generation. This is why the
  agent flips from `offer_refund_or_reship` to `verify_with_rider` after a single
  admin correction.

Response schema is enforced via `generationConfig.responseMimeType =
"application/json"` plus a defensive parser (`parseDecision`) that whitelists
every enum value.

---

## 5. Data model

Six operational tables + three auth / supporting tables. All RLS-enabled — every
server call goes through the service_role on the backend.

| Table | Purpose | Key columns |
|---|---|---|
| `orders` | Deliveries in flight | `order_code`, `customer_email`, `address`, `rider_id`, `status` |
| `riders` | Fleet | `name`, `status (available/busy/off_duty)`, `capacity` |
| `users` | Login accounts (admin + rider) | `email`, `password`, `role`, `rider_id` |
| `incidents` | The agent's work queue | `source`, `issue_category`, `input_type`, `raw_input`, `image_url`, `audio_url`, `analysis (jsonb)`, `status`, `attempt_count` |
| `action_logs` | Every state transition | `incident_id`, `action`, `status`, `result (jsonb)`, `message` |
| `notifications` | Outbound emails | `email_id` (Resend id), `status (queued/sent/failed/bounced)`, `error` |
| `customer_responses` | Signed clarification-form submissions | `token_hash`, `expires_at`, `submitted_at`, `response_data (jsonb)` |
| `decision_feedback` | Admin corrections → feeds back into Gemini | `verdict`, `suggested_action`, `comment` |

Three migrations apply this schema in order (`supabase/migrations/00{1,2,3}_*.sql`),
each with `if not exists` guards so re-runs are safe.

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
| LLM | Gemini 3.8-flash | Free tier, native multimodal (text + image + audio), structured JSON output |
| Email | Resend | Simple API, generous free tier, works without a verified domain against the account owner's inbox |
| Styling | Tailwind v4 + custom Caldera tokens | Design system = token file + a few helper classes |
| Session | HMAC-signed cookie (crypto, no library) | ~50 lines, zero infra |
| State machine | Plain TypeScript | Easier to reason about than a framework; see §3 above |

---

## 9. Where to look in the source

```
app/
  page.tsx                       Landing: three-portal picker
  customer/page.tsx              Customer lookup + complaint flow
  customer-form/[token]/         Clarification form (email token)
  rider/                         Rider portal (layout, dashboard, incident view)
  admin/                         Admin portal (layout, dashboard, incident + feedback)
  login/                         Rider + admin login forms
  api/                           All route handlers
  components/IssueReporter.tsx   Shared structured incident intake (used by rider + customer)

lib/
  workflow.ts                    State machine (the agent)
  gemini.ts                      Multimodal + feedback-aware LLM call
  resend.ts                      Email send + template
  storage.ts                     Supabase Storage helper
  session.ts                     HMAC cookie session
  token.ts                       Customer form token mint + verify
  supabase.ts                    Admin + browser clients
  types.ts                       Shared types

supabase/migrations/
  001_init.sql                   Core tables + seed
  002_portals.sql                users + rider_id on orders + rider assignments
  003_feedback_and_sources.sql   source/category/audio_url + decision_feedback
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
