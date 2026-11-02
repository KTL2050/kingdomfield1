-- KTLSALES: read-only door for the Daily Plan Check agent.
-- agent_daily_plan_data(key, date) returns one day (East Africa Time) of
-- Uganda reps, their clock-ins, field visits and approved leave, plus each
-- store's usual position worked out from the last 90 days of punch-ins.
-- Only the fields the agent uses leave the database: no passwords or
-- photos. The caller proves itself with a key; only its SHA-256 hash is
-- stored here. The function is stable, so Postgres refuses any write
-- inside it. Revoke the agent by deleting its row in agent_keys.
-- Run once in the Supabase SQL Editor. Safe to run again.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.agent_keys (
  name       text primary key,
  key_hash   text not null unique,  -- hex SHA-256 of the key
  created_at timestamptz not null default now()
);
alter table public.agent_keys enable row level security;
-- No policies: nobody reads or writes this table through the API.
revoke all on public.agent_keys from anon, authenticated;

create or replace function public.agent_daily_plan_data(p_key text, p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from timestamptz := p_date::timestamp at time zone 'Africa/Kampala';
  v_to   timestamptz := (p_date + 1)::timestamp at time zone 'Africa/Kampala';
  v_reps text[];
begin
  if p_key is null or p_date is null or not exists (
    select 1 from agent_keys
    where name = 'daily-plan-check'
      and key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')
  ) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select coalesce(array_agg(u.id::text), '{}') into v_reps
  from users u
  where u.country = 'UG' and u.is_active = true;

  -- Columns are picked by name from each row rather than selected
  -- directly, so a column the live table lacks is left out instead of
  -- breaking the function, and new columns never leak in.
  return jsonb_build_object(
    'date', p_date,
    'timezone', 'Africa/Kampala',
    'generated_at', now(),
    'users', coalesce((
      select jsonb_agg((
        select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(u)) e
        where e.key = any (array['id', 'full_name', 'email', 'role', 'status', 'country'])
      ) order by u.full_name)
      from users u
      where u.id::text = any (v_reps)
    ), '[]'::jsonb),
    'attendance', coalesce((
      select jsonb_agg((
        select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(a)) e
        where e.key = any (array[
          'employee_id', 'clock_in', 'clock_in_lat', 'clock_in_lng', 'clock_in_location',
          'clock_out', 'clock_out_lat', 'clock_out_lng', 'clock_out_location'
        ])
      ) order by a.clock_in)
      from attendance a
      where a.employee_id::text = any (v_reps)
        and a.clock_in::timestamptz >= v_from and a.clock_in::timestamptz < v_to
    ), '[]'::jsonb),
    'visits', coalesce((
      select jsonb_agg((
        select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(v)) e
        where e.key = any (array[
          'id', 'employee_id', 'contact_name', 'type', 'notes', 'status',
          'punch_in_time', 'punch_in_lat', 'punch_in_lng', 'punch_in_location',
          'punch_out_time', 'punch_out_lat', 'punch_out_lng', 'punch_out_location',
          'is_cover', 'cover_for', 'client_id'
        ])
      ) order by v.punch_in_time)
      from field_visits v
      where v.employee_id::text = any (v_reps)
        and v.punch_in_time::timestamptz >= v_from and v.punch_in_time::timestamptz < v_to
    ), '[]'::jsonb),
    'leave', coalesce((
      select jsonb_agg(jsonb_build_object(
        'employee_id', l.employee_id, 'leave_type_name', l.leave_type_name,
        'start_date', l.start_date, 'end_date', l.end_date
      ) order by l.start_date)
      from leave_requests l
      where l.employee_id::text = any (v_reps)
        and l.status = 'approved'
        and l.start_date <= p_date and l.end_date >= p_date
    ), '[]'::jsonb),
    -- A store's usual position: the median of its punch-ins over 90 days.
    'store_positions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'store', s.store, 'lat', s.lat, 'lng', s.lng, 'punch_ins', s.n
      ) order by s.store)
      from (
        select v.contact_name as store,
               percentile_cont(0.5) within group (order by v.punch_in_lat::float8) as lat,
               percentile_cont(0.5) within group (order by v.punch_in_lng::float8) as lng,
               count(*) as n
        from field_visits v
        where v.contact_name is not null and v.punch_in_lat is not null
          and v.punch_in_time::timestamptz >= v_to - interval '90 days'
          and v.punch_in_time::timestamptz < v_to
        group by v.contact_name
      ) s
    ), '[]'::jsonb)
  );
end;
$$;

-- Supabase grants new functions to anon and authenticated by default;
-- take that back, then let only the anon key call it (the key check
-- above is the real gate).
revoke all on function public.agent_daily_plan_data(text, date) from public, anon, authenticated;
grant execute on function public.agent_daily_plan_data(text, date) to anon;

notify pgrst, 'reload schema';
