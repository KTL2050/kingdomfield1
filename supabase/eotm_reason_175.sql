-- Star of the Day: the reason can now be up to 175 characters (was 75).
-- Replaces the old database rule eotm_reason_max_75. Safe to run again.
alter table public.eotm_votes drop constraint if exists eotm_reason_max_75;
alter table public.eotm_votes drop constraint if exists eotm_reason_max_175;
alter table public.eotm_votes add constraint eotm_reason_max_175 check (char_length(reason) <= 175);
notify pgrst, 'reload schema';
