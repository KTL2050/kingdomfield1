/* ═══════════════════════════════════════════════════════════════════════════
   KTLSALES — STOCK POSITION MODULE
   Drop-in module. Add ONE line at the bottom of clockin.html, just before
   </body> (after ktl-leave.js / ktl-leave-admin.js, if present):

       <script src="ktl-stock.js"></script>

   It reuses the app's Supabase client (sb), session (currentUser), role
   helpers (isSalesRep/canManage/canAdmin), navigation (buildNav/goTo),
   and CSS classes (card, btn, badge, table, tabs...). Nothing in
   clockin.html needs to change. clockin.html already loads ExcelJS in
   its <head>, which this module reuses for the "Export to Excel" button.

   A rep walks into a store, picks the outlet from the customers assigned
   to them, picks an AIWIBI SKU, counts what is physically there (shelf +
   backstore + damages) and the module computes the stock position:
   sellable units, units sold since the last count, average daily
   offtake, days of cover and a suggested reorder quantity.

   Requires the stock_counts / stock_count_items / stock_audit_access
   tables to already exist in Supabase (same tables the standalone
   stockposition.html used).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

// ─── CONFIG ────────────────────────────────────────────────────────────────
const AIWIBI_TABLES = ['aiwibi_aiwina'];
const DEFAULT_COVER_DAYS = 21;   // what "well stocked" means, in days
const DAMAGE_REASONS = ['Expired', 'Torn packaging', 'Crushed carton', 'Water damage', 'Faded / dusty', 'Other'];
const NAV_ICON = 'M2 5l6-3 6 3v6l-6 3-6-3V5zM2 5l6 3 6-3M8 8v6';

// ─── STATE ─────────────────────────────────────────────────────────────────
let booted        = false;
let accessChecked = false;
let hasAccess      = false;
let stockActive    = false;

let visibleClients = [];
let allProducts     = [];
let skuRows          = [];   // AIWIBI SKUs available at the selected store
let lastCountMap     = {};   // sku -> { sellable, counted_at }
let selectedClient   = null;
let activeSku         = null;
let basket             = {};  // sku -> saved count line
let hideCounted       = false;
let collapsedCats     = {};
let allUsers           = [];
let accessMap          = {}; // user_id -> true
let lastSubmittedLines = []; // snapshot used by Share/Export on the post-submit screen

// ─── SAFE ACCESS TO HOST APP GLOBALS ───────────────────────────────────────
function me()        { try { return currentUser || null; } catch (e) { return null; } }
function DB()        { try { return sb; } catch (e) { return null; } }
function roleRep()   { try { return isSalesRep(); } catch (e) { return me()?.role === 'sales_rep'; } }
function roleAdmin() { try { return canAdmin();   } catch (e) { return me()?.role === 'admin'; } }
function roleMgr()   { try { return canManage();  } catch (e) { return ['admin', 'manager'].includes(me()?.role); } }

// ─── SMALL HELPERS ─────────────────────────────────────────────────────────
const esc     = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const jsq     = s => String(s ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,' ');
const normSku = s => (s || '').replace(/[\u00A0\u200B\u200C\u200D\uFEFF\r\n\t]/g, '').trim().toLowerCase();
const num     = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const int     = v => Math.max(0, Math.round(num(v)));
const dash    = v => (v === null || v === undefined || Number.isNaN(v)) ? '\u2014' : v;
const initials = n => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

function toast(msg, kind) {
  const t = document.getElementById('sp-toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'sp-toast show' + (kind ? ' ' + kind : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = 'sp-toast'; }, 3200);
}

// ─── STYLES (scoped with an sp- prefix so nothing here can collide with the
//     host app or with other drop-in modules) ───────────────────────────────
function injectStyles() {
  if (document.getElementById('sp-styles')) return;
  const css = `
.sp-step-rail{display:flex;align-items:stretch;gap:0;background:var(--bg);border:0.5px solid var(--brd);border-radius:11px;overflow:hidden;margin-bottom:14px;box-shadow:0 1px 5px rgba(0,0,0,0.05);}
.sp-step-node{flex:1;display:flex;align-items:center;gap:10px;padding:13px 16px;position:relative;cursor:pointer;transition:background .15s;min-width:0;}
.sp-step-node:not(:last-child)::after{content:'';position:absolute;right:-1px;top:0;bottom:0;width:1px;background:var(--brd);}
.sp-step-node:hover{background:var(--bg2);}
.sp-step-node.locked{cursor:not-allowed;opacity:.42;}
.sp-step-node.locked:hover{background:transparent;}
.sp-step-node.active{background:var(--royal-light);}
.sp-step-node.active::before{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--royal);}
.sp-step-dot{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700;flex-shrink:0;background:var(--bg2);color:var(--txt3);border:0.5px solid var(--brd2);transition:all .2s;}
.sp-step-node.active .sp-step-dot{background:var(--royal);color:#fff;border-color:var(--royal);box-shadow:0 0 0 4px rgba(26,58,107,.14);}
.sp-step-node.done .sp-step-dot{background:var(--green);color:#fff;border-color:var(--green);}
.sp-step-meta{min-width:0;}
.sp-step-k{font-size:9.5px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:.09em;}
.sp-step-v{font-size:12.5px;font-weight:600;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--txt2);}
.sp-step-node.active .sp-step-v{color:var(--royal);font-weight:700;}
.sp-step-node.done .sp-step-v{color:var(--txt);}

.sp-store-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;}
.sp-store-card{display:flex;align-items:center;gap:11px;padding:13px;border-radius:10px;border:0.5px solid var(--brd);background:var(--bg);cursor:pointer;transition:all .15s;text-align:left;font-family:inherit;width:100%;}
.sp-store-card:hover{border-color:var(--royal-border);background:var(--royal-light);transform:translateY(-1px);box-shadow:0 3px 10px rgba(26,58,107,.09);}
.sp-store-card.sel{border-color:var(--royal);background:var(--royal-light);box-shadow:0 0 0 2px rgba(26,58,107,.14);}
.sp-store-av{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;background:var(--royal-light);color:var(--royal);border:0.5px solid var(--royal-border);}
.sp-store-card.sel .sp-store-av{background:var(--royal);color:#fff;}
.sp-store-nm{font-size:12.5px;font-weight:600;line-height:1.3;}
.sp-store-meta{font-size:10.5px;color:var(--txt3);margin-top:3px;display:flex;align-items:center;gap:5px;flex-wrap:wrap;}

.sp-cat-block{border:0.5px solid var(--brd);border-radius:10px;overflow:hidden;margin-bottom:10px;background:var(--bg);}
.sp-cat-hdr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;background:var(--bg2);border-bottom:0.5px solid var(--brd);cursor:pointer;}
.sp-cat-nm{font-size:11.5px;font-weight:700;letter-spacing:.01em;display:flex;align-items:center;gap:8px;}
.sp-cat-count{font-size:10px;color:var(--txt3);font-weight:600;}
.sp-sku-row{display:flex;align-items:center;gap:11px;padding:9px 14px;border-bottom:0.5px solid var(--brd);cursor:pointer;transition:background .12s;}
.sp-sku-row:last-child{border-bottom:none;}
.sp-sku-row:hover{background:var(--bg2);}
.sp-sku-row:hover .sp-count-btn.quiet{border-color:var(--royal);color:var(--royal);}
.sp-sku-row.counted:hover, .sp-sku-row.pending:hover{background-color:rgba(0,0,0,.015);}
.sp-sku-row.counted{background:transparent;border-left:2px solid #3B6D11;padding-left:12px;}
.sp-sku-row.pending{background:transparent;border-left:2px solid #854F0B;padding-left:12px;}
.sp-sku-row.active{background:var(--royal-light)!important;box-shadow:inset 3px 0 0 var(--royal);}
.sp-sku-size{width:50px;flex-shrink:0;text-align:center;padding:4px 0;border-radius:7px;background:var(--bg2);border:0.5px solid var(--brd);font-size:10.5px;font-weight:700;color:var(--txt2);}
.sp-sku-row.counted .sp-sku-size{background:#EAF3DE;border-color:#C0DD97;color:#3B6D11;}
.sp-sku-row.pending .sp-sku-size{background:#FAEEDA;border-color:#FAC775;color:#854F0B;}
.sp-sku-main{flex:1;min-width:0;}
.sp-sku-nm{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--txt);}
.sp-sku-sub{font-size:10.5px;color:var(--txt3);margin-top:2px;}
.sp-sku-right{display:flex;align-items:center;gap:11px;flex-shrink:0;}
.sp-sku-onhand{text-align:right;}
.sp-sku-onhand-v{font-size:14px;font-weight:700;letter-spacing:-.02em;line-height:1;}
.sp-sku-onhand-l{font-size:9px;color:var(--txt3);text-transform:uppercase;letter-spacing:.07em;margin-top:2px;}
/* Row action — a real button, sharing the row's click, so the row both
   looks and behaves like a single list item. Weight is earned, not uniform:
   most rows are quiet outlines; only "awaiting close" gets solid color,
   because that's the one state that genuinely needs attention before the
   rep leaves the store. */
.sp-count-btn{border-radius:6px;padding:6px 13px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;transition:all .12s;flex-shrink:0;}
.sp-count-btn.quiet{background:var(--bg);border:1px solid var(--brd2);color:var(--txt2);}
.sp-count-btn.quiet:hover{background:var(--royal-light);}
.sp-count-btn.urgent{background:var(--gold);border:1px solid var(--gold);color:#fff;}
.sp-count-btn.urgent:hover{filter:brightness(0.95);}
.sp-count-btn:active{transform:scale(.95);}

/* Step 3 opens as a popup over the whole screen, dimming everything behind
   it, rather than an inline panel the page has to scroll down to. */
#sp-step3-wrap{position:fixed;inset:0;z-index:2000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px;}
#sp-step3-wrap.hidden{display:none!important;}
#sp-step3-wrap .sp-count-panel{width:100%;max-width:560px;max-height:calc(100vh - 40px);overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.35);}

@keyframes sp-pop-in{from{opacity:0;transform:scale(.97) translateY(4px);}to{opacity:1;transform:scale(1) translateY(0);}}
.sp-count-panel{border:0.5px solid var(--royal-border);border-radius:12px;background:var(--bg);overflow:hidden;box-shadow:0 4px 18px rgba(26,58,107,.1);animation:sp-pop-in .15s ease-out;}
@media(prefers-reduced-motion:reduce){.sp-count-panel{animation:none;}}
.sp-count-hd{background:var(--royal);color:#fff;padding:14px 18px 15px;position:relative;}
.sp-ch-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px;}
.sp-ch-eyebrow{font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.62;}
.sp-ch-close{width:30px;height:30px;border-radius:50%;border:none;background:transparent;color:#fff;opacity:.75;font-size:20px;line-height:1;cursor:pointer;flex-shrink:0;font-family:inherit;display:flex;align-items:center;justify-content:center;transition:all .12s;}
.sp-ch-close:hover{background:rgba(255,255,255,.16);opacity:1;}
.sp-count-hd-sku{font-size:14px;font-weight:700;letter-spacing:-.01em;}
.sp-count-hd-sub{font-size:11px;opacity:.68;margin-top:3px;}
/* A faint ruled-paper texture behind the card body — a stock card, not a
   generic form sheet. */
.sp-count-body{padding:16px 18px;background-image:repeating-linear-gradient(to bottom,transparent,transparent 27px,rgba(20,30,50,.035) 27px,rgba(20,30,50,.035) 28px);}
.sp-count-sec{font-size:9.5px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:.1em;margin:18px 0 10px;display:flex;align-items:center;gap:8px;}
.sp-count-sec:first-child{margin-top:0;}
.sp-count-sec::after{content:'';flex:1;height:0.5px;background:var(--brd);}
.sp-num-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;}

/* The ledger line — the signature entry moment. The number sits on a ruled
   baseline, like an amount written into a stock card, instead of inside a
   generic rounded stepper box. It is the single largest, heaviest thing in
   the popup — everything else in the card is quieter than this number. */
.sp-ledger-line{padding:2px 0;}
.sp-ll-label{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px;}
.sp-ll-lbl-text{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3);}
.sp-ll-hint{font-size:10.5px;color:var(--txt3);font-style:italic;}
.sp-ll-row{display:flex;align-items:center;gap:14px;}
.sp-ll-nudge{width:36px;height:36px;border-radius:50%;border:1px solid var(--brd2);background:var(--bg);color:var(--txt2);font-size:17px;line-height:1;cursor:pointer;flex-shrink:0;font-family:inherit;display:flex;align-items:center;justify-content:center;transition:all .12s;}
.sp-ll-nudge:hover{border-color:var(--royal);color:var(--royal);background:var(--royal-light);}
.sp-ll-nudge:active{transform:scale(.9);}
.sp-ll-figure{flex:1;min-width:0;border-bottom:2px solid var(--txt);padding-bottom:7px;}
.sp-ll-inp{width:100%;border:none;background:transparent;font-family:inherit;font-size:42px;font-weight:700;letter-spacing:-.02em;color:var(--txt);text-align:center;padding:0;-moz-appearance:textfield;}
.sp-ll-inp::-webkit-outer-spin-button,.sp-ll-inp::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.sp-ll-inp:focus{outline:none;}
.sp-ll-inp.dmg{color:var(--red);}
.sp-ledger-line.tinted .sp-ll-figure{border-bottom-color:var(--royal);}
.sp-ledger-line.danger .sp-ll-figure{border-bottom-color:var(--red);}

/* A quiet reference line for a value already on record (e.g. opening stock
   while you're closing) — a fact, not another field to fill in. */
.sp-ref-line{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:10px;border-bottom:1px dashed var(--brd2);margin-bottom:2px;}
.sp-ref-lbl{font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--txt3);}
.sp-ref-v{font-size:22px;font-weight:700;margin-top:4px;letter-spacing:-.01em;}

/* One clear primary action; everything else reads as a plain link so it
   never competes with it. */
.sp-cta-row{margin-top:18px;}
.sp-cta-primary{width:100%;padding:12px;font-size:13px;}
.sp-cta-footer{display:flex;align-items:center;justify-content:center;gap:9px;margin-top:11px;flex-wrap:wrap;}
.sp-ghost-link{background:none;border:none;padding:2px;font-family:inherit;font-size:11.5px;font-weight:600;color:var(--royal);cursor:pointer;}
.sp-ghost-link:hover{text-decoration:underline;}
.sp-ghost-link.danger{color:var(--red);}
.sp-cta-sep{color:var(--txt3);font-size:11px;}

.sp-calc-strip{background:#0f2550;border-radius:11px;padding:14px 16px;color:#fff;margin-top:16px;}
.sp-calc-top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-bottom:11px;border-bottom:0.5px solid rgba(255,255,255,.16);}
.sp-calc-hero-l{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.11em;opacity:.6;}
.sp-calc-hero-v{font-size:32px;font-weight:700;letter-spacing:-.035em;line-height:1;margin-top:4px;}
.sp-calc-hero-u{font-size:12px;font-weight:600;opacity:.6;margin-left:5px;letter-spacing:0;}
.sp-pos-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.02em;}
.sp-pos-ok{background:rgba(29,158,117,.22);color:#7ff0c8;box-shadow:inset 0 0 0 .5px rgba(127,240,200,.35);}
.sp-pos-low{background:rgba(239,159,39,.22);color:#ffd18a;box-shadow:inset 0 0 0 .5px rgba(255,209,138,.35);}
.sp-pos-crit{background:rgba(226,75,74,.24);color:#ffb3b2;box-shadow:inset 0 0 0 .5px rgba(255,179,178,.35);}
.sp-pos-over{background:rgba(184,200,232,.22);color:#cfe0ff;box-shadow:inset 0 0 0 .5px rgba(207,224,255,.3);}
.sp-calc-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding-top:11px;}
.sp-calc-cell{min-width:0;}
.sp-calc-l{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;opacity:.55;}
.sp-calc-v{font-size:15px;font-weight:700;letter-spacing:-.02em;margin-top:3px;}
.sp-calc-v small{font-size:10px;font-weight:600;opacity:.6;margin-left:2px;}
.sp-calc-note{font-size:10.5px;opacity:.62;margin-top:10px;line-height:1.5;}

.sp-chip-row{display:flex;flex-wrap:wrap;gap:6px;}
.sp-chip{padding:5px 11px;border-radius:20px;border:0.5px solid var(--brd2);background:var(--bg);font-size:11px;font-weight:500;cursor:pointer;font-family:inherit;color:var(--txt2);transition:all .13s;}
.sp-chip:hover{border-color:var(--royal-border);color:var(--royal);}
.sp-chip.on{background:var(--royal);border-color:var(--royal);color:#fff;font-weight:600;}
.sp-chip.on-dmg{background:#FCEBEB;border-color:#F7C1C1;color:#A32D2D;font-weight:600;}

.sp-basket-bar{position:sticky;bottom:0;z-index:40;background:var(--bg);border:0.5px solid var(--brd);border-radius:12px;padding:11px 15px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;box-shadow:0 -2px 16px rgba(26,58,107,.1),0 1px 4px rgba(0,0,0,.05);margin-top:14px;}
.sp-basket-stats{display:flex;align-items:center;gap:18px;flex-wrap:wrap;min-width:0;}
.sp-bs{min-width:0;}
.sp-bs-l{font-size:9px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:.08em;}
.sp-bs-v{font-size:16px;font-weight:700;letter-spacing:-.02em;margin-top:1px;}
.sp-bs-v.dmg{color:var(--red);}
.sp-bs-v.oos{color:var(--amber);}
.sp-basket-actions{display:flex;gap:8px;flex-shrink:0;}

.sp-pmeter{height:5px;background:var(--bg2);border-radius:3px;overflow:hidden;margin-top:8px;}
.sp-pmeter i{display:block;height:100%;border-radius:3px;background:var(--royal);transition:width .35s ease;}

.sp-acc-row{display:flex;align-items:center;gap:11px;padding:10px 0;border-bottom:0.5px solid var(--brd);}
.sp-acc-row:last-child{border-bottom:none;}
.sp-acc-av{width:32px;height:32px;border-radius:50%;background:var(--royal-light);color:var(--royal);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;}
.sp-sw{position:relative;width:40px;height:22px;flex-shrink:0;}
.sp-sw input{opacity:0;width:0;height:0;}
.sp-sw span{position:absolute;inset:0;background:var(--bg2);border:0.5px solid var(--brd2);border-radius:20px;cursor:pointer;transition:all .18s;}
.sp-sw span::before{content:'';position:absolute;width:16px;height:16px;left:2px;top:2px;background:#fff;border-radius:50%;transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.2);}
.sp-sw input:checked+span{background:var(--green);border-color:var(--green);}
.sp-sw input:checked+span::before{transform:translateX(18px);}

.sp-tbl-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}

.sp-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,90px);background:#1a1a1a;color:#fff;padding:11px 18px;border-radius:10px;font-size:12.5px;font-weight:500;z-index:9998;box-shadow:0 8px 28px rgba(0,0,0,.3);opacity:0;transition:all .28s cubic-bezier(.4,0,.2,1);max-width:88vw;text-align:center;pointer-events:none;}
.sp-toast.show{transform:translate(-50%,0);opacity:1;}
.sp-toast.ok{background:#12735a;}
.sp-toast.err{background:#8f2626;}

@media(max-width:768px){
  .sp-step-rail{flex-wrap:wrap;}
  .sp-step-node{flex:1 1 100%;padding:10px 14px;}
  .sp-step-node:not(:last-child)::after{right:0;left:0;top:auto;bottom:-1px;width:auto;height:1px;}
  .sp-store-grid{grid-template-columns:1fr;}
  .sp-num-grid{grid-template-columns:1fr 1fr;gap:14px;}
  .sp-ll-row{gap:9px;}
  .sp-ll-nudge{width:32px;height:32px;font-size:15px;}
  .sp-ll-inp{font-size:30px;}
  .sp-calc-row{grid-template-columns:1fr 1fr;gap:9px;}
  .sp-calc-hero-v{font-size:27px;}
  .sp-basket-bar{padding:10px 12px;}
  .sp-basket-stats{gap:13px;}
  .sp-bs-v{font-size:14px;}
  .sp-basket-actions{width:100%;}
  .sp-basket-actions .btn{flex:1;}
  .sp-sku-right .sp-sku-onhand{display:none;}
}`;
  const style = document.createElement('style');
  style.id = 'sp-styles';
  style.textContent = css;
  document.head.appendChild(style);
  if (!document.getElementById('sp-toast')) {
    const t = document.createElement('div');
    t.id = 'sp-toast';
    t.className = 'sp-toast';
    document.body.appendChild(t);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SCREEN MARKUP
// ═══════════════════════════════════════════════════════════════════════════
function screenHtml() {
  return `
  <div class="tabs" id="sp-tabs">
    <div class="tab active" data-tab="count" onclick="Stock.switchTab('count')">Count stock</div>
    <div class="tab" data-tab="history" onclick="Stock.switchTab('history')">Recent counts</div>
    <div class="tab hidden" data-tab="access" id="sp-tab-access" onclick="Stock.switchTab('access')">Who can count stock</div>
  </div>

  <!-- ══════ TAB: COUNT ══════ -->
  <div class="tc active" id="sp-tc-count">
    <div id="sp-scope-banner"></div>

    <div class="sp-step-rail" id="sp-step-rail"></div>

    <!-- Step 1 -->
    <div class="card" id="sp-step1-card">
      <div class="card-hdr">
        <div>
          <div class="card-title">Which store are you in?</div>
          <div class="card-sub" id="sp-step1-sub">Pick the outlet you have walked into.</div>
        </div>
        <input class="si" id="sp-store-search" placeholder="Search stores..." oninput="Stock.renderStores()" style="width:220px;max-width:100%;"/>
      </div>
      <div class="sp-store-grid" id="sp-store-grid"></div>
    </div>

    <!-- Step 2 -->
    <div class="card hidden" id="sp-step2-card">
      <div class="card-hdr">
        <div>
          <div class="card-title">Pick the SKU you're counting</div>
          <div class="card-sub" id="sp-step2-sub">—</div>
        </div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;">
          <input class="si" id="sp-sku-search" placeholder="Search SKU..." oninput="Stock.renderSkus()" style="width:180px;max-width:100%;"/>
          <button class="btn btn-sm" id="sp-btn-toggle-counted" onclick="Stock.toggleHideCounted()">Hide counted</button>
        </div>
      </div>
      <div class="sp-pmeter" style="margin-bottom:12px;"><i id="sp-sku-progress" style="width:0%"></i></div>
      <div id="sp-sku-list"></div>
    </div>

    <!-- Basket -->
    <div class="hidden" id="sp-basket-wrap"></div>
  </div>

  <!-- ══════ TAB: HISTORY ══════ -->
  <div class="tc" id="sp-tc-history">
    <div class="card">
      <div class="card-hdr">
        <div>
          <div class="card-title">Recent stock counts</div>
          <div class="card-sub">The last 50 counts you can see.</div>
        </div>
        <button class="btn btn-sm" onclick="Stock.loadHistory()">Refresh</button>
      </div>
      <div class="sp-tbl-scroll" id="sp-history-wrap"><div class="empty-state">Loading...</div></div>
    </div>
  </div>

  <!-- ══════ TAB: ACCESS ══════ -->
  <div class="tc" id="sp-tc-access">
    <div class="card">
      <div class="card-hdr">
        <div>
          <div class="card-title">Who can count stock</div>
          <div class="card-sub">Turn Stock Position on for the people you choose. Admins and managers always have it.</div>
        </div>
        <input class="si" id="sp-acc-search" placeholder="Search people..." oninput="Stock.renderAccess()" style="width:200px;max-width:100%;"/>
      </div>
      <div class="alert ai"><span>&#9432;</span><span>Changes take effect the next time that person opens Stock Position.</span></div>
      <div id="sp-access-list"><div class="empty-state">Loading...</div></div>
    </div>
  </div>

  <!-- Step 3 pops up over everything, so it lives outside the tabs — a
       tab going display:none behind it would otherwise hide it too. -->
  <div class="hidden" id="sp-step3-wrap" onclick="if(event.target===this) Stock.closePanel()"></div>`;
}

function deniedCardHtml() {
  return `<div class="card" style="max-width:480px;margin:40px auto;text-align:center;">
    <div class="card-title" style="margin-bottom:8px;">Stock Position is restricted</div>
    <div style="font-size:12.5px;color:var(--txt2);line-height:1.7;">
      This tool is switched on per person. Ask an administrator to give you access in
      <strong>Stock Position &rarr; Who can count stock</strong>, then open Stock Position again.
    </div>
  </div>`;
}

function ensureScreen() {
  if (document.getElementById('screen-stock')) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const div = document.createElement('div');
  div.className = 'screen';
  div.id = 'screen-stock';
  div.innerHTML = screenHtml();
  content.appendChild(div);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACCESS
// ═══════════════════════════════════════════════════════════════════════════
/* Access = admin/manager always, everyone else needs a row in stock_audit_access */
async function checkAccess() {
  if (roleMgr()) return true;
  const db = DB(); const u = me();
  if (!db || !u) return false;
  try {
    const { data, error } = await db.from('stock_audit_access')
      .select('can_access').eq('user_id', String(u.id)).maybeSingle();
    if (error) { console.warn('stock_audit_access:', error.message); return false; }
    return !!(data && data.can_access !== false);
  } catch (e) { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════
async function loadClients() {
  const db = DB(); const u = me();
  const { data } = await db.from('clients').select('*').eq('status', 'active').order('name');
  const all = data || [];
  if (roleRep()) {
    const { data: asgn } = await db.from('client_assignments').select('client_id').eq('user_id', u.id);
    const ids = new Set((asgn || []).map(a => String(a.client_id)));
    visibleClients = all.filter(c => ids.has(String(c.id)));
  } else {
    visibleClients = all;
  }
}

async function loadProducts() {
  const db = DB();
  let out = [], from = 0, size = 1000;
  while (true) {
    const { data, error } = await db.from('products').select('*').order('name').range(from, from + size - 1);
    if (error || !data || !data.length) break;
    out = out.concat(data);
    if (data.length < size) break;
    from += size;
  }
  allProducts = out;
}

/* AIWIBI SKUs for a store: the brand listing table, filtered to brands the
   store actually carries. Falls back to name-matching the product master. */
/* A store only gets asked to count what it has actually bought — a SKU it
   has never invoiced for isn't physically on the shelf, so there's nothing
   to count. That means no fallback to the full catalog when a store has
   zero AIWIBI purchase history; an empty result there is correct, not a
   gap to paper over. */
async function loadSkusForClient(client) {
  const db = DB();
  let catalogRows = [];
  for (const t of AIWIBI_TABLES) {
    const { data, error } = await db.from(t).select('*');
    if (!error && data) catalogRows = catalogRows.concat(data);
  }
  if (!catalogRows.length) {
    catalogRows = allProducts
      .filter(p => /aiwibi|aiwina/i.test((p.name || '') + ' ' + (p.sku || '')))
      .map(p => ({ sku: p.sku, item_name: p.name, category: p.category }));
  }
  const catalog = buildCatalogRows(catalogRows);
  const purchased = await loadPurchasedSkuKeys(client, catalog);
  return catalog.filter(row => purchased.has(normSku(row.sku)));
}

function buildCatalogRows(rows) {
  const seen = new Set();
  const list = [];
  rows.forEach(r => {
    const sku = (r.sku || r.item_name || '').trim();
    if (!sku) return;
    const key = normSku(sku);
    if (seen.has(key)) return;
    seen.add(key);
    const name = (r.item_name || r.sku || '').trim();
    const p = matchProduct(sku, name);
    list.push({
      sku,
      name: name || sku,
      category: r.category || deriveCategory(name || sku),
      size: deriveSize(name || sku),
      productId: p?.id || null,
      inner: int(p?.inner) || 0,
      warehouse: p ? int(p.stock_on_hand) : null
    });
  });
  list.sort((a, b) =>
    a.category.localeCompare(b.category) ||
    sizeRank(a.size) - sizeRank(b.size) ||
    a.name.localeCompare(b.name));
  return list;
}

/* Which AIWIBI SKUs has this store ever actually been invoiced for?
   invoice_line_items is the same real, Zoho-synced sales record the
   Clients → Purchase History tab reads from — not the Place Listing
   orders table, which only records what a rep proposed. All-time, no
   date window: a SKU bought once is a SKU that's on that shelf. */
async function loadPurchasedSkuKeys(client, catalog) {
  const bySku = new Set(catalog.map(r => normSku(r.sku)));
  const byName = new Map(catalog.map(r => [normSku(r.name), normSku(r.sku)]));
  const skuList = [...bySku];

  const rows = await fetchClientInvoiceLines(client);
  const found = new Set();
  rows.forEach(r => {
    const code = normSku(r.item_code || '');
    const name = normSku(r.item_name || '');
    if (code && bySku.has(code)) { found.add(code); return; }
    if (name && byName.has(name)) { found.add(byName.get(name)); return; }
    if (code) {
      const partial = skuList.find(s => s.length > 3 && (code.includes(s) || s.includes(code)));
      if (partial) found.add(partial);
    }
  });
  return found;
}

/* Same two-step lookup the Clients screen uses: match by the linked Zoho
   customer id first, and only fall back to a name match if there's no
   link yet or the linked id turns up nothing. */
async function fetchClientInvoiceLines(client) {
  const db = DB();
  const zohoId = client.zoho_customer_id;
  let rows = [];
  if (zohoId) rows = await pageInvoiceLines(db, q => q.eq('customer_id', zohoId));
  if (!zohoId || !rows.length) rows = await pageInvoiceLines(db, q => q.ilike('customer_name', client.name));
  return rows;
}
async function pageInvoiceLines(db, applyFilter) {
  let all = [], from = 0, pageSize = 1000;
  while (true) {
    let q = db.from('invoice_line_items').select('item_code,item_name').range(from, from + pageSize - 1);
    q = applyFilter(q);
    const { data, error } = await q;
    if (error) { console.warn('[stock] invoice_line_items:', error.message); break; }
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

function matchProduct(sku, name) {
  const s = normSku(sku), n = normSku(name);
  return allProducts.find(p => normSku(p.sku) === s)
      || allProducts.find(p => normSku(p.name) === s)
      || (n && allProducts.find(p => normSku(p.sku) === n))
      || (n && allProducts.find(p => normSku(p.name) === n))
      || (n.length > 4 && allProducts.find(p => normSku(p.name || '').includes(n)))
      || null;
}

/* Group the AIWIBI range the way the stock sheet does */
function deriveCategory(name) {
  const n = (name || '').toLowerCase();
  if (/wipe/.test(n))                        return 'Aiwibi Wipes';
  if (/\(\s*\d{2,3}\s*\)/.test(n))           return 'Aiwibi Diapers & Pants (pack-count variants)';
  if (/\bpant/.test(n))                      return 'Aiwibi High Count Pants';
  if (/diaper|nappy|newborn|\bnb\b/.test(n)) return 'Aiwibi High Count Diapers';
  return 'Other Aiwibi items';
}
function deriveSize(name) {
  const n = (name || '').toUpperCase();
  const pack = n.match(/\(\s*(\d{2,3})\s*\)/);
  if (/NEW\s*BORN|NEWBORN|\bNB\b/.test(n)) {
    const pcs = n.match(/(\d{2,3})\s*PCS?/);
    return pcs ? `NB ${pcs[1]}` : 'NB';
  }
  const sz = n.match(/\b(XXL|XL|L|M|S)\b/);
  if (sz && pack) return `${sz[1]}(${pack[1]})`;
  if (sz) return sz[1];
  if (pack) return pack[1];
  return '—';
}
function sizeRank(s) {
  const base = String(s).replace(/\(.*\)/, '').trim().toUpperCase();
  const order = { 'NB': 0, 'S': 1, 'M': 2, 'L': 3, 'XL': 4, 'XXL': 5 };
  if (base.startsWith('NB')) return 0;
  return order[base] ?? 90;
}

/* Last saved position per SKU, so opening stock pre-fills itself */
async function loadLastCounts(clientId) {
  const db = DB();
  lastCountMap = {};
  try {
    const { data: counts, error } = await db.from('stock_counts')
      .select('id,counted_at').eq('client_id', String(clientId))
      .order('counted_at', { ascending: false }).limit(25);
    if (error || !counts || !counts.length) return;
    const byId = {}; counts.forEach(c => byId[c.id] = c.counted_at);
    const { data: items } = await db.from('stock_count_items')
      .select('count_id,sku,sellable,physical').in('count_id', counts.map(c => c.id));
    (items || []).forEach(it => {
      const key = normSku(it.sku);
      const when = byId[it.count_id];
      if (!lastCountMap[key] || new Date(when) > new Date(lastCountMap[key].counted_at)) {
        lastCountMap[key] = { sellable: int(it.sellable ?? it.physical), counted_at: when };
      }
    });
  } catch (e) { console.warn('last counts unavailable:', e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  STEP RAIL
// ═══════════════════════════════════════════════════════════════════════════
function renderStepRail() {
  const rail = document.getElementById('sp-step-rail');
  if (!rail) return;
  const closed = Object.values(basket).filter(b => b.closing != null).length;
  const opened = Object.values(basket).filter(b => b.closing == null).length;
  let step3v = 'Count the stock';
  if (closed || opened) {
    const parts = [];
    if (closed) parts.push(`${closed} closed`);
    if (opened) parts.push(`${opened} awaiting close`);
    step3v = parts.join(' · ');
  }
  const steps = [
    { k: 'Step 1', v: selectedClient ? selectedClient.name : 'Choose a store',
      state: selectedClient ? 'done' : 'active', go: 'Stock.goStep1()' },
    { k: 'Step 2', v: activeSku ? activeSku.name : (selectedClient ? `${skuRows.length} AIWIBI items` : 'Pick an SKU'),
      state: !selectedClient ? 'locked' : (activeSku ? 'done' : 'active'), go: 'Stock.goStep2()' },
    { k: 'Step 3', v: step3v,
      state: !activeSku ? 'locked' : 'active', go: '' }
  ];
  rail.innerHTML = steps.map((s, i) => `
    <div class="sp-step-node ${s.state}" ${s.state !== 'locked' && s.go ? `onclick="${s.go}"` : ''}>
      <div class="sp-step-dot">${s.state === 'done' ? '&#10003;' : i + 1}</div>
      <div class="sp-step-meta"><div class="sp-step-k">${s.k}</div><div class="sp-step-v">${esc(s.v)}</div></div>
    </div>`).join('');
}
function goStep1() {
  document.getElementById('sp-step1-card').classList.remove('hidden');
  document.getElementById('sp-step1-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function goStep2() {
  if (!selectedClient) return;
  document.getElementById('sp-step2-card').classList.remove('hidden');
  document.getElementById('sp-step2-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderScopeBanner() {
  const el = document.getElementById('sp-scope-banner');
  if (!el) return;
  el.innerHTML = roleRep()
    ? `<div class="rep-scope-banner"><span>&#128205;</span><span>You are counting stock in the <strong>${visibleClients.length}</strong> store${visibleClients.length === 1 ? '' : 's'} assigned to you.</span></div>`
    : `<div class="rep-scope-banner"><span>&#128274;</span><span>You can count stock in any of the <strong>${visibleClients.length}</strong> active stores.</span></div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STEP 1: STORES
// ═══════════════════════════════════════════════════════════════════════════
function renderStores() {
  const q = (document.getElementById('sp-store-search').value || '').toLowerCase();
  const list = visibleClients.filter(c =>
    !q || (c.name || '').toLowerCase().includes(q) || (c.address || '').toLowerCase().includes(q));
  const grid = document.getElementById('sp-store-grid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
      ${visibleClients.length ? 'No store matches that search.' : 'No stores are assigned to you yet. Ask your manager to assign your outlets.'}</div>`;
    return;
  }
  grid.innerHTML = list.map(c => `
    <button class="sp-store-card ${selectedClient && String(selectedClient.id) === String(c.id) ? 'sel' : ''}" onclick="Stock.pickStore('${c.id}')">
      <div class="sp-store-av">${initials(c.name)}</div>
      <div style="min-width:0;flex:1;">
        <div class="sp-store-nm">${esc(c.name)}</div>
        <div class="sp-store-meta">
          ${c.type ? `<span class="badge bb">${esc(c.type)}</span>` : ''}
          <span>${esc(c.address || c.phone || 'No address on file')}</span>
        </div>
      </div>
    </button>`).join('');
}

async function pickStore(id) {
  const c = visibleClients.find(x => String(x.id) === String(id));
  if (!c) return;
  if (selectedClient && String(selectedClient.id) !== String(c.id) && Object.keys(basket).length) {
    if (!confirm(`You have ${Object.keys(basket).length} counted SKU(s) for ${selectedClient.name} that are not submitted yet. Switching store clears them. Continue?`)) return;
    basket = {}; activeSku = null;
  }
  selectedClient = c;
  document.getElementById('sp-step1-card').classList.add('hidden');
  document.getElementById('sp-step2-card').classList.remove('hidden');
  document.getElementById('sp-sku-list').innerHTML = `<div class="empty-state"><div style="font-size:20px;margin-bottom:8px;">&#9203;</div>Checking ${esc(c.name)}'s purchase history...</div>`;
  renderStores(); renderStepRail();

  skuRows = await loadSkusForClient(c);
  await loadLastCounts(c.id);
  document.getElementById('sp-step2-sub').textContent = skuRows.length
    ? `${skuRows.length} AIWIBI item${skuRows.length === 1 ? '' : 's'} this store has bought before. Tap one to count it.`
    : `No AIWIBI purchase history found for ${c.name} — nothing to count here yet.`;
  renderSkus(); renderBasket(); saveDraft();
}

// ═══════════════════════════════════════════════════════════════════════════
//  STEP 2: SKUS
// ═══════════════════════════════════════════════════════════════════════════
function toggleHideCounted() {
  hideCounted = !hideCounted;
  document.getElementById('sp-btn-toggle-counted').textContent = hideCounted ? 'Show all' : 'Hide counted';
  renderSkus();
}
function toggleCat(name) { collapsedCats[name] = !collapsedCats[name]; renderSkus(); }

function renderSkus() {
  const q = (document.getElementById('sp-sku-search').value || '').toLowerCase();
  const wrap = document.getElementById('sp-sku-list');
  const preSearch = skuRows.length;
  let list = skuRows.filter(r => !q || r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q));
  const matchedSearch = list.length;
  if (hideCounted) list = list.filter(r => stageOf(normSku(r.sku)) !== 'closed');

  const closed = skuRows.filter(r => stageOf(normSku(r.sku)) === 'closed').length;
  const prog = document.getElementById('sp-sku-progress');
  if (prog) prog.style.width = (skuRows.length ? Math.round(closed / skuRows.length * 100) : 0) + '%';

  if (!list.length) {
    let msg;
    if (!preSearch)              msg = `${selectedClient ? esc(selectedClient.name) : 'This store'} has no recorded AIWIBI purchases, so there's nothing to count here.`;
    else if (q && !matchedSearch) msg = `No SKU matches "${esc(q)}".`;
    else if (hideCounted && closed === skuRows.length) msg = 'Every SKU in this store is closed out. Nice work.';
    else                          msg = 'Nothing left to show here.';
    wrap.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }
  const cats = {};
  list.forEach(r => { (cats[r.category] = cats[r.category] || []).push(r); });

  wrap.innerHTML = Object.keys(cats).sort().map(cat => {
    const rows = cats[cat];
    const nDone = rows.filter(r => stageOf(normSku(r.sku)) === 'closed').length;
    const open = !collapsedCats[cat];
    return `<div class="sp-cat-block">
      <div class="sp-cat-hdr" onclick="Stock.toggleCat('${jsq(cat)}')">
        <div class="sp-cat-nm"><span style="font-size:10px;opacity:.55;">${open ? '&#9662;' : '&#9656;'}</span>${esc(cat)}</div>
        <div class="sp-cat-count">${nDone} / ${rows.length} closed</div>
      </div>
      ${open ? rows.map(r => skuRowHtml(r)).join('') : ''}
    </div>`;
  }).join('');
}

function skuRowHtml(r) {
  const key = normSku(r.sku);
  const b = basket[key];
  const last = lastCountMap[key];
  const stage = stageOf(key);
  const isActive = activeSku && normSku(activeSku.sku) === key;

  let onhand = '', btnStyle = '', btnLabel, rowClass, subLine, urgent = false;
  if (stage === 'closed') {
    const c = statusColor(b.status);
    onhand = `<div class="sp-sku-onhand"><div class="sp-sku-onhand-v" style="color:${c}">${b.sellable}</div>
             <div class="sp-sku-onhand-l">sellable</div></div>`;
    btnStyle = `style="border-color:${c};color:${c};"`;
    btnLabel = 'Edit';
    rowClass = 'counted';
    subLine = `sold ${b.sold} today`;
  } else if (stage === 'opened') {
    onhand = `<div class="sp-sku-onhand"><div class="sp-sku-onhand-v" style="color:var(--txt2)">${b.opening}</div>
             <div class="sp-sku-onhand-l">opening</div></div>`;
    btnLabel = 'Close count';
    rowClass = 'pending';
    subLine = 'needs a closing count before you leave';
    urgent = true;
  } else if (last) {
    onhand = `<div class="sp-sku-onhand"><div class="sp-sku-onhand-v" style="color:var(--txt3)">${last.sellable}</div>
             <div class="sp-sku-onhand-l">last count</div></div>`;
    btnLabel = 'Count';
    rowClass = '';
    subLine = `last closed ${daysAgoLabel(last.counted_at)}`;
  } else {
    btnLabel = 'First count';
    rowClass = '';
    subLine = '';
  }
  const sq = jsq(r.sku);
  const btn = `<button type="button" class="sp-count-btn ${urgent ? 'urgent' : 'quiet'}" ${btnStyle} onclick="event.stopPropagation();Stock.openCount('${sq}')">${btnLabel}</button>`;
  return `<div class="sp-sku-row ${rowClass} ${isActive ? 'active' : ''}" onclick="Stock.openCount('${sq}')">
    <div class="sp-sku-size">${esc(r.size)}</div>
    <div class="sp-sku-main">
      <div class="sp-sku-nm">${esc(r.name)}</div>
      <div class="sp-sku-sub mono">${esc(r.sku)}${subLine ? ` · ${subLine}` : ''}</div>
    </div>
    <div class="sp-sku-right">${onhand}${btn}</div>
  </div>`;
}

function daysAgoLabel(iso) {
  const d = daysBetween(iso, new Date());
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  return `${Math.round(d)} days ago`;
}
function daysBetween(a, b) { return Math.max(0, (new Date(b) - new Date(a)) / 86400000); }
function statusColor(s) {
  return s === 'Out of stock' || s === 'Critical' ? 'var(--red)'
       : s === 'Low' ? 'var(--amber)'
       : s === 'Overstocked' ? 'var(--royal)' : 'var(--green)';
}
function statusBadge(s) {
  return s === 'Out of stock' || s === 'Critical' ? 'br'
       : s === 'Low' ? 'ba'
       : s === 'Overstocked' ? 'bb' : 'bg';
}

// ═══════════════════════════════════════════════════════════════════════════
//  STEP 3: OPEN THE SHELF, THEN CLOSE IT
//  Every SKU goes through two checkpoints: Opening stock when you arrive at
//  the store, Closing stock when you're done with it — later that visit, or
//  right before you leave for the next store. The system works out what
//  sold in between; nobody types a "sold" number by hand.
// ═══════════════════════════════════════════════════════════════════════════
function stageOf(key) {
  const b = basket[key];
  if (!b) return 'new';
  return (b.closing === null || b.closing === undefined) ? 'opened' : 'closed';
}

function openCount(sku) {
  const r = skuRows.find(x => normSku(x.sku) === normSku(sku));
  if (!r) return;
  activeSku = r;
  const stage = stageOf(normSku(r.sku));
  if (stage === 'new')          renderOpeningForm(r, false);
  else if (stage === 'opened')  renderClosingForm(r, false);
  else                          renderClosedSummary(r);
  renderSkus(); renderStepRail();
}

/* ── Opening: one number, as fast as possible ────────────────────────────── */
function renderOpeningForm(r, editing) {
  const key = normSku(r.sku);
  const last = lastCountMap[key];
  const b = basket[key];
  const openingDefault = editing && b ? b.opening : (last ? last.sellable : 0);
  const pos = skuRows.findIndex(x => normSku(x.sku) === key) + 1;

  const wrap = document.getElementById('sp-step3-wrap');
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
  <div class="sp-count-panel">
    <div class="sp-count-hd">
      <div class="sp-ch-top">
        <span class="sp-ch-eyebrow">Stock card &middot; ${pos} of ${skuRows.length}</span>
        <button class="sp-ch-close" onclick="Stock.closePanel()" aria-label="Close">&times;</button>
      </div>
      <div class="sp-count-hd-sku">${esc(r.name)}</div>
      <div class="sp-count-hd-sub mono">${esc(r.sku)} &nbsp;·&nbsp; ${esc(r.category)}</div>
    </div>
    <div class="sp-count-body">
      ${numField('opening', 'Opening stock', openingDefault, last ? `last closing count was ${last.sellable}` : 'no previous count — enter what you see', 'tinted')}

      <div class="sp-cta-row">
        <button class="btn btn-royal sp-cta-primary" onclick="Stock.saveOpening()">${editing ? 'Update opening stock' : 'Save opening stock'}</button>
      </div>
      <div class="sp-cta-footer">
        ${editing ? `<button class="sp-ghost-link danger" onclick="Stock.removeSku()">Remove this SKU</button><span class="sp-cta-sep">&middot;</span>` : ''}
        <button class="sp-ghost-link" onclick="Stock.saveOpening(true)">Save &amp; next SKU &rarr;</button>
      </div>
      <div style="font-size:10.5px;color:var(--txt3);margin-top:12px;line-height:1.6;text-align:center;">
        Come back to this SKU later — in the evening, or right before you leave this store — to enter the <strong>closing stock</strong> and see what it sold today.
      </div>
    </div>
  </div>`;
}

function saveOpening(next) {
  if (!activeSku) return;
  const key = normSku(activeSku.sku);
  const opening = int(document.getElementById('sp-f-opening').value);
  const existing = basket[key];
  basket[key] = {
    sku: activeSku.sku, name: activeSku.name, category: activeSku.category, size: activeSku.size,
    productId: activeSku.productId,
    opening, openingAt: new Date().toISOString(),
    closing: existing?.closing ?? null, closingAt: existing?.closingAt ?? null,
    damaged: existing?.damaged ?? 0, damageReason: existing?.damageReason ?? null,
    notes: existing?.notes ?? null,
    sellable: existing?.sellable ?? null, sold: existing?.sold ?? null,
    avgDaily: existing?.avgDaily ?? null, daysCover: existing?.daysCover ?? null,
    suggested: existing?.suggested ?? null, status: existing?.status ?? null
  };
  toast(`${activeSku.name} — opening stock saved`, 'ok');
  saveDraft();

  if (next) {
    const idx = skuRows.findIndex(r => normSku(r.sku) === key);
    const nxt = skuRows.slice(idx + 1).find(r => stageOf(normSku(r.sku)) === 'new')
             || skuRows.find(r => stageOf(normSku(r.sku)) === 'new');
    if (nxt) { openCount(nxt.sku); renderBasket(); return; }
    toast('Every SKU has an opening stock recorded.', 'ok');
  }
  closePanel(); renderBasket();
}

/* ── Closing: what's left, any damage, and the sale the system works out ── */
function renderClosingForm(r, editing) {
  const key = normSku(r.sku);
  const b = basket[key];
  const closingDefault = editing ? (b.closing ?? 0) : 0;
  const pos = skuRows.findIndex(x => normSku(x.sku) === key) + 1;

  const wrap = document.getElementById('sp-step3-wrap');
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
  <div class="sp-count-panel">
    <div class="sp-count-hd">
      <div class="sp-ch-top">
        <span class="sp-ch-eyebrow">Stock card &middot; ${pos} of ${skuRows.length}</span>
        <button class="sp-ch-close" onclick="Stock.closePanel()" aria-label="Close">&times;</button>
      </div>
      <div class="sp-count-hd-sku">${esc(r.name)}</div>
      <div class="sp-count-hd-sub mono">${esc(r.sku)} &nbsp;·&nbsp; ${esc(r.category)}</div>
    </div>
    <div class="sp-count-body">
      <div class="sp-ref-line">
        <div>
          <div class="sp-ref-lbl">Opening stock &middot; recorded ${daysAgoLabel(b.openingAt)}</div>
          <div class="sp-ref-v">${b.opening}</div>
        </div>
        <button class="sp-ghost-link" onclick="Stock.editOpening()">Change</button>
      </div>

      <div class="sp-count-sec">Closing stock — what's left now</div>
      <div class="sp-num-grid">
        ${numField('closing', 'Closing stock', closingDefault, 'count what remains before you leave')}
        ${numField('damaged', 'Damaged units', editing ? (b.damaged || 0) : 0, 'not sellable', 'danger')}
      </div>
      <div style="margin-top:14px;">
        <div class="sp-ll-lbl-text" style="margin-bottom:7px;">Reason for the damage</div>
        <div class="sp-chip-row" id="sp-dmg-chips">
          ${DAMAGE_REASONS.map(x => `<button class="sp-chip ${(editing && b.damageReason === x) ? 'on-dmg' : ''}" onclick="Stock.pickReason(this,'${x}')">${x}</button>`).join('')}
        </div>
      </div>

      <div class="sp-count-sec">Notes</div>
      <input class="fin" id="sp-f-notes" placeholder="Anything the office should know — e.g. shelf given to a competitor" value="${esc((editing && b.notes) || '')}"/>

      <div class="sp-calc-strip" id="sp-calc-strip"></div>

      <div class="sp-cta-row">
        <button class="btn btn-royal sp-cta-primary" onclick="Stock.saveClosing()">${editing ? 'Update closing stock' : 'Close this SKU'}</button>
      </div>
      <div class="sp-cta-footer">
        <button class="sp-ghost-link danger" onclick="Stock.removeSku()">Remove this SKU</button>
        <span class="sp-cta-sep">&middot;</span>
        <button class="sp-ghost-link" onclick="Stock.saveClosing(true)">Close &amp; next SKU &rarr;</button>
      </div>
      <div style="font-size:10.5px;color:var(--txt3);margin-top:12px;line-height:1.6;text-align:center;">
        <strong>Sold today</strong> = opening &minus; closing. <strong>Sellable now</strong> = closing &minus; damaged.
      </div>
    </div>
  </div>`;

  wrap._reason = (editing && b.damageReason) || '';
  recalcClosing();
}

function saveClosing(next) {
  if (!activeSku) return;
  const key = normSku(activeSku.sku);
  const b = basket[key];
  if (!b) return;
  const c = computeClosing(b.opening);
  const wrap = document.getElementById('sp-step3-wrap');
  if (c.damaged > 0 && !wrap._reason) { toast('Pick a reason for the damaged units.', 'err'); return; }
  if (c.closing === 0 && c.damaged === 0 && b.opening === 0) {
    if (!confirm('Everything is zero for this SKU. Save it as out of stock?')) return;
  }
  basket[key] = {
    ...b,
    closing: c.closing, closingAt: new Date().toISOString(),
    damaged: c.damaged, damageReason: wrap._reason || null,
    notes: document.getElementById('sp-f-notes').value.trim() || null,
    sellable: c.sellable, sold: c.sold,
    avgDaily: +c.avgDaily.toFixed(2),
    daysCover: c.daysCover === null ? null : +c.daysCover.toFixed(1),
    suggested: c.suggested, status: c.status
  };
  toast(`${activeSku.name} closed — ${c.sellable} sellable, ${c.sold} sold today`, 'ok');
  saveDraft();

  if (next) {
    const idx = skuRows.findIndex(r => normSku(r.sku) === key);
    const nxt = skuRows.slice(idx + 1).find(r => stageOf(normSku(r.sku)) === 'opened')
             || skuRows.find(r => stageOf(normSku(r.sku)) === 'opened');
    if (nxt) { openCount(nxt.sku); renderBasket(); return; }
    toast('Every opened SKU is closed out.', 'ok');
  }
  closePanel(); renderBasket();
}

/* ── Closed: a read-only summary, with a way back into either checkpoint ── */
function renderClosedSummary(r) {
  const key = normSku(r.sku);
  const b = basket[key];
  const pos = skuRows.findIndex(x => normSku(x.sku) === key) + 1;
  const pillClass = b.status === 'Out of stock' || b.status === 'Critical' ? 'sp-pos-crit'
                  : b.status === 'Low' ? 'sp-pos-low'
                  : b.status === 'Overstocked' ? 'sp-pos-over' : 'sp-pos-ok';
  const wrap = document.getElementById('sp-step3-wrap');
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
  <div class="sp-count-panel">
    <div class="sp-count-hd">
      <div class="sp-ch-top">
        <span class="sp-ch-eyebrow">Stock card &middot; ${pos} of ${skuRows.length}</span>
        <button class="sp-ch-close" onclick="Stock.closePanel()" aria-label="Close">&times;</button>
      </div>
      <div class="sp-count-hd-sku">${esc(r.name)}</div>
      <div class="sp-count-hd-sub mono">${esc(r.sku)} &nbsp;·&nbsp; ${esc(r.category)}</div>
    </div>
    <div class="sp-count-body">
      <div class="sp-calc-strip" style="margin-top:0;">
        <div class="sp-calc-top">
          <div>
            <div class="sp-calc-hero-l">Sold today</div>
            <div class="sp-calc-hero-v">${b.sold}<span class="sp-calc-hero-u">units</span></div>
          </div>
          <span class="sp-pos-pill ${pillClass}">${b.status}</span>
        </div>
        <div class="sp-calc-row">
          <div class="sp-calc-cell"><div class="sp-calc-l">Opening</div><div class="sp-calc-v">${b.opening}</div></div>
          <div class="sp-calc-cell"><div class="sp-calc-l">Closing</div><div class="sp-calc-v">${b.closing}</div></div>
          <div class="sp-calc-cell"><div class="sp-calc-l">Damaged</div><div class="sp-calc-v" style="${b.damaged ? 'color:#ffb3b2' : ''}">${b.damaged}</div></div>
          <div class="sp-calc-cell"><div class="sp-calc-l">Sellable now</div><div class="sp-calc-v">${b.sellable}</div></div>
        </div>
      </div>
      ${b.notes ? `<div style="font-size:12px;color:var(--txt2);margin-top:14px;line-height:1.6;"><strong>Note:</strong> ${esc(b.notes)}</div>` : ''}
      <div class="sp-cta-row">
        <button class="btn btn-royal sp-cta-primary" onclick="Stock.editClosing()">Edit closing count</button>
      </div>
      <div class="sp-cta-footer">
        <button class="sp-ghost-link" onclick="Stock.editOpening()">Edit opening count</button>
        <span class="sp-cta-sep">&middot;</span>
        <button class="sp-ghost-link danger" onclick="Stock.removeSku()">Remove this SKU</button>
      </div>
    </div>
  </div>`;
}
function editOpening() { if (activeSku) renderOpeningForm(activeSku, true); }
function editClosing() { if (activeSku) renderClosingForm(activeSku, true); }

function numField(id, label, value, hint, mod) {
  return `<div class="sp-ledger-line ${mod || ''}">
    <div class="sp-ll-label">
      <span class="sp-ll-lbl-text">${label}</span>
      ${hint ? `<span class="sp-ll-hint">${hint}</span>` : ''}
    </div>
    <div class="sp-ll-row">
      <button class="sp-ll-nudge" onclick="Stock.bump('${id}',-1)" aria-label="Decrease ${label}">&minus;</button>
      <div class="sp-ll-figure">
        <input class="sp-ll-inp ${id === 'damaged' ? 'dmg' : ''}" type="number" inputmode="numeric" min="0" id="sp-f-${id}" value="${int(value)}" oninput="Stock.recalcClosing()"/>
      </div>
      <button class="sp-ll-nudge" onclick="Stock.bump('${id}',1)" aria-label="Increase ${label}">+</button>
    </div>
  </div>`;
}
function bump(id, d) {
  const el = document.getElementById('sp-f-' + id);
  if (!el) return;
  el.value = Math.max(0, int(el.value) + d);
  recalcClosing();
}
function pickReason(btn, val) {
  const wrap = document.getElementById('sp-step3-wrap');
  const same = wrap._reason === val;
  wrap._reason = same ? '' : val;
  document.querySelectorAll('#sp-dmg-chips .sp-chip').forEach(c => c.classList.remove('on-dmg'));
  if (!same) btn.classList.add('on-dmg');
}
function closePanel() {
  activeSku = null;
  document.getElementById('sp-step3-wrap').classList.add('hidden');
  document.getElementById('sp-step3-wrap').innerHTML = '';
  renderSkus(); renderStepRail();
}
function removeSku() {
  if (!activeSku) return;
  delete basket[normSku(activeSku.sku)];
  saveDraft(); closePanel(); renderBasket();
  toast('Removed from this visit.');
}

/* The actual stock-position maths — opening and closing are two physical
   counts of the same shelf, taken hours apart, so "sold" is never typed by
   hand: opening minus closing is what left the shelf today. */
function computeClosing(opening) {
  const closing = int(document.getElementById('sp-f-closing').value);
  const damaged = int(document.getElementById('sp-f-damaged').value);

  const sellable = Math.max(0, closing - damaged);
  const sold = opening - closing;
  const avgDaily = sold > 0 ? sold : 0;
  const daysCover = avgDaily > 0 ? sellable / avgDaily : null;
  const suggested = avgDaily > 0 ? Math.max(0, Math.ceil(avgDaily * DEFAULT_COVER_DAYS - sellable)) : 0;

  let status;
  if (sellable === 0)          status = 'Out of stock';
  else if (daysCover === null) status = sellable <= 5 ? 'Low' : 'Healthy';
  else if (daysCover < 3)      status = 'Critical';
  else if (daysCover < 7)      status = 'Low';
  else if (daysCover > 45)     status = 'Overstocked';
  else                         status = 'Healthy';

  return { opening, closing, damaged, sellable, sold, avgDaily, daysCover, suggested, status };
}

function recalcClosing() {
  // Typed negative values are corrected on the spot, not just clamped
  // silently once saved — the field itself should never show a minus sign.
  document.querySelectorAll('.sp-ll-inp').forEach(el => { if (num(el.value) < 0) el.value = 0; });
  const el = document.getElementById('sp-f-closing');
  if (!el || !activeSku) return;
  const key = normSku(activeSku.sku);
  const opening = basket[key]?.opening ?? 0;
  const c = computeClosing(opening);
  const pillClass = c.status === 'Out of stock' || c.status === 'Critical' ? 'sp-pos-crit'
                  : c.status === 'Low' ? 'sp-pos-low'
                  : c.status === 'Overstocked' ? 'sp-pos-over' : 'sp-pos-ok';
  const soldTxt = c.sold < 0 ? `<span style="color:#ffb3b2;">${c.sold}</span>` : c.sold;
  document.getElementById('sp-calc-strip').innerHTML = `
    <div class="sp-calc-top">
      <div>
        <div class="sp-calc-hero-l">Sold today</div>
        <div class="sp-calc-hero-v">${soldTxt}<span class="sp-calc-hero-u">units</span></div>
      </div>
      <span class="sp-pos-pill ${pillClass}">${c.status}</span>
    </div>
    <div class="sp-calc-row">
      <div class="sp-calc-cell"><div class="sp-calc-l">Opening</div><div class="sp-calc-v">${c.opening}</div></div>
      <div class="sp-calc-cell"><div class="sp-calc-l">Closing</div><div class="sp-calc-v">${c.closing}</div></div>
      <div class="sp-calc-cell"><div class="sp-calc-l">Sellable now</div><div class="sp-calc-v">${c.sellable}</div></div>
      <div class="sp-calc-cell"><div class="sp-calc-l">Days of cover</div><div class="sp-calc-v">${c.daysCover === null ? '—' : c.daysCover.toFixed(1)}<small>d</small></div></div>
    </div>
    <div class="sp-calc-note">
      ${c.sold < 0
        ? '&#9888;&#65039; Closing is higher than opening. Check both counts — a delivery may have come in today.'
        : c.avgDaily > 0
          ? `Selling about <strong>${c.avgDaily.toFixed(1)}</strong> units a day. To hold ${DEFAULT_COVER_DAYS} days of cover, order <strong>${c.suggested}</strong> units.`
          : 'No units sold today, so days of cover can\u2019t be estimated yet.'}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  BASKET + SUBMIT
// ═══════════════════════════════════════════════════════════════════════════
function renderBasket() {
  const all = Object.values(basket);
  const lines = all.filter(l => l.closing != null);
  const pending = all.filter(l => l.closing == null);
  const wrap = document.getElementById('sp-basket-wrap');
  if (!lines.length && !pending.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; renderStepRail(); return; }
  wrap.classList.remove('hidden');

  const sellable = lines.reduce((s, l) => s + l.sellable, 0);
  const damaged  = lines.reduce((s, l) => s + l.damaged, 0);
  const oos      = lines.filter(l => l.status === 'Out of stock').length;
  const low      = lines.filter(l => l.status === 'Low' || l.status === 'Critical').length;

  const pendingBanner = pending.length ? `
    <div class="alert aw" style="margin-bottom:14px;">
      <span>&#9203;</span>
      <span><strong>${pending.length} SKU${pending.length > 1 ? 's' : ''}</strong> ${pending.length > 1 ? 'have' : 'has'} an opening stock recorded but no closing count yet: ${esc(pending.slice(0, 4).map(l => l.name).join(', '))}${pending.length > 4 ? '…' : ''}. Close ${pending.length > 1 ? 'them' : 'it'} out before you leave this store.</span>
    </div>` : '';

  if (!lines.length) {
    wrap.innerHTML = pendingBanner;
    renderStepRail();
    return;
  }

  wrap.innerHTML = `
  ${pendingBanner}
  <div class="card">
    <div class="card-hdr">
      <div>
        <div class="card-title">This visit &mdash; ${esc(selectedClient.name)}</div>
        <div class="card-sub">${lines.length} of ${skuRows.length} AIWIBI SKUs closed out</div>
      </div>
      <button class="btn btn-sm" onclick="Stock.exportExcel()">Export to Excel</button>
    </div>
    <div class="sp-tbl-scroll">
      <table>
        <thead><tr>
          <th>SKU</th><th>Category</th><th style="text-align:right">Opening</th><th style="text-align:right">Closing</th>
          <th style="text-align:right">Damaged</th><th style="text-align:right">Sellable</th><th style="text-align:right">Sold today</th>
          <th>Position</th><th></th>
        </tr></thead>
        <tbody>${lines.map(l => `
          <tr>
            <td><div style="font-weight:600;">${esc(l.name)}</div><div class="mono" style="color:var(--txt3);">${esc(l.sku)}</div></td>
            <td style="color:var(--txt2);font-size:11.5px;">${esc(l.category)}</td>
            <td style="text-align:right">${l.opening}</td>
            <td style="text-align:right">${l.closing}</td>
            <td style="text-align:right;${l.damaged ? 'color:var(--red);font-weight:600;' : ''}">${l.damaged}</td>
            <td style="text-align:right;font-weight:700;">${l.sellable}</td>
            <td style="text-align:right">${dash(l.sold)}</td>
            <td><span class="badge ${statusBadge(l.status)}">${l.status}</span></td>
            <td style="text-align:right;"><button class="btn btn-sm" onclick="Stock.openCount('${jsq(l.sku)}')">Edit</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <div class="sp-basket-bar">
    <div class="sp-basket-stats">
      <div class="sp-bs"><div class="sp-bs-l">SKUs closed</div><div class="sp-bs-v">${lines.length}</div></div>
      <div class="sp-bs"><div class="sp-bs-l">Sellable units</div><div class="sp-bs-v">${sellable}</div></div>
      <div class="sp-bs"><div class="sp-bs-l">Damaged</div><div class="sp-bs-v dmg">${damaged}</div></div>
      <div class="sp-bs"><div class="sp-bs-l">Out of stock</div><div class="sp-bs-v oos">${oos}</div></div>
      <div class="sp-bs"><div class="sp-bs-l">Low / critical</div><div class="sp-bs-v">${low}</div></div>
    </div>
    <div class="sp-basket-actions">
      <button class="btn btn-danger" onclick="Stock.clearBasket()">Discard</button>
      <button class="btn btn-green" id="sp-submit-btn" onclick="Stock.submitCount()">Submit stock position</button>
    </div>
  </div>`;
  renderStepRail();
}

function clearBasket() {
  if (!confirm('Discard every SKU counted in this visit?')) return;
  basket = {}; closePanel(); localStorage.removeItem('ktl_stock_draft');
  renderBasket(); renderSkus();
  toast('Count discarded.');
}

async function submitCount() {
  const all = Object.values(basket);
  const lines = all.filter(l => l.closing != null);
  const pending = all.filter(l => l.closing == null);
  if (!lines.length || !selectedClient) return;
  if (pending.length) {
    const noun = pending.length > 1 ? 'SKUs still have' : 'SKU still has';
    if (!confirm(`${pending.length} ${noun} an opening stock but no closing count. ${pending.length > 1 ? 'They' : 'It'} won't be included in this submission. Continue?`)) return;
  }
  const u = me(); const db = DB();
  const btn = document.getElementById('sp-submit-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Submitting...';

  let lat = null, lng = null;
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 6000, enableHighAccuracy: true }));
    lat = pos.coords.latitude; lng = pos.coords.longitude;
  } catch (e) { /* location is a bonus, not a blocker */ }

  const ref = 'SP-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' +
              Math.random().toString(36).slice(2, 6).toUpperCase();
  const header = {
    ref,
    client_id:   String(selectedClient.id),
    client_name: selectedClient.name,
    user_id:     String(u.id),
    user_name:   u.full_name || u.email,
    brand:       'AIWIBI',
    counted_at:  new Date().toISOString(),
    latitude: lat, longitude: lng,
    total_skus:     lines.length,
    total_sellable: lines.reduce((s, l) => s + l.sellable, 0),
    total_damaged:  lines.reduce((s, l) => s + l.damaged, 0),
    oos_count:      lines.filter(l => l.status === 'Out of stock').length,
    status: 'submitted'
  };

  try {
    const { data: cnt, error: e1 } = await db.from('stock_counts').insert(header).select().single();
    if (e1) throw e1;
    // The stock_count_items table still has its original opening/received/
    // shelf/backstore/physical columns — "received" and "backstore" are no
    // longer collected (always 0), and "shelf"/"physical" now both carry the
    // Closing stock figure, so nothing about the schema had to change.
    const items = lines.map(l => ({
      count_id: cnt.id, sku: l.sku, item_name: l.name, category: l.category,
      product_id: l.productId, opening: l.opening, received: 0,
      shelf: l.closing, backstore: 0, physical: l.closing,
      damaged: l.damaged, damage_reason: l.damageReason, sellable: l.sellable,
      sold: l.sold, days_elapsed: 1, avg_daily: l.avgDaily,
      days_cover: l.daysCover, suggested_order: l.suggested, status: l.status,
      nearest_expiry: null, notes: l.notes
    }));
    const { error: e2 } = await db.from('stock_count_items').insert(items);
    if (e2) throw e2;

    // Only the closed lines were submitted — keep any still-pending SKUs in
    // the draft so the rep can come back and close them out later.
    lastSubmittedLines = lines;
    if (pending.length) {
      const keep = {};
      pending.forEach(l => { keep[normSku(l.sku)] = l; });
      basket = keep;
      saveDraft();
    } else {
      localStorage.removeItem('ktl_stock_draft');
    }
    showSubmitted(ref, lines);
  } catch (err) {
    console.error(err);
    btn.disabled = false; btn.textContent = 'Submit stock position';
    toast('Could not save: ' + (err.message || 'unknown error') + '. Your count is still here — try again.', 'err');
  }
}

/* Builds one Dashboard-style KPI card: dotted corner, coloured icon tile,
   label, headline value and a caption — the same markup the Dashboard's
   own "My Clients" / "Active SKUs" row uses. */
function mcCard(bg, fg, iconPaths, label, value, sub) {
  return `<div class="mc">
    <div class="mc-dots">&bull;&bull;&bull;</div>
    <div class="mc-top">
      <div class="mc-ico" style="background:${bg};color:${fg};">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${iconPaths}</svg>
      </div>
      <div class="mc-body">
        <div class="mc-lbl">${label}</div>
        <div class="mc-val">${value}</div>
        <div class="mc-sub">${sub}</div>
      </div>
    </div>
  </div>`;
}

function showSubmitted(ref, lines) {
  const sellable = lines.reduce((s, l) => s + l.sellable, 0);
  const damaged  = lines.reduce((s, l) => s + l.damaged, 0);
  const reorder  = lines.filter(l => l.suggested > 0);
  document.getElementById('sp-step2-card').classList.add('hidden');
  document.getElementById('sp-basket-wrap').innerHTML = `
  <div class="card" style="border-color:#C0DD97;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
      <div style="width:42px;height:42px;border-radius:12px;background:#EAF3DE;color:#3B6D11;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">&#10003;</div>
      <div>
        <div style="font-size:14px;font-weight:700;">Stock position submitted</div>
        <div style="font-size:11.5px;color:var(--txt3);margin-top:2px;">${esc(selectedClient.name)} &nbsp;·&nbsp; <span class="mono">${ref}</span></div>
      </div>
    </div>
    <div class="metrics-grid" style="margin-bottom:12px;">
      ${mcCard('#EEF0FF', '#5B5BD6', '<path d="M9 2h6a1 1 0 011 1v2H8V3a1 1 0 011-1z"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><path d="M9 12h6M9 16h4"/>', 'SKUs counted', lines.length, `Out of ${skuRows.length} at this store`)}
      ${mcCard('#E7F7F0', '#12A171', '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>', 'Sellable units', sellable, 'Closing count, less damage')}
      ${mcCard('#FDECEC', '#E24B4A', '<circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/>', 'Damaged', damaged, 'Written off this visit')}
      ${mcCard('#FAF2DE', '#A97406', '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/>', 'Need reorder', reorder.length, `To hold ${DEFAULT_COVER_DAYS} days of cover`)}
    </div>
    ${reorder.length ? `<div class="alert aw"><span>&#128230;</span><span><strong>${reorder.length} SKU${reorder.length > 1 ? 's' : ''}</strong> should be reordered to hold ${DEFAULT_COVER_DAYS} days of cover: ${esc(reorder.slice(0, 4).map(l => `${l.name} (${l.suggested})`).join(', '))}${reorder.length > 4 ? '…' : ''}</span></div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-green" onclick="Stock.shareWhatsApp('${ref}')">Share on WhatsApp</button>
      <button class="btn btn-gold" onclick="Stock.exportExcel('${ref}')">Export to Excel</button>
      <button class="btn btn-royal" onclick="Stock.startNewCount()">Count another store</button>
    </div>
  </div>`;
  document.getElementById('screen-stock').scrollTo?.({ top: 0, behavior: 'smooth' });
  document.getElementById('sp-basket-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('Stock position submitted.', 'ok');
}

function startNewCount() {
  basket = {}; activeSku = null; selectedClient = null; skuRows = [];
  document.getElementById('sp-step1-card').classList.remove('hidden');
  document.getElementById('sp-step2-card').classList.add('hidden');
  document.getElementById('sp-step3-wrap').classList.add('hidden');
  document.getElementById('sp-basket-wrap').classList.add('hidden');
  document.getElementById('sp-basket-wrap').innerHTML = '';
  renderStores(); renderStepRail();
}

// ─── Draft (survives a dropped connection or a closed tab) ─────────────────
function saveDraft() {
  if (!selectedClient) return;
  localStorage.setItem('ktl_stock_draft', JSON.stringify({
    clientId: selectedClient.id, basket, at: Date.now()
  }));
}
async function restoreDraft() {
  const raw = localStorage.getItem('ktl_stock_draft');
  if (!raw) return;
  let d; try { d = JSON.parse(raw); } catch (e) { return; }
  if (!d.basket || !Object.keys(d.basket).length) return;
  if (Date.now() - d.at > 36e5 * 12) { localStorage.removeItem('ktl_stock_draft'); return; }
  const c = visibleClients.find(x => String(x.id) === String(d.clientId));
  if (!c) return;
  const n = Object.keys(d.basket).length;
  if (!confirm(`You have an unsubmitted count of ${n} SKU(s) at ${c.name}. Pick up where you left off?`)) {
    localStorage.removeItem('ktl_stock_draft'); return;
  }
  selectedClient = c;
  basket = d.basket;
  document.getElementById('sp-step1-card').classList.add('hidden');
  document.getElementById('sp-step2-card').classList.remove('hidden');
  skuRows = await loadSkusForClient(c);
  await loadLastCounts(c.id);
  document.getElementById('sp-step2-sub').textContent = skuRows.length
    ? `${skuRows.length} AIWIBI item${skuRows.length === 1 ? '' : 's'} this store has bought before. Tap one to count it.`
    : `No AIWIBI purchase history found for ${c.name} — nothing to count here yet.`;
  renderSkus(); renderBasket();
}

// ─── Share + export ─────────────────────────────────────────────────────────
function shareWhatsApp(ref) {
  const u = me();
  const lines = ref ? lastSubmittedLines : Object.values(basket).filter(l => l.closing != null);
  const oos = lines.filter(l => l.status === 'Out of stock');
  const low = lines.filter(l => l.status === 'Low' || l.status === 'Critical');
  let t = `*AIWIBI STOCK POSITION*\n${selectedClient.name}\n${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}\nRef: ${ref}\n\n`;
  t += `Counted by: ${u.full_name || u.email}\n`;
  t += `SKUs closed: ${lines.length}\n`;
  t += `Sellable units: ${lines.reduce((s, l) => s + l.sellable, 0)}\n`;
  t += `Damaged units: ${lines.reduce((s, l) => s + l.damaged, 0)}\n\n`;
  if (oos.length) t += `*OUT OF STOCK (${oos.length})*\n` + oos.map(l => `• ${l.name}`).join('\n') + '\n\n';
  if (low.length) t += `*RUNNING LOW (${low.length})*\n` + low.map(l => `• ${l.name} — ${l.sellable} left${l.daysCover !== null ? `, ${l.daysCover}d cover` : ''}`).join('\n') + '\n\n';
  const ro = lines.filter(l => l.suggested > 0);
  if (ro.length) t += `*SUGGESTED ORDER*\n` + ro.map(l => `• ${l.name} — ${l.suggested} units`).join('\n') + '\n';
  window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank');
}

async function exportExcel(ref) {
  const u = me();
  const lines = ref ? lastSubmittedLines : Object.values(basket).filter(l => l.closing != null);
  if (!lines.length) { toast('Nothing to export yet.', 'err'); return; }
  if (typeof ExcelJS === 'undefined') { toast('Export library did not load. Check your connection and try again.', 'err'); return; }
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Stock Position');
    ws.mergeCells('A1:L1');
    ws.getCell('A1').value = `AIWIBI STOCK POSITION — ${selectedClient.name}`;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1A3A6B' } };
    ws.getCell('A1').alignment = { horizontal: 'center' };
    ws.mergeCells('A2:L2');
    ws.getCell('A2').value = `${new Date().toLocaleString('en-GB')}  ·  Counted by ${u.full_name || u.email}${ref ? `  ·  ${ref}` : ''}`;
    ws.getCell('A2').font = { size: 10, color: { argb: 'FF6B6B67' } };
    ws.getCell('A2').alignment = { horizontal: 'center' };
    ws.addRow([]);

    const head = ws.addRow(['Store', 'Category', 'SKU', 'Size', 'Opening', 'Closing', 'Damaged', 'Damage reason', 'Sellable', 'Sold today', 'Days cover', 'Position']);
    head.eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3A6B' } };
      c.alignment = { horizontal: 'center', wrapText: true, vertical: 'middle' };
    });
    head.height = 30;

    lines.forEach(l => {
      const r = ws.addRow([selectedClient.name, l.category, l.sku, l.size, l.opening, l.closing,
        l.damaged, l.damageReason || '', l.sellable, l.sold ?? '\u2014',
        l.daysCover === null ? '—' : l.daysCover, l.status]);
      const colour = l.status === 'Out of stock' || l.status === 'Critical' ? 'FFFCEBEB'
                   : l.status === 'Low' ? 'FFFAEEDA'
                   : l.status === 'Overstocked' ? 'FFE8EEF8' : 'FFEAF3DE';
      r.getCell(12).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colour } };
      r.getCell(12).font = { bold: true, size: 10 };
      r.getCell(9).font = { bold: true };
    });

    const tot = ws.addRow(['TOTAL', '', '', '', lines.reduce((s, l) => s + l.opening, 0), lines.reduce((s, l) => s + l.closing, 0),
      lines.reduce((s, l) => s + l.damaged, 0), '',
      lines.reduce((s, l) => s + l.sellable, 0), lines.reduce((s, l) => s + (l.sold ?? 0), 0), '', '']);
    tot.eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F8' } }; });

    ws.columns.forEach((c, i) => { c.width = i === 0 ? 26 : i === 1 ? 32 : i === 2 ? 26 : i === 7 ? 18 : 13; });
    ws.views = [{ state: 'frozen', ySplit: 4 }];

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Stock Position — ${selectedClient.name} — ${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click(); URL.revokeObjectURL(a.href);
    toast('Excel file downloaded.', 'ok');
  } catch (e) { console.error(e); toast('Could not build the Excel file.', 'err'); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  RECENT COUNTS
// ═══════════════════════════════════════════════════════════════════════════
async function loadHistory() {
  const db = DB(); const u = me();
  const wrap = document.getElementById('sp-history-wrap');
  wrap.innerHTML = '<div class="empty-state">Loading...</div>';
  let q = db.from('stock_counts').select('*').order('counted_at', { ascending: false }).limit(50);
  if (roleRep()) q = q.eq('user_id', String(u.id));
  const { data, error } = await q;
  if (error) { wrap.innerHTML = `<div class="alert ad"><span>&#9888;</span><span>Could not load counts: ${esc(error.message)}. The <span class="mono">stock_counts</span> table may not exist yet.</span></div>`; return; }
  if (!data || !data.length) { wrap.innerHTML = '<div class="empty-state">No stock counts yet. Your first count will show up here.</div>'; return; }
  wrap.innerHTML = `<table>
    <thead><tr><th>Date</th><th>Store</th><th>Counted by</th><th style="text-align:right">SKUs</th>
    <th style="text-align:right">Sellable</th><th style="text-align:right">Damaged</th><th style="text-align:right">Out of stock</th><th>Ref</th></tr></thead>
    <tbody>${data.map(r => `<tr>
      <td>${new Date(r.counted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}</td>
      <td style="font-weight:600;">${esc(r.client_name)}</td>
      <td style="color:var(--txt2);">${esc(r.user_name)}</td>
      <td style="text-align:right">${r.total_skus ?? '—'}</td>
      <td style="text-align:right;font-weight:700;">${r.total_sellable ?? '—'}</td>
      <td style="text-align:right;${r.total_damaged ? 'color:var(--red);font-weight:600;' : ''}">${r.total_damaged ?? 0}</td>
      <td style="text-align:right">${r.oos_count ? `<span class="badge br">${r.oos_count}</span>` : '0'}</td>
      <td class="mono" style="color:var(--txt3);">${esc(r.ref || '')}</td>
    </tr>`).join('')}</tbody></table>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  WHO CAN COUNT STOCK (ADMIN / MANAGER)
// ═══════════════════════════════════════════════════════════════════════════
async function loadAccess() {
  const db = DB();
  const wrap = document.getElementById('sp-access-list');
  wrap.innerHTML = '<div class="empty-state">Loading...</div>';
  const [{ data: users }, acc] = await Promise.all([
    db.from('users').select('id,full_name,email,role,is_active').order('full_name'),
    db.from('stock_audit_access').select('user_id,can_access')
  ]);
  if (acc.error) { wrap.innerHTML = `<div class="alert ad"><span>&#9888;</span><span>Could not load access settings: ${esc(acc.error.message)}. Create the <span class="mono">stock_audit_access</span> table first.</span></div>`; return; }
  allUsers = (users || []).filter(u => u.is_active !== false);
  accessMap = {};
  (acc.data || []).forEach(r => { accessMap[String(r.user_id)] = r.can_access !== false; });
  renderAccess();
}

function renderAccess() {
  const q = (document.getElementById('sp-acc-search').value || '').toLowerCase();
  const list = allUsers.filter(u => !q || (u.full_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  const wrap = document.getElementById('sp-access-list');
  if (!list.length) { wrap.innerHTML = '<div class="empty-state">No one matches that search.</div>'; return; }
  wrap.innerHTML = list.map(u => {
    const always = ['admin', 'manager'].includes(u.role);
    const on = always || !!accessMap[String(u.id)];
    return `<div class="sp-acc-row">
      <div class="sp-acc-av">${initials(u.full_name || u.email)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12.5px;font-weight:600;">${esc(u.full_name || '—')}</div>
        <div style="font-size:11px;color:var(--txt3);">${esc(u.email || '')}</div>
      </div>
      <span class="badge ${always ? 'bgold' : 'bb'}" style="flex-shrink:0;">${esc((u.role || '').replace('_', ' '))}</span>
      ${always
        ? `<span style="font-size:10.5px;color:var(--txt3);width:40px;text-align:center;flex-shrink:0;">Always</span>`
        : `<label class="sp-sw"><input type="checkbox" ${on ? 'checked' : ''} onchange="Stock.setAccess('${u.id}',this.checked,this)"/><span></span></label>`}
    </div>`;
  }).join('');
}

async function setAccess(userId, on, el) {
  const db = DB(); const u = me();
  el.disabled = true;
  const { error } = await db.from('stock_audit_access').upsert({
    user_id: String(userId), can_access: on,
    granted_by: u.full_name || u.email,
    granted_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  el.disabled = false;
  if (error) { el.checked = !on; toast('Could not save: ' + error.message, 'err'); return; }
  accessMap[String(userId)] = on;
  const who = (allUsers.find(x => String(x.id) === String(userId))?.full_name) || 'That person';
  toast(on ? `${who} can now count stock.` : `${who} no longer has Stock Position.`, 'ok');
}

// ═══════════════════════════════════════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════════════════════════════════════
function switchTab(key) {
  document.querySelectorAll('#sp-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === key));
  document.querySelectorAll('#screen-stock .tc').forEach(c => c.classList.remove('active'));
  document.getElementById('sp-tc-' + key)?.classList.add('active');
  if (key === 'history') loadHistory();
  if (key === 'access')  loadAccess();
}

// ═══════════════════════════════════════════════════════════════════════════
//  INTEGRATION WITH THE HOST APP (nav, routing, boot)
// ═══════════════════════════════════════════════════════════════════════════
function injectNav(containerId, withClose) {
  const el = document.getElementById(containerId);
  if (!el || !me()) return;
  const allowed = roleMgr() || hasAccess === true;
  if (!allowed) return;
  const cb = withClose ? "goTo('stock');closeDrawer()" : "goTo('stock')";
  const html = `<div class="nav-sec">In Store</div>
    <div class="nav-item${stockActive ? ' active' : ''}" onclick="${cb}">
      <svg class="ni" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="${NAV_ICON}"/></svg>Stock Position
    </div>`;

  // Take the slot directly above "Performance" (falls back down the list
  // if that section is missing for this role).
  const secs = [...el.querySelectorAll('.nav-sec')];
  const sec  = n => secs.find(s => s.textContent.trim().toLowerCase() === n);
  const anchor = sec('performance') || sec('administration') || sec('account');
  if (anchor) anchor.insertAdjacentHTML('beforebegin', html);
  else el.insertAdjacentHTML('beforeend', html);
}

function goToStock() {
  if (!me()) return;
  ensureScreen();
  stockActive = true;
  try { currentScreen = 'stock'; } catch (e) { /* host uses a lexical binding */ }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-stock')?.classList.add('active');
  const title = document.getElementById('page-title');
  const mob   = document.getElementById('mob-screen');
  if (title) title.textContent = 'Stock Position';
  if (mob)   mob.textContent   = 'Stock Position';
  try { buildNav('sidebar-nav'); buildNav('drawer-nav', true); } catch (e) {}

  const allowed = roleMgr() || hasAccess === true;
  if (!allowed) {
    const tc = document.getElementById('sp-tc-count');
    if (tc) tc.innerHTML = deniedCardHtml();
    return;
  }
  if (roleMgr()) document.getElementById('sp-tab-access')?.classList.remove('hidden');

  if (!booted) { booted = true; bootData(); }
}

async function bootData() {
  const grid = document.getElementById('sp-store-grid');
  if (grid) grid.innerHTML = '<div class="empty-state">Loading your stores...</div>';
  await Promise.all([loadClients(), loadProducts()]);
  renderScopeBanner();
  renderStores();
  renderStepRail();
  restoreDraft();
}

function patchHost() {
  if (window.__spPatched) return;

  const origBuildNav = window.buildNav;
  if (typeof origBuildNav === 'function') {
    window.buildNav = function (containerId, withClose) {
      origBuildNav.apply(this, arguments);
      try { injectNav(containerId, withClose); } catch (e) { console.warn('[stock] nav:', e); }
    };
  }

  const origGoTo = window.goTo;
  if (typeof origGoTo === 'function') {
    window.goTo = function (screen) {
      if (screen === 'stock') { goToStock(); return; }
      stockActive = false;
      document.getElementById('screen-stock')?.classList.remove('active');
      return origGoTo.apply(this, arguments);
    };
  }

  const origSignOut = window.signOut;
  if (typeof origSignOut === 'function') {
    window.signOut = function () {
      booted = false; accessChecked = false; hasAccess = false; stockActive = false;
      visibleClients = []; allProducts = []; skuRows = []; lastCountMap = {};
      selectedClient = null; activeSku = null; basket = {}; hideCounted = false;
      collapsedCats = {}; allUsers = []; accessMap = {};
      return origSignOut.apply(this, arguments);
    };
  }

  window.__spPatched = true;
}

// ─── BOOT ────────────────────────────────────────────────────────────────
function waitForApp() {
  const app = document.getElementById('app');
  const signedIn = !!me() && app && !app.classList.contains('hidden');
  if (!signedIn) return;

  injectStyles();
  ensureScreen();
  try { buildNav('sidebar-nav'); buildNav('drawer-nav', true); } catch (e) {}

  if (!accessChecked) {
    (async () => {
      hasAccess = await checkAccess();
      accessChecked = true;
      try { buildNav('sidebar-nav'); buildNav('drawer-nav', true); } catch (e) {}
      if (stockActive) goToStock();
    })();
  }

  clearInterval(bootTimer);
}

patchHost();
const bootTimer = setInterval(waitForApp, 600);
document.addEventListener('DOMContentLoaded', () => { patchHost(); waitForApp(); });

// ─── PUBLIC API (used by inline onclick handlers) ──────────────────────────
window.Stock = {
  goTo: goToStock, switchTab,
  renderStores, pickStore, goStep1, goStep2,
  toggleHideCounted, toggleCat, renderSkus,
  openCount, bump, pickReason, closePanel, recalcClosing,
  saveOpening, saveClosing, editOpening, editClosing, removeSku,
  clearBasket, submitCount, startNewCount, shareWhatsApp, exportExcel,
  loadHistory, loadAccess, renderAccess, setAccess,
};

console.log('%c[KTL] Stock Position module ready', 'color:#1a3a6b;font-weight:700');
})();