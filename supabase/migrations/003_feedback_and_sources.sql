-- ParcelPilot migration 003
-- Adds source classification, structured category, audio uploads, and the
-- admin feedback loop that drives agent self-improvement.

-- =========================================================================
-- incidents: where the report came from + user-picked category + audio file
-- =========================================================================
alter table public.incidents
  add column if not exists source text not null default 'rider_report'
    check (source in ('rider_report','customer_complaint')),
  add column if not exists issue_category text,          -- user-selected chip
  add column if not exists audio_url text;               -- when voice input is used

create index if not exists idx_incidents_source on public.incidents(source);

-- =========================================================================
-- Allow audio as an input_type (voice_transcript stays for pasted text).
-- =========================================================================
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'incidents'
      and constraint_name = 'incidents_input_type_check'
  ) then
    alter table public.incidents drop constraint incidents_input_type_check;
  end if;
end$$;

alter table public.incidents
  add constraint incidents_input_type_check
    check (input_type in ('text','voice_transcript','audio','image'));

-- =========================================================================
-- decision_feedback: admin corrections to agent decisions
-- =========================================================================
create table if not exists public.decision_feedback (
  id             uuid primary key default gen_random_uuid(),
  incident_id    uuid not null references public.incidents(id) on delete cascade,
  verdict        text not null check (verdict in ('right_call','wrong_call')),
  suggested_action text,     -- when wrong_call: what should it have done?
  comment        text,       -- freeform note from admin
  reviewer_user_id uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists idx_feedback_created on public.decision_feedback(created_at desc);
create index if not exists idx_feedback_incident on public.decision_feedback(incident_id);

alter table public.decision_feedback enable row level security;

-- =========================================================================
-- Allow the customer complaint flow to proceed without an auth user.
-- We also need a "customer_complaint" row with no reported_by_user_id,
-- which the schema already allows (it is nullable).
-- =========================================================================
