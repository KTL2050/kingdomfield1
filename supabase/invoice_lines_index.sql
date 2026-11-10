-- Speeds up the Wallet points check / Top Sales Reps: purchases looked up by store AND date,
-- sorted by date. The existing single-column indexes can't do both at once. Safe to run again.
create index if not exists idx_invoice_line_items_customer_date
  on public.invoice_line_items (customer_id, line_date);
