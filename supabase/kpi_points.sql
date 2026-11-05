-- KTLSALES: Department KPIs → Employee of the Month points.
-- A KPI with a target can be "lower is better" (e.g. downtime, delays): achieved when
-- the figure is at or below the target. Run once in the Supabase SQL Editor. Safe to run again.
alter table public.dept_kpis add column if not exists lower_is_better boolean not null default false;
notify pgrst, 'reload schema';
