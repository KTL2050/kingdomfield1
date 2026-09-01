/* ═══════════════════════════════════════════════════════════════════════════
   KTLSALES — REPORTS CENTRE
   A Zoho-Inventory-style reporting module. Drop-in file; add ONE line to
   clockin.html just before </body>:

       <script src="ktl-reports.js"></script>

   It takes over the existing Reports screen, reusing the app's Supabase
   client (sb), session (currentUser), role helpers, and CSS. The old Reports
   markup is hidden rather than deleted, so nothing else breaks.
 
   Reports included
     Listings   — by store, by sales rep, by rep & store, listing detail,
                  products listed detail, daily summary
     Attendance — detail (clock in/out), summary by employee, late arrivals,
                  missing clock-outs, daily attendance
     Leave      — request detail, summary by employee, by type, by status,
                  current & upcoming leave
     Wallet     — points by rep, payout requests, payout summary
     Stock      — position by store, position by rep, count detail, item
                  detail, daily summary, reorder suggestions, damage detail
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CFG = {
  lateHour:      9,        // clock-in at or after 09:00 counts as late
  pointsPerItem: 1,        // wallet points earned per product listed
  ugxPerPoint:   1000,
  rowLimit:      8000,     // safety cap on any single query
  countedStatuses: ['submitted', 'fulfilled'],   // listings that count as real
};

// ─── STATE ─────────────────────────────────────────────────────────────────
const S = {
  mounted:   false,
  view:      'home',            // home | report
  reportId:  null,
  cat:       'all',
  search:    '',
  favs:      JSON.parse(localStorage.getItem('ktl_report_favs') || '[]'),
  visited:   JSON.parse(localStorage.getItem('ktl_report_visits') || '{}'),
  // active report run
  preset:    'this_month',
  from:      '',
  to:        '',
  filters:   { rep:'', store:'', status:'', q:'', leaveType:'' },
  conds:     [],                // More Filters: {field, op, value, value2}
  sort:      { key:null, dir:'desc' },
  rows:      [],
  cols:      [],
  running:   false,
  hidden:    {},                // column key -> true when hidden
  // caches
  cache:     {},
  users:     [],
  clients:   [],
  leaveTypes:[],
};

// ─── HOST APP ACCESS ───────────────────────────────────────────────────────
function me()        { try { return currentUser || null; } catch (e) { return null; } }
function DB()        { try { return sb; } catch (e) { return null; } }
function roleRep()   { try { return isSalesRep(); } catch (e) { return me()?.role === 'sales_rep'; } }
function roleAdmin() { try { return canAdmin();   } catch (e) { return me()?.role === 'admin'; } }

// ─── SMALL HELPERS ─────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function iso(d) { const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset()*60000).toISOString().split('T')[0]; }
function parseD(s) { if (!s) return null; const p = String(s).split('T')[0].split('-').map(Number); return new Date(p[0], p[1]-1, p[2]); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function todayISO() { return iso(new Date()); }

function fmtDate(v) { const d = parseD(v); return d ? d.toLocaleDateString('en-UG', { day:'2-digit', month:'short', year:'numeric' }) : '—'; }
function fmtDateTime(v) { return v ? new Date(v).toLocaleString('en-UG', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'; }
function fmtTime(v) { return v ? new Date(v).toLocaleTimeString('en-UG', { hour:'2-digit', minute:'2-digit' }) : '—'; }
function fmtNum(v) { return Number(v || 0).toLocaleString('en-UG'); }
function fmtMoney(v) { return 'UGX ' + Number(v || 0).toLocaleString('en-UG', { maximumFractionDigits: 0 }); }
function fmtHours(v) {
  if (v == null || isNaN(v)) return '—';
  const h = Math.floor(v), m = Math.round((v - h) * 60);
  return `${h}h ${String(m).padStart(2,'0')}m`;
}

function fmtCell(val, type) {
  if (val == null || val === '') return '—';
  switch (type) {
    case 'money':    return fmtMoney(val);
    case 'num':      return fmtNum(val);
    case 'date':     return fmtDate(val);
    case 'datetime': return fmtDateTime(val);
    case 'time':     return fmtTime(val);
    case 'hours':    return fmtHours(val);
    case 'pct':      return Number(val).toFixed(1) + '%';
    default:         return String(val);
  }
}
const isNumericType = t => ['num','money','pct','hours'].includes(t);

function userName(id) {
  const u = S.users.find(x => String(x.id) === String(id));
  return u ? u.full_name : (id ? 'Unknown user' : '—');
}

function toast(msg, kind) {
  document.getElementById('rpt-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'rpt-toast';
  el.className = 'rpt-toast';
  el.style.background = kind === 'error' ? '#A32D2D' : kind === 'warn' ? '#854F0B' : '#1D9E75';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3000);
  setTimeout(() => el.remove(), 3400);
}

// ─── DATE PRESETS ──────────────────────────────────────────────────────────
const PRESETS = [
  { id:'today',        label:'Today' },
  { id:'yesterday',    label:'Yesterday' },
  { id:'this_week',    label:'This Week' },
  { id:'last_week',    label:'Last Week' },
  { id:'this_month',   label:'This Month' },
  { id:'last_month',   label:'Last Month' },
  { id:'last_7',       label:'Last 7 Days' },
  { id:'last_30',      label:'Last 30 Days' },
  { id:'last_90',      label:'Last 90 Days' },
  { id:'this_quarter', label:'This Quarter' },
  { id:'this_year',    label:'This Year' },
  { id:'last_year',    label:'Last Year' },
  { id:'all',          label:'All Time' },
  { id:'custom',       label:'Custom' },
];

function resolveRange(preset) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const startOfWeek = d => { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); return x; };
  switch (preset) {
    case 'today':        return { from: todayISO(), to: todayISO() };
    case 'yesterday':    { const d = iso(addDays(now, -1)); return { from: d, to: d }; }
    case 'this_week':    return { from: iso(startOfWeek(now)), to: todayISO() };
    case 'last_week':    { const s = addDays(startOfWeek(now), -7); return { from: iso(s), to: iso(addDays(s, 6)) }; }
    case 'this_month':   return { from: iso(new Date(y, m, 1)), to: todayISO() };
    case 'last_month':   return { from: iso(new Date(y, m-1, 1)), to: iso(new Date(y, m, 0)) };
    case 'last_7':       return { from: iso(addDays(now, -6)), to: todayISO() };
    case 'last_30':      return { from: iso(addDays(now, -29)), to: todayISO() };
    case 'last_90':      return { from: iso(addDays(now, -89)), to: todayISO() };
    case 'this_quarter': return { from: iso(new Date(y, Math.floor(m/3)*3, 1)), to: todayISO() };
    case 'this_year':    return { from: iso(new Date(y, 0, 1)), to: todayISO() };
    case 'last_year':    return { from: iso(new Date(y-1, 0, 1)), to: iso(new Date(y-1, 11, 31)) };
    case 'all':          return { from: '2000-01-01', to: '2099-12-31' };
    default:             return { from: S.from || iso(new Date(y, m, 1)), to: S.to || todayISO() };
  }
}
function rangeLabel() {
  if (S.preset === 'all') return 'All time';
  return `From ${fmtDate(S.from)} To ${fmtDate(S.to)}`;
}

// ─── STYLES ────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('rpt-styles')) return;
  const css = `
/* ═══ REPORTS CENTRE — "ledger sheet" visual system ════════════════════════
   The report body is treated as a printed statement: serif masthead, hairline
   rules, tabular figures, a ruled totals line. The app chrome stays as it is;
   everything here is scoped to #rpt-root so nothing else shifts.           */
#rpt-root{
  --rp-ink:#12233F;
  --rp-royal:#1A3A6B;      --rp-royal-soft:#EAF0F8;
  --rp-gold:#A97406;       --rp-gold-soft:#FAF2DE;
  --rp-teal:#0F766E;       --rp-teal-soft:#E3F1EF;
  --rp-paper:#FFFFFF;      --rp-canvas:#F6F7F9;
  --rp-rule:#EAEAE4;       --rp-rule-mid:#D8D9D3;  --rp-rule-strong:#1A3A6B;
  --rp-txt:#1F2024;        --rp-txt2:#575C68;  --rp-txt3:#8B909B;
  --rp-pos:#1D7A5A;        --rp-neg:#A32D2D;
  --rp-serif:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,'Times New Roman',serif;
  color:var(--rp-txt);
}
#rpt-root .num,#rpt-root .rp-fig,#rpt-root td.r,#rpt-root .rp-stamp-v{
  font-variant-numeric:tabular-nums lining-nums;font-feature-settings:"tnum" 1,"lnum" 1;
}

/* ── Page heading ─────────────────────────────────────────────────────── */
.rp-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:18px;}
.rp-kicker{font-size:9.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--rp-gold);}
.rp-h1{font-family:var(--rp-serif);font-size:29px;font-weight:600;letter-spacing:-.015em;line-height:1.1;color:var(--rp-ink);margin-top:5px;}
.rp-lede{font-size:12.5px;color:var(--rp-txt2);margin-top:6px;max-width:52ch;line-height:1.55;}
.rp-find{position:relative;min-width:250px;flex:0 1 320px;}
.rp-find input{width:100%;padding:10px 13px 10px 34px;border:none;border-bottom:1.5px solid var(--rp-rule-mid);background:transparent;font-size:13px;font-family:inherit;color:var(--rp-txt);transition:border-color .18s;}
.rp-find input::placeholder{color:var(--rp-txt3);}
.rp-find input:focus{outline:none;border-bottom-color:var(--rp-royal);}
.rp-find svg{position:absolute;left:6px;top:50%;transform:translateY(-50%);color:var(--rp-txt3);}

/* ── Layout ───────────────────────────────────────────────────────────── */
.rp-grid{display:grid;grid-template-columns:212px 1fr;gap:26px;align-items:start;}
.rp-rail{position:sticky;top:8px;}
.rp-rail-hd{font-size:9px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--rp-txt3);padding:0 0 9px 13px;}
.rp-rail-i{display:flex;align-items:center;gap:10px;padding:9px 13px;border-left:2px solid transparent;font-size:12.5px;color:var(--rp-txt2);cursor:pointer;transition:color .15s,border-color .15s,background .15s;}
.rp-rail-i:hover{color:var(--rp-ink);background:rgba(26,58,107,.035);}
.rp-rail-i.on{border-left-color:var(--rp-royal);color:var(--rp-ink);font-weight:600;background:rgba(26,58,107,.05);}
.rp-rail-i .c{margin-left:auto;font-size:11px;color:var(--rp-txt3);font-variant-numeric:tabular-nums;}
.rp-rail-i.on .c{color:var(--rp-royal);}
.rp-rail-sep{height:1px;background:var(--rp-rule);margin:11px 0 13px 13px;}

/* ── Report index ─────────────────────────────────────────────────────── */
.rp-list{background:var(--rp-paper);border:1px solid var(--rp-rule);border-radius:3px;overflow:hidden;box-shadow:0 1px 2px rgba(18,35,63,.04);}
.rp-item{display:grid;grid-template-columns:38px 1fr 118px 132px;gap:16px;align-items:center;padding:15px 20px;border-bottom:1px solid var(--rp-rule);cursor:pointer;transition:background .14s;position:relative;}
.rp-item:last-child{border-bottom:none;}
.rp-item::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--rp-accent,transparent);opacity:0;transition:opacity .14s;}
.rp-item:hover{background:var(--rp-canvas);}
.rp-item:hover::before{opacity:1;}
.rp-glyph{width:38px;height:38px;border-radius:2px;display:flex;align-items:center;justify-content:center;background:var(--rp-tint);color:var(--rp-accent);flex-shrink:0;}
.rp-item-name{font-family:var(--rp-serif);font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--rp-ink);line-height:1.25;}
.rp-item-desc{font-size:11.5px;color:var(--rp-txt2);margin-top:3px;line-height:1.5;}
.rp-item-meta{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--rp-txt3);font-weight:600;}
.rp-item-seen{font-size:11.5px;color:var(--rp-txt2);font-variant-numeric:tabular-nums;}
.rp-item-seen.never{color:var(--rp-txt3);}
.rp-star{position:absolute;right:14px;top:13px;font-size:13px;line-height:1;color:var(--rp-rule-mid);cursor:pointer;user-select:none;transition:color .14s,transform .14s;}
.rp-star:hover{transform:scale(1.18);color:var(--rp-gold);}
.rp-star.on{color:var(--rp-gold);}
.rp-idx-hd{display:grid;grid-template-columns:38px 1fr 118px 132px;gap:16px;padding:11px 20px;background:var(--rp-canvas);border-bottom:1px solid var(--rp-rule);font-size:9px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--rp-txt3);}

/* ── Toolbar ──────────────────────────────────────────────────────────── */
.rp-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px;}
.rp-back{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:600;letter-spacing:.03em;color:var(--rp-txt2);background:none;border:none;cursor:pointer;padding:6px 0;font-family:inherit;transition:color .15s;}
.rp-back:hover{color:var(--rp-royal);}
.rp-seg{display:inline-flex;border:1px solid var(--rp-rule-mid);border-radius:3px;overflow:hidden;background:var(--rp-paper);}
.rp-seg button{border:none;background:none;padding:8px 13px;font-size:11.5px;font-family:inherit;font-weight:500;color:var(--rp-txt2);cursor:pointer;border-right:1px solid var(--rp-rule);display:inline-flex;align-items:center;gap:6px;transition:background .14s,color .14s;}
.rp-seg button:last-child{border-right:none;}
.rp-seg button:hover{background:var(--rp-canvas);color:var(--rp-ink);}
.rp-seg button.gold{background:var(--rp-gold);color:#fff;font-weight:600;}
.rp-seg button.gold:hover{background:#96660A;color:#fff;}
.rp-seg .n{font-variant-numeric:tabular-nums;color:var(--rp-royal);font-weight:700;}

/* ── Filter strip ─────────────────────────────────────────────────────── */
.rp-filters{display:flex;align-items:center;gap:0;flex-wrap:wrap;background:var(--rp-paper);border:1px solid var(--rp-rule);border-bottom:none;border-radius:3px 3px 0 0;padding:0 4px;}
.rp-f{display:flex;flex-direction:column;gap:1px;padding:9px 14px;border-right:1px solid var(--rp-rule);min-width:0;}
.rp-f:last-of-type{border-right:none;}
.rp-f label{font-size:8.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--rp-txt3);}
.rp-f select,.rp-f input{border:none;background:transparent;font-size:12.5px;font-family:inherit;font-weight:500;color:var(--rp-ink);padding:1px 0;max-width:180px;cursor:pointer;}
.rp-f select:focus,.rp-f input:focus{outline:none;color:var(--rp-royal);}
.rp-f-act{margin-left:auto;display:flex;align-items:center;gap:7px;padding:8px 10px 8px 14px;}
.rp-run{background:var(--rp-royal);color:#fff;border:none;padding:9px 18px;border-radius:3px;font-size:12px;font-weight:600;font-family:inherit;letter-spacing:.02em;cursor:pointer;transition:background .15s;}
.rp-run:hover{background:#142E56;}
.rp-run:disabled{opacity:.55;cursor:default;}
.rp-ghost{background:none;border:none;font-size:11.5px;color:var(--rp-txt2);cursor:pointer;font-family:inherit;padding:8px 6px;transition:color .15s;}
.rp-ghost:hover{color:var(--rp-royal);}

/* ── Conditions ───────────────────────────────────────────────────────── */
.rp-conds{background:var(--rp-canvas);border:1px solid var(--rp-rule);border-bottom:none;padding:13px 18px;}
.rp-cond{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;}
.rp-cond .n{width:20px;height:20px;border-radius:2px;background:var(--rp-ink);color:#fff;font-size:9.5px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-variant-numeric:tabular-nums;}
.rp-cond select,.rp-cond input{border:1px solid var(--rp-rule-mid);background:var(--rp-paper);border-radius:3px;padding:7px 9px;font-size:12px;font-family:inherit;color:var(--rp-txt);}
.rp-cond select:focus,.rp-cond input:focus{outline:none;border-color:var(--rp-royal);}
.rp-cond .x{border:none;background:none;color:var(--rp-txt3);cursor:pointer;font-size:13px;padding:4px 6px;}
.rp-cond .x:hover{color:var(--rp-neg);}

/* ── The sheet ────────────────────────────────────────────────────────── */
.rp-sheet{background:var(--rp-paper);border:1px solid var(--rp-rule);border-radius:0 0 3px 3px;box-shadow:0 1px 3px rgba(18,35,63,.05);animation:rp-in .28s ease-out;}
@keyframes rp-in{from{opacity:0;transform:translateY(3px);}to{opacity:1;transform:none;}}
.rp-mast{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:30px 30px 0;}
.rp-org{font-size:9.5px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--rp-txt3);}
.rp-title{font-family:var(--rp-serif);font-size:26px;font-weight:600;letter-spacing:-.02em;color:var(--rp-ink);margin-top:7px;line-height:1.12;}
.rp-range{font-size:12px;color:var(--rp-txt2);margin-top:8px;}
.rp-range b{font-weight:600;color:var(--rp-txt);}
.rp-applied{font-size:11.5px;color:var(--rp-txt2);margin-top:5px;}
.rp-applied .tag{display:inline-block;background:var(--rp-royal-soft);color:var(--rp-royal);border-radius:2px;padding:2px 7px;margin-right:5px;font-size:11px;font-weight:600;}
.rp-stamp{display:grid;grid-template-columns:auto auto;gap:3px 14px;text-align:right;border-right:2px solid var(--rp-gold);padding-right:14px;}
.rp-stamp-k{font-size:8.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--rp-txt3);}
.rp-stamp-v{font-size:11.5px;color:var(--rp-txt);font-weight:500;}
.rp-figline{display:flex;gap:0;flex-wrap:wrap;margin:22px 30px 0;border-top:1px solid var(--rp-rule);border-bottom:2px solid var(--rp-ink);}
.rp-fig-i{padding:13px 26px 13px 0;margin-right:26px;border-right:1px solid var(--rp-rule);}
.rp-fig-i:last-child{border-right:none;margin-right:0;}
.rp-fig-v{font-family:var(--rp-serif);font-size:22px;font-weight:600;letter-spacing:-.02em;color:var(--rp-ink);line-height:1;font-variant-numeric:tabular-nums;}
.rp-fig-k{font-size:9px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--rp-txt3);margin-top:6px;}

/* ── Table ────────────────────────────────────────────────────────────── */
.rp-scroll{overflow:auto;max-height:calc(100vh - 400px);margin-top:2px;}
table.rp-tbl{width:100%;border-collapse:collapse;}
table.rp-tbl th{position:sticky;top:0;z-index:2;background:var(--rp-paper);padding:13px 14px 9px;text-align:left;font-size:9px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--rp-txt3);white-space:nowrap;cursor:pointer;border-bottom:1px solid var(--rp-rule-mid);transition:color .14s;}
table.rp-tbl th:first-child{padding-left:30px;}
table.rp-tbl th:last-child{padding-right:30px;}
table.rp-tbl th:hover{color:var(--rp-royal);}
table.rp-tbl th.r{text-align:right;}
table.rp-tbl th.sorted{color:var(--rp-ink);}
.rp-caret{font-size:7px;margin-left:4px;color:var(--rp-gold);}
table.rp-tbl td{padding:12px 14px;font-size:12.5px;border-bottom:1px solid var(--rp-rule);vertical-align:top;color:var(--rp-txt);line-height:1.45;}
table.rp-tbl td:first-child{padding-left:30px;}
table.rp-tbl td:last-child{padding-right:30px;}
table.rp-tbl td.r{text-align:right;white-space:nowrap;}
table.rp-tbl tbody tr{transition:background .12s;}
table.rp-tbl tbody tr:hover{background:var(--rp-canvas);}
.rp-lead{font-weight:600;color:var(--rp-ink);}
.rp-rank{font-family:var(--rp-serif);font-size:13px;color:var(--rp-txt3);width:34px;padding-right:0!important;}
.rp-rank.top{color:var(--rp-gold);font-weight:600;}
.rp-primary{position:relative;}
.rp-primary .rp-fig{font-weight:600;font-size:13px;color:var(--rp-ink);}
.rp-share{display:block;height:2px;background:var(--rp-accent,var(--rp-royal));opacity:.85;margin-top:6px;margin-left:auto;border-radius:1px;transition:width .3s ease-out;}
.rp-muted{color:var(--rp-txt3);}
table.rp-tbl tfoot td{padding:14px;font-size:12.5px;font-weight:700;color:var(--rp-ink);border-top:2px solid var(--rp-ink);border-bottom:none;background:var(--rp-paper);}
table.rp-tbl tfoot td:first-child{padding-left:30px;font-family:var(--rp-serif);font-weight:600;letter-spacing:-.01em;}
table.rp-tbl tfoot td:last-child{padding-right:30px;}
.rp-foot{padding:14px 30px 22px;font-size:10.5px;color:var(--rp-txt3);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;}

/* ── Chips, badges, states ────────────────────────────────────────────── */
.rp-chip{display:inline-block;font-size:10.5px;font-weight:600;letter-spacing:.04em;padding:2px 8px;border-radius:2px;text-transform:uppercase;}
.rp-chip.ok{background:var(--rp-teal-soft);color:var(--rp-teal);}
.rp-chip.warn{background:var(--rp-gold-soft);color:var(--rp-gold);}
.rp-chip.bad{background:#FBEBEB;color:var(--rp-neg);}
.rp-chip.neut{background:var(--rp-royal-soft);color:var(--rp-royal);}
.rp-chip.grey{background:#F0F0EC;color:var(--rp-txt2);}
.rp-empty{padding:64px 30px;text-align:center;}
.rp-empty-mark{font-family:var(--rp-serif);font-size:34px;color:var(--rp-rule-mid);line-height:1;}
.rp-empty-t{font-family:var(--rp-serif);font-size:17px;font-weight:600;color:var(--rp-ink);margin-top:14px;}
.rp-empty-d{font-size:12.5px;color:var(--rp-txt2);margin-top:7px;line-height:1.6;}
.rp-skel{height:11px;border-radius:2px;background:linear-gradient(90deg,#EFEFEA 25%,#F7F7F4 50%,#EFEFEA 75%);background-size:400% 100%;animation:rp-shim 1.3s ease-in-out infinite;}
@keyframes rp-shim{0%{background-position:100% 0;}100%{background-position:0 0;}}
.rpt-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);color:#fff;padding:12px 20px;border-radius:3px;font-size:12.5px;font-weight:500;letter-spacing:.01em;z-index:99999;box-shadow:0 8px 28px rgba(18,35,63,.28);transition:opacity .35s;}
.rpt-toast.out{opacity:0;}
.rpt-drop{position:absolute;background:var(--rp-paper,#fff);border:1px solid #D8D9D3;border-radius:3px;box-shadow:0 12px 34px rgba(18,35,63,.16);padding:5px;z-index:9500;min-width:210px;max-height:330px;overflow-y:auto;}
.rpt-drop-hd{padding:9px 11px 7px;font-size:8.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8B909B;}
.rpt-drop-item{padding:8px 11px;border-radius:2px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:9px;color:#1F2024;}
.rpt-drop-item:hover{background:#F6F7F9;}

#rpt-root :focus-visible{outline:2px solid var(--rp-royal);outline-offset:2px;}
@media(prefers-reduced-motion:reduce){#rpt-root *,#rpt-root *::before{animation:none!important;transition:none!important;}}
@media(max-width:960px){
  .rp-grid{grid-template-columns:1fr;gap:16px;}
  .rp-rail{position:static;display:flex;gap:4px;overflow-x:auto;padding-bottom:4px;}
  .rp-rail-hd,.rp-rail-sep{display:none;}
  .rp-rail-i{border-left:none;border-bottom:2px solid transparent;white-space:nowrap;}
  .rp-rail-i.on{border-left:none;border-bottom-color:var(--rp-royal);}
  .rp-item,.rp-idx-hd{grid-template-columns:32px 1fr;}
  .rp-item-meta,.rp-item-seen{display:none;}
  .rp-mast{flex-direction:column;padding:22px 18px 0;}
  .rp-stamp{border-right:none;border-left:2px solid var(--rp-gold);padding:0 0 0 12px;text-align:left;}
  .rp-figline{margin:18px 18px 0;}
  table.rp-tbl th:first-child,table.rp-tbl td:first-child{padding-left:18px;}
  table.rp-tbl th:last-child,table.rp-tbl td:last-child{padding-right:18px;}
  .rp-scroll{max-height:none;}
  .rp-h1{font-size:23px;}
}`;
  const el = document.createElement('style');
  el.id = 'rpt-styles';
  el.textContent = css;
  document.head.appendChild(el);
}

// ═══════════════════════════════════════════════════════════════════════════
//  DATA LAYER — every fetch is cached per date range so sorting and
//  filtering never re-query the database.
// ═══════════════════════════════════════════════════════════════════════════
async function loadRefData() {
  if (S.users.length && S.clients.length && S.leaveTypes.length) return;
  const [u, c, lt] = await Promise.all([
    DB().from('users').select('id,full_name,email,role,is_active').order('full_name'),
    DB().from('clients').select('id,name').order('name'),
    DB().from('leave_types').select('id,name').order('sort_order'),
  ]);
  S.users      = u.data || [];
  S.clients    = c.data || [];
  S.leaveTypes = lt.data || [];
}

function cacheKey(kind) { return `${kind}|${S.from}|${S.to}`; }

async function fetchOrders() {
  const key = cacheKey('orders');
  if (S.cache[key]) return S.cache[key];
  const { data, error } = await DB().from('orders').select('*')
    .gte('order_date', S.from).lte('order_date', S.to)
    .order('order_date', { ascending: false }).limit(CFG.rowLimit);
  if (error) throw new Error('Listings: ' + error.message);
  S.cache[key] = data || [];
  return S.cache[key];
}

/** order_items carries no date of its own, so it is fetched by parent order. */
async function fetchOrderItems(orders) {
  const key = cacheKey('items');
  if (S.cache[key]) return S.cache[key];
  const ids = orders.map(o => o.id);
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {          // chunked: URLs have limits
    const { data, error } = await DB().from('order_items').select('*').in('order_id', ids.slice(i, i+200));
    if (error) throw new Error('Listing items: ' + error.message);
    out.push(...(data || []));
  }
  S.cache[key] = out;
  return out;
}

/** Confirmed-purchase count per order — an item only counts once it's been
 *  matched against a real Zoho invoice for that client, on or after the
 *  listing date. Reuses the exact same matching engine as the rep Wallet
 *  and each client's "Successful Listing" tab (_w* helpers, defined in the
 *  main clockin.html script), so these reports agree with what reps see. */
async function fetchConfirmedByOrder() {
  const key = cacheKey('confirmed');
  if (S.cache[key]) return S.cache[key];

  const orders = await fetchOrders();   // full period set, unfiltered by rep/store/status
  const items  = await fetchOrderItems(orders);

  const itemsByOrder = {};
  items.forEach(it => (itemsByOrder[it.order_id] || (itemsByOrder[it.order_id] = [])).push(it));

  const M = _wBuildProductMaps();
  const clientIds = Array.from(new Set(orders.map(o => o.client_id).filter(Boolean)));
  const sinceDate = orders.reduce((min, o) => {
    const d = o.order_date || '';
    return d && (!min || d < min) ? d : min;
  }, '');
  const history = await _wBuildPurchaseHistory(clientIds, sinceDate);

  const byOrder = {};
  orders.forEach(o => {
    const cid = String(o.client_id || '');
    byOrder[o.id] = cid
      ? _wConfirmedForOrder(o, itemsByOrder[o.id] || [], history.get(cid) || [], M)
      : 0;
  });

  S.cache[key] = byOrder;
  return byOrder;
}

async function fetchAttendance() {
  const key = cacheKey('att');
  if (S.cache[key]) return S.cache[key];
  const { data, error } = await DB().from('attendance').select('*')
    .gte('clock_in', S.from + 'T00:00:00').lte('clock_in', S.to + 'T23:59:59')
    .order('clock_in', { ascending: false }).limit(CFG.rowLimit);
  if (error) throw new Error('Attendance: ' + error.message);
  S.cache[key] = data || [];
  return S.cache[key];
}

async function fetchPayouts() {
  const key = cacheKey('payouts');
  if (S.cache[key]) return S.cache[key];
  const { data, error } = await DB().from('payout_requests').select('*').limit(CFG.rowLimit);
  if (error) { console.warn('[reports] payouts:', error.message); S.cache[key] = []; return []; }
  const inRange = (data || []).filter(p => {
    const d = (p.requested_at || p.approved_at || '').split('T')[0];
    return !d || (d >= S.from && d <= S.to);
  });
  S.cache[key] = inRange;
  return inRange;
}

/** Leave requests overlapping the selected period — a leave spanning the
    range boundary still counts, same convention as orders/attendance. */
async function fetchLeave() {
  const key = cacheKey('leave');
  if (S.cache[key]) return S.cache[key];
  const { data, error } = await DB().from('leave_requests').select('*')
    .lte('start_date', S.to).gte('end_date', S.from)
    .order('start_date', { ascending: false }).limit(CFG.rowLimit);
  if (error) { console.warn('[reports] leave:', error.message); S.cache[key] = []; return []; }
  S.cache[key] = data || [];
  return S.cache[key];
}

/** Stock position headers — one row per store visit submitted through the
    Stock Position module. Tolerates a missing table (feature not set up
    yet) the same way payouts/leave do, rather than failing the whole run. */
async function fetchStockCounts() {
  const key = cacheKey('stockcounts');
  if (S.cache[key]) return S.cache[key];
  const { data, error } = await DB().from('stock_counts').select('*')
    .gte('counted_at', S.from + 'T00:00:00').lte('counted_at', S.to + 'T23:59:59')
    .order('counted_at', { ascending: false }).limit(CFG.rowLimit);
  if (error) { console.warn('[reports] stock_counts:', error.message); S.cache[key] = []; return []; }
  S.cache[key] = data || [];
  return S.cache[key];
}
/** stock_count_items carries no date of its own, so it is fetched by parent
    count header — same chunked-by-200 pattern as order items. */
async function fetchStockCountItems(counts) {
  const key = cacheKey('stockitems');
  if (S.cache[key]) return S.cache[key];
  const ids = counts.map(c => c.id);
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await DB().from('stock_count_items').select('*').in('count_id', ids.slice(i, i + 200));
    if (error) { console.warn('[reports] stock_count_items:', error.message); continue; }
    out.push(...(data || []));
  }
  S.cache[key] = out;
  return out;
}
function applyStockCountFilters(counts) {
  const f = S.filters;
  return counts.filter(c => {
    if (f.rep   && String(c.user_id)   !== f.rep)   return false;
    if (f.store && String(c.client_id) !== f.store) return false;
    return true;
  });
}

/** Listings that count toward performance — drafts and cancellations excluded. */
function countedOrders(orders) {
  return orders.filter(o => CFG.countedStatuses.includes(o.status));
}
function applyOrderFilters(orders) {
  const f = S.filters;
  return orders.filter(o => {
    if (f.rep    && String(o.created_by) !== f.rep)  return false;
    if (f.store  && String(o.client_id)  !== f.store) return false;
    if (f.status && o.status !== f.status)            return false;
    return true;
  });
}
function hoursBetween(a, b) {
  if (!a || !b) return null;
  return (new Date(b) - new Date(a)) / 3600000;
}

// ═══════════════════════════════════════════════════════════════════════════
//  REPORT DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════
const REPORTS = [

// ── LISTINGS ──────────────────────────────────────────────────────────────
{
  id:'listings-by-store', ranked:true, cat:'Listings', name:'Listings by Store',
  desc:'Top stores ranked by how many products have been listed at each one.',
  filters:['rep','status'],
  cols:[
    { key:'store',      label:'Store',            type:'text' },
    { key:'products',   label:'Products Listed',  type:'num',  total:true, r:true },
    { key:'listings',   label:'Listing Count',    type:'num',  total:true, r:true },
    { key:'reps',       label:'Reps Involved',    type:'num',  r:true },
    { key:'avg',        label:'Avg per Listing',  type:'num',  r:true },
    { key:'last',       label:'Last Listing',     type:'date' },
  ],
  async run() {
    const orders = countedOrders(applyOrderFilters(await fetchOrders()));
    const byOrder = await fetchConfirmedByOrder();

    const g = {};
    orders.forEach(o => {
      const confirmed = byOrder[o.id] || 0;
      if (confirmed === 0) return;   // only count listings the store actually bought from
      const k = String(o.client_id || 'none');
      if (!g[k]) g[k] = { store:o.client_name || 'Unknown store', products:0, listings:0, reps:new Set(), last:null };
      g[k].products += confirmed;
      g[k].listings += 1;
      if (o.created_by) g[k].reps.add(String(o.created_by));
      if (!g[k].last || o.order_date > g[k].last) g[k].last = o.order_date;
    });
    return Object.values(g).map(r => ({
      store: r.store, products: r.products, listings: r.listings,
      reps: r.reps.size, avg: r.listings ? +(r.products / r.listings).toFixed(1) : 0, last: r.last,
    })).sort((a, b) => b.products - a.products);
  },
},

{
  id:'listings-by-rep', ranked:true, cat:'Listings', name:'Listings by Sales Rep',
  desc:'Products listed by each sales rep across all stores. Filter by store to see one store only.',
  filters:['store','status'],
  cols:[
    { key:'rep',       label:'Sales Rep',        type:'text' },
    { key:'products',  label:'Products Listed',  type:'num',  total:true, r:true },
    { key:'listings',  label:'Listing Count',    type:'num',  total:true, r:true },
    { key:'stores',    label:'Stores Covered',   type:'num',  r:true },
    { key:'avg',       label:'Avg per Listing',  type:'num',  r:true },
    { key:'share',     label:'Share of Total',   type:'pct',  r:true },
    { key:'last',      label:'Last Activity',    type:'date' },
  ],
  async run() {
    const orders = countedOrders(applyOrderFilters(await fetchOrders()));
    const byOrder = await fetchConfirmedByOrder();

    const g = {};
    orders.forEach(o => {
      const confirmed = byOrder[o.id] || 0;
      if (confirmed === 0) return;   // only count listings the store actually bought from
      const k = String(o.created_by || 'none');
      if (!g[k]) g[k] = { rep:userName(o.created_by), products:0, listings:0, stores:new Set(), last:null };
      g[k].products += confirmed;
      g[k].listings += 1;
      if (o.client_id) g[k].stores.add(String(o.client_id));
      if (!g[k].last || o.order_date > g[k].last) g[k].last = o.order_date;
    });
    const rows = Object.values(g);
    const total = rows.reduce((s, r) => s + r.products, 0) || 1;
    return rows.map(r => ({
      rep: r.rep, products: r.products, listings: r.listings, stores: r.stores.size,
      avg: r.listings ? +(r.products / r.listings).toFixed(1) : 0,
      share: +(r.products / total * 100).toFixed(1), last: r.last,
    })).sort((a, b) => b.products - a.products);
  },
},

{
  id:'listings-rep-store', cat:'Listings', name:'Listings by Rep and Store',
  desc:'One row per rep and store pair — who listed what, and where.',
  filters:['rep','store','status'],
  cols:[
    { key:'rep',      label:'Sales Rep',       type:'text' },
    { key:'store',    label:'Store',           type:'text' },
    { key:'products', label:'Products Listed', type:'num', total:true, r:true },
    { key:'listings', label:'Listing Count',   type:'num', total:true, r:true },
    { key:'first',    label:'First Listing',   type:'date' },
    { key:'last',     label:'Last Listing',    type:'date' },
  ],
  async run() {
    const orders = countedOrders(applyOrderFilters(await fetchOrders()));
    const byOrder = await fetchConfirmedByOrder();

    const g = {};
    orders.forEach(o => {
      const confirmed = byOrder[o.id] || 0;
      if (confirmed === 0) return;   // only count listings the store actually bought from
      const k = `${o.created_by}|${o.client_id}`;
      if (!g[k]) g[k] = { rep:userName(o.created_by), store:o.client_name || 'Unknown store', products:0, listings:0, first:o.order_date, last:o.order_date };
      g[k].products += confirmed;
      g[k].listings += 1;
      if (o.order_date < g[k].first) g[k].first = o.order_date;
      if (o.order_date > g[k].last)  g[k].last  = o.order_date;
    });
    return Object.values(g).sort((a, b) => b.products - a.products);
  },
},

{
  id:'listing-detail', cat:'Listings', name:'Listing Detail',
  desc:'Every listing submitted in the period, with store, rep, item count and status.',
  filters:['rep','store','status'],
  cols:[
    { key:'ref',      label:'Reference',  type:'text' },
    { key:'date',     label:'Date',       type:'date' },
    { key:'store',    label:'Store',      type:'text' },
    { key:'rep',      label:'Sales Rep',  type:'text' },
    { key:'products', label:'Confirmed Purchases', type:'num', total:true, r:true },
    { key:'status',   label:'Status',     type:'badge' },
    { key:'created',  label:'Submitted',  type:'datetime' },
  ],
  async run() {
    const orders  = applyOrderFilters(await fetchOrders());
    const byOrder = await fetchConfirmedByOrder();
    return orders.map(o => ({
      ref: o.order_ref, date: o.order_date, store: o.client_name || '—',
      rep: userName(o.created_by), products: byOrder[o.id] || 0,
      status: o.status, created: o.created_at,
    }));
  },
},

{
  id:'products-listed', cat:'Listings', name:'Products Listed Detail',
  desc:'One row per product listed — the line-by-line record behind every listing.',
  filters:['rep','store','status'],
  cols:[
    { key:'date',    label:'Date',       type:'date' },
    { key:'sku',     label:'SKU',        type:'text' },
    { key:'product', label:'Product',    type:'text' },
    { key:'store',   label:'Store',      type:'text' },
    { key:'rep',     label:'Sales Rep',  type:'text' },
    { key:'price',   label:'Unit Price', type:'money', total:true, r:true },
    { key:'ref',     label:'Listing',    type:'text' },
  ],
  async run() {
    const orders = applyOrderFilters(await fetchOrders());
    const items  = await fetchOrderItems(orders);
    const oMap = {};
    orders.forEach(o => { oMap[o.id] = o; });
    return items.filter(it => oMap[it.order_id]).map(it => {
      const o = oMap[it.order_id];
      return {
        date: o.order_date, sku: it.sku || '—', product: it.product_name || '—',
        store: o.client_name || '—', rep: userName(o.created_by),
        price: Number(it.unit_price || 0), ref: o.order_ref,
      };
    }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  },
},

{
  id:'listings-daily', cat:'Listings', name:'Daily Listing Summary',
  desc:'Listing activity per day — volume, stores covered and reps active.',
  filters:['rep','store','status'],
  cols:[
    { key:'date',     label:'Date',            type:'date' },
    { key:'products', label:'Products Listed', type:'num', total:true, r:true },
    { key:'listings', label:'Listings',        type:'num', total:true, r:true },
    { key:'stores',   label:'Stores',          type:'num', r:true },
    { key:'reps',     label:'Reps Active',     type:'num', r:true },
  ],
  async run() {
    const orders  = countedOrders(applyOrderFilters(await fetchOrders()));
    const byOrder = await fetchConfirmedByOrder();
    const g = {};
    orders.forEach(o => {
      const confirmed = byOrder[o.id] || 0;
      if (confirmed === 0) return;   // only count listings the store actually bought from
      const k = o.order_date;
      if (!g[k]) g[k] = { date:k, products:0, listings:0, stores:new Set(), reps:new Set() };
      g[k].products += confirmed;
      g[k].listings += 1;
      if (o.client_id)  g[k].stores.add(String(o.client_id));
      if (o.created_by) g[k].reps.add(String(o.created_by));
    });
    return Object.values(g).map(r => ({ ...r, stores:r.stores.size, reps:r.reps.size }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  },
},

// ── ATTENDANCE (CLOCK IN / CLOCK OUT) ─────────────────────────────────────
{
  id:'attendance-detail', cat:'Attendance', name:'Attendance Detail',
  desc:'Every clock-in and clock-out with times, hours worked and locations.',
  filters:['employee','attstatus'],
  cols:[
    { key:'employee', label:'Employee',          type:'text' },
    { key:'date',     label:'Date',              type:'date' },
    { key:'in',       label:'Clock In',          type:'time' },
    { key:'out',      label:'Clock Out',         type:'time' },
    { key:'hours',    label:'Hours',             type:'hours', total:true, r:true },
    { key:'late',     label:'Late',              type:'text' },
    { key:'status',   label:'Status',            type:'badge' },
    { key:'inLoc',    label:'Clock In Location', type:'text' },
    { key:'outLoc',   label:'Clock Out Location',type:'text' },
  ],
  async run() {
    const rows = await fetchAttendance();
    const f = S.filters;
    return rows.filter(r => {
      if (f.rep && String(r.employee_id) !== f.rep) return false;
      if (f.status === 'completed' && !r.clock_out) return false;
      if (f.status === 'open'      &&  r.clock_out) return false;
      if (f.status === 'late'      && new Date(r.clock_in).getHours() < CFG.lateHour) return false;
      return true;
    }).map(r => ({
      employee: r.employee_name || userName(r.employee_id),
      date: (r.clock_in || '').split('T')[0],
      in: r.clock_in, out: r.clock_out,
      hours: r.clock_out ? +(hoursBetween(r.clock_in, r.clock_out)).toFixed(2) : null,
      late: new Date(r.clock_in).getHours() >= CFG.lateHour ? 'Late' : 'On time',
      status: r.clock_out ? 'completed' : 'in',
      inLoc: r.clock_in_location || '—', outLoc: r.clock_out_location || '—',
    }));
  },
},

{
  id:'attendance-summary', cat:'Attendance', name:'Attendance Summary by Employee',
  desc:'Days present, hours worked, punctuality and missed clock-outs per employee.',
  filters:['employee'],
  cols:[
    { key:'employee',  label:'Employee',        type:'text' },
    { key:'days',      label:'Days Present',    type:'num',   total:true, r:true },
    { key:'hours',     label:'Total Hours',     type:'hours', total:true, r:true },
    { key:'avg',       label:'Avg Hours/Day',   type:'hours', r:true },
    { key:'lateCount', label:'Late Arrivals',   type:'num',   total:true, r:true },
    { key:'onTimePct', label:'On Time',         type:'pct',   r:true },
    { key:'missing',   label:'No Clock Out',    type:'num',   total:true, r:true },
    { key:'first',     label:'First Day',       type:'date' },
    { key:'last',      label:'Last Day',        type:'date' },
  ],
  async run() {
    const rows = await fetchAttendance();
    const f = S.filters;
    const g = {};
    rows.filter(r => !f.rep || String(r.employee_id) === f.rep).forEach(r => {
      const k = String(r.employee_id);
      if (!g[k]) g[k] = { employee: r.employee_name || userName(r.employee_id), days:0, hours:0, lateCount:0, missing:0, first:null, last:null };
      const day = (r.clock_in || '').split('T')[0];
      g[k].days += 1;
      if (r.clock_out) g[k].hours += hoursBetween(r.clock_in, r.clock_out) || 0;
      else g[k].missing += 1;
      if (new Date(r.clock_in).getHours() >= CFG.lateHour) g[k].lateCount += 1;
      if (!g[k].first || day < g[k].first) g[k].first = day;
      if (!g[k].last  || day > g[k].last)  g[k].last  = day;
    });
    return Object.values(g).map(r => ({
      ...r,
      hours: +r.hours.toFixed(2),
      avg: r.days ? +(r.hours / r.days).toFixed(2) : 0,
      onTimePct: r.days ? +((r.days - r.lateCount) / r.days * 100).toFixed(1) : 0,
    })).sort((a, b) => b.days - a.days);
  },
},

{
  id:'late-arrivals', cat:'Attendance', name:'Late Arrivals',
  desc:`Clock-ins at or after ${String(CFG.lateHour).padStart(2,'0')}:00, with how late each one was.`,
  filters:['employee'],
  cols:[
    { key:'employee', label:'Employee',   type:'text' },
    { key:'date',     label:'Date',       type:'date' },
    { key:'in',       label:'Clock In',   type:'time' },
    { key:'lateBy',   label:'Late By',    type:'hours', r:true },
    { key:'out',      label:'Clock Out',  type:'time' },
    { key:'hours',    label:'Hours',      type:'hours', total:true, r:true },
    { key:'inLoc',    label:'Location',   type:'text' },
  ],
  async run() {
    const rows = await fetchAttendance();
    const f = S.filters;
    return rows.filter(r => new Date(r.clock_in).getHours() >= CFG.lateHour)
      .filter(r => !f.rep || String(r.employee_id) === f.rep)
      .map(r => {
        const ci = new Date(r.clock_in);
        const due = new Date(ci); due.setHours(CFG.lateHour, 0, 0, 0);
        return {
          employee: r.employee_name || userName(r.employee_id),
          date: (r.clock_in || '').split('T')[0],
          in: r.clock_in, lateBy: +((ci - due) / 3600000).toFixed(2), out: r.clock_out,
          hours: r.clock_out ? +(hoursBetween(r.clock_in, r.clock_out)).toFixed(2) : null,
          inLoc: r.clock_in_location || '—',
        };
      }).sort((a, b) => b.lateBy - a.lateBy);
  },
},

{
  id:'missing-clockout', cat:'Attendance', name:'Missing Clock-Outs',
  desc:'Shifts opened but never closed — these distort hours worked until corrected.',
  filters:['employee'],
  cols:[
    { key:'employee', label:'Employee',  type:'text' },
    { key:'date',     label:'Date',      type:'date' },
    { key:'in',       label:'Clock In',  type:'time' },
    { key:'openFor',  label:'Open For',  type:'hours', r:true },
    { key:'inLoc',    label:'Location',  type:'text' },
  ],
  async run() {
    const rows = await fetchAttendance();
    const f = S.filters;
    return rows.filter(r => !r.clock_out)
      .filter(r => !f.rep || String(r.employee_id) === f.rep)
      .map(r => ({
        employee: r.employee_name || userName(r.employee_id),
        date: (r.clock_in || '').split('T')[0], in: r.clock_in,
        openFor: +((Date.now() - new Date(r.clock_in)) / 3600000).toFixed(2),
        inLoc: r.clock_in_location || '—',
      })).sort((a, b) => b.openFor - a.openFor);
  },
},

{
  id:'attendance-daily', cat:'Attendance', name:'Daily Attendance Summary',
  desc:'Headcount, punctuality and average hours for each day in the period.',
  filters:['employee'],
  cols:[
    { key:'date',      label:'Date',          type:'date' },
    { key:'present',   label:'Present',       type:'num',   total:true, r:true },
    { key:'lateCount', label:'Late',          type:'num',   total:true, r:true },
    { key:'onTimePct', label:'On Time',       type:'pct',   r:true },
    { key:'hours',     label:'Total Hours',   type:'hours', total:true, r:true },
    { key:'avg',       label:'Avg Hours',     type:'hours', r:true },
    { key:'missing',   label:'No Clock Out',  type:'num',   total:true, r:true },
  ],
  async run() {
    const rows = await fetchAttendance();
    const f = S.filters;
    const g = {};
    rows.filter(r => !f.rep || String(r.employee_id) === f.rep).forEach(r => {
      const k = (r.clock_in || '').split('T')[0];
      if (!g[k]) g[k] = { date:k, present:0, lateCount:0, hours:0, missing:0 };
      g[k].present += 1;
      if (new Date(r.clock_in).getHours() >= CFG.lateHour) g[k].lateCount += 1;
      if (r.clock_out) g[k].hours += hoursBetween(r.clock_in, r.clock_out) || 0;
      else g[k].missing += 1;
    });
    return Object.values(g).map(r => ({
      ...r, hours:+r.hours.toFixed(2),
      avg: r.present ? +(r.hours / r.present).toFixed(2) : 0,
      onTimePct: r.present ? +((r.present - r.lateCount) / r.present * 100).toFixed(1) : 0,
    })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  },
},

// ── WALLET ────────────────────────────────────────────────────────────────
{
  id:'wallet-by-rep', ranked:true, cat:'Wallet', name:'Wallet Points by Rep',
  desc:'Points earned from listings, points redeemed, and the balance owed to each rep.',
  filters:['rep'],
  cols:[
    { key:'rep',      label:'Sales Rep',     type:'text' },
    { key:'earned',   label:'Points Earned', type:'num',   total:true, r:true },
    { key:'redeemed', label:'Redeemed',      type:'num',   total:true, r:true },
    { key:'balance',  label:'Balance',       type:'num',   total:true, r:true },
    { key:'value',    label:'Value',         type:'money', total:true, r:true },
    { key:'eligible', label:'Can Cash Out',  type:'text' },
    { key:'listings', label:'Listings',      type:'num',   total:true, r:true },
  ],
  async run() {
    const orders  = countedOrders(applyOrderFilters(await fetchOrders()));
    const payouts = await fetchPayouts();
    const byOrder = await fetchConfirmedByOrder();

    const g = {};
    orders.forEach(o => {
      const confirmed = byOrder[o.id] || 0;
      if (confirmed === 0) return;   // points are only earned on confirmed purchases
      const k = String(o.created_by || 'none');
      if (!g[k]) g[k] = { rep:userName(o.created_by), earned:0, redeemed:0, listings:0 };
      g[k].earned  += confirmed * CFG.pointsPerItem;
      g[k].listings += 1;
    });
    payouts.filter(p => ['approved','paid'].includes(p.status)).forEach(p => {
      const k = String(p.rep_id || 'none');
      if (!g[k]) g[k] = { rep:p.rep_name || userName(p.rep_id), earned:0, redeemed:0, listings:0 };
      g[k].redeemed += Number(p.points_used || 0);
    });
    return Object.values(g).map(r => {
      const balance = r.earned - r.redeemed;
      return { ...r, balance, value: balance * CFG.ugxPerPoint, eligible: balance >= 50 ? 'Yes' : 'No' };
    }).sort((a, b) => b.balance - a.balance);
  },
},

{
  id:'payout-requests', cat:'Wallet', name:'Payout Requests',
  desc:'Every cash-out request with amount, status and who approved it.',
  filters:['rep','payoutstatus'],
  cols:[
    { key:'rep',       label:'Sales Rep',    type:'text' },
    { key:'requested', label:'Requested On', type:'datetime' },
    { key:'points',    label:'Points Used',  type:'num',   total:true, r:true },
    { key:'amount',    label:'Amount',       type:'money', total:true, r:true },
    { key:'mobile',    label:'Mobile Number',type:'text' },
    { key:'status',    label:'Status',       type:'badge' },
    { key:'approved',  label:'Decided On',   type:'datetime' },
    { key:'by',        label:'Approved By',  type:'text' },
  ],
  async run() {
    const payouts = await fetchPayouts();
    const f = S.filters;
    return payouts.filter(p => {
      if (f.rep    && String(p.rep_id) !== f.rep) return false;
      if (f.status && p.status !== f.status)      return false;
      return true;
    }).map(p => ({
      rep: p.rep_name || userName(p.rep_id), requested: p.requested_at,
      points: Number(p.points_used || 0), amount: Number(p.amount_ugx || 0),
      mobile: p.mobile_number || '—', status: p.status || 'pending',
      approved: p.approved_at, by: p.approved_by ? userName(p.approved_by) : '—',
    })).sort((a, b) => String(b.requested || '').localeCompare(String(a.requested || '')));
  },
},

{
  id:'payout-summary', cat:'Wallet', name:'Payout Summary by Status',
  desc:'Totals of requested, approved and paid cash-outs — what has gone out and what is owed.',
  filters:[],
  cols:[
    { key:'status',   label:'Status',        type:'badge' },
    { key:'count',    label:'Requests',      type:'num',   total:true, r:true },
    { key:'points',   label:'Points',        type:'num',   total:true, r:true },
    { key:'amount',   label:'Amount',        type:'money', total:true, r:true },
    { key:'reps',     label:'Reps',          type:'num',   r:true },
    { key:'last',     label:'Most Recent',   type:'datetime' },
  ],
  async run() {
    const payouts = await fetchPayouts();
    const g = {};
    payouts.forEach(p => {
      const k = p.status || 'pending';
      if (!g[k]) g[k] = { status:k, count:0, points:0, amount:0, reps:new Set(), last:null };
      g[k].count  += 1;
      g[k].points += Number(p.points_used || 0);
      g[k].amount += Number(p.amount_ugx || 0);
      if (p.rep_id) g[k].reps.add(String(p.rep_id));
      const when = p.approved_at || p.requested_at;
      if (when && (!g[k].last || when > g[k].last)) g[k].last = when;
    });
    return Object.values(g).map(r => ({ ...r, reps:r.reps.size }))
      .sort((a, b) => b.amount - a.amount);
  },
},

// ── LEAVE ─────────────────────────────────────────────────────────────────
{
  id:'leave-detail', cat:'Leave', name:'Leave Request Detail',
  desc:'Every leave request overlapping the period, with dates, status and who decided it.',
  filters:['employee','leavetype','leavestatus'],
  cols:[
    { key:'employee',   label:'Employee',    type:'text' },
    { key:'type',       label:'Leave Type',  type:'text' },
    { key:'start',      label:'Start',       type:'date' },
    { key:'end',        label:'End',         type:'date' },
    { key:'days',       label:'Days',        type:'num', total:true, r:true },
    { key:'status',     label:'Status',      type:'badge' },
    { key:'reason',     label:'Reason',      type:'text' },
    { key:'requested',  label:'Requested',   type:'datetime' },
    { key:'decidedBy',  label:'Decided By',  type:'text' },
    { key:'decidedOn',  label:'Decided On',  type:'datetime' },
  ],
  async run() {
    const rows = await fetchLeave();
    const f = S.filters;
    return rows
      .filter(r => !f.rep       || String(r.employee_id) === f.rep)
      .filter(r => !f.leaveType || r.leave_type_id === f.leaveType)
      .filter(r => !f.status    || r.status === f.status)
      .map(r => ({
        employee: r.employee_name || userName(r.employee_id),
        type: r.leave_type_name || '—',
        start: r.start_date, end: r.end_date, days: Number(r.days_count || 0),
        status: r.status, reason: r.reason || '—',
        requested: r.requested_at,
        decidedBy: r.decided_by_name || (r.decided_by ? userName(r.decided_by) : '—'),
        decidedOn: r.decided_at,
      })).sort((a, b) => String(b.start).localeCompare(String(a.start)));
  },
},

{
  id:'leave-by-employee', ranked:true, cat:'Leave', name:'Leave Summary by Employee',
  desc:'Requests, approved days taken and outcomes for each employee in the period.',
  filters:['employee','leavetype'],
  cols:[
    { key:'employee',     label:'Employee',       type:'text' },
    { key:'requests',     label:'Requests',       type:'num', total:true, r:true },
    { key:'approvedDays', label:'Approved Days',  type:'num', total:true, r:true },
    { key:'pending',      label:'Pending',        type:'num', total:true, r:true },
    { key:'approved',     label:'Approved',       type:'num', total:true, r:true },
    { key:'rejected',     label:'Rejected',       type:'num', total:true, r:true },
    { key:'cancelled',    label:'Cancelled',      type:'num', total:true, r:true },
    { key:'last',         label:'Last Request',   type:'date' },
  ],
  async run() {
    const rows = await fetchLeave();
    const f = S.filters;
    const scoped = rows
      .filter(r => !f.rep       || String(r.employee_id) === f.rep)
      .filter(r => !f.leaveType || r.leave_type_id === f.leaveType);
    const g = {};
    scoped.forEach(r => {
      const k = String(r.employee_id);
      if (!g[k]) g[k] = { employee: r.employee_name || userName(r.employee_id), requests:0, approvedDays:0, pending:0, approved:0, rejected:0, cancelled:0, last:null };
      g[k].requests += 1;
      if (r.status === 'approved')       { g[k].approved += 1; g[k].approvedDays += Number(r.days_count || 0); }
      else if (r.status === 'pending')   g[k].pending += 1;
      else if (r.status === 'rejected')  g[k].rejected += 1;
      else if (r.status === 'cancelled') g[k].cancelled += 1;
      if (!g[k].last || r.start_date > g[k].last) g[k].last = r.start_date;
    });
    return Object.values(g).sort((a, b) => b.approvedDays - a.approvedDays);
  },
},

{
  id:'leave-by-type', cat:'Leave', name:'Leave by Type',
  desc:'Requests and approved days broken down by leave type.',
  filters:['employee','leavestatus'],
  cols:[
    { key:'type',         label:'Leave Type',      type:'text' },
    { key:'requests',     label:'Requests',        type:'num', total:true, r:true },
    { key:'approvedDays', label:'Approved Days',   type:'num', total:true, r:true },
    { key:'employees',    label:'Employees',       type:'num', r:true },
    { key:'avg',          label:'Avg Days/Request',type:'num', r:true },
    { key:'rejected',     label:'Rejected',        type:'num', total:true, r:true },
  ],
  async run() {
    const rows = await fetchLeave();
    const f = S.filters;
    const scoped = rows
      .filter(r => !f.rep    || String(r.employee_id) === f.rep)
      .filter(r => !f.status || r.status === f.status);
    const g = {};
    scoped.forEach(r => {
      const k = r.leave_type_id || 'none';
      if (!g[k]) g[k] = { type: r.leave_type_name || 'Unknown', requests:0, approvedDays:0, employees:new Set(), rejected:0 };
      g[k].requests += 1;
      if (r.status === 'approved') g[k].approvedDays += Number(r.days_count || 0);
      if (r.status === 'rejected') g[k].rejected += 1;
      if (r.employee_id) g[k].employees.add(String(r.employee_id));
    });
    return Object.values(g).map(r => ({
      type: r.type, requests: r.requests, approvedDays: r.approvedDays,
      employees: r.employees.size, avg: r.requests ? +(r.approvedDays / r.requests).toFixed(1) : 0,
      rejected: r.rejected,
    })).sort((a, b) => b.approvedDays - a.approvedDays);
  },
},

{
  id:'leave-status-summary', cat:'Leave', name:'Leave Summary by Status',
  desc:'Totals of pending, approved, rejected and cancelled leave in the period.',
  filters:['employee','leavetype'],
  cols:[
    { key:'status',    label:'Status',       type:'badge' },
    { key:'count',     label:'Requests',     type:'num', total:true, r:true },
    { key:'days',      label:'Days',         type:'num', total:true, r:true },
    { key:'employees', label:'Employees',    type:'num', r:true },
    { key:'last',      label:'Most Recent',  type:'datetime' },
  ],
  async run() {
    const rows = await fetchLeave();
    const f = S.filters;
    const scoped = rows
      .filter(r => !f.rep       || String(r.employee_id) === f.rep)
      .filter(r => !f.leaveType || r.leave_type_id === f.leaveType);
    const g = {};
    scoped.forEach(r => {
      const k = r.status || 'pending';
      if (!g[k]) g[k] = { status:k, count:0, days:0, employees:new Set(), last:null };
      g[k].count += 1;
      g[k].days  += Number(r.days_count || 0);
      if (r.employee_id) g[k].employees.add(String(r.employee_id));
      const when = r.decided_at || r.requested_at;
      if (when && (!g[k].last || when > g[k].last)) g[k].last = when;
    });
    return Object.values(g).map(r => ({ ...r, employees:r.employees.size }))
      .sort((a, b) => b.count - a.count);
  },
},

{
  id:'leave-roster', cat:'Leave', name:'Currently & Upcoming Leave',
  desc:'Approved leave in the period, marked as upcoming, active or completed.',
  filters:['employee','leavetype'],
  cols:[
    { key:'employee', label:'Employee',   type:'text' },
    { key:'type',     label:'Leave Type', type:'text' },
    { key:'start',    label:'Start',      type:'date' },
    { key:'end',      label:'End',        type:'date' },
    { key:'days',     label:'Days',       type:'num', total:true, r:true },
    { key:'live',     label:'Status',     type:'badge' },
  ],
  async run() {
    const rows = await fetchLeave();
    const f = S.filters;
    const t = todayISO();
    return rows
      .filter(r => r.status === 'approved')
      .filter(r => !f.rep       || String(r.employee_id) === f.rep)
      .filter(r => !f.leaveType || r.leave_type_id === f.leaveType)
      .map(r => ({
        employee: r.employee_name || userName(r.employee_id),
        type: r.leave_type_name || '—',
        start: r.start_date, end: r.end_date, days: Number(r.days_count || 0),
        live: r.start_date > t ? 'upcoming' : (r.end_date < t ? 'completed' : 'active'),
      })).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  },
},

// ── STOCK POSITION ────────────────────────────────────────────────────────
// Reps don't decide to run these — an admin switches Stock Position on for
// whoever should be counting (Stock Position → Who can count stock), so
// every row below is built from what that chosen set of people submitted.
{
  id:'stock-by-store', ranked:true, cat:'Stock', name:'Stock Position by Store',
  desc:'Every store counted in the period, ranked by sellable units on the shelf.',
  filters:['rep','stockstatus'],
  cols:[
    { key:'store',    label:'Store',          type:'text' },
    { key:'sellable', label:'Sellable Units', type:'num', total:true, r:true },
    { key:'skus',     label:'SKUs Closed',    type:'num', total:true, r:true },
    { key:'damaged',  label:'Damaged',        type:'num', total:true, r:true },
    { key:'oos',      label:'Out of Stock',   type:'num', total:true, r:true },
    { key:'lowCrit',  label:'Low / Critical', type:'num', total:true, r:true },
    { key:'reps',     label:'Reps Counting',  type:'num', r:true },
    { key:'visits',   label:'Visits',         type:'num', total:true, r:true },
    { key:'last',     label:'Last Counted',   type:'date' },
  ],
  async run() {
    const counts = applyStockCountFilters(await fetchStockCounts());
    const items  = await fetchStockCountItems(counts);
    const cMap = {}; counts.forEach(c => { cMap[c.id] = c; });
    const f = S.filters;

    const g = {};
    items.forEach(it => {
      const c = cMap[it.count_id]; if (!c) return;
      if (f.status && it.status !== f.status) return;
      const k = String(c.client_id || 'none');
      if (!g[k]) g[k] = { store:c.client_name || 'Unknown store', sellable:0, skus:0, damaged:0, oos:0, lowCrit:0, reps:new Set(), visits:new Set(), last:null };
      g[k].sellable += Number(it.sellable || 0);
      g[k].skus     += 1;
      g[k].damaged  += Number(it.damaged || 0);
      if (it.status === 'Out of stock') g[k].oos += 1;
      if (it.status === 'Low' || it.status === 'Critical') g[k].lowCrit += 1;
      if (c.user_id) g[k].reps.add(String(c.user_id));
      g[k].visits.add(String(c.id));
      const day = (c.counted_at || '').split('T')[0];
      if (!g[k].last || day > g[k].last) g[k].last = day;
    });
    return Object.values(g).map(r => ({
      store: r.store, sellable: r.sellable, skus: r.skus, damaged: r.damaged,
      oos: r.oos, lowCrit: r.lowCrit, reps: r.reps.size, visits: r.visits.size, last: r.last,
    })).sort((a, b) => b.sellable - a.sellable);
  },
},

{
  id:'stock-by-rep', ranked:true, cat:'Stock', name:'Stock Position by Rep',
  desc:'Who is actually doing the counting — SKUs closed, stores covered, and what they found.',
  filters:['store','stockstatus'],
  cols:[
    { key:'rep',      label:'Counted By',     type:'text' },
    { key:'skus',     label:'SKUs Closed',    type:'num', total:true, r:true },
    { key:'sellable', label:'Sellable Units', type:'num', total:true, r:true },
    { key:'damaged',  label:'Damaged',        type:'num', total:true, r:true },
    { key:'oos',      label:'Out of Stock',   type:'num', total:true, r:true },
    { key:'stores',   label:'Stores Covered', type:'num', r:true },
    { key:'visits',   label:'Visits',         type:'num', total:true, r:true },
    { key:'last',     label:'Last Active',    type:'date' },
  ],
  async run() {
    const counts = applyStockCountFilters(await fetchStockCounts());
    const items  = await fetchStockCountItems(counts);
    const cMap = {}; counts.forEach(c => { cMap[c.id] = c; });
    const f = S.filters;

    const g = {};
    items.forEach(it => {
      const c = cMap[it.count_id]; if (!c) return;
      if (f.status && it.status !== f.status) return;
      const k = String(c.user_id || 'none');
      if (!g[k]) g[k] = { rep:c.user_name || userName(c.user_id), skus:0, sellable:0, damaged:0, oos:0, stores:new Set(), visits:new Set(), last:null };
      g[k].skus     += 1;
      g[k].sellable += Number(it.sellable || 0);
      g[k].damaged  += Number(it.damaged || 0);
      if (it.status === 'Out of stock') g[k].oos += 1;
      if (c.client_id) g[k].stores.add(String(c.client_id));
      g[k].visits.add(String(c.id));
      const day = (c.counted_at || '').split('T')[0];
      if (!g[k].last || day > g[k].last) g[k].last = day;
    });
    return Object.values(g).map(r => ({
      rep: r.rep, skus: r.skus, sellable: r.sellable, damaged: r.damaged,
      oos: r.oos, stores: r.stores.size, visits: r.visits.size, last: r.last,
    })).sort((a, b) => b.skus - a.skus);
  },
},

{
  id:'stock-count-detail', cat:'Stock', name:'Stock Count Detail',
  desc:'Every stock position submitted in the period, one row per store visit.',
  filters:['rep','store'],
  cols:[
    { key:'ref',       label:'Reference',    type:'text' },
    { key:'date',      label:'Date',         type:'date' },
    { key:'store',     label:'Store',        type:'text' },
    { key:'rep',       label:'Counted By',   type:'text' },
    { key:'skus',      label:'SKUs Closed',  type:'num', total:true, r:true },
    { key:'sellable',  label:'Sellable',     type:'num', total:true, r:true },
    { key:'damaged',   label:'Damaged',      type:'num', total:true, r:true },
    { key:'oos',       label:'Out of Stock', type:'num', total:true, r:true },
    { key:'submitted', label:'Submitted',    type:'datetime' },
  ],
  async run() {
    const counts = applyStockCountFilters(await fetchStockCounts());
    return counts.map(c => ({
      ref: c.ref, date: (c.counted_at || '').split('T')[0], store: c.client_name || '—',
      rep: c.user_name || userName(c.user_id), skus: Number(c.total_skus || 0),
      sellable: Number(c.total_sellable || 0), damaged: Number(c.total_damaged || 0),
      oos: Number(c.oos_count || 0), submitted: c.counted_at,
    })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  },
},

{
  id:'stock-item-detail', cat:'Stock', name:'Stock Item Detail',
  desc:'One row per SKU counted — the line-by-line record behind every stock position.',
  filters:['rep','store','stockstatus'],
  cols:[
    { key:'date',     label:'Date',       type:'date' },
    { key:'store',    label:'Store',      type:'text' },
    { key:'rep',      label:'Counted By', type:'text' },
    { key:'sku',      label:'SKU',        type:'text' },
    { key:'product',  label:'Product',    type:'text' },
    { key:'opening',  label:'Opening',    type:'num', r:true },
    { key:'closing',  label:'Closing',    type:'num', r:true },
    { key:'damaged',  label:'Damaged',    type:'num', total:true, r:true },
    { key:'sellable', label:'Sellable',   type:'num', total:true, r:true },
    { key:'sold',     label:'Sold',       type:'num', total:true, r:true },
    { key:'status',   label:'Position',   type:'badge' },
    { key:'ref',      label:'Reference',  type:'text' },
  ],
  async run() {
    const counts = applyStockCountFilters(await fetchStockCounts());
    const items  = await fetchStockCountItems(counts);
    const cMap = {}; counts.forEach(c => { cMap[c.id] = c; });
    const f = S.filters;
    return items
      .filter(it => cMap[it.count_id] && (!f.status || it.status === f.status))
      .map(it => {
        const c = cMap[it.count_id];
        return {
          date: (c.counted_at || '').split('T')[0], store: c.client_name || '—',
          rep: c.user_name || userName(c.user_id), sku: it.sku || '—', product: it.item_name || '—',
          opening: Number(it.opening || 0), closing: Number(it.physical ?? it.shelf ?? 0),
          damaged: Number(it.damaged || 0), sellable: Number(it.sellable || 0),
          sold: it.sold == null ? null : Number(it.sold), status: it.status || '—', ref: c.ref,
        };
      }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  },
},

{
  id:'stock-daily', cat:'Stock', name:'Daily Stock Summary',
  desc:'Stock-count activity per day — visits, stores covered and reps active.',
  filters:['rep','store'],
  cols:[
    { key:'date',     label:'Date',        type:'date' },
    { key:'visits',   label:'Visits',      type:'num', total:true, r:true },
    { key:'skus',     label:'SKUs Closed', type:'num', total:true, r:true },
    { key:'stores',   label:'Stores',      type:'num', r:true },
    { key:'reps',     label:'Reps Active', type:'num', r:true },
    { key:'sellable', label:'Sellable',    type:'num', total:true, r:true },
    { key:'damaged',  label:'Damaged',     type:'num', total:true, r:true },
  ],
  async run() {
    const counts = applyStockCountFilters(await fetchStockCounts());
    const g = {};
    counts.forEach(c => {
      const k = (c.counted_at || '').split('T')[0];
      if (!g[k]) g[k] = { date:k, visits:0, skus:0, stores:new Set(), reps:new Set(), sellable:0, damaged:0 };
      g[k].visits   += 1;
      g[k].skus     += Number(c.total_skus || 0);
      g[k].sellable += Number(c.total_sellable || 0);
      g[k].damaged  += Number(c.total_damaged || 0);
      if (c.client_id) g[k].stores.add(String(c.client_id));
      if (c.user_id)   g[k].reps.add(String(c.user_id));
    });
    return Object.values(g).map(r => ({ ...r, stores:r.stores.size, reps:r.reps.size }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  },
},

{
  id:'stock-reorder', ranked:true, cat:'Stock', name:'Reorder Suggestions',
  desc:'SKUs that need restocking, based on the most recent count of each in the period.',
  filters:['rep','store'],
  cols:[
    { key:'store',     label:'Store',         type:'text' },
    { key:'sku',       label:'SKU',           type:'text' },
    { key:'product',   label:'Product',       type:'text' },
    { key:'sellable',  label:'Sellable Now',  type:'num', r:true },
    { key:'suggested', label:'Suggest Order', type:'num', total:true, r:true },
    { key:'daysCover', label:'Days Cover',    type:'num', r:true },
    { key:'status',    label:'Position',      type:'badge' },
    { key:'last',      label:'Last Counted',  type:'date' },
  ],
  async run() {
    const counts = applyStockCountFilters(await fetchStockCounts());
    const items  = await fetchStockCountItems(counts);
    const cMap = {}; counts.forEach(c => { cMap[c.id] = c; });

    // One row per store+SKU — only the most recently counted line survives,
    // so a SKU counted twice in the period doesn't get double-ordered.
    const latest = {};
    items.forEach(it => {
      const c = cMap[it.count_id]; if (!c) return;
      const k = `${c.client_id}|${it.sku}`;
      if (!latest[k] || c.counted_at > latest[k].at) latest[k] = { it, c, at: c.counted_at };
    });
    return Object.values(latest)
      .filter(({ it }) => Number(it.suggested_order || 0) > 0)
      .map(({ it, c }) => ({
        store: c.client_name || '—', sku: it.sku || '—', product: it.item_name || '—',
        sellable: Number(it.sellable || 0), suggested: Number(it.suggested_order || 0),
        daysCover: it.days_cover == null ? null : Number(it.days_cover),
        status: it.status || '—', last: (c.counted_at || '').split('T')[0],
      })).sort((a, b) => b.suggested - a.suggested);
  },
},

{
  id:'stock-damage', cat:'Stock', name:'Damaged Stock Detail',
  desc:'Every SKU with damaged units in the period, and the reason recorded for it.',
  filters:['rep','store'],
  cols:[
    { key:'date',    label:'Date',       type:'date' },
    { key:'store',   label:'Store',      type:'text' },
    { key:'rep',     label:'Counted By', type:'text' },
    { key:'sku',     label:'SKU',        type:'text' },
    { key:'product', label:'Product',    type:'text' },
    { key:'damaged', label:'Damaged',    type:'num', total:true, r:true },
    { key:'reason',  label:'Reason',     type:'text' },
    { key:'notes',   label:'Notes',      type:'text' },
    { key:'ref',     label:'Reference',  type:'text' },
  ],
  async run() {
    const counts = applyStockCountFilters(await fetchStockCounts());
    const items  = await fetchStockCountItems(counts);
    const cMap = {}; counts.forEach(c => { cMap[c.id] = c; });
    return items
      .filter(it => cMap[it.count_id] && Number(it.damaged || 0) > 0)
      .map(it => {
        const c = cMap[it.count_id];
        return {
          date: (c.counted_at || '').split('T')[0], store: c.client_name || '—',
          rep: c.user_name || userName(c.user_id), sku: it.sku || '—', product: it.item_name || '—',
          damaged: Number(it.damaged || 0), reason: it.damage_reason || '—',
          notes: it.notes || '—', ref: c.ref,
        };
      }).sort((a, b) => b.damaged - a.damaged);
  },
},
];

const CATEGORIES = ['Listings', 'Attendance', 'Leave', 'Wallet', 'Stock'];
function reportById(id) { return REPORTS.find(r => r.id === id); }

// ═══════════════════════════════════════════════════════════════════════════
//  REPORTS CENTRE — home screen
// ═══════════════════════════════════════════════════════════════════════════
function root() { return document.getElementById('rpt-root'); }

function visitLabel(id) {
  const t = S.visited[id];
  return t ? fmtDateTime(t) : '—';
}

const CAT_STYLE = {
  Listings:   { accent:'#1A3A6B', tint:'#EAF0F8', source:'Listings & items' },
  Attendance: { accent:'#0F766E', tint:'#E3F1EF', source:'Clock in / out'  },
  Leave:      { accent:'#6B3FA0', tint:'#F1EAFA', source:'Leave requests'  },
  Wallet:     { accent:'#A97406', tint:'#FAF2DE', source:'Points & payouts'},
  Stock:      { accent:'#9A3412', tint:'#FCEEE6', source:'Stock counts'    },
};
const CAT_ICON = {
  Listings:   '<path d="M3 4h14M3 9h14M3 14h9"/>',
  Attendance: '<circle cx="10" cy="10" r="7.2"/><path d="M10 6v4.3l2.8 1.7"/>',
  Leave:      '<rect x="3" y="4.5" width="14" height="12.5" rx="1.6"/><path d="M3 8.5h14M6.5 2.5v4M13.5 2.5v4"/>',
  Wallet:     '<path d="M3 6.5h11a2 2 0 012 2v5a2 2 0 01-2 2H4a1 1 0 01-1-1V6.5zM3 6.5A1.5 1.5 0 014.5 5H13"/><circle cx="13.4" cy="11" r="1"/>',
  Stock:      '<path d="M10 2.5l7 3.5v7l-7 3.5-7-3.5v-7l7-3.5z"/><path d="M3 6l7 3.5 7-3.5M10 9.5V17.5"/>',
};
function catIcon(cat, size) {
  return `<svg width="${size||18}" height="${size||18}" viewBox="0 0 20 20" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${CAT_ICON[cat] || ''}</svg>`;
}

function renderHome() {
  const el = root(); if (!el) return;
  const q = S.search.toLowerCase().trim();

  const list = REPORTS.filter(r => {
    if (S.cat === 'favourites' && !S.favs.includes(r.id)) return false;
    if (S.cat !== 'all' && S.cat !== 'favourites' && r.cat !== S.cat) return false;
    if (q && !(`${r.name} ${r.desc} ${r.cat}`.toLowerCase().includes(q))) return false;
    return true;
  });

  const rail = (id, label, count) =>
    `<div class="rp-rail-i${S.cat === id ? ' on' : ''}" tabindex="0" role="button"
          onclick="Reports.setCat('${id}')" onkeydown="if(event.key==='Enter')Reports.setCat('${id}')">
       <span>${label}</span><span class="c">${count}</span></div>`;

  el.innerHTML = `
  <div class="rp-head">
    <div>
      <div class="rp-kicker">Kingdom Trading Limited</div>
      <div class="rp-h1">Reports</div>
      <div class="rp-lede">Listings, attendance, leave, wallet and stock-count figures for the whole operation — filter any report by date, rep or store, then export or print it.</div>
    </div>
    <div class="rp-find">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      <input placeholder="Find a report" value="${esc(S.search)}" oninput="Reports.setSearch(this.value)" aria-label="Find a report"/>
    </div>
  </div>

  <div class="rp-grid">
    <div class="rp-rail">
      ${rail('all', 'All reports', REPORTS.length)}
      ${rail('favourites', 'Starred', S.favs.length)}
      <div class="rp-rail-sep"></div>
      <div class="rp-rail-hd">Category</div>
      ${CATEGORIES.map(c => rail(c, c, REPORTS.filter(r => r.cat === c).length)).join('')}
    </div>

    <div class="rp-list">
      <div class="rp-idx-hd"><span></span><span>Report</span><span>Category</span><span>Last opened</span></div>
      ${list.length ? list.map(r => {
        const st = CAT_STYLE[r.cat] || CAT_STYLE.Listings;
        const seen = S.visited[r.id];
        return `<div class="rp-item" style="--rp-accent:${st.accent};--rp-tint:${st.tint};"
                     tabindex="0" role="button" onclick="Reports.open('${r.id}')"
                     onkeydown="if(event.key==='Enter')Reports.open('${r.id}')">
          <span class="rp-glyph">${catIcon(r.cat, 19)}</span>
          <div style="min-width:0;">
            <div class="rp-item-name">${esc(r.name)}</div>
            <div class="rp-item-desc">${esc(r.desc)}</div>
          </div>
          <div class="rp-item-meta">${r.cat}</div>
          <div class="rp-item-seen${seen ? '' : ' never'}">${seen ? fmtDateTime(seen) : 'Not yet opened'}</div>
          <span class="rp-star${S.favs.includes(r.id) ? ' on' : ''}" title="Star this report"
                onclick="event.stopPropagation();Reports.toggleFav('${r.id}')">${S.favs.includes(r.id) ? '★' : '☆'}</span>
        </div>`;
      }).join('')
      : `<div class="rp-empty">
           <div class="rp-empty-mark">${S.cat === 'favourites' ? '★' : '—'}</div>
           <div class="rp-empty-t">${S.cat === 'favourites' ? 'No starred reports yet' : 'Nothing matches that search'}</div>
           <div class="rp-empty-d">${S.cat === 'favourites'
             ? 'Star a report from the list to keep it here.'
             : 'Try a shorter search term, or pick a different category.'}</div>
         </div>`}
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  REPORT VIEW
// ═══════════════════════════════════════════════════════════════════════════
function filterControls(def) {
  const f = S.filters;
  const wants = def.filters || [];
  const bits = [];
  const chip = (label, inner) => `<div class="rp-f"><label>${label}</label>${inner}</div>`;

  bits.push(chip('Period', `<select onchange="Reports.setPreset(this.value)" aria-label="Period">
      ${PRESETS.map(p => `<option value="${p.id}"${S.preset === p.id ? ' selected' : ''}>${p.label}</option>`).join('')}
    </select>`));

  if (S.preset !== 'all') {
    bits.push(chip('From', `<input type="date" value="${S.from}" onchange="Reports.setDate('from',this.value)" aria-label="From date"/>`));
    bits.push(chip('To',   `<input type="date" value="${S.to}" onchange="Reports.setDate('to',this.value)" aria-label="To date"/>`));
  }

  if (wants.includes('rep') || wants.includes('employee')) {
    const isEmp = wants.includes('employee');
    const people = isEmp ? S.users : S.users.filter(u => ['sales_rep','manager','admin'].includes(u.role));
    bits.push(chip(isEmp ? 'Employee' : 'Sales rep', `<select onchange="Reports.setFilter('rep',this.value)">
        <option value="">Everyone</option>
        ${people.map(u => `<option value="${u.id}"${f.rep === String(u.id) ? ' selected' : ''}>${esc(u.full_name)}</option>`).join('')}
      </select>`));
  }

  if (wants.includes('store')) {
    bits.push(chip('Store', `<select onchange="Reports.setFilter('store',this.value)">
        <option value="">All stores</option>
        ${S.clients.map(c => `<option value="${c.id}"${f.store === String(c.id) ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>`));
  }

  if (wants.includes('status')) {
    bits.push(chip('Listing status', `<select onchange="Reports.setFilter('status',this.value)">
        ${['','submitted','fulfilled','partial','draft','cancelled']
          .map(x => `<option value="${x}"${f.status === x ? ' selected' : ''}>${x ? x[0].toUpperCase()+x.slice(1) : 'Any status'}</option>`).join('')}
      </select>`));
  }

  if (wants.includes('attstatus')) {
    bits.push(chip('Shift', `<select onchange="Reports.setFilter('status',this.value)">
        <option value=""${f.status === '' ? ' selected' : ''}>All shifts</option>
        <option value="completed"${f.status === 'completed' ? ' selected' : ''}>Completed</option>
        <option value="open"${f.status === 'open' ? ' selected' : ''}>Still clocked in</option>
        <option value="late"${f.status === 'late' ? ' selected' : ''}>Late arrivals</option>
      </select>`));
  }

  if (wants.includes('payoutstatus')) {
    bits.push(chip('Payout status', `<select onchange="Reports.setFilter('status',this.value)">
        ${['','pending','approved','paid','rejected']
          .map(x => `<option value="${x}"${f.status === x ? ' selected' : ''}>${x ? x[0].toUpperCase()+x.slice(1) : 'Any status'}</option>`).join('')}
      </select>`));
  }

  if (wants.includes('leavetype')) {
    bits.push(chip('Leave type', `<select onchange="Reports.setFilter('leaveType',this.value)">
        <option value="">All leave types</option>
        ${S.leaveTypes.map(t => `<option value="${t.id}"${f.leaveType === String(t.id) ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>`));
  }

  if (wants.includes('leavestatus')) {
    bits.push(chip('Leave status', `<select onchange="Reports.setFilter('status',this.value)">
        ${['','pending','approved','rejected','cancelled']
          .map(x => `<option value="${x}"${f.status === x ? ' selected' : ''}>${x ? x[0].toUpperCase()+x.slice(1) : 'Any status'}</option>`).join('')}
      </select>`));
  }

  if (wants.includes('stockstatus')) {
    bits.push(chip('Stock status', `<select onchange="Reports.setFilter('status',this.value)">
        ${['','Healthy','Low','Critical','Out of stock','Overstocked']
          .map(x => `<option value="${x}"${f.status === x ? ' selected' : ''}>${x || 'Any status'}</option>`).join('')}
      </select>`));
  }

  return bits.join('');
}

const OPS = {
  text: [['contains','contains'],['ncontains','does not contain'],['is','is'],['isnot','is not'],['starts','starts with']],
  num:  [['eq','='],['ne','≠'],['gt','>'],['gte','≥'],['lt','<'],['lte','≤'],['between','between']],
  date: [['is','on'],['gt','after'],['lt','before'],['between','between']],
};
function opsFor(type) {
  if (isNumericType(type)) return OPS.num;
  if (['date','datetime','time'].includes(type)) return OPS.date;
  return OPS.text;
}

function condRows(def) {
  if (!S.conds.length) return '';
  return `<div class="rp-conds">
    ${S.conds.map((c, i) => {
      const col  = def.cols.find(x => x.key === c.field) || def.cols[0];
      const ops  = opsFor(col.type);
      const isDate = ['date','datetime','time'].includes(col.type);
      const inputType = isNumericType(col.type) ? 'number' : isDate ? 'date' : 'text';
      return `<div class="rp-cond">
        <span class="n">${i+1}</span>
        <select onchange="Reports.setCond(${i},'field',this.value)" aria-label="Field">
          ${def.cols.map(x => `<option value="${x.key}"${c.field === x.key ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
        </select>
        <select onchange="Reports.setCond(${i},'op',this.value)" aria-label="Comparison">
          ${ops.map(([v, l]) => `<option value="${v}"${c.op === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <input type="${inputType}" value="${esc(c.value ?? '')}" placeholder="Value" aria-label="Value"
               onchange="Reports.setCond(${i},'value',this.value)" style="max-width:170px;"/>
        ${c.op === 'between' ? `<input type="${inputType}" value="${esc(c.value2 ?? '')}" placeholder="and" aria-label="Second value"
               onchange="Reports.setCond(${i},'value2',this.value)" style="max-width:170px;"/>` : ''}
        <button class="x" onclick="Reports.removeCond(${i})" title="Remove condition">✕</button>
      </div>`;
    }).join('')}
    <button class="rp-ghost" onclick="Reports.addCond()" style="padding-left:28px;color:var(--rp-royal);font-weight:600;">＋ Add another condition</button>
  </div>`;
}

/** More Filters conditions, applied to the produced rows. */
function applyConds(rows, def) {
  if (!S.conds.length) return rows;
  return rows.filter(row => S.conds.every(c => {
    if (!c.field || c.value === '' || c.value == null) return true;
    const col = def.cols.find(x => x.key === c.field);
    const raw = row[c.field];
    if (raw == null) return false;

    if (col && isNumericType(col.type)) {
      const v = Number(raw), a = Number(c.value), b = Number(c.value2);
      switch (c.op) {
        case 'eq': return v === a;  case 'ne': return v !== a;
        case 'gt': return v > a;    case 'gte': return v >= a;
        case 'lt': return v < a;    case 'lte': return v <= a;
        case 'between': return v >= a && v <= (isNaN(b) ? Infinity : b);
        default: return true;
      }
    }
    if (col && ['date','datetime','time'].includes(col.type)) {
      const v = String(raw).split('T')[0];
      switch (c.op) {
        case 'is': return v === c.value;
        case 'gt': return v > c.value;
        case 'lt': return v < c.value;
        case 'between': return v >= c.value && v <= (c.value2 || '2099-12-31');
        default: return true;
      }
    }
    const v = String(raw).toLowerCase(), t = String(c.value).toLowerCase();
    switch (c.op) {
      case 'contains':  return v.includes(t);
      case 'ncontains': return !v.includes(t);
      case 'is':        return v === t;
      case 'isnot':     return v !== t;
      case 'starts':    return v.startsWith(t);
      default: return true;
    }
  }));
}

function visibleCols(def) { return def.cols.filter(c => !S.hidden[c.key]); }

function sortRows(rows, def) {
  if (!S.sort.key) return rows;
  const col = def.cols.find(c => c.key === S.sort.key);
  const dir = S.sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[S.sort.key], y = b[S.sort.key];
    if (x == null) return 1;
    if (y == null) return -1;
    if (col && isNumericType(col.type)) return (Number(x) - Number(y)) * dir;
    return String(x).localeCompare(String(y)) * dir;
  });
}

const CHIP_MAP = {
  submitted:'neut', fulfilled:'ok', partial:'warn', draft:'grey', cancelled:'bad',
  completed:'ok', in:'neut', pending:'warn', approved:'ok', paid:'ok', rejected:'bad',
  upcoming:'neut', active:'ok',
  Healthy:'ok', Low:'warn', Critical:'bad', 'Out of stock':'bad', Overstocked:'neut',
};

/** The metric a ranked report is ordered by — gets the share rule under it. */
function primaryKey(def) {
  const c = def.cols.find(x => x.total && x.type === 'num');
  return c ? c.key : null;
}

function skeletonSheet(def) {
  const cols = visibleCols(def);
  return `<div class="rp-scroll"><table class="rp-tbl">
    <thead><tr>${cols.map(c => `<th class="${c.r ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${Array.from({ length: 6 }).map(() => `<tr>${cols.map((c, i) =>
      `<td><div class="rp-skel" style="width:${i === 0 ? 62 : 38 + (i % 3) * 12}%;"></div></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
}

function renderReport() {
  const el = root(); if (!el) return;
  const def = reportById(S.reportId);
  if (!def) { S.view = 'home'; renderHome(); return; }

  const st   = CAT_STYLE[def.cat] || CAT_STYLE.Listings;
  const cols = visibleCols(def);
  const rows = sortRows(applyConds(S.rows, def), def);

  const totals = {};
  def.cols.filter(c => c.total).forEach(c => {
    totals[c.key] = rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0);
  });
  const hasTotals = Object.keys(totals).length > 0;

  const pk       = primaryKey(def);
  const ranked   = !!def.ranked && (!S.sort.key || S.sort.key === pk);
  const pkMax    = pk ? Math.max(...rows.map(r => Number(r[pk]) || 0), 0) : 0;
  const headline = def.cols.filter(c => c.total).slice(0, 3);

  el.innerHTML = `
  <div class="rp-bar">
    <div style="display:flex;align-items:center;gap:16px;min-width:0;">
      <button class="rp-back" onclick="Reports.home()">← All reports</button>
      <span style="width:1px;height:22px;background:var(--rp-rule-mid);"></span>
      <span style="display:inline-flex;align-items:center;gap:8px;color:${st.accent};">
        ${catIcon(def.cat, 16)}
        <span style="font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;">${def.cat}</span>
      </span>
    </div>
    <div class="rp-seg">
      <button onclick="Reports.toggleColsMenu(event)">Columns <span class="n">${cols.length}</span></button>
      <button onclick="Reports.print()">Print</button>
      <button onclick="Reports.exportCSV()">CSV</button>
      <button class="gold" onclick="Reports.exportExcel()">Export Excel</button>
    </div>
  </div>

  <div class="rp-filters">
    ${filterControls(def)}
    <div class="rp-f-act">
      <button class="rp-ghost" onclick="Reports.addCond()">＋ Condition${S.conds.length ? ` (${S.conds.length})` : ''}</button>
      <button class="rp-ghost" onclick="Reports.reset()">Reset</button>
      <button class="rp-run" onclick="Reports.run()" ${S.running ? 'disabled' : ''}>${S.running ? 'Running…' : 'Run report'}</button>
    </div>
  </div>
  ${condRows(def)}

  <div class="rp-sheet">
    <div class="rp-mast">
      <div style="min-width:0;">
        <div class="rp-org">Kingdom Trading Limited</div>
        <div class="rp-title">${esc(def.name)}</div>
        <div class="rp-range">${rangeLabel()}</div>
        ${activeFilterSummary(def)}
      </div>
      <div class="rp-stamp">
        <div class="rp-stamp-k">Prepared</div><div class="rp-stamp-v">${fmtDateTime(new Date().toISOString())}</div>
        <div class="rp-stamp-k">By</div><div class="rp-stamp-v">${esc(me()?.full_name || '—')}</div>
        <div class="rp-stamp-k">Rows</div><div class="rp-stamp-v">${S.running ? '—' : fmtNum(rows.length)}</div>
      </div>
    </div>

    ${!S.running && rows.length && headline.length ? `<div class="rp-figline">
      ${headline.map(c => `<div class="rp-fig-i">
        <div class="rp-fig-v">${esc(fmtCell(+totals[c.key].toFixed(2), c.type))}</div>
        <div class="rp-fig-k">${esc(c.label)}</div>
      </div>`).join('')}
    </div>` : ''}

    ${S.running ? skeletonSheet(def)
    : rows.length ? `<div class="rp-scroll"><table class="rp-tbl">
        <thead><tr>
          ${ranked ? '<th class="rp-rank"></th>' : ''}
          ${cols.map(c => `<th class="${c.r ? 'r' : ''}${S.sort.key === c.key ? ' sorted' : ''}"
              onclick="Reports.sortBy('${c.key}')" title="Sort by ${esc(c.label)}">${esc(c.label)}${
              S.sort.key === c.key ? `<span class="rp-caret">${S.sort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${rows.map((r, i) => `<tr>
            ${ranked ? `<td class="rp-rank${i < 3 ? ' top' : ''}">${i + 1}</td>` : ''}
            ${cols.map((c, ci) => {
              const isPk = c.key === pk && pkMax > 0;
              const cls = [c.r ? 'r' : '', isPk ? 'rp-primary' : '', ci === 0 && !ranked ? 'rp-lead' : ''].filter(Boolean).join(' ');
              const w = isPk ? Math.max(3, Math.round((Number(r[c.key]) || 0) / pkMax * 100)) : 0;
              return `<td class="${cls}" style="${isPk ? `--rp-accent:${st.accent};` : ''}">
                ${isPk ? `<span class="rp-fig">${esc(fmtCell(r[c.key], c.type))}</span><span class="rp-share" style="width:${w}%;"></span>`
                       : cellHTML(r[c.key], c)}
              </td>`;
            }).join('')}
          </tr>`).join('')}
        </tbody>
        ${hasTotals ? `<tfoot><tr>
          ${ranked ? '<td class="rp-rank"></td>' : ''}
          ${cols.map((c, i) => `<td class="${c.r ? 'r' : ''}">${
            i === 0 ? 'Total' : (c.total ? esc(fmtCell(+totals[c.key].toFixed(2), c.type)) : '')}</td>`).join('')}
        </tr></tfoot>` : ''}
      </table></div>
      <div class="rp-foot">
        <span>${fmtNum(rows.length)} row${rows.length === 1 ? '' : 's'}${S.conds.length ? ` after ${S.conds.length} condition${S.conds.length === 1 ? '' : 's'}` : ''}</span>
        <span>${esc(st.source)} · figures cover ${esc(rangeLabel().toLowerCase())}</span>
      </div>`
    : `<div class="rp-empty">
        <div class="rp-empty-mark">—</div>
        <div class="rp-empty-t">Nothing recorded in this period</div>
        <div class="rp-empty-d">Widen the period, or clear a filter${S.filters.rep || S.filters.store || S.filters.status ? '' : ''}.
          ${S.conds.length ? 'The extra conditions may also be excluding every row.' : ''}</div>
      </div>`}
  </div>`;
}

function cellHTML(val, col) {
  if (col.type === 'badge') {
    const v = String(val || '—');
    return `<span class="rp-chip ${CHIP_MAP[v] || 'neut'}">${esc(v[0].toUpperCase() + v.slice(1))}</span>`;
  }
  if (col.key === 'late') {
    return val === 'Late' ? `<span class="rp-chip warn">Late</span>`
                          : `<span style="color:var(--rp-txt3);">On time</span>`;
  }
  if (col.key === 'eligible') {
    return val === 'Yes' ? `<span class="rp-chip ok">Yes</span>` : `<span class="rp-muted">No</span>`;
  }
  const out = fmtCell(val, col.type);
  if (out === '—') return `<span class="rp-muted">—</span>`;
  if (isNumericType(col.type) && Number(val) < 0) return `<span style="color:var(--rp-neg);">${esc(out)}</span>`;
  return esc(out);
}

function activeFilterSummary(def) {
  const tags = [];
  if (S.filters.rep)    tags.push(userName(S.filters.rep));
  if (S.filters.store)  tags.push(S.clients.find(c => String(c.id) === S.filters.store)?.name || 'Store');
  if (S.filters.status) tags.push(S.filters.status[0].toUpperCase() + S.filters.status.slice(1));
  if (S.conds.length)   tags.push(`${S.conds.length} condition${S.conds.length === 1 ? '' : 's'}`);
  return tags.length
    ? `<div class="rp-applied">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
    : '';
}

function toggleColsMenu(e) {
  e.stopPropagation();
  document.getElementById('rpt-colmenu')?.remove();
  const def = reportById(S.reportId); if (!def) return;
  const r = e.currentTarget.getBoundingClientRect();
  const m = document.createElement('div');
  m.className = 'rpt-drop';
  m.id = 'rpt-colmenu';
  m.style.top  = (r.bottom + 6) + 'px';
  m.style.left = Math.max(12, r.right - 220) + 'px';
  m.innerHTML = `<div class="rpt-drop-hd">Show columns</div>
    ${def.cols.map(c => `<div class="rpt-drop-item" onclick="Reports.toggleCol('${c.key}')">
      <input type="checkbox" ${S.hidden[c.key] ? '' : 'checked'} style="pointer-events:none;"/> ${esc(c.label)}</div>`).join('')}`;
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('click', function h(ev) {
    if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', h); }
  }), 0);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACTIONS
// ═══════════════════════════════════════════════════════════════════════════
async function run() {
  const def = reportById(S.reportId); if (!def) return;
  S.running = true; renderReport();
  try {
    await loadRefData();
    S.rows = await def.run();
    S.visited[def.id] = new Date().toISOString();
    localStorage.setItem('ktl_report_visits', JSON.stringify(S.visited));
  } catch (e) {
    console.error('[reports]', e);
    S.rows = [];
    toast(e.message || 'Report failed to run', 'error');
  }
  S.running = false;
  renderReport();
}

async function open(id) {
  const def = reportById(id); if (!def) return;
  S.reportId = id;
  S.view = 'report';
  S.filters = { rep:'', store:'', status:'', q:'', leaveType:'' };
  S.conds = [];
  S.hidden = {};
  S.sort = { key:null, dir:'desc' };
  S.rows = [];
  if (!S.from || !S.to) { const r = resolveRange(S.preset); S.from = r.from; S.to = r.to; }
  renderReport();
  await run();
}

function home() { S.view = 'home'; S.reportId = null; renderHome(); }
function setCat(c) { S.cat = c; renderHome(); }
function setSearch(v) {
  S.search = v;
  const el = root().querySelector('.rpt-srch input');
  const pos = el?.selectionStart;
  renderHome();
  const el2 = root().querySelector('.rpt-srch input');
  if (el2) { el2.focus(); if (pos != null) el2.setSelectionRange(pos, pos); }
}
function toggleFav(id) {
  S.favs = S.favs.includes(id) ? S.favs.filter(x => x !== id) : [...S.favs, id];
  localStorage.setItem('ktl_report_favs', JSON.stringify(S.favs));
  renderHome();
}

function setPreset(p) {
  S.preset = p;
  const r = resolveRange(p);
  S.from = r.from; S.to = r.to;
  S.cache = {};                      // range changed → data must be refetched
  if (p === 'custom') { renderReport(); return; }
  run();
}
function setDate(which, v) {
  S[which] = v;
  S.preset = 'custom';
  S.cache = {};
  if (S.from && S.to && S.from > S.to) { toast('The From date is after the To date.', 'warn'); return; }
  run();
}
function setFilter(k, v) { S.filters[k] = v; run(); }
function sortBy(key) {
  if (S.sort.key === key) S.sort.dir = S.sort.dir === 'asc' ? 'desc' : 'asc';
  else S.sort = { key, dir:'desc' };
  renderReport();
}
function toggleCol(key) {
  S.hidden[key] = !S.hidden[key];
  const def = reportById(S.reportId);
  if (visibleCols(def).length === 0) { S.hidden[key] = false; toast('At least one column must stay visible.', 'warn'); }
  document.getElementById('rpt-colmenu')?.remove();
  renderReport();
}
function addCond() {
  const def = reportById(S.reportId); if (!def) return;
  const col = def.cols[0];
  S.conds.push({ field: col.key, op: isNumericType(col.type) ? 'gt' : ['date','datetime','time'].includes(col.type) ? 'is' : 'contains', value:'', value2:'' });
  renderReport();
}
function setCond(i, field, value) {
  if (!S.conds[i]) return;
  S.conds[i][field] = value;
  if (field === 'field') {
    const def = reportById(S.reportId);
    const col = def.cols.find(c => c.key === value);
    S.conds[i].op = isNumericType(col.type) ? 'gt' : ['date','datetime','time'].includes(col.type) ? 'is' : 'contains';
    S.conds[i].value = ''; S.conds[i].value2 = '';
  }
  renderReport();
}
function removeCond(i) { S.conds.splice(i, 1); renderReport(); }
function reset() {
  S.filters = { rep:'', store:'', status:'', q:'', leaveType:'' };
  S.conds = []; S.hidden = {}; S.sort = { key:null, dir:'desc' };
  S.preset = 'this_month';
  const r = resolveRange(S.preset); S.from = r.from; S.to = r.to;
  S.cache = {};
  run();
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════════════════════════════════
function currentTable() {
  const def = reportById(S.reportId);
  const cols = visibleCols(def);
  const rows = sortRows(applyConds(S.rows, def), def);
  return { def, cols, rows };
}
function safeName(s) { return String(s).replace(/[^\w]+/g, '_'); }

function exportCSV() {
  const { def, cols, rows } = currentTable();
  if (!rows.length) { toast('Nothing to export.', 'warn'); return; }
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    [q('Kingdom Trading Limited')].join(','),
    [q(def.name)].join(','),
    [q(rangeLabel())].join(','),
    '',
    cols.map(c => q(c.label)).join(','),
    ...rows.map(r => cols.map(c => q(fmtCell(r[c.key], c.type))).join(',')),
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type:'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName(def.name)}_${S.from}_to_${S.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSV downloaded.');
}

async function exportExcel() {
  const { def, cols, rows } = currentTable();
  if (!rows.length) { toast('Nothing to export.', 'warn'); return; }
  if (typeof ExcelJS === 'undefined') { toast('Excel library not loaded — using CSV instead.', 'warn'); return exportCSV(); }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(def.name.slice(0, 30));

  ws.mergeCells(1, 1, 1, cols.length);
  ws.getCell(1, 1).value = 'Kingdom Trading Limited';
  ws.getCell(1, 1).font = { name:'Calibri', size:13, bold:true, color:{ argb:'FF1A3A6B' } };
  ws.getCell(1, 1).alignment = { horizontal:'center' };

  ws.mergeCells(2, 1, 2, cols.length);
  ws.getCell(2, 1).value = def.name;
  ws.getCell(2, 1).font = { name:'Calibri', size:11, bold:true };
  ws.getCell(2, 1).alignment = { horizontal:'center' };

  ws.mergeCells(3, 1, 3, cols.length);
  ws.getCell(3, 1).value = rangeLabel();
  ws.getCell(3, 1).font = { name:'Calibri', size:10, color:{ argb:'FF6B6B67' } };
  ws.getCell(3, 1).alignment = { horizontal:'center' };

  const headRow = ws.getRow(5);
  cols.forEach((c, i) => {
    const cell = headRow.getCell(i + 1);
    cell.value = c.label;
    cell.font = { name:'Calibri', size:10.5, bold:true, color:{ argb:'FFFFFFFF' } };
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1A3A6B' } };
    cell.alignment = { horizontal: c.r ? 'right' : 'left', vertical:'middle' };
  });
  headRow.height = 20;

  rows.forEach((r, ri) => {
    const row = ws.getRow(6 + ri);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      const raw = r[c.key];
      if (isNumericType(c.type) && raw != null && raw !== '') {
        cell.value = Number(raw);
        cell.numFmt = c.type === 'money' ? '#,##0' : c.type === 'pct' ? '0.0"%"' : '#,##0.##';
      } else if (c.type === 'date' && raw) {
        cell.value = fmtDate(raw);
      } else if ((c.type === 'datetime' || c.type === 'time') && raw) {
        cell.value = c.type === 'time' ? fmtTime(raw) : fmtDateTime(raw);
      } else {
        cell.value = raw == null || raw === '' ? '—' : String(raw);
      }
      cell.font = { name:'Calibri', size:10.5 };
      cell.alignment = { horizontal: c.r ? 'right' : 'left' };
      if (ri % 2 === 1) cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF7F8FA' } };
    });
  });

  const totalCols = def.cols.filter(c => c.total && !S.hidden[c.key]);
  if (totalCols.length) {
    const tr = ws.getRow(6 + rows.length);
    cols.forEach((c, i) => {
      const cell = tr.getCell(i + 1);
      if (i === 0) cell.value = `Total — ${rows.length} rows`;
      else if (c.total) { cell.value = rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0); cell.numFmt = c.type === 'money' ? '#,##0' : '#,##0.##'; }
      cell.font = { name:'Calibri', size:10.5, bold:true };
      cell.alignment = { horizontal: c.r ? 'right' : 'left' };
      cell.border = { top:{ style:'thin', color:{ argb:'FF1A3A6B' } } };
    });
  }

  cols.forEach((c, i) => {
    const maxLen = Math.max(c.label.length, ...rows.slice(0, 200).map(r => String(fmtCell(r[c.key], c.type)).length));
    ws.getColumn(i + 1).width = Math.min(42, Math.max(11, maxLen + 3));
  });
  ws.views = [{ state:'frozen', ySplit:5 }];

  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = `${safeName(def.name)}_${S.from}_to_${S.to}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Excel file downloaded.');
}

function print() {
  const { def, cols, rows } = currentTable();
  if (!rows.length) { toast('Nothing to print.', 'warn'); return; }
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print.', 'warn'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>${esc(def.name)}</title><style>
    body{font-family:'Segoe UI',Arial,sans-serif;padding:22px 26px;color:#1F2024;}
    .org{font-size:8.5px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#8B909B;}
    h1{font-family:'Iowan Old Style',Palatino,Georgia,serif;font-size:21px;font-weight:600;letter-spacing:-.02em;color:#12233F;margin:6px 0 0;}
    .range{font-size:11px;color:#575C68;margin-top:5px;}
    .stamp{float:right;text-align:right;font-size:10px;color:#575C68;border-right:2px solid #A97406;padding-right:11px;}
    .stamp b{display:block;font-size:8px;letter-spacing:.13em;text-transform:uppercase;color:#8B909B;font-weight:700;}
    table{width:100%;border-collapse:collapse;font-size:10px;margin-top:18px;}
    th{border-top:1px solid #EAEAE4;border-bottom:2px solid #12233F;padding:8px 9px 6px;text-align:left;
       font-size:7.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:#575C68;}
    td{padding:7px 9px;border-bottom:1px solid #EAEAE4;font-variant-numeric:tabular-nums;}
    .r{text-align:right;}
    tfoot td{font-weight:700;border-top:2px solid #12233F;border-bottom:none;color:#12233F;}
    .foot{margin-top:14px;font-size:8.5px;color:#8B909B;}
    @page{size:landscape;margin:11mm;}
  </style></head><body>
    <div class="stamp"><b>Prepared</b>${esc(fmtDateTime(new Date().toISOString()))}<b style="margin-top:5px;">By</b>${esc(me()?.full_name || '—')}</div>
    <div class="org">Kingdom Trading Limited</div>
    <h1>${esc(def.name)}</h1>
    <div class="range">${esc(rangeLabel())}</div>
    <table><thead><tr>${cols.map(c => `<th class="${c.r ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${cols.map(c => `<td class="${c.r ? 'r' : ''}">${esc(fmtCell(r[c.key], c.type))}</td>`).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr>${cols.map((c, i) => `<td class="${c.r ? 'r' : ''}">${i === 0 ? 'Total' : (c.total ? esc(fmtCell(rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0), c.type)) : '')}</td>`).join('')}</tr></tfoot>
    </table>
    <div class="foot">${fmtNum(rows.length)} rows · generated from KTLSALES</div>
  </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 350);
}

// ═══════════════════════════════════════════════════════════════════════════
//  MOUNT — takes over the existing Reports screen
// ═══════════════════════════════════════════════════════════════════════════
function mount() {
  if (S.mounted) return true;
  const screen = document.getElementById('screen-reports');
  if (!screen) return false;

  injectStyles();

  // Preserve the original markup (other code references its ids) but hide it.
  const legacy = document.createElement('div');
  legacy.id = 'rpt-legacy';
  legacy.style.display = 'none';
  while (screen.firstChild) legacy.appendChild(screen.firstChild);
  screen.appendChild(legacy);

  const rootEl = document.createElement('div');
  rootEl.id = 'rpt-root';
  screen.appendChild(rootEl);

  S.mounted = true;
  return true;
}

async function boot() {
  if (!mount()) return;
  if (roleRep()) {
    root().innerHTML = `<div class="empty-state" style="padding:50px 20px;">
      <div style="font-size:26px;margin-bottom:9px;">🔒</div>
      <div style="font-weight:600;font-size:13px;">Reports are not available for sales reps</div></div>`;
    return;
  }
  if (!S.from || !S.to) { const r = resolveRange(S.preset); S.from = r.from; S.to = r.to; }
  await loadRefData();
  if (S.view === 'report' && S.reportId) renderReport();
  else renderHome();
}

function patchHost() {
  if (window.__rptPatched) return;
  const orig = window.loadReports;
  window.loadReports = function () {
    boot();
    return undefined;                     // legacy loader intentionally skipped
  };
  window.__rptLegacyLoadReports = orig;
  window.__rptPatched = true;
}

patchHost();
document.addEventListener('DOMContentLoaded', patchHost);

// ─── PUBLIC API (inline onclick handlers) ──────────────────────────────────
window.Reports = {
  open, home, run, reset,
  setCat, setSearch, toggleFav,
  setPreset, setDate, setFilter,
  sortBy, toggleCol, toggleColsMenu,
  addCond, setCond, removeCond,
  exportCSV, exportExcel, print,
  boot, state: S, definitions: REPORTS, config: CFG,
};

console.log('%c[KTL] Reports Centre ready — ' + REPORTS.length + ' reports', 'color:#1a3a6b;font-weight:700');
})();
