-- ParcelPilot migration 005
-- Multi-agent trace + evaluation storage.
--
-- The incident analysis now runs through a Google ADK multi-agent pipeline
-- (PII Guardian → Classifier → Planner → Evaluator → Executor) communicating
-- over A2A. Each agent step is recorded in `agent_trace`; the Evaluator's
-- scores land in `agent_evaluations`. The PII map that lets Next.js re-attach
-- real identifiers at the email boundary lives on the incident itself.

-- =========================================================================
-- incidents: masked text + pii map held by the orchestrator
-- =========================================================================
alter table public.incidents
  add column if not exists masked_input text,                -- raw_input with PII tokens
  add column if not exists pii_map jsonb,                    -- { "<<NAME_1>>": "Caanush Gandhi", ... }
  add column if not exists notify_email text,                -- extra email the reporter asked us to CC
  add column if not exists eval_score numeric,               -- overall score 0..1
  add column if not exists eval_hallucination numeric,       -- 0..1 (higher = more hallucinated)
  add column if not exists eval_truthfulness numeric,        -- 0..1
  add column if not exists eval_grounded numeric,            -- 0..1
  add column if not exists heal_attempts int not null default 0,
  add column if not exists total_tokens_in int not null default 0,
  add column if not exists total_tokens_out int not null default 0,
  add column if not exists total_cost_usd numeric not null default 0,
  add column if not exists total_latency_ms int not null default 0,
  add column if not exists pii_leak_detected boolean not null default false;

-- =========================================================================
-- agent_trace: one row per agent step. Think of it as A2A call history.
-- =========================================================================
create table if not exists public.agent_trace (
  id             uuid primary key default gen_random_uuid(),
  incident_id    uuid not null references public.incidents(id) on delete cascade,
  step_index     int  not null,                              -- 0,1,2,… in orchestrator order
  agent_name     text not null,                              -- "pii_guardian", "classifier", …
  protocol       text not null default 'a2a',                -- 'a2a' | 'mcp' | 'direct'
  input          jsonb,                                      -- what this agent received
  output         jsonb,                                      -- what it returned
  model          text,                                       -- e.g. 'gemini-2.0-flash'
  latency_ms     int,
  status         text not null check (status in ('ok','error')),
  error          text,
  created_at     timestamptz not null default now()
);

create index if not exists idx_agent_trace_incident on public.agent_trace(incident_id, step_index);

alter table public.agent_trace enable row level security;

-- =========================================================================
-- agent_evaluations: scored per planner output. Lets admin see truthfulness
-- + hallucination without re-running the eval.
-- =========================================================================
create table if not exists public.agent_evaluations (
  id              uuid primary key default gen_random_uuid(),
  incident_id     uuid not null references public.incidents(id) on delete cascade,
  attempt         int  not null default 1,
  truthfulness    numeric,
  hallucination   numeric,
  grounded        numeric,
  overall         numeric,
  verdict         text check (verdict in ('pass','retry','escalate')),
  reasoning       text,
  evaluator_model text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_agent_evaluations_incident on public.agent_evaluations(incident_id, attempt);

alter table public.agent_evaluations enable row level security;
