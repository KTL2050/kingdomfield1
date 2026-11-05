-- KTLSALES: Department KPIs (Uganda first).
-- Each manager sets their own department's KPIs for a month and posts dated progress
-- updates; staff in that department can comment. Admins view only.
-- Run once in the Supabase SQL Editor BEFORE deploying ktl-kpis.js. Safe to run again.

-- Which department each person is in (set by admins in User Management)
alter table public.users add column if not exists department text;

create table if not exists public.dept_kpis (
  id          uuid primary key default gen_random_uuid(),
  country     text not null default 'UG',
  month_key   text not null,                 -- e.g. '2026-11'
  department  text not null,                 -- IT | Finance | Store & Delivery | Sales | Marketing
  statement   text not null,                 -- the KPI in words
  target      numeric,                       -- optional figure, e.g. 120000000
  unit        text,                          -- optional, e.g. 'UGX', 'leads', '%'
  sort_order  integer not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists dept_kpis_month on public.dept_kpis (country, month_key, department);

-- Dated progress on a KPI: manager status updates and staff comments
create table if not exists public.dept_kpi_updates (
  id          uuid primary key default gen_random_uuid(),
  kpi_id      uuid not null references public.dept_kpis(id) on delete cascade,
  author_id   uuid,
  author_name text,
  kind        text not null check (kind in ('update', 'comment')),
  status      text check (status in ('on_track', 'at_risk', 'achieved', 'partly', 'not_achieved')),
  actual      numeric,                       -- figure so far (updates on KPIs with a target)
  note        text,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz
);
create index if not exists dept_kpi_updates_kpi on public.dept_kpi_updates (kpi_id, created_at);

notify pgrst, 'reload schema';
