-- ParcelPilot portals migration
-- Adds users (admin + rider logins), rider assignment on orders,
-- and the user who filed each incident.

-- =========================================================================
-- users (demo logins — admin + riders)
-- =========================================================================
create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  password    text not null,                       -- demo-only; plain text ok for hackathon
  role        text not null check (role in ('admin','rider')),
  display_name text not null,
  rider_id    uuid references public.riders(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_users_email on public.users(email);

alter table public.users enable row level security;

-- =========================================================================
-- orders: assigned rider
-- =========================================================================
alter table public.orders
  add column if not exists rider_id uuid references public.riders(id) on delete set null;

create index if not exists idx_orders_rider on public.orders(rider_id);

-- =========================================================================
-- incidents: who filed this (nullable so legacy rows survive)
-- =========================================================================
alter table public.incidents
  add column if not exists reported_by_user_id uuid references public.users(id) on delete set null;

-- =========================================================================
-- Seed accounts.
-- Admin + three riders. Rider accounts link to the already-seeded rider rows.
-- Passwords are DEMO ONLY. Do not reuse this scheme in production.
-- =========================================================================
insert into public.users (email, password, role, display_name, rider_id)
select 'admin@parcelpilot.dev', 'admin123', 'admin', 'Ops Admin', null
where not exists (select 1 from public.users where email = 'admin@parcelpilot.dev');

insert into public.users (email, password, role, display_name, rider_id)
select 'arjun@parcelpilot.dev', 'rider123', 'rider', 'Arjun Kumar', r.id
from public.riders r
where r.name = 'Arjun Kumar'
  and not exists (select 1 from public.users where email = 'arjun@parcelpilot.dev');

insert into public.users (email, password, role, display_name, rider_id)
select 'priya@parcelpilot.dev', 'rider123', 'rider', 'Priya Shah', r.id
from public.riders r
where r.name = 'Priya Shah'
  and not exists (select 1 from public.users where email = 'priya@parcelpilot.dev');

insert into public.users (email, password, role, display_name, rider_id)
select 'rohan@parcelpilot.dev', 'rider123', 'rider', 'Rohan Mehta', r.id
from public.riders r
where r.name = 'Rohan Mehta'
  and not exists (select 1 from public.users where email = 'rohan@parcelpilot.dev');

-- Make Priya available (she was seeded as 'busy' originally).
update public.riders set status = 'available' where name = 'Priya Shah';

-- =========================================================================
-- Assign the seeded orders to riders so the rider portal has something to show.
-- =========================================================================
update public.orders o
   set rider_id = r.id
  from public.riders r
 where o.order_code = 'PP-1001' and r.name = 'Arjun Kumar'
   and o.rider_id is null;

update public.orders o
   set rider_id = r.id
  from public.riders r
 where o.order_code = 'PP-1002' and r.name = 'Priya Shah'
   and o.rider_id is null;

update public.orders o
   set rider_id = r.id
  from public.riders r
 where o.order_code = 'PP-1003' and r.name = 'Rohan Mehta'
   and o.rider_id is null;
