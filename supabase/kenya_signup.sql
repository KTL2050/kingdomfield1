-- KTLSALES: Kenya team + self sign-up with admin approval.
-- Run once in the Supabase SQL Editor, then push the matching code straight away
-- (the code expects the per-country "Everyone" chat and Star of the Day below).
-- Safe to run again.

-- 1. Users: country + approval status. Everyone who exists today = Uganda, approved.
alter table public.users add column if not exists country text not null default 'UG';
alter table public.users add column if not exists status  text not null default 'approved';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_country_check') then
    alter table public.users add constraint users_country_check check (country in ('UG', 'KE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_status_check') then
    alter table public.users add constraint users_status_check check (status in ('pending', 'approved', 'rejected'));
  end if;
end $$;
create index if not exists users_country_idx on public.users (country);

-- 2. Star of the Day: one winner per month PER COUNTRY (was one per month).
alter table public.eotm_monthly_results add column if not exists country text not null default 'UG';
do $$ declare c text; begin
  -- drop the old one-row-per-month rule, whether it's a constraint or a plain unique index
  for c in select conname from pg_constraint
           where conrelid = 'public.eotm_monthly_results'::regclass and contype in ('u', 'p')
             and pg_get_constraintdef(oid) ~* '^(unique|primary key) \(month_key\)$'
  loop execute format('alter table public.eotm_monthly_results drop constraint %I', c); end loop;
  for c in select indexname from pg_indexes
           where schemaname = 'public' and tablename = 'eotm_monthly_results'
             and indexdef ~* 'unique index .* \(month_key\)$'
  loop execute format('drop index public.%I', c); end loop;
end $$;
create unique index if not exists eotm_results_month_country on public.eotm_monthly_results (month_key, country);

-- 3. Chat: "Everyone" becomes per country; the existing group messages are Uganda's.
update public.chat_messages set conversation = 'all:UG' where conversation = 'all';
update public.chat_reads    set conversation = 'all:UG' where conversation = 'all';

notify pgrst, 'reload schema';
