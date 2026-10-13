-- UBL ranked listing tables. These replace T250 / SLOBS / NEW ITEMS for listing.
-- Nothing is deleted: the old tables stay as they are.
-- Run once in the Supabase SQL Editor, BEFORE deploying the matching index.html.
create table if not exists public.ubl_t100 (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  item_name text,
  rank integer,
  created_at timestamptz not null default now()
);
create table if not exists public.ubl_t101_500 (like public.ubl_t100 including all);
create table if not exists public.ubl_t501_plus (like public.ubl_t100 including all);

-- Points each listed item will earn (0/1/3), fixed when it's listed.
-- Old listings stay NULL and count as 1 point.
alter table public.order_items add column if not exists points integer;

-- Swaps a whole list in one step: if anything fails, the old list is kept as it was.
create or replace function public.replace_ranked_list(p_table text, p_rows jsonb)
returns integer language plpgsql as $$
declare n integer;
begin
  if p_table not in ('ubl_t100','ubl_t101_500','ubl_t501_plus') then
    raise exception 'Not a ranked list table: %', p_table;
  end if;
  execute format('delete from public.%I', p_table);
  execute format('insert into public.%I (sku, item_name, rank)
                  select r->>''sku'', nullif(r->>''item_name'',''''), (r->>''rank'')::int
                  from jsonb_array_elements($1) r', p_table) using p_rows;
  get diagnostics n = row_count;
  return n;
end $$;

notify pgrst, 'reload schema';

-- Replaces all three UBL lists from one ranked file, in one step.
-- Rank decides the list: 1–100 → T100, 101–500 → T101–500, 501+ → T501+.
-- If anything fails, all three lists stay as they were.
create or replace function public.replace_all_ranked_lists(p_rows jsonb)
returns jsonb language plpgsql as $$
declare a integer; b integer; c integer;
begin
  delete from public.ubl_t100      where true;
  delete from public.ubl_t101_500  where true;
  delete from public.ubl_t501_plus where true;
  insert into public.ubl_t100 (sku, item_name, rank)
    select r->>'sku', nullif(r->>'item_name',''), (r->>'rank')::int
    from jsonb_array_elements(p_rows) r where (r->>'rank')::int between 1 and 100;
  get diagnostics a = row_count;
  insert into public.ubl_t101_500 (sku, item_name, rank)
    select r->>'sku', nullif(r->>'item_name',''), (r->>'rank')::int
    from jsonb_array_elements(p_rows) r where (r->>'rank')::int between 101 and 500;
  get diagnostics b = row_count;
  insert into public.ubl_t501_plus (sku, item_name, rank)
    select r->>'sku', nullif(r->>'item_name',''), (r->>'rank')::int
    from jsonb_array_elements(p_rows) r where (r->>'rank')::int >= 501;
  get diagnostics c = row_count;
  return jsonb_build_object('ubl_t100', a, 'ubl_t101_500', b, 'ubl_t501_plus', c);
end $$;

notify pgrst, 'reload schema';
