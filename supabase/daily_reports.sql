-- KTLSALES: Daily Activity Reports.
-- A rep submits one report per day (a snapshot of that day's completed field
-- visits + totals + end-of-day remarks); the country's reviewer reads them.
-- Run once in the Supabase SQL Editor BEFORE deploying ktl-daily-report.js. Safe to run again.

create table if not exists public.daily_reports (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null,
  employee_name text,
  country       text not null default 'UG',
  report_date   date not null,
  visits        jsonb not null default '[]'::jsonb,   -- store, type, reason, outcome, issues, times, minutes
  totals        jsonb not null default '{}'::jsonb,   -- visits, minutes, by_type
  remarks       text not null,
  reviewer_id   uuid,                                 -- who it was sent to
  submitted_at  timestamptz not null default now(),
  is_update     boolean not null default false,       -- re-sent after more visits that day
  seen_at       timestamptz,                          -- when the reviewer opened it
  unique (employee_id, report_date)
);
create index if not exists daily_reports_country_date on public.daily_reports (country, report_date);
create index if not exists daily_reports_reviewer_seen on public.daily_reports (reviewer_id, seen_at);

-- Who reviews each country's reports (changeable in User Management).
create table if not exists public.report_reviewers (
  country     text primary key check (country in ('UG', 'KE')),
  reviewer_id uuid not null,
  updated_at  timestamptz not null default now()
);

-- Uganda → Raymond Mpamizo (only if no reviewer is set yet)
insert into public.report_reviewers (country, reviewer_id)
select 'UG', id from public.users
where full_name ilike 'Raymond Mpamizo' and is_active = true
limit 1
on conflict (country) do nothing;

notify pgrst, 'reload schema';
