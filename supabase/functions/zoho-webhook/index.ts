import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL         = "https://bccqhwsbhgssoapiqljy.supabase.co";
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjY3Fod3NiaGdzc29hcGlxbGp5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDI0MzczNCwiZXhwIjoyMDg5ODE5NzM0fQ.jQS-HoxiIRhBeahU5FKXPoyys80tOZ-lHudlSXLncbA";
const ZOHO_REFRESH         = "1000.87b58b1cd67b63c1b05f66a9239a89e5.19d64c5f2c595fe543843b447921d9b0";
const ZOHO_CLIENT_ID       = "1000.65SD8Z9GEKQ2SW2ER5K225O14O9J9V";
const ZOHO_CLIENT_SECRET   = "99ad226b3328bc42c7907f7dd2030d65724194c097";
const ZOHO_ORG_ID          = "780891784";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BRAND_TABLE_MAP: Record<string, string[]> = {
  UBL:   ["t250", "slobs", "new_items"],
  AWIBI: ["awibi_awina"],
  AWINA: ["awibi_awina"],
};

async function getZohoToken(): Promise<string> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`https://accounts.zoho.com/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          refresh_token: ZOHO_REFRESH,
          client_id: ZOHO_CLIENT_ID,
          client_secret: ZOHO_CLIENT_SECRET,
          grant_type: "refresh_token"
        })
      });
      const data = await res.json();
      if (data.access_token) return data.access_token;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    } catch (e) { console.error("Token error:", e); }
  }
  throw new Error("Could not get Zoho token");
}

async function zohoFetch(url: string, token: string): Promise<{ data: any; newToken: string }> {
  let currentToken = token;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${currentToken}` } });
      const data = await res.json();
      if (data.code === 57 || data.code === 14 || res.status === 401) {
        currentToken = await getZohoToken();
        continue;
      }
      if (res.status === 429) { await new Promise(r => setTimeout(r, 10000)); continue; }
      return { data, newToken: currentToken };
    } catch (e) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue; }
      throw e;
    }
  }
  throw new Error(`Failed to fetch ${url}`);
}

// ─── SYNC CLIENTS ─────────────────────────────────────────────────────────────
async function syncClients(sb: any, page: number): Promise<{ clients_synced: number; has_more_pages: boolean }> {
  const token = await getZohoToken();
  const url = `https://www.zohoapis.com/inventory/v1/contacts?organization_id=${ZOHO_ORG_ID}&contact_type=customer&page=${page}&per_page=200`;
  const { data } = await zohoFetch(url, token);

  const contacts = data.contacts || [];
  const hasMore  = data.page_context?.has_more_page ?? false;

  if (contacts.length === 0) return { clients_synced: 0, has_more_pages: false };

  const rows = contacts.map((c: any) => ({
    zoho_customer_id:   String(c.contact_id || c.customer_id || ""),
    name:               String(c.contact_name || c.customer_name || ""),
    phone:              c.phone || c.mobile || null,
    email:              c.email || null,
    outstanding_amount: Number(c.outstanding_receivable_amount || 0),
    status:             c.status === "active" ? "active" : "inactive",
    last_synced:        new Date().toISOString(),
  })).filter((r: any) => r.zoho_customer_id && r.name);

  let synced = 0;
  // Upsert in batches of 50
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await sb.from("clients").upsert(batch, { onConflict: "zoho_customer_id" });
    if (!error) synced += batch.length;
    else console.error("Client upsert error:", error.message);
  }

  console.log(`Clients page ${page}: ${synced} synced`);
  return { clients_synced: synced, has_more_pages: hasMore };
}

// ─── SYNC PRODUCTS ────────────────────────────────────────────────────────────
async function syncProducts(sb: any, page: number): Promise<{ products_synced: number; has_more_pages: boolean }> {
  const token = await getZohoToken();
  const url = `https://www.zohoapis.com/inventory/v1/items?organization_id=${ZOHO_ORG_ID}&page=${page}&per_page=200`;
  const { data } = await zohoFetch(url, token);

  const items    = data.items || [];
  const hasMore  = data.page_context?.has_more_page ?? false;

  if (items.length === 0) return { products_synced: 0, has_more_pages: false };

  const rows = items.map((item: any) => ({
    zoho_item_id:      String(item.item_id || ""),
    sku:               String(item.sku || item.item_id || ""),
    name:              String(item.name || ""),
    description:       item.description || null,
    rate:              Number(item.rate || item.selling_price || 0),
    purchase_rate:     Number(item.purchase_rate || item.cost_price || 0),
    stock_on_hand:     Number(item.stock_on_hand || item.available_stock || 0),
    available_stock:   Number(item.available_for_sale_stock || item.stock_on_hand || 0),
    unit:              item.unit || null,
    status:            item.status === "active" ? "active" : "inactive",
    last_synced:       new Date().toISOString(),
  })).filter((r: any) => r.sku && r.name);

  let synced = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    // Try upsert by zoho_item_id first, fall back to sku
    const { error } = await sb.from("products").upsert(batch, { onConflict: "sku" });
    if (!error) synced += batch.length;
    else console.error("Product upsert error:", error.message);
  }

  console.log(`Products page ${page}: ${synced} synced`);
  return { products_synced: synced, has_more_pages: hasMore };
}

// ─── RECONCILE LISTED ITEMS ───────────────────────────────────────────────────
async function reconcileListedItems(sb: any, zohoCustomerId: string, customerName: string, lineItems: any[], invoiceId: string, invoiceNumber: string, invoiceDate: string): Promise<number> {
  if (!lineItems || lineItems.length === 0) return 0;
  let clients: any[] = [];
  if (zohoCustomerId) {
    const { data } = await sb.from("clients").select("id, name, zoho_customer_id").eq("zoho_customer_id", zohoCustomerId).limit(1);
    clients = data || [];
  }
  if (clients.length === 0) {
    const { data } = await sb.from("clients").select("id, name, zoho_customer_id").ilike("name", customerName).limit(1);
    clients = data || [];
  }
  if (clients.length === 0) return 0;
  const client = clients[0];
  const { data: brandRows } = await sb.from("client_brand_assignments").select("brand").eq("client_id", String(client.id));
  if (!brandRows || brandRows.length === 0) return 0;
  const brands: string[] = brandRows.map((r: any) => r.brand);
  const tablesToCheck = new Set<string>();
  brands.forEach((b: string) => (BRAND_TABLE_MAP[b] || []).forEach((t: string) => tablesToCheck.add(t)));
  if (tablesToCheck.size === 0) return 0;
  const skuMap = new Map<string, { item_name: string | null; table_name: string }>();
  for (const tableName of tablesToCheck) {
    const { data: tableRows } = await sb.from(tableName).select("sku, item_name");
    if (tableRows) tableRows.forEach((r: any) => { const key = r.sku.trim().toLowerCase(); if (!skuMap.has(key)) skuMap.set(key, { item_name: r.item_name || null, table_name: tableName }); });
  }
  const toUpsert: any[] = [];
  for (const li of lineItems) {
    const purchasedSku = (li.sku || li.item_code || "").trim().toLowerCase();
    if (!purchasedSku) continue;
    const match = skuMap.get(purchasedSku);
    if (!match) continue;
    toUpsert.push({ client_id: String(client.id), client_name: client.name, zoho_customer_id: zohoCustomerId, sku: (li.sku || li.item_code || "").trim(), item_name: li.name || li.item_name || match.item_name || null, item_id: String(li.item_id || ""), brand_table: match.table_name, invoice_id: invoiceId, invoice_number: invoiceNumber, purchase_date: invoiceDate, unit_price: Number(li.rate || li.unit_price || 0), quantity: Number(li.quantity || 0) });
  }
  if (toUpsert.length === 0) return 0;
  const { error } = await sb.from("listed_items").upsert(toUpsert, { onConflict: "client_id,sku", ignoreDuplicates: false });
  if (error) { console.error("listed_items upsert error:", error.message); return 0; }
  return toUpsert.length;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });

  try {
    const body = await req.json();
    const { sync_type = "invoices", date_from = "2020-01-01", date_to = new Date().toISOString().split("T")[0], customer_id, start_page = 1, page = 1 } = body;

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── CLIENTS sync ──────────────────────────────────────────────────────────
    if (sync_type === "clients") {
      const result = await syncClients(sb, page);
      return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── PRODUCTS sync ─────────────────────────────────────────────────────────
    if (sync_type === "products") {
      const result = await syncProducts(sb, page);
      return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── INVOICES sync (existing logic) ────────────────────────────────────────
    console.log(`📅 Syncing invoices ${date_from} → ${date_to}, page ${start_page}`);
    let token = await getZohoToken();

    let url = `https://www.zohoapis.com/inventory/v1/invoices?organization_id=${ZOHO_ORG_ID}&date_start=${date_from}&date_end=${date_to}&filter_by=Status.All&sort_column=date&sort_order=D&page=${start_page}&per_page=50`;
    if (customer_id) url += `&customer_id=${customer_id}`;

    const { data: listData, newToken: t1 } = await zohoFetch(url, token);
    token = t1;

    if (!listData.invoices || listData.invoices.length === 0) {
      return new Response(JSON.stringify({ ok: true, invoices_processed: 0, line_items_saved: 0, clients_synced: 0, listed_items_confirmed: 0, has_more_pages: false, current_page: start_page, next_start_page: null, is_complete: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const hasMorePages = listData.page_context?.has_more_page ?? false;
    const totalPages   = listData.page_context?.total_pages || start_page;
    const invoices     = listData.invoices;
    let totalSaved = 0, totalSkipped = 0, totalListedConfirmed = 0;
    const errors: string[] = [];
    const processedClients = new Map<string, any>();

    for (const inv of invoices) {
      try {
        const detailUrl = `https://www.zohoapis.com/inventory/v1/invoices/${inv.invoice_id}?organization_id=${ZOHO_ORG_ID}`;
        const { data: detailData, newToken: t2 } = await zohoFetch(detailUrl, token);
        token = t2;
        const detail = detailData.invoice;
        if (!detail) { totalSkipped++; continue; }
        if (detail.customer_id && detail.customer_name) processedClients.set(detail.customer_id, { id: detail.customer_id, name: detail.customer_name, phone: detail.customer_phone || null, outstanding: detail.outstanding_amount || 0 });
        const lineItems = detail.line_items ?? [];
        if (lineItems.length === 0) { totalSkipped++; continue; }
        const rows = lineItems.map((li: any) => ({ id: `${detail.invoice_id}_${li.line_item_id || li.item_id || li.sku || Date.now()}_${Math.random()}`.slice(0, 255), invoice_id: String(detail.invoice_id), invoice_number: String(detail.invoice_number || ""), customer_id: String(detail.customer_id ?? ""), customer_name: String(detail.customer_name ?? ""), item_id: String(li.item_id ?? ""), item_code: String(li.sku ?? li.item_code ?? ""), item_name: String(li.name ?? li.item_name ?? ""), quantity: Number(li.quantity ?? 0), unit_price: Number(li.rate ?? li.unit_price ?? 0), line_total: Number(li.item_total ?? li.line_total ?? 0), line_date: detail.date ?? date_from, last_synced: new Date().toISOString() }));
        const { error: upsertError } = await sb.from("invoice_line_items").upsert(rows, { onConflict: "id", ignoreDuplicates: false });
        if (upsertError) { errors.push(`${detail.invoice_number}: ${upsertError.message}`); totalSkipped++; }
        else { totalSaved += rows.length; totalListedConfirmed += await reconcileListedItems(sb, String(detail.customer_id ?? ""), String(detail.customer_name ?? ""), lineItems, String(detail.invoice_id), String(detail.invoice_number || ""), detail.date ?? date_from); }
        await new Promise(r => setTimeout(r, 200));
      } catch (invErr: any) { errors.push(`Invoice ${inv.invoice_id}: ${invErr.message}`); totalSkipped++; }
    }

    let clientsAdded = 0;
    for (const [clientId, client] of processedClients) {
      const { error } = await sb.from("clients").upsert({ zoho_customer_id: clientId, name: client.name, phone: client.phone, outstanding_amount: client.outstanding, status: "active", last_synced: new Date().toISOString() }, { onConflict: "zoho_customer_id" });
      if (!error) clientsAdded++;
    }

    try { await sb.from("sync_log").insert({ synced_at: new Date().toISOString(), date_from, date_to, page: start_page, invoices: invoices.length, line_items: totalSaved, clients_synced: clientsAdded }); } catch (e) { console.warn("sync_log error:", e); }

    return new Response(JSON.stringify({ ok: true, invoices_processed: invoices.length, line_items_saved: totalSaved, clients_synced: clientsAdded, listed_items_confirmed: totalListedConfirmed, items_skipped: totalSkipped, current_page: start_page, next_start_page: hasMorePages ? start_page + 1 : null, has_more_pages: hasMorePages, total_pages: totalPages, is_complete: !hasMorePages, date_from, date_to, errors: errors.length > 0 ? errors.slice(0, 10) : undefined }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    console.error("Fatal error:", e);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});