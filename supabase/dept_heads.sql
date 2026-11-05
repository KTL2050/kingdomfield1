-- KTLSALES: Heads of department. Only the head sets and updates their department's KPIs.
-- One head per department, chosen by admins in User Management. Safe to run again.
create table if not exists public.dept_heads (
  country    text not null default 'UG',
  department text not null,
  head_id    uuid not null,
  updated_at timestamptz not null default now(),
  primary key (country, department)
);
notify pgrst, 'reload schema';
