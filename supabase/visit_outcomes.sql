-- Issues seen at the store (in-store field visits).
-- Run once in the Supabase SQL Editor before deploying the matching index.html.
-- Safe to run again; visits already logged simply have these columns empty.
-- (issues = chip list from an earlier version, now unused; issues_note = the free-text box)
alter table public.field_visits add column if not exists issues      text[];
alter table public.field_visits add column if not exists issues_note text;
notify pgrst, 'reload schema';
