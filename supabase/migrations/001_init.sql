-- ParcelPilot schema
-- Run this in Supabase Studio > SQL Editor (or psql) once.

create extension if not exists "pgcrypto";

-- =========================================================================
-- orders
-- =========================================================================
create table if not exists public.orders (
  id              uuid primary key default gen_random_uuid(),
  order_code      text not null unique,
  customer_name   text not null,
  customer_email  text not null,
  customer_phone  text,
  address         text not null,
  address_notes   text,
  deadline        timestamptz,
  status          text not null default 'in_transit' check (status in (
                    'pending','in_transit','out_for_delivery',
                    'delivered','exception','cancelled','rescheduled'
                  )),
  created_at      timestamptz not null default now()
);

-- =========================================================================
-- riders
-- =========================================================================
create table if not exists public.riders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  status      text not null default 'available' check (status in ('available','busy','off_duty')),
  capacity    int  not null default 10,
  created_at  timestamptz not null default now()
);

-- =========================================================================
-- incidents
-- =========================================================================
create table if not exists public.incidents (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid references public.orders(id) on delete set null,
  rider_id       uuid references public.riders(id) on delete set null,
  input_type     text not null check (input_type in ('text','voice_transcript','image')),
  raw_input      text,
  image_url      text,
  type           text,
  description    text,
  status         text not null default 'received' check (status in (
                   'received','analyzing','awaiting_customer','response_received',
                   'ready_for_recovery','recovery_pending','resolved','escalated','failed'
                 )),
  attempt_count  int not null default 0,
  analysis       jsonb,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

create index if not exists idx_incidents_status on public.incidents(status);
create index if not exists idx_incidents_order_id on public.incidents(order_id);

-- =========================================================================
-- action_logs (audit trail)
-- =========================================================================
create table if not exists public.action_logs (
  id           uuid primary key default gen_random_uuid(),
  incident_id  uuid not null references public.incidents(id) on delete cascade,
  action       text not null,
  status       text not null check (status in ('started','success','failed','retrying')),
  result       jsonb,
  message      text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_action_logs_incident on public.action_logs(incident_id, created_at desc);

-- =========================================================================
-- notifications (outbound emails)
-- =========================================================================
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  incident_id  uuid not null references public.incidents(id) on delete cascade,
  channel      text not null default 'email',
  recipient    text not null,
  subject      text,
  body         text,
  email_id     text,                             -- resend message id
  status       text not null default 'queued' check (status in ('queued','sent','bounced','failed','opened')),
  error        text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists idx_notifications_incident on public.notifications(incident_id);

-- =========================================================================
-- customer_responses (form submissions)
-- =========================================================================
create table if not exists public.customer_responses (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references public.incidents(id) on delete cascade,
  token_hash    text not null unique,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  submitted_at  timestamptz,
  response_data jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_customer_responses_incident on public.customer_responses(incident_id);
create index if not exists idx_customer_responses_token on public.customer_responses(token_hash);

-- =========================================================================
-- updated_at trigger for incidents
-- =========================================================================
create or replace function public.touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_incidents_updated_at on public.incidents;
create trigger trg_incidents_updated_at
  before update on public.incidents
  for each row execute function public.touch_updated_at();

-- =========================================================================
-- RLS: locked down. All access goes through the service_role on the server.
-- =========================================================================
alter table public.orders              enable row level security;
alter table public.riders              enable row level security;
alter table public.incidents           enable row level security;
alter table public.action_logs         enable row level security;
alter table public.notifications       enable row level security;
alter table public.customer_responses  enable row level security;

-- No public policies: service_role bypasses RLS. Public access is denied by default.

-- =========================================================================
-- Seed fixtures (edit the customer_email on the first row to a real inbox you own)
-- =========================================================================
insert into public.riders (name, phone, status, capacity) values
  ('Arjun Kumar',  '+91 98765 10001', 'available', 15),
  ('Priya Shah',   '+91 98765 10002', 'busy',      12),
  ('Rohan Mehta',  '+91 98765 10003', 'available', 10)
on conflict do nothing;

insert into public.orders (order_code, customer_name, customer_email, customer_phone, address, address_notes, deadline, status) values
  ('PP-1001', 'Caanush Gandhi', 'gandhimouriyan1234@gmail.com', '+91 90000 11111',
   'Flat 3B, Lotus Residency, near the park, Bengaluru 560001', null,
   now() + interval '4 hours', 'out_for_delivery'),
  ('PP-1002', 'Meera Nair', 'meera.test@example.com', '+91 90000 22222',
   '12 MG Road, Indiranagar, Bengaluru', 'Ring the bell twice',
   now() + interval '6 hours', 'in_transit'),
  ('PP-1003', 'Rahul Verma', 'rahul.test@example.com', '+91 90000 33333',
   'House 42, Street 7, HSR Layout, Bengaluru', null,
   now() + interval '2 hours', 'out_for_delivery')
on conflict (order_code) do nothing;
