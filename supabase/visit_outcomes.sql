-- Amount collected on "Collecting Payment" field visits (UGX or KES).
-- Run once in the Supabase SQL Editor before deploying the matching index.html.
-- Safe to run again; visits already logged simply have these columns empty.
alter table public.field_visits add column if not exists amount_collected numeric;
alter table public.field_visits add column if not exists amount_currency  text;
notify pgrst, 'reload schema';
