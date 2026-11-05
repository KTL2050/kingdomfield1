-- Star of the Day: the core value(s) the voter says the person showed that day.
-- Older votes stay NULL. Safe to run again.
alter table public.eotm_votes add column if not exists core_values text[];
notify pgrst, 'reload schema';
