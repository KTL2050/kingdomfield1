/* ═══════════════════════════════════════════════════════════════════════════
   KTLSALES — LEAVE MANAGEMENT MODULE
   Drop-in module. Add ONE line at the bottom of clockin.html, just before
   </body>:

       <script src="ktl-leave.js"></script>

   It reuses the app's Supabase client (sb), session (currentUser), role
   helpers (isSalesRep/canManage/canAdmin), navigation (buildNav/goTo),
   dialogs (showConfirmDialog) and CSS classes. Nothing in clockin.html
   needs to change.

   Requires leave-management-schema.sql to have been run once in Supabase.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CFG = {
  bucket:          'leave-attachments',
  excludeWeekends: false,   // set true to count Mon–Fri only as leave days
  notifPollMs:     60000,   // how often the bell refreshes
  maxAttachmentMB: 5,
};

const STATUS_LABEL = {
  pending:   'Pending',
  approved:  'Approved',
  rejected:  'Rejected',
  cancelled: 'Cancelled',
  upcoming:  'Upcoming',
  active:    'On Leave',
  completed: 'Completed',
};
const STATUS_BADGE = {
  pending:'ba', approved:'bg', rejected:'br', cancelled:'bb',
  upcoming:'bb', active:'bg', completed:'bgold',
};
const STATUS_COLOR = {
  pending:'#854F0B', approved:'#3B6D11', rejected:'#A32D2D', cancelled:'#6b6b67',
  upcoming:'#2451a0', active:'#1D9E75', completed:'#b8860b',
};

// ─── STATE ─────────────────────────────────────────────────────────────────
const S = {
  booted:      false,
  loading:     false,
  tab:         'overview',      // overview | approvals | calendar | requests | settings
  types:       [],
  users:       [],              // id, full_name, email, role, is_active
  approvers:   [],              // { employee_id, manager_id }
  requests:    [],
  roster:      [],              // approved leave for everyone — visible to all
  repTab:      'mine',          // mine | roster
  notifs:      [],
  teamIds:     null,            // null = every employee (admin)
  calMode:     'month',         // month | week | day
  calCursor:   new Date(),
  filters:     { rep:'', manager:'', type:'', status:'', from:'', to:'' },
};

// ─── SAFE ACCESS TO HOST APP GLOBALS ───────────────────────────────────────
function me()        { try { return currentUser || null; } catch (e) { return null; } }
function DB()        { try { return sb; } catch (e) { return null; } }
function roleRep()   { try { return isSalesRep(); } catch (e) { return me()?.role === 'sales_rep'; } }
function roleAdmin() { try { return canAdmin();   } catch (e) { return me()?.role === 'admin'; } }
function roleMgr()   { try { return canManage();  } catch (e) { return ['admin','manager'].includes(me()?.role); } }

// ─── SMALL HELPERS ─────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const jsq = s => String(s ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,' ');

function todayISO() { return new Date().toISOString().split('T')[0]; }
function iso(d)     { const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset()*60000).toISOString().split('T')[0]; }
function parseD(s)  { if (!s) return null; const [y,m,d] = String(s).split('T')[0].split('-').map(Number); return new Date(y, m-1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }

function fmtDate(s) {
  const d = parseD(s); if (!d) return '—';
  return d.toLocaleDateString('en-UG', { day:'2-digit', month:'short', year:'numeric' });
}
function fmtShort(s) {
  const d = parseD(s); if (!d) return '—';
  return d.toLocaleDateString('en-UG', { day:'numeric', month:'short' });
}
function fmtStamp(t) {
  if (!t) return '—';
  return new Date(t).toLocaleString('en-UG', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function relTime(t) {
  if (!t) return '';
  const diff = (Date.now() - new Date(t).getTime()) / 1000;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  if (diff < 604800)return Math.floor(diff/86400) + 'd ago';
  return fmtShort(new Date(t).toISOString());
}
function initials(name) {
  return (name || 'U').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0,2);
}

/** Inclusive day count between two dates, honouring CFG.excludeWeekends. */
function countDays(startISO, endISO) {
  const a = parseD(startISO), b = parseD(endISO);
  if (!a || !b || b < a) return 0;
  let n = 0;
  for (let d = new Date(a); d <= b; d = addDays(d, 1)) {
    if (CFG.excludeWeekends && (d.getDay() === 0 || d.getDay() === 6)) continue;
    n++;
  }
  return n;
}
function countWorkingDays(startISO, endISO) {
  const a = parseD(startISO), b = parseD(endISO);
  if (!a || !b || b < a) return 0;
  let n = 0;
  for (let d = new Date(a); d <= b; d = addDays(d, 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  }
  return n;
}

/** Approved leave gains a live sub-status so the calendar can colour it. */
function liveStatus(r) {
  if (!r) return 'pending';
  if (r.status !== 'approved') return r.status;
  const t = todayISO();
  if (r.start_date > t) return 'upcoming';
  if (r.end_date   < t) return 'completed';
  return 'active';
}
function badge(status) {
  return `<span class="badge ${STATUS_BADGE[status] || 'bb'}">${STATUS_LABEL[status] || status}</span>`;
}
function typeColor(r) {
  const t = S.types.find(x => x.id === r.leave_type_id);
  return t?.color || '#2451a0';
}
function userName(id) {
  if (id == null) return '—';
  const u = S.users.find(x => String(x.id) === String(id));
  return u ? u.full_name : '—';
}
function covers(r, dISO) { return r.start_date <= dISO && r.end_date >= dISO; }

/** Requests opened from a notification may sit outside the loaded scope. */
function getReq(id) {
  return S.requests.find(x => x.id === id)
      || S.roster.find(x => x.id === id)      // colleagues' leave opened from the roster
      || null;
}
function cacheReq(r) {
  if (!r) return;
  const i = S.requests.findIndex(x => x.id === r.id);
  if (i >= 0) S.requests[i] = r; else S.requests.push(r);
}

function toast(msg, kind) {
  document.getElementById('lv-toast')?.remove();
  const bg = kind === 'error' ? '#A32D2D' : kind === 'warn' ? '#854F0B' : '#1D9E75';
  const el = document.createElement('div');
  el.id = 'lv-toast';
  el.className = 'lv-toast';
  el.style.background = bg;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

// ─── STYLES ────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('lv-styles')) return;
  const css = `
.lv-bell{position:relative;width:34px;height:34px;border-radius:9px;border:0.5px solid var(--brd2);background:var(--bg);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;color:var(--txt2);flex-shrink:0;transition:all .15s;}
.lv-bell:hover{background:var(--bg2);color:var(--royal);}
.lv-bell-dot{position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#E24B4A;color:#fff;font-size:9.5px;font-weight:700;display:none;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(226,75,74,.5);}
.lv-bell-dot.on{display:flex;}
.lv-panel{position:fixed;width:340px;max-width:calc(100vw - 24px);max-height:70vh;overflow-y:auto;background:var(--bg);border:0.5px solid var(--brd2);border-radius:13px;box-shadow:0 12px 40px rgba(0,0,0,.18);z-index:9500;display:none;}
.lv-panel.open{display:block;}
.lv-panel-hdr{padding:12px 14px;border-bottom:0.5px solid var(--brd);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--bg);border-radius:13px 13px 0 0;}
.lv-nrow{padding:11px 14px;border-bottom:0.5px solid var(--brd);cursor:pointer;display:flex;gap:10px;transition:background .12s;}
.lv-nrow:hover{background:var(--bg2);}
.lv-nrow.unread{background:var(--royal-light);}
.lv-nrow.unread:hover{background:#dde7f7;}
.lv-ndot{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:5px;}
.lv-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px;}
.lv-stat{background:var(--bg);border:0.5px solid var(--brd);border-radius:11px;padding:13px 14px;box-shadow:0 1px 5px rgba(0,0,0,.05);}
.lv-stat-v{font-size:21px;font-weight:700;letter-spacing:-.02em;line-height:1.1;}
.lv-stat-l{font-size:10.5px;color:var(--txt3);text-transform:uppercase;letter-spacing:.07em;font-weight:600;margin-top:5px;}
.lv-stat-s{font-size:11px;color:var(--txt2);margin-top:3px;}
.lv-cal{border:0.5px solid var(--brd);border-radius:11px;overflow:hidden;background:var(--bg);}
.lv-cal-hd{display:grid;grid-template-columns:repeat(7,1fr);background:var(--bg2);border-bottom:0.5px solid var(--brd);}
.lv-cal-hd div{padding:8px 6px;font-size:10px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:.07em;text-align:center;}
.lv-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);}
.lv-day{min-height:96px;border-right:0.5px solid var(--brd);border-bottom:0.5px solid var(--brd);padding:5px 5px 6px;position:relative;}
.lv-day:nth-child(7n){border-right:none;}
.lv-day.out{background:var(--bg2);opacity:.55;}
.lv-day.today{background:#fffdf3;box-shadow:inset 0 0 0 1.5px var(--gold-mid);}
.lv-day.we{background:rgba(26,58,107,.025);}
.lv-daynum{font-size:11px;font-weight:600;color:var(--txt2);margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;}
.lv-day.today .lv-daynum{color:var(--gold);}
.lv-chip{display:block;width:100%;text-align:left;border:none;border-radius:5px;padding:3px 6px;margin-bottom:3px;font-size:10px;font-weight:600;line-height:1.35;cursor:pointer;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:inherit;}
.lv-chip.pend{background:repeating-linear-gradient(45deg,#EF9F27,#EF9F27 5px,#e0942190 5px,#e0942190 10px);}
.lv-chip:hover{filter:brightness(1.12);}
.lv-more{font-size:9.5px;color:var(--txt3);cursor:pointer;padding-left:2px;}
.lv-wk{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;}
.lv-wkcol{border:0.5px solid var(--brd);border-radius:10px;background:var(--bg);overflow:hidden;min-height:180px;}
.lv-wkhd{padding:7px 8px;background:var(--bg2);border-bottom:0.5px solid var(--brd);font-size:11px;font-weight:600;text-align:center;}
.lv-wkhd.today{background:var(--gold-light);color:var(--gold);}
.lv-wkbody{padding:6px;}
.lv-legend{display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--txt2);margin-top:10px;}
.lv-lg{display:inline-flex;align-items:center;gap:5px;}
.lv-lgd{width:10px;height:10px;border-radius:3px;display:inline-block;}
.lv-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:9600;padding:16px;}
.lv-modal{background:var(--bg);border-radius:15px;width:100%;max-width:540px;max-height:88vh;overflow-y:auto;box-shadow:0 14px 52px rgba(0,0,0,.24);}
.lv-modal-hd{padding:16px 20px;border-bottom:0.5px solid var(--brd);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--bg);border-radius:15px 15px 0 0;z-index:2;}
.lv-modal-bd{padding:18px 20px;}
.lv-modal-ft{padding:14px 20px;border-top:0.5px solid var(--brd);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;position:sticky;bottom:0;background:var(--bg);border-radius:0 0 15px 15px;}
.lv-x{background:none;border:none;font-size:20px;line-height:1;color:var(--txt3);cursor:pointer;padding:2px 6px;border-radius:6px;}
.lv-x:hover{background:var(--bg2);color:var(--txt);}
.lv-kv{display:grid;grid-template-columns:132px 1fr;gap:7px 12px;font-size:12.5px;}
.lv-k{color:var(--txt3);font-weight:600;font-size:11.5px;}
.lv-req{border:0.5px solid var(--brd);border-radius:11px;padding:13px 14px;margin-bottom:10px;background:var(--bg);display:flex;gap:12px;align-items:flex-start;box-shadow:0 1px 4px rgba(0,0,0,.04);}
.lv-av{width:36px;height:36px;border-radius:50%;background:var(--royal-light);color:var(--royal);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;}
.lv-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);color:#fff;padding:11px 18px;border-radius:10px;font-size:12.5px;font-weight:500;z-index:99999;box-shadow:0 6px 24px rgba(0,0,0,.25);transition:opacity .35s,transform .35s;max-width:90vw;}
.lv-toast.out{opacity:0;transform:translateX(-50%) translateY(8px);}
.lv-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px;}
.lv-tabcount{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 5px;border-radius:9px;background:#E24B4A;color:#fff;font-size:9.5px;font-weight:700;margin-left:6px;}
.lv-scroll{overflow-x:auto;}
.lv-pill{padding:4px 10px;border-radius:7px;font-size:11px;border:0.5px solid var(--brd2);background:var(--bg);color:var(--txt2);cursor:pointer;font-family:inherit;font-weight:500;}
.lv-pill.on{background:var(--royal);color:#fff;border-color:var(--royal);}
.lv-mini-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;gap:8px;}
.lv-mini-m{font-size:12.5px;font-weight:700;letter-spacing:-.01em;}
.lv-mini-nav{display:flex;gap:4px;align-items:center;}
.lv-mini-btn{width:24px;height:24px;border-radius:7px;border:0.5px solid var(--brd2);background:var(--bg);color:var(--txt2);cursor:pointer;font-size:12px;line-height:1;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;}
.lv-mini-btn:hover{background:var(--bg2);color:var(--royal);}
.lv-mini-btn.txt{width:auto;padding:0 9px;font-size:11px;font-weight:500;}
.lv-mini-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;}
.lv-mini-dow{font-size:9px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:.06em;text-align:center;padding-bottom:4px;}
.lv-mini-d{height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--txt2);position:relative;}
.lv-mini-d.out{color:var(--txt3);opacity:.4;}
.lv-mini-d.today{box-shadow:inset 0 0 0 1.5px var(--gold-mid);font-weight:700;color:var(--gold);}
.lv-mini-d.has{cursor:pointer;font-weight:600;color:#fff;}
.lv-mini-d.has:hover{filter:brightness(1.12);}
.lv-mini-d.has.today{color:#fff;}
.lv-mini-list{margin-top:11px;border-top:0.5px solid var(--brd);padding-top:9px;}
.lv-mini-row{display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;border-radius:6px;}
.lv-mini-row:hover{background:var(--bg2);}
.lv-mini-bar{width:3px;height:26px;border-radius:2px;flex-shrink:0;}
@media(max-width:900px){
  .lv-kv{grid-template-columns:110px 1fr;}
  .lv-day{min-height:74px;}
  .lv-wk{grid-template-columns:1fr;}
}
@media(max-width:640px){
  .lv-cal-hd div{font-size:9px;padding:6px 2px;}
  .lv-day{min-height:62px;padding:3px;}
  .lv-chip{font-size:8.5px;padding:2px 4px;}
  .lv-panel{width:calc(100vw - 20px);}
}`;
  const el = document.createElement('style');
  el.id = 'lv-styles';
  el.textContent = css;
  document.head.appendChild(el);
}

// ─── DATA LAYER ────────────────────────────────────────────────────────────
async function loadTypes() {
  const { data, error } = await DB().from('leave_types').select('*').order('sort_order');
  if (error) { console.warn('[leave] types:', error.message); return; }
  S.types = data || [];
}

async function loadUsers() {
  const { data } = await DB().from('users').select('id,full_name,email,role,is_active').order('full_name');
  S.users = data || [];
}

async function loadApprovers() {
  const { data } = await DB().from('leave_approvers').select('*');
  S.approvers = data || [];
}

/** Which employees the signed-in user is allowed to see. null = everyone. */
async function resolveScope() {
  const u = me();
  if (!u) { S.teamIds = []; return; }
  if (roleAdmin()) { S.teamIds = null; return; }
  if (roleRep())   { S.teamIds = [String(u.id)]; return; }
  const { data } = await DB().from('leave_approvers').select('employee_id').eq('manager_id', u.id);
  const ids = new Set((data || []).map(r => String(r.employee_id)));
  ids.add(String(u.id));                       // managers see their own leave too
  S.teamIds = [...ids];
}

/** Everyone can see who is away. Approved leave only, and only the facts
    people need to plan around — never the reason or the attachment. */
async function loadRoster() {
  const from = iso(addDays(new Date(), -45));
  const { data, error } = await DB().from('leave_requests')
    .select('id,employee_id,employee_name,leave_type_id,leave_type_name,start_date,end_date,days_count,status')
    .eq('status', 'approved').gte('end_date', from)
    .order('start_date', { ascending: true }).limit(500);
  if (error) { console.warn('[leave] roster:', error.message); S.roster = []; return; }
  S.roster = data || [];
}

async function loadRequests() {
  let q = DB().from('leave_requests').select('*').order('start_date', { ascending: false }).limit(1000);
  if (S.teamIds !== null) q = q.in('employee_id', S.teamIds);
  const { data, error } = await q;
  if (error) { console.warn('[leave] requests:', error.message); S.requests = []; return; }
  S.requests = data || [];
}

async function approverIdsFor(employeeId) {
  const { data } = await DB().from('leave_approvers').select('manager_id').eq('employee_id', employeeId);
  let ids = (data || []).map(r => r.manager_id);
  if (!ids.length) {                            // nobody assigned yet → fall back to admins
    const { data: admins } = await DB().from('users').select('id').eq('role', 'admin').eq('is_active', true);
    ids = (admins || []).map(u => u.id);
  }
  return [...new Set(ids.map(String))].filter(id => String(id) !== String(employeeId));
}

async function notify(userIds, type, title, body, requestId) {
  const uniq = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!uniq.length) return;
  const rows = uniq.map(uid => ({ user_id: uid, type, title, body, request_id: requestId }));
  const { error } = await DB().from('leave_notifications').insert(rows);
  if (error) console.warn('[leave] notify:', error.message);
}

async function audit(requestId, action, fromStatus, toStatus, note) {
  const u = me();
  await DB().from('leave_audit_log').insert({
    request_id: requestId, action,
    actor_id: u?.id, actor_name: u?.full_name,
    from_status: fromStatus, to_status: toStatus, note: note || null,
  }).then(({ error }) => { if (error) console.warn('[leave] audit:', error.message); });
}

// ═══════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS — topbar bell
// ═══════════════════════════════════════════════════════════════════════════
const NOTIF_META = {
  new_request: { icon:'📥', color:'#854F0B' },
  approved:    { icon:'✅', color:'#3B6D11' },
  rejected:    { icon:'❌', color:'#A32D2D' },
  cancelled:   { icon:'🚫', color:'#6b6b67' },
  upcoming:    { icon:'📅', color:'#2451a0' },
};

function mountBell() {
  if (document.getElementById('lv-bell')) return;
  const host = document.querySelector('.topbar-right');
  if (!host) return;
  const btn = document.createElement('button');
  btn.className = 'lv-bell';
  btn.id = 'lv-bell';
  btn.title = 'Leave notifications';
  btn.onclick = e => { e.stopPropagation(); toggleBell(); };
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
      <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/>
    </svg><span class="lv-bell-dot" id="lv-bell-dot">0</span>`;
  host.insertBefore(btn, host.firstChild);

  const panel = document.createElement('div');
  panel.className = 'lv-panel';
  panel.id = 'lv-panel';
  document.body.appendChild(panel);

  document.addEventListener('click', e => {
    const p = document.getElementById('lv-panel');
    if (p && p.classList.contains('open') && !p.contains(e.target)) p.classList.remove('open');
  });
}

function toggleBell() {
  const panel = document.getElementById('lv-panel');
  const btn   = document.getElementById('lv-bell');
  if (!panel || !btn) return;
  if (panel.classList.contains('open')) { panel.classList.remove('open'); return; }
  const r = btn.getBoundingClientRect();
  const w = Math.min(340, window.innerWidth - 24);
  panel.style.top  = (r.bottom + 8) + 'px';
  panel.style.left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12)) + 'px';
  renderPanel();
  panel.classList.add('open');
  loadNotifs().then(renderPanel);
}

async function loadNotifs() {
  const u = me();
  if (!u) return;
  const { data, error } = await DB().from('leave_notifications')
    .select('*').eq('user_id', u.id)
    .order('created_at', { ascending: false }).limit(40);
  if (error) { console.warn('[leave] notifs:', error.message); return; }
  S.notifs = data || [];
  const unread = S.notifs.filter(n => !n.is_read).length;
  const dot = document.getElementById('lv-bell-dot');
  if (dot) { dot.textContent = unread > 9 ? '9+' : unread; dot.classList.toggle('on', unread > 0); }
}

function renderPanel() {
  const panel = document.getElementById('lv-panel');
  if (!panel) return;
  const unread = S.notifs.filter(n => !n.is_read).length;
  const rows = S.notifs.length ? S.notifs.map(n => {
    const m = NOTIF_META[n.type] || { icon:'🔔', color:'var(--royal)' };
    return `<div class="lv-nrow${n.is_read ? '' : ' unread'}" onclick="Leave.openNotif('${n.id}',${n.request_id ? `'${n.request_id}'` : 'null'})">
      <span class="lv-ndot" style="background:${m.color};${n.is_read ? 'opacity:.25;' : ''}"></span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;line-height:1.4;">${m.icon} ${esc(n.title)}</div>
        <div style="font-size:11.5px;color:var(--txt2);line-height:1.5;margin-top:2px;">${esc(n.body || '')}</div>
        <div style="font-size:10px;color:var(--txt3);margin-top:4px;">${relTime(n.created_at)}</div>
      </div>
    </div>`;
  }).join('') : `<div class="empty-state" style="padding:30px 20px;">
      <div style="font-size:24px;margin-bottom:8px;">🔔</div>
      <div style="font-size:12.5px;">Nothing yet. Leave activity shows up here.</div>
    </div>`;

  panel.innerHTML = `<div class="lv-panel-hdr">
      <span style="font-size:13px;font-weight:700;">Leave notifications</span>
      ${unread ? `<button class="btn btn-sm" onclick="event.stopPropagation();Leave.markAllRead()">Mark all read</button>` : ''}
    </div>${rows}`;
}

async function markAllRead() {
  const u = me(); if (!u) return;
  await DB().from('leave_notifications').update({ is_read: true }).eq('user_id', u.id).eq('is_read', false);
  await loadNotifs(); renderPanel();
}

async function openNotif(notifId, requestId) {
  const n = S.notifs.find(x => x.id === notifId);
  if (n && !n.is_read) {
    n.is_read = true;
    DB().from('leave_notifications').update({ is_read: true }).eq('id', notifId).then(() => {});
    loadNotifs().then(renderPanel);
  }
  document.getElementById('lv-panel')?.classList.remove('open');
  if (requestId) { goToLeave(); await openDetail(requestId); }
}

/** Fires the "starting tomorrow" alerts. De-duplicated per user per request. */
async function sweepUpcoming() {
  if (roleRep()) return;
  const tomorrow = iso(addDays(new Date(), 1));
  const due = S.requests.filter(r => r.status === 'approved' && r.start_date === tomorrow);
  if (!due.length) return;

  const ids = due.map(r => r.id);
  const { data: existing } = await DB().from('leave_notifications')
    .select('user_id,request_id').eq('type', 'upcoming').in('request_id', ids);
  const seen = new Set((existing || []).map(n => `${n.request_id}|${n.user_id}`));

  for (const r of due) {
    const recipients = [...new Set([...(await approverIdsFor(r.employee_id)), String(r.employee_id)])];
    const missing = recipients.filter(uid => !seen.has(`${r.id}|${uid}`));
    if (!missing.length) continue;
    await notify(missing, 'upcoming',
      'Upcoming leave',
      `${r.employee_name || userName(r.employee_id)} is on leave from tomorrow and returns on ${fmtDate(r.end_date)}.`,
      r.id);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SCREEN RENDERING
// ═══════════════════════════════════════════════════════════════════════════
function root() { return document.getElementById('lv-root'); }

async function refresh(showSpinner) {
  const el = root(); if (!el) return;
  if (showSpinner) el.innerHTML = `<div class="empty-state" style="padding:50px 20px;">Loading leave data…</div>`;
  await Promise.all([loadTypes(), loadUsers(), loadApprovers()]);
  await resolveScope();
  await loadRequests();
  await loadRoster();
  await loadNotifs();
  sweepUpcoming().catch(e => console.warn('[leave] sweep:', e.message));
  render();
  document.querySelectorAll('[data-lv-mini]').forEach(el => drawMini(el.id));
}

function render() {
  const el = root(); if (!el) return;
  el.innerHTML = roleRep() ? renderRep() : renderManager();
  if (S.tab === 'calendar' && !roleRep()) drawCalendar();
}

function myRequests() {
  const u = me();
  return S.requests.filter(r => String(r.employee_id) === String(u?.id));
}

// ─── SALES REP VIEW ────────────────────────────────────────────────────────
function renderRep() {
  const mine    = myRequests();
  const year    = new Date().getFullYear();
  const pending = mine.filter(r => r.status === 'pending');
  const approved= mine.filter(r => r.status === 'approved');
  const taken   = approved.filter(r => r.end_date < todayISO() && parseD(r.start_date).getFullYear() === year)
                          .reduce((s, r) => s + (r.days_count || 0), 0);
  const upcoming= approved.filter(r => r.start_date > todayISO());
  const onLeave = approved.find(r => covers(r, todayISO()));

  const banner = onLeave
    ? `<div class="alert ag"><span>🌴</span><div>You are on <strong>${esc(onLeave.leave_type_name)}</strong> until ${fmtDate(onLeave.end_date)}. Welcome back on ${fmtDate(iso(addDays(parseD(onLeave.end_date), 1)))}.</div></div>`
    : upcoming.length
      ? `<div class="alert ai"><span>📅</span><div>Next approved leave: <strong>${esc(upcoming[upcoming.length-1].leave_type_name)}</strong>, ${fmtDate(upcoming[upcoming.length-1].start_date)} – ${fmtDate(upcoming[upcoming.length-1].end_date)}.</div></div>`
      : '';

  const away = rosterGroups().now.length;

  if (S.repTab === 'roster') {
    return `
    <div class="lv-bar">
      <div>
        <div style="font-size:15px;font-weight:700;letter-spacing:-.02em;">Who's away</div>
        <div style="font-size:11.5px;color:var(--txt2);margin-top:2px;">Approved leave across the team, so you can plan around it.</div>
      </div>
      <button class="btn btn-royal" onclick="Leave.openRequestForm()">＋ Request leave</button>
    </div>
    <div class="tabs" style="margin-bottom:14px;">
      <div class="tab" onclick="Leave.setRepTab('mine')">My leave</div>
      <div class="tab active" onclick="Leave.setRepTab('roster')">Who's away${away ? `<span class="lv-tabcount">${away}</span>` : ''}</div>
    </div>
    ${renderRoster()}`;
  }

  return `
  <div class="lv-bar">
    <div>
      <div style="font-size:15px;font-weight:700;letter-spacing:-.02em;">My leave</div>
      <div style="font-size:11.5px;color:var(--txt2);margin-top:2px;">Request time off and track where each request stands.</div>
    </div>
    <button class="btn btn-royal" onclick="Leave.openRequestForm()">＋ Request leave</button>
  </div>
  <div class="tabs" style="margin-bottom:14px;">
    <div class="tab active" onclick="Leave.setRepTab('mine')">My leave</div>
    <div class="tab" onclick="Leave.setRepTab('roster')">Who's away${away ? `<span class="lv-tabcount">${away}</span>` : ''}</div>
  </div>
  ${banner}
  <div class="lv-stats">
    ${stat(pending.length, 'Pending', pending.length ? 'Waiting for approval' : 'Nothing waiting', '#854F0B')}
    ${stat(approved.length, 'Approved', 'All time', '#3B6D11')}
    ${stat(taken, 'Days taken', `Completed in ${year}`, 'var(--royal)')}
    ${stat(upcoming.length, 'Upcoming', upcoming.length ? `Next: ${fmtShort(upcoming[upcoming.length-1].start_date)}` : 'None booked', 'var(--gold)')}
  </div>
  <div class="card">
    <div class="card-hdr"><span class="card-title">My requests</span>
      <span style="font-size:11px;color:var(--txt3);">${mine.length} total</span></div>
    ${mine.length ? `<div class="lv-scroll"><table><thead><tr>
        <th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th>Status</th><th>Requested</th><th>Decision</th><th></th>
      </tr></thead><tbody>${mine.map(repRow).join('')}</tbody></table></div>`
      : `<div class="empty-state"><div style="font-size:26px;margin-bottom:8px;">🗓️</div>
         <div style="font-weight:600;font-size:13px;margin-bottom:4px;">No requests yet</div>
         <div>Use “Request leave” to submit your first one.</div></div>`}
  </div>`;
}

function repRow(r) {
  const ls = liveStatus(r);
  const decision = r.status === 'approved'
    ? `<span style="color:#3B6D11;">Approved by ${esc(r.decided_by_name || userName(r.decided_by))}</span>`
    : r.status === 'rejected'
      ? `<span style="color:#A32D2D;" title="${esc(r.rejection_reason || '')}">Rejected — ${esc((r.rejection_reason || 'no reason given').slice(0, 40))}</span>`
      : '<span style="color:var(--txt3);">—</span>';
  return `<tr>
    <td><span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:2px;background:${typeColor(r)};"></span>${esc(r.leave_type_name || '—')}</span></td>
    <td>${fmtShort(r.start_date)} – ${fmtShort(r.end_date)}</td>
    <td><strong>${r.days_count || 0}</strong></td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.reason || '')}">${esc(r.reason || '—')}</td>
    <td>${badge(ls)}</td>
    <td style="font-size:11.5px;color:var(--txt2);">${fmtShort(iso(new Date(r.requested_at)))}</td>
    <td style="font-size:11.5px;">${decision}</td>
    <td style="text-align:right;white-space:nowrap;">
      <button class="btn btn-sm" onclick="Leave.openDetail('${r.id}')">View</button>
      ${r.status === 'pending' ? `<button class="btn btn-sm btn-danger" onclick="Leave.cancel('${r.id}')">Cancel</button>` : ''}
    </td></tr>`;
}

function stat(value, label, sub, color) {
  return `<div class="lv-stat">
    <div class="lv-stat-v" style="color:${color};">${value}</div>
    <div class="lv-stat-l">${label}</div>
    <div class="lv-stat-s">${sub}</div>
  </div>`;
}

// ─── MANAGER / ADMIN VIEW ──────────────────────────────────────────────────
function renderManager() {
  const pending = S.requests.filter(r => r.status === 'pending');
  const tabs = [
    { id:'overview',  label:'Overview' },
    { id:'approvals', label:'Pending approvals', count: pending.length },
    { id:'calendar',  label:'Calendar' },
    { id:'roster',    label:"Who's away" },
    { id:'requests',  label:'All requests' },
  ];
  if (roleAdmin()) tabs.push({ id:'settings', label:'Settings' });

  const body =
    S.tab === 'approvals' ? renderApprovals() :
    S.tab === 'calendar'  ? renderCalendarShell() :
    S.tab === 'roster'    ? renderRoster() :
    S.tab === 'requests'  ? renderList() :
    S.tab === 'settings'  ? renderSettings() :
                            renderOverview();

  return `
  <div class="lv-bar">
    <div>
      <div style="font-size:15px;font-weight:700;letter-spacing:-.02em;">Leave management</div>
      <div style="font-size:11.5px;color:var(--txt2);margin-top:2px;">
        ${roleAdmin() ? 'Organisation-wide leave' : `Your team — ${(S.teamIds || []).length} people`}
      </div>
    </div>
    <button class="btn btn-royal" onclick="Leave.openRequestForm()">＋ Request leave</button>
  </div>
  <div class="card" style="padding:0;">
    <div class="tabs" style="margin-bottom:0;">
      ${tabs.map(t => `<div class="tab${S.tab === t.id ? ' active' : ''}" onclick="Leave.setTab('${t.id}')">
        ${t.label}${t.count ? `<span class="lv-tabcount">${t.count}</span>` : ''}</div>`).join('')}
    </div>
    <div style="padding:14px;">${body}</div>
  </div>`;
}

function renderOverview() {
  const t = todayISO();
  const approved = S.requests.filter(r => r.status === 'approved');
  const pending  = S.requests.filter(r => r.status === 'pending');
  const onLeave  = approved.filter(r => covers(r, t));
  const soon     = approved.filter(r => r.start_date > t && r.start_date <= iso(addDays(new Date(), 14)))
                           .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const month    = new Date().toISOString().slice(0, 7);
  const monthDays= approved.filter(r => r.start_date.slice(0, 7) === month)
                           .reduce((s, r) => s + (r.days_count || 0), 0);
  const rejected = S.requests.filter(r => r.status === 'rejected').length;

  const oldest = pending.length ? Math.floor((Date.now() - new Date(
    pending.map(r => r.requested_at).sort()[0]).getTime()) / 86400000) : 0;

  return `
  <div class="lv-stats">
    ${stat(pending.length, 'Awaiting you', pending.length ? `Oldest waiting ${oldest} day${oldest === 1 ? '' : 's'}` : 'Queue is clear', '#854F0B')}
    ${stat(onLeave.length, 'On leave today', onLeave.length ? onLeave.map(r => (r.employee_name || userName(r.employee_id)).split(' ')[0]).slice(0, 3).join(', ') : 'Everyone is in', '#1D9E75')}
    ${stat(soon.length, 'Starting soon', 'Next 14 days', 'var(--royal)')}
    ${stat(monthDays, 'Leave days', 'Approved this month', 'var(--gold)')}
    ${stat(approved.length, 'Approved', 'All time', '#3B6D11')}
    ${stat(rejected, 'Rejected', 'All time', '#A32D2D')}
  </div>

  <div class="two-col" style="align-items:start;">
    <div class="card" style="margin-bottom:0;">
      <div class="card-hdr"><span class="card-title">On leave today</span>
        <span class="badge ${onLeave.length ? 'bg' : 'bb'}">${onLeave.length}</span></div>
      ${onLeave.length ? onLeave.map(r => personRow(r, `back ${fmtDate(iso(addDays(parseD(r.end_date), 1)))}`)).join('')
        : `<div class="empty-state" style="padding:24px;">Full team is in today.</div>`}
    </div>
    <div class="card" style="margin-bottom:0;">
      <div class="card-hdr"><span class="card-title">Coming up</span>
        <span style="font-size:11px;color:var(--txt3);">Next 14 days</span></div>
      ${soon.length ? soon.slice(0, 8).map(r => personRow(r, `${fmtShort(r.start_date)} – ${fmtShort(r.end_date)}`)).join('')
        : `<div class="empty-state" style="padding:24px;">No leave booked in the next two weeks.</div>`}
    </div>
  </div>

  ${pending.length ? `<div class="card" style="margin-top:14px;margin-bottom:0;">
    <div class="card-hdr"><span class="card-title">Waiting for your decision</span>
      <button class="btn btn-sm" onclick="Leave.setTab('approvals')">Open all →</button></div>
    ${pending.slice(0, 3).map(approvalCard).join('')}
  </div>` : ''}`;
}

function personRow(r, note) {
  const name = r.employee_name || userName(r.employee_id);
  return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:0.5px solid var(--brd);cursor:pointer;" onclick="Leave.openDetail('${r.id}')">
    <div class="lv-av">${initials(name)}</div>
    <div style="flex:1;min-width:0;">
      <div style="font-size:12.5px;font-weight:600;">${esc(name)}</div>
      <div style="font-size:11px;color:var(--txt2);margin-top:1px;">
        <span style="width:7px;height:7px;border-radius:2px;background:${typeColor(r)};display:inline-block;margin-right:5px;"></span>
        ${esc(r.leave_type_name || '')} · ${note}
      </div>
    </div>
    <span style="font-size:11px;font-weight:600;color:var(--txt3);">${r.days_count}d</span>
  </div>`;
}

// ─── PENDING APPROVALS ─────────────────────────────────────────────────────
function renderApprovals() {
  const pending = S.requests.filter(r => r.status === 'pending')
    .sort((a, b) => (a.requested_at || '').localeCompare(b.requested_at || ''));
  if (!pending.length) return `<div class="empty-state" style="padding:44px 20px;">
      <div style="font-size:28px;margin-bottom:10px;">✅</div>
      <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Nothing to approve</div>
      <div>New requests from your team land here.</div></div>`;
  return pending.map(approvalCard).join('');
}

function approvalCard(r) {
  const name  = r.employee_name || userName(r.employee_id);
  const mine  = canDecide(r);
  const waited= Math.floor((Date.now() - new Date(r.requested_at).getTime()) / 86400000);
  return `<div class="lv-req">
    <div class="lv-av">${initials(name)}</div>
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:13px;font-weight:600;">${esc(name)}</span>
        ${badge('pending')}
        ${r.attachment_path ? '<span style="font-size:11px;color:var(--txt3);">📎 attachment</span>' : ''}
      </div>
      <div style="font-size:12px;color:var(--txt2);margin-top:4px;">
        <span style="width:8px;height:8px;border-radius:2px;background:${typeColor(r)};display:inline-block;margin-right:5px;"></span>
        <strong style="color:var(--txt);">${esc(r.leave_type_name || '')}</strong> ·
        ${fmtDate(r.start_date)} → ${fmtDate(r.end_date)} · <strong>${r.days_count} day${r.days_count === 1 ? '' : 's'}</strong>
      </div>
      <div style="font-size:11.5px;color:var(--txt2);margin-top:4px;line-height:1.5;">${esc(r.reason || 'No reason given.')}</div>
      <div style="font-size:10.5px;color:var(--txt3);margin-top:5px;">Requested ${relTime(r.requested_at)}${waited >= 2 ? ` · waiting ${waited} days` : ''}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0;">
      <button class="btn btn-sm" onclick="Leave.openDetail('${r.id}')">View</button>
      ${mine ? `<button class="btn btn-sm btn-green" onclick="Leave.approve('${r.id}')">✓ Approve</button>
      <button class="btn btn-sm btn-danger" onclick="Leave.reject('${r.id}')">✕ Reject</button>`
      : `<span style="font-size:10px;color:var(--txt3);text-align:center;max-width:90px;line-height:1.4;">Another manager approves this</span>`}
    </div>
  </div>`;
}

/** A request can be decided by an assigned approver, or any admin — never by its owner. */
function canDecide(r) {
  const u = me();
  if (!u || r.status !== 'pending') return false;
  if (String(r.employee_id) === String(u.id)) return false;
  if (roleAdmin()) return true;
  const assigned = S.approvers.filter(a => String(a.employee_id) === String(r.employee_id));
  if (!assigned.length) return roleMgr();
  return assigned.some(a => String(a.manager_id) === String(u.id));
}


// ═══════════════════════════════════════════════════════════════════════════
//  WHO'S AWAY — the team roster, visible to every role
// ═══════════════════════════════════════════════════════════════════════════
function rosterGroups() {
  const t = todayISO();
  const all = calendarItems().filter(r => r.status === 'approved');
  const seen = new Set();
  const uniq = all.filter(r => (seen.has(r.id) ? false : seen.add(r.id)));
  return {
    now:      uniq.filter(r => covers(r, t)).sort((a, b) => a.end_date.localeCompare(b.end_date)),
    upcoming: uniq.filter(r => r.start_date > t).sort((a, b) => a.start_date.localeCompare(b.start_date)),
    past:     uniq.filter(r => r.end_date < t).sort((a, b) => b.end_date.localeCompare(a.end_date)).slice(0, 15),
  };
}

function rosterRow(r, mode) {
  const name = r.employee_name || userName(r.employee_id);
  const ls   = liveStatus(r);
  const t    = todayISO();
  let note;
  if (mode === 'now') {
    const left = countDays(t, r.end_date);
    note = `Back on ${fmtDate(iso(addDays(parseD(r.end_date), 1)))} · ${left} day${left === 1 ? '' : 's'} left`;
  } else if (mode === 'upcoming') {
    const until = countDays(t, r.start_date) - 1;
    note = until <= 0 ? 'Starts tomorrow' : `Starts in ${until} day${until === 1 ? '' : 's'}`;
  } else {
    note = `Returned ${fmtDate(iso(addDays(parseD(r.end_date), 1)))}`;
  }
  return `<tr>
    <td><strong>${esc(name)}</strong></td>
    <td><span style="display:inline-flex;align-items:center;gap:6px;">
      <span style="width:8px;height:8px;border-radius:2px;background:${typeColor(r)};"></span>${esc(r.leave_type_name || '—')}</span></td>
    <td>${fmtDate(r.start_date)}</td>
    <td>${fmtDate(r.end_date)}</td>
    <td><strong>${r.days_count || 0}</strong></td>
    <td>${badge(ls)}</td>
    <td style="font-size:11.5px;color:var(--txt2);">${note}</td>
  </tr>`;
}

function rosterTable(rows, mode, emptyText) {
  if (!rows.length) return `<div class="empty-state" style="padding:26px 20px;">${esc(emptyText)}</div>`;
  return `<div class="lv-scroll"><table><thead><tr>
      <th>Employee</th><th>Leave type</th><th>Start date</th><th>End date</th><th>Days</th><th>Status</th><th></th>
    </tr></thead><tbody>${rows.map(r => rosterRow(r, mode)).join('')}</tbody></table></div>`;
}

function renderRoster() {
  const g = rosterGroups();
  const me_ = me();
  const mineAway = g.now.some(r => String(r.employee_id) === String(me_?.id));

  return `
  <div class="lv-stats" style="margin-bottom:14px;">
    ${stat(g.now.length, 'Away today', g.now.length ? g.now.map(r => (r.employee_name || userName(r.employee_id)).split(' ')[0]).slice(0, 3).join(', ') : 'Everyone is in', '#1D9E75')}
    ${stat(g.upcoming.filter(r => r.start_date <= iso(addDays(new Date(), 7))).length, 'Away next week', 'Approved leave', 'var(--royal)')}
    ${stat(g.upcoming.length, 'Booked ahead', 'All upcoming leave', 'var(--gold)')}
  </div>

  <div class="card" style="margin-bottom:14px;">
    <div class="card-hdr"><span class="card-title">On leave now</span>
      <span class="badge ${g.now.length ? 'bg' : 'bb'}">${g.now.length}</span></div>
    ${rosterTable(g.now, 'now', 'Nobody is on leave today.')}
  </div>

  <div class="card" style="margin-bottom:14px;">
    <div class="card-hdr"><span class="card-title">Coming up</span>
      <span style="font-size:11px;color:var(--txt3);">Approved and scheduled</span></div>
    ${rosterTable(g.upcoming, 'upcoming', 'No leave booked yet.')}
  </div>

  <div class="card" style="margin-bottom:0;">
    <div class="card-hdr"><span class="card-title">Recently back</span>
      <span style="font-size:11px;color:var(--txt3);">Last 45 days</span></div>
    ${rosterTable(g.past, 'past', 'No completed leave in this period.')}
  </div>

  <div style="font-size:11px;color:var(--txt3);margin-top:12px;line-height:1.6;">
    Approved leave only. Reasons and attachments stay private to the person and their approvers.
    ${mineAway ? '' : ''}
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CALENDAR — month / week / day
// ═══════════════════════════════════════════════════════════════════════════
function renderCalendarShell() {
  const c = S.calCursor;
  let label;
  if (S.calMode === 'month') {
    label = c.toLocaleDateString('en-UG', { month:'long', year:'numeric' });
  } else if (S.calMode === 'week') {
    const s = startOfWeek(c), e = addDays(s, 6);
    label = `${s.toLocaleDateString('en-UG',{day:'numeric',month:'short'})} – ${e.toLocaleDateString('en-UG',{day:'numeric',month:'short',year:'numeric'})}`;
  } else {
    label = c.toLocaleDateString('en-UG', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  }

  return `
  <div class="lv-bar" style="margin-bottom:10px;">
    <div style="display:flex;align-items:center;gap:8px;">
      <button class="btn btn-sm" onclick="Leave.calStep(-1)">‹</button>
      <span style="font-size:13.5px;font-weight:700;min-width:180px;">${label}</span>
      <button class="btn btn-sm" onclick="Leave.calStep(1)">›</button>
      <button class="btn btn-sm" onclick="Leave.calToday()">Today</button>
    </div>
    <div style="display:flex;gap:5px;">
      ${['month','week','day'].map(m => `<button class="lv-pill${S.calMode === m ? ' on' : ''}" onclick="Leave.calMode('${m}')">${m[0].toUpperCase()+m.slice(1)}</button>`).join('')}
    </div>
  </div>
  <div id="lv-cal-host"></div>
  <div class="lv-legend">
    <span class="lv-lg"><span class="lv-lgd" style="background:repeating-linear-gradient(45deg,#EF9F27,#EF9F27 3px,#e0942190 3px,#e0942190 6px);"></span>Pending</span>
    <span class="lv-lg"><span class="lv-lgd" style="background:#2451a0;"></span>Approved / upcoming</span>
    <span class="lv-lg"><span class="lv-lgd" style="background:#1D9E75;"></span>On leave now</span>
    <span class="lv-lg"><span class="lv-lgd" style="background:#b8860b;"></span>Completed</span>
    <span class="lv-lg" style="color:var(--txt3);">Rejected and cancelled leave is hidden from the calendar.</span>
  </div>`;
}

function startOfWeek(d) { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0,0,0,0); return x; }

function calendarItems() {
  const out = new Map();
  S.requests.filter(r => ['pending','approved'].includes(r.status)).forEach(r => out.set(r.id, r));
  S.roster.forEach(r => { if (!out.has(r.id)) out.set(r.id, r); });   // everyone's approved leave
  return [...out.values()];
}
function itemsOn(dISO) {
  return calendarItems().filter(r => covers(r, dISO))
    .sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || ''));
}

function drawCalendar() {
  const host = document.getElementById('lv-cal-host');
  if (!host) return;
  host.innerHTML = S.calMode === 'month' ? monthHTML()
                 : S.calMode === 'week'  ? weekHTML()
                 : dayHTML();
}

function chip(r, compact) {
  const ls   = liveStatus(r);
  const name = r.employee_name || userName(r.employee_id);
  const bg   = ls === 'pending' ? '' : `background:${STATUS_COLOR[ls]};`;
  const label= compact ? initials(name) : `${name.split(' ')[0]} · ${(r.leave_type_name || '').replace(' Leave','')}`;
  return `<button class="lv-chip${ls === 'pending' ? ' pend' : ''}" style="${bg}"
    title="${esc(name)} — ${esc(r.leave_type_name)} · ${fmtDate(r.start_date)} to ${fmtDate(r.end_date)} · ${STATUS_LABEL[ls]}"
    onclick="Leave.openDetail('${r.id}')">${esc(label)}</button>`;
}

function monthHTML() {
  const c     = S.calCursor;
  const first = new Date(c.getFullYear(), c.getMonth(), 1);
  const start = startOfWeek(first);
  const t     = todayISO();
  const compact = window.innerWidth <= 640;
  const cap   = compact ? 2 : 3;

  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d    = addDays(start, i);
    const dISO = iso(d);
    const out  = d.getMonth() !== c.getMonth();
    const we   = d.getDay() === 0 || d.getDay() === 6;
    const list = itemsOn(dISO);
    const shown= list.slice(0, cap);
    const rest = list.length - shown.length;
    cells += `<div class="lv-day${out ? ' out' : ''}${dISO === t ? ' today' : ''}${we ? ' we' : ''}">
      <div class="lv-daynum"><span>${d.getDate()}</span>${list.length > cap ? `<span style="font-size:9px;color:var(--txt3);">${list.length}</span>` : ''}</div>
      ${shown.map(r => chip(r, compact)).join('')}
      ${rest > 0 ? `<div class="lv-more" onclick="Leave.calDay('${dISO}')">+${rest} more</div>` : ''}
    </div>`;
  }
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `<div class="lv-cal">
    <div class="lv-cal-hd">${days.map(d => `<div>${d}</div>`).join('')}</div>
    <div class="lv-cal-grid">${cells}</div>
  </div>`;
}

function weekHTML() {
  const start = startOfWeek(S.calCursor);
  const t     = todayISO();
  let cols = '';
  for (let i = 0; i < 7; i++) {
    const d    = addDays(start, i);
    const dISO = iso(d);
    const list = itemsOn(dISO);
    cols += `<div class="lv-wkcol">
      <div class="lv-wkhd${dISO === t ? ' today' : ''}">
        ${d.toLocaleDateString('en-UG', { weekday:'short' })} ${d.getDate()}
      </div>
      <div class="lv-wkbody">
        ${list.length ? list.map(r => {
          const ls = liveStatus(r);
          const name = r.employee_name || userName(r.employee_id);
          return `<div onclick="Leave.openDetail('${r.id}')" style="cursor:pointer;border-left:3px solid ${STATUS_COLOR[ls]};background:var(--bg2);border-radius:5px;padding:5px 7px;margin-bottom:5px;">
            <div style="font-size:11px;font-weight:600;">${esc(name)}</div>
            <div style="font-size:10px;color:var(--txt2);margin-top:1px;">${esc(r.leave_type_name || '')}</div>
            <div style="font-size:9.5px;color:var(--txt3);margin-top:2px;">${STATUS_LABEL[ls]}</div>
          </div>`;
        }).join('') : `<div style="font-size:10.5px;color:var(--txt3);text-align:center;padding:14px 4px;">—</div>`}
      </div></div>`;
  }
  return `<div class="lv-wk">${cols}</div>`;
}

function dayHTML() {
  const dISO = iso(S.calCursor);
  const list = itemsOn(dISO);
  if (!list.length) return `<div class="empty-state" style="padding:44px 20px;">
    <div style="font-size:26px;margin-bottom:8px;">☀️</div>
    <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Nobody is on leave</div>
    <div>${fmtDate(dISO)} is fully staffed.</div></div>`;
  return list.map(r => {
    const ls   = liveStatus(r);
    const name = r.employee_name || userName(r.employee_id);
    const dayN = countDays(r.start_date, dISO);
    return `<div class="lv-req" style="cursor:pointer;" onclick="Leave.openDetail('${r.id}')">
      <div class="lv-av" style="background:${STATUS_COLOR[ls]}22;color:${STATUS_COLOR[ls]};">${initials(name)}</div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:13px;font-weight:600;">${esc(name)}</span>${badge(ls)}
        </div>
        <div style="font-size:12px;color:var(--txt2);margin-top:3px;">
          ${esc(r.leave_type_name || '')} · ${fmtDate(r.start_date)} → ${fmtDate(r.end_date)}
        </div>
        <div style="font-size:11px;color:var(--txt3);margin-top:3px;">Day ${dayN} of ${r.days_count}</div>
      </div></div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
//  ALL REQUESTS — table + filters
// ═══════════════════════════════════════════════════════════════════════════
function filtered() {
  const f = S.filters;
  return S.requests.filter(r => {
    if (f.rep    && String(r.employee_id) !== f.rep) return false;
    if (f.type   && r.leave_type_id !== f.type)      return false;
    if (f.status && liveStatus(r) !== f.status && r.status !== f.status) return false;
    if (f.from   && r.end_date   < f.from)           return false;
    if (f.to     && r.start_date > f.to)             return false;
    if (f.manager) {
      const ok = S.approvers.some(a => String(a.employee_id) === String(r.employee_id) && String(a.manager_id) === f.manager);
      if (!ok) return false;
    }
    return true;
  });
}

function renderList() {
  const rows  = filtered();
  const inScope = S.users.filter(u => S.teamIds === null || S.teamIds.includes(String(u.id)));
  const mgrs  = S.users.filter(u => ['admin','manager'].includes(u.role));
  const f     = S.filters;
  const total = rows.filter(r => r.status === 'approved').reduce((s, r) => s + (r.days_count || 0), 0);

  return `
  <div class="search-row">
    <select class="sel" onchange="Leave.setFilter('rep',this.value)">
      <option value="">All employees</option>
      ${inScope.map(u => `<option value="${u.id}"${f.rep === String(u.id) ? ' selected' : ''}>${esc(u.full_name)}</option>`).join('')}
    </select>
    ${roleAdmin() ? `<select class="sel" onchange="Leave.setFilter('manager',this.value)">
      <option value="">All managers</option>
      ${mgrs.map(u => `<option value="${u.id}"${f.manager === String(u.id) ? ' selected' : ''}>${esc(u.full_name)}</option>`).join('')}
    </select>` : ''}
    <select class="sel" onchange="Leave.setFilter('type',this.value)">
      <option value="">All leave types</option>
      ${S.types.map(t => `<option value="${t.id}"${f.type === t.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
    </select>
    <select class="sel" onchange="Leave.setFilter('status',this.value)">
      <option value="">All statuses</option>
      ${['pending','approved','upcoming','active','completed','rejected','cancelled']
        .map(s => `<option value="${s}"${f.status === s ? ' selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
    </select>
    <input type="date" class="si" value="${f.from}" onchange="Leave.setFilter('from',this.value)" title="From"/>
    <input type="date" class="si" value="${f.to}" onchange="Leave.setFilter('to',this.value)" title="To"/>
    <button class="btn btn-sm" onclick="Leave.clearFilters()">Clear</button>
    <span style="font-size:11.5px;color:var(--txt3);margin-left:auto;">${rows.length} request${rows.length === 1 ? '' : 's'} · ${total} approved days</span>
  </div>
  ${rows.length ? `<div class="lv-scroll"><table><thead><tr>
      <th>Employee</th><th>Type</th><th>Start</th><th>End</th><th>Days</th><th>Reason</th>
      <th>Status</th><th>Requested</th><th>Decided by</th><th></th>
    </tr></thead><tbody>${rows.map(listRow).join('')}</tbody></table></div>`
    : `<div class="empty-state" style="padding:40px 20px;">No requests match these filters.</div>`}`;
}

function listRow(r) {
  const name = r.employee_name || userName(r.employee_id);
  const ls   = liveStatus(r);
  const by   = r.decided_by_name || userName(r.decided_by);
  return `<tr>
    <td><strong>${esc(name)}</strong></td>
    <td><span style="width:8px;height:8px;border-radius:2px;background:${typeColor(r)};display:inline-block;margin-right:5px;"></span>${esc(r.leave_type_name || '—')}</td>
    <td>${fmtShort(r.start_date)}</td>
    <td>${fmtShort(r.end_date)}</td>
    <td><strong>${r.days_count || 0}</strong></td>
    <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.reason || '')}">${esc(r.reason || '—')}</td>
    <td>${badge(ls)}</td>
    <td style="font-size:11.5px;color:var(--txt2);">${fmtShort(iso(new Date(r.requested_at)))}</td>
    <td style="font-size:11.5px;">${r.status === 'pending' ? '<span style="color:var(--txt3);">—</span>' : esc(by)}</td>
    <td style="text-align:right;white-space:nowrap;">
      <button class="btn btn-sm" onclick="Leave.openDetail('${r.id}')">View</button>
      ${canDecide(r) ? `<button class="btn btn-sm btn-green" onclick="Leave.approve('${r.id}')">✓</button>
        <button class="btn btn-sm btn-danger" onclick="Leave.reject('${r.id}')">✕</button>` : ''}
    </td></tr>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SETTINGS (Super Admin) — leave types + approver assignments
// ═══════════════════════════════════════════════════════════════════════════
function renderSettings() {
  const reps = S.users.filter(u => u.is_active !== false && u.role === 'sales_rep');
  const mgrs = S.users.filter(u => u.is_active !== false && ['admin','manager'].includes(u.role));

  return `
  <div class="card" style="margin-bottom:14px;">
    <div class="card-hdr"><span class="card-title">Leave types</span>
      <button class="btn btn-sm btn-royal" onclick="Leave.openTypeForm()">＋ Add type</button></div>
    <div class="lv-scroll"><table><thead><tr>
      <th>Name</th><th>Code</th><th>Attachment</th><th>Max days</th><th>Colour</th><th>Status</th><th></th>
    </tr></thead><tbody>
      ${S.types.map(t => `<tr>
        <td><strong>${esc(t.name)}</strong><div style="font-size:11px;color:var(--txt3);">${esc(t.description || '')}</div></td>
        <td class="mono">${esc(t.code)}</td>
        <td>${t.requires_attachment ? '<span class="badge ba">Required</span>' : '<span style="color:var(--txt3);">Optional</span>'}</td>
        <td>${t.max_days_per_request || '—'}</td>
        <td><span style="width:14px;height:14px;border-radius:4px;background:${t.color};display:inline-block;vertical-align:middle;"></span></td>
        <td>${t.is_active ? '<span class="badge bg">Active</span>' : '<span class="badge br">Hidden</span>'}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn btn-sm" onclick="Leave.openTypeForm('${t.id}')">Edit</button>
          <button class="btn btn-sm" onclick="Leave.toggleType('${t.id}')">${t.is_active ? 'Hide' : 'Show'}</button>
        </td></tr>`).join('')}
    </tbody></table></div>
  </div>

  <div class="card" style="margin-bottom:0;">
    <div class="card-hdr"><span class="card-title">Who approves whose leave</span>
      <span style="font-size:11px;color:var(--txt3);">Employees with no approver fall back to all admins</span></div>
    <div class="lv-scroll"><table><thead><tr>
      <th>Sales rep</th><th>Approvers</th><th></th>
    </tr></thead><tbody>
      ${reps.length ? reps.map(r => {
        const assigned = S.approvers.filter(a => String(a.employee_id) === String(r.id));
        return `<tr>
          <td><strong>${esc(r.full_name)}</strong><div style="font-size:11px;color:var(--txt3);">${esc(r.email || '')}</div></td>
          <td>${assigned.length
            ? assigned.map(a => `<span class="badge bb" style="margin:2px 4px 2px 0;">${esc(userName(a.manager_id))}
                <span onclick="Leave.unassign('${a.id}')" style="cursor:pointer;margin-left:5px;font-weight:700;">×</span></span>`).join('')
            : '<span style="color:#854F0B;font-size:11.5px;">No approver — defaults to admins</span>'}</td>
          <td style="text-align:right;white-space:nowrap;">
            <select class="sel" style="font-size:11px;padding:4px 8px;" onchange="Leave.assign('${r.id}',this.value);this.value='';">
              <option value="">＋ Add approver…</option>
              ${mgrs.filter(m => String(m.id) !== String(r.id) && !assigned.some(a => String(a.manager_id) === String(m.id)))
                    .map(m => `<option value="${m.id}">${esc(m.full_name)}</option>`).join('')}
            </select>
          </td></tr>`;
      }).join('') : `<tr><td colspan="3" class="empty-state">No active sales reps found.</td></tr>`}
    </tbody></table></div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════════════════════════════
function modal(html, width) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'lv-ov';
  ov.id = 'lv-ov';
  ov.innerHTML = `<div class="lv-modal"${width ? ` style="max-width:${width}px;"` : ''}>${html}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  return ov;
}
function closeModal() { document.getElementById('lv-ov')?.remove(); }

// ─── NEW REQUEST FORM ──────────────────────────────────────────────────────
function openRequestForm() {
  const types = S.types.filter(t => t.is_active);
  if (!types.length) { toast('No leave types are set up yet. Ask an admin to add one.', 'warn'); return; }
  const t = todayISO();
  modal(`
    <div class="lv-modal-hd">
      <div><div style="font-size:15px;font-weight:700;">Request leave</div>
      <div style="font-size:11.5px;color:var(--txt2);margin-top:2px;">Your approvers are notified as soon as you submit.</div></div>
      <button class="lv-x" onclick="Leave.closeModal()">×</button>
    </div>
    <div class="lv-modal-bd">
      <div id="lv-form-err" class="alert ad" style="display:none;"></div>
      <div class="fg">
        <label class="flbl">Leave type</label>
        <select class="fin" id="lv-f-type" onchange="Leave.onTypeChange()">
          ${types.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}
        </select>
        <div id="lv-type-hint" style="font-size:11px;color:var(--txt3);margin-top:3px;"></div>
      </div>
      <div class="fgrid">
        <div class="fg"><label class="flbl">Start date</label>
          <input type="date" class="fin" id="lv-f-start" min="${t}" value="${t}" onchange="Leave.recalc()"/></div>
        <div class="fg"><label class="flbl">End date</label>
          <input type="date" class="fin" id="lv-f-end" min="${t}" value="${t}" onchange="Leave.recalc()"/></div>
      </div>
      <div class="alert ai" id="lv-days-box"><span>🗓️</span><div id="lv-days-txt">1 day of leave.</div></div>
      <div class="fg"><label class="flbl">Reason</label>
        <textarea class="fin" id="lv-f-reason" rows="3" placeholder="Briefly explain why you need this leave"></textarea></div>
      <div class="fg"><label class="flbl">Attachment <span style="color:var(--txt3);font-weight:400;">(optional — max ${CFG.maxAttachmentMB}MB)</span></label>
        <input type="file" class="fin" id="lv-f-file" accept="image/*,.pdf,.doc,.docx"/></div>
    </div>
    <div class="lv-modal-ft">
      <button class="btn" onclick="Leave.closeModal()">Cancel</button>
      <button class="btn btn-royal" id="lv-submit-btn" onclick="Leave.submit()">Submit request</button>
    </div>`);
  onTypeChange();
  recalc();
}

function onTypeChange() {
  const t = S.types.find(x => x.id === document.getElementById('lv-f-type')?.value);
  const hint = document.getElementById('lv-type-hint');
  if (!t || !hint) return;
  const bits = [];
  if (t.description) bits.push(t.description);
  if (t.requires_attachment) bits.push('An attachment is required for this type.');
  if (t.max_days_per_request) bits.push(`Up to ${t.max_days_per_request} days per request.`);
  hint.textContent = bits.join(' ');
  recalc();
}

function recalc() {
  const s = document.getElementById('lv-f-start')?.value;
  const e = document.getElementById('lv-f-end')?.value;
  const box = document.getElementById('lv-days-box');
  const txt = document.getElementById('lv-days-txt');
  if (!s || !e || !txt) return;
  if (e < s) {
    box.className = 'alert ad';
    txt.innerHTML = 'The end date is before the start date. Pick a later end date.';
    return;
  }
  const d  = countDays(s, e);
  const wd = countWorkingDays(s, e);
  const t  = S.types.find(x => x.id === document.getElementById('lv-f-type')?.value);
  const over = t?.max_days_per_request && d > t.max_days_per_request;
  box.className = over ? 'alert aw' : 'alert ai';
  txt.innerHTML = `<strong>${d} day${d === 1 ? '' : 's'}</strong> of leave · ${wd} working day${wd === 1 ? '' : 's'}
    ${over ? `<br>That is over the ${t.max_days_per_request}-day limit for ${esc(t.name)}.` : ''}`;
}

function formErr(msg) {
  const el = document.getElementById('lv-form-err');
  if (!el) { toast(msg, 'error'); return; }
  el.innerHTML = `<span>⚠️</span><div>${esc(msg)}</div>`;
  el.style.display = 'flex';
  if (el.scrollIntoView) el.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

async function submit() {
  const u = me(); if (!u) return;
  const btn = document.getElementById('lv-submit-btn');
  const typeId = document.getElementById('lv-f-type').value;
  const start  = document.getElementById('lv-f-start').value;
  const end    = document.getElementById('lv-f-end').value;
  const reason = document.getElementById('lv-f-reason').value.trim();
  const file   = document.getElementById('lv-f-file').files[0];
  const type   = S.types.find(x => x.id === typeId);

  if (!typeId)      return formErr('Choose a leave type.');
  if (!start || !end) return formErr('Choose both a start and an end date.');
  if (end < start)  return formErr('The end date cannot be before the start date.');
  if (!reason)      return formErr('Add a short reason for your leave.');
  if (type?.requires_attachment && !file) return formErr(`${type.name} needs a supporting document attached.`);
  if (file && file.size > CFG.maxAttachmentMB * 1024 * 1024) return formErr(`Attachment is larger than ${CFG.maxAttachmentMB}MB.`);

  const days = countDays(start, end);
  if (days < 1) return formErr('That date range covers no leave days.');
  if (type?.max_days_per_request && days > type.max_days_per_request)
    return formErr(`${type.name} allows a maximum of ${type.max_days_per_request} days per request.`);

  btn.disabled = true; btn.innerHTML = '<span class="spinner" style="border-top-color:#fff;"></span>Submitting…';

  // Overlap guard
  const { data: clash } = await DB().from('leave_requests')
    .select('id,start_date,end_date,status')
    .eq('employee_id', u.id).in('status', ['pending','approved'])
    .lte('start_date', end).gte('end_date', start);
  if (clash && clash.length) {
    btn.disabled = false; btn.textContent = 'Submit request';
    return formErr(`You already have ${clash[0].status} leave from ${fmtDate(clash[0].start_date)} to ${fmtDate(clash[0].end_date)}. Cancel it first or pick other dates.`);
  }

  // Attachment
  let path = null, fname = null;
  if (file) {
    const safe = file.name.replace(/[^\w.\-]/g, '_');
    path  = `${u.id}/${Date.now()}_${safe}`;
    fname = file.name;
    const { error } = await DB().storage.from(CFG.bucket).upload(path, file, { contentType: file.type, upsert: false });
    if (error) {
      btn.disabled = false; btn.textContent = 'Submit request';
      return formErr(`Attachment upload failed: ${error.message}. Check that the "${CFG.bucket}" storage bucket exists.`);
    }
  }

  const row = {
    employee_id: u.id, employee_name: u.full_name,
    leave_type_id: typeId, leave_type_name: type?.name || '',
    start_date: start, end_date: end,
    days_count: days, working_days: countWorkingDays(start, end),
    reason, attachment_path: path, attachment_name: fname,
    status: 'pending', requested_at: new Date().toISOString(),
  };
  const { data, error } = await DB().from('leave_requests').insert(row).select().single();
  if (error) {
    btn.disabled = false; btn.textContent = 'Submit request';
    return formErr('Could not save the request: ' + error.message);
  }

  await audit(data.id, 'submitted', null, 'pending', null);
  const approvers = await approverIdsFor(u.id);
  await notify(approvers, 'new_request',
    'New leave request',
    `${u.full_name} has requested ${type?.name} from ${fmtDate(start)} to ${fmtDate(end)} (${days} day${days === 1 ? '' : 's'}).`,
    data.id);

  closeModal();
  toast(approvers.length
    ? `Request submitted. ${approvers.length} approver${approvers.length === 1 ? '' : 's'} notified.`
    : 'Request submitted.');
  await refresh();
}

// ─── DETAIL MODAL ──────────────────────────────────────────────────────────
async function openDetail(id) {
  let r = getReq(id);
  if (!r) {
    const { data } = await DB().from('leave_requests').select('*').eq('id', id).maybeSingle();
    r = data; cacheReq(r);
  }
  if (!r) { toast('That request could not be found.', 'error'); return; }

  const name = r.employee_name || userName(r.employee_id);
  const ls   = liveStatus(r);
  const mine = String(r.employee_id) === String(me()?.id);
  // Colleagues can see that someone is away and for how long. The reason,
  // the attachment and the decision trail belong to the person and their
  // approvers only.
  const full = mine || roleMgr();

  modal(`
    <div class="lv-modal-hd">
      <div style="display:flex;align-items:center;gap:11px;">
        <div class="lv-av">${initials(name)}</div>
        <div><div style="font-size:14.5px;font-weight:700;">${esc(name)}</div>
        <div style="font-size:11.5px;color:var(--txt2);margin-top:1px;">${esc(r.leave_type_name || '')} · ${r.days_count} day${r.days_count === 1 ? '' : 's'}</div></div>
      </div>
      <button class="lv-x" onclick="Leave.closeModal()">×</button>
    </div>
    <div class="lv-modal-bd">
      <div style="margin-bottom:14px;">${badge(ls)}</div>
      <div class="lv-kv">
        <div class="lv-k">Leave type</div><div>${esc(r.leave_type_name || '—')}</div>
        <div class="lv-k">Start date</div><div>${fmtDate(r.start_date)}</div>
        <div class="lv-k">End date</div><div>${fmtDate(r.end_date)}</div>
        <div class="lv-k">Days</div><div>${r.days_count} calendar${r.working_days != null ? ` · ${r.working_days} working` : ''}</div>
        <div class="lv-k">Returns to work</div><div>${fmtDate(iso(addDays(parseD(r.end_date), 1)))}</div>
        ${full ? `<div class="lv-k">Reason</div><div style="line-height:1.6;">${esc(r.reason || '—')}</div>
        <div class="lv-k">Attachment</div><div>${r.attachment_path
          ? `<button class="btn btn-sm" onclick="Leave.openAttachment('${r.id}')">📎 ${esc(r.attachment_name || 'Open file')}</button>`
          : '<span style="color:var(--txt3);">None</span>'}</div>
        <div class="lv-k">Requested</div><div>${fmtStamp(r.requested_at)}</div>` : ''}
        ${full && r.status === 'approved' ? `<div class="lv-k">Approved by</div><div>${esc(r.decided_by_name || userName(r.decided_by))} · ${fmtStamp(r.decided_at)}</div>` : ''}
        ${full && r.status === 'rejected' ? `<div class="lv-k">Rejected by</div><div>${esc(r.decided_by_name || userName(r.decided_by))} · ${fmtStamp(r.decided_at)}</div>
          <div class="lv-k">Reason given</div><div style="color:#A32D2D;line-height:1.6;">${esc(r.rejection_reason || '—')}</div>` : ''}
        ${r.status === 'cancelled' ? `<div class="lv-k">Cancelled</div><div>${fmtStamp(r.cancelled_at)}</div>` : ''}
      </div>
      <div id="lv-trail" style="margin-top:16px;"></div>
    </div>
    <div class="lv-modal-ft">
      <button class="btn" onclick="Leave.closeModal()">Close</button>
      ${(mine && r.status === 'pending') || (roleAdmin() && !mine && ['pending','approved'].includes(r.status))
        ? `<button class="btn btn-danger" onclick="Leave.cancel('${r.id}')">${mine ? 'Cancel request' : 'Cancel leave (admin)'}</button>` : ''}
      ${canDecide(r) ? `<button class="btn btn-danger" onclick="Leave.reject('${r.id}')">✕ Reject</button>
        <button class="btn btn-green" onclick="Leave.approve('${r.id}')">✓ Approve</button>` : ''}
    </div>`, 600);

  if (!full) return;                      // no history for colleagues
  const { data: trail } = await DB().from('leave_audit_log')
    .select('*').eq('request_id', r.id).order('created_at');
  const host = document.getElementById('lv-trail');
  if (host && trail?.length) {
    host.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;">History</div>
      ${trail.map(a => `<div style="display:flex;gap:9px;padding:6px 0;border-bottom:0.5px solid var(--brd);font-size:11.5px;">
        <span style="width:6px;height:6px;border-radius:50%;background:var(--royal);margin-top:6px;flex-shrink:0;"></span>
        <div><strong>${esc(a.action)}</strong> by ${esc(a.actor_name || '—')}
        ${a.note ? `<div style="color:var(--txt2);margin-top:2px;">${esc(a.note)}</div>` : ''}
        <div style="color:var(--txt3);font-size:10.5px;margin-top:2px;">${fmtStamp(a.created_at)}</div></div>
      </div>`).join('')}`;
  }
}

async function openAttachment(id) {
  const r = getReq(id);
  if (!r?.attachment_path) return;
  const { data, error } = await DB().storage.from(CFG.bucket).createSignedUrl(r.attachment_path, 300);
  if (error || !data?.signedUrl) { toast('Could not open the attachment: ' + (error?.message || 'no link returned'), 'error'); return; }
  window.open(data.signedUrl, '_blank');
}

// ═══════════════════════════════════════════════════════════════════════════
//  ACTIONS — approve / reject / cancel / settings
// ═══════════════════════════════════════════════════════════════════════════
async function approve(id) {
  const r = getReq(id);
  const u = me();
  if (!r || !u) return;
  if (!canDecide(r)) { toast('You are not an approver for this employee.', 'error'); return; }

  const name = r.employee_name || userName(r.employee_id);
  showConfirmDialog({
    icon: '✅',
    title: 'Approve leave',
    message: `Approve <strong>${esc(r.leave_type_name)}</strong> for <strong>${esc(name)}</strong>,<br>${fmtDate(r.start_date)} to ${fmtDate(r.end_date)} (${r.days_count} day${r.days_count === 1 ? '' : 's'})?`,
    confirmLabel: 'Approve leave',
    confirmStyle: 'background:#1D9E75;color:#fff;border:none;',
    onConfirm: async () => {
      closeModal();
      const { data: updated, error } = await DB().from('leave_requests').update({
        status: 'approved', decided_by: u.id, decided_by_name: u.full_name,
        decided_at: new Date().toISOString(), rejection_reason: null,
      }).eq('id', id).eq('status', 'pending').select();
      if (error) { toast('Could not approve: ' + error.message, 'error'); return; }
      if (!updated || !updated.length) {
        toast('Another approver already decided on this request.', 'warn');
        await refresh(); return;
      }

      await audit(id, 'approved', 'pending', 'approved', null);
      const line = `${name} will be on ${r.leave_type_name} from ${fmtDate(r.start_date)} to ${fmtDate(r.end_date)}.`;
      await notify([r.employee_id], 'approved', 'Leave approved',
        `Your ${r.leave_type_name} from ${fmtDate(r.start_date)} to ${fmtDate(r.end_date)} was approved by ${u.full_name}.`, id);
      const others = (await approverIdsFor(r.employee_id)).filter(x => String(x) !== String(u.id));
      await notify(others, 'approved', 'Leave approved', line, id);

      toast(`Approved. ${name} and ${others.length} other approver${others.length === 1 ? '' : 's'} notified.`);
      await refresh();
    },
  });
}

function reject(id) {
  const r = getReq(id);
  const u = me();
  if (!r || !u) return;
  if (!canDecide(r)) { toast('You are not an approver for this employee.', 'error'); return; }
  const name = r.employee_name || userName(r.employee_id);

  modal(`
    <div class="lv-modal-hd">
      <div><div style="font-size:15px;font-weight:700;">Reject leave request</div>
      <div style="font-size:11.5px;color:var(--txt2);margin-top:2px;">${esc(name)} · ${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</div></div>
      <button class="lv-x" onclick="Leave.closeModal()">×</button>
    </div>
    <div class="lv-modal-bd">
      <div class="alert aw"><span>💬</span><div>${esc(name)} sees this reason, so make it clear enough to act on.</div></div>
      <div class="fg"><label class="flbl">Reason for rejection</label>
        <textarea class="fin" id="lv-rej-reason" rows="3" placeholder="e.g. Two reps are already off that week — please move to the following week."></textarea></div>
      <div id="lv-rej-err" class="alert ad" style="display:none;"></div>
    </div>
    <div class="lv-modal-ft">
      <button class="btn" onclick="Leave.closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="Leave.confirmReject('${id}')">Reject request</button>
    </div>`, 480);
}

async function confirmReject(id) {
  const r = getReq(id);
  if (!r) { toast('That request is no longer available.', 'error'); return; }
  const u = me();
  const reason = document.getElementById('lv-rej-reason')?.value.trim();
  if (!reason) {
    const e = document.getElementById('lv-rej-err');
    if (e) { e.innerHTML = '<span>⚠️</span><div>Add a reason before rejecting.</div>'; e.style.display = 'flex'; }
    return;
  }
  const name = r.employee_name || userName(r.employee_id);
  const { data: updated, error } = await DB().from('leave_requests').update({
    status: 'rejected', decided_by: u.id, decided_by_name: u.full_name,
    decided_at: new Date().toISOString(), rejection_reason: reason,
  }).eq('id', id).eq('status', 'pending').select();
  if (error) { toast('Could not reject: ' + error.message, 'error'); return; }
  if (!updated || !updated.length) {
    closeModal(); toast('Another approver already decided on this request.', 'warn');
    await refresh(); return;
  }

  await audit(id, 'rejected', 'pending', 'rejected', reason);
  await notify([r.employee_id], 'rejected', 'Leave request rejected',
    `Your leave request for ${fmtDate(r.start_date)} to ${fmtDate(r.end_date)} was rejected by ${u.full_name}. Reason: ${reason}`, id);
  const others = (await approverIdsFor(r.employee_id)).filter(x => String(x) !== String(u.id));
  await notify(others, 'rejected', 'Leave request rejected',
    `${name}'s leave for ${fmtDate(r.start_date)} to ${fmtDate(r.end_date)} was rejected by ${u.full_name}.`, id);

  closeModal();
  toast('Request rejected. The employee has been notified.');
  await refresh();
}

function cancel(id) {
  const r = getReq(id);
  const u = me();
  if (!r || !u) return;
  const owner = String(r.employee_id) === String(u.id);
  if (!owner && !roleAdmin()) { toast('Only the employee or an admin can cancel this request.', 'error'); return; }
  if (r.status !== 'pending' && !roleAdmin()) { toast('Only pending requests can be cancelled.', 'warn'); return; }

  showConfirmDialog({
    icon: '🚫',
    title: 'Cancel leave request',
    message: `Withdraw the request for <strong>${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</strong>? Approvers will be told it is no longer needed.`,
    confirmLabel: 'Cancel request',
    confirmStyle: 'background:#A32D2D;color:#fff;border:none;',
    onConfirm: async () => {
      closeModal();
      const { error } = await DB().from('leave_requests').update({
        status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: u.id,
      }).eq('id', id);
      if (error) { toast('Could not cancel: ' + error.message, 'error'); return; }

      await audit(id, 'cancelled', r.status, 'cancelled', owner ? 'Withdrawn by employee' : 'Cancelled by admin');
      const name = r.employee_name || userName(r.employee_id);
      const recipients = await approverIdsFor(r.employee_id);
      if (!owner) recipients.push(String(r.employee_id));
      await notify(recipients, 'cancelled', 'Leave request cancelled',
        `${name}'s leave request for ${fmtDate(r.start_date)} to ${fmtDate(r.end_date)} was cancelled.`, id);

      toast('Request cancelled.');
      await refresh();
    },
  });
}

// ─── SETTINGS ACTIONS ──────────────────────────────────────────────────────
function openTypeForm(id) {
  const t = S.types.find(x => x.id === id) || {};
  modal(`
    <div class="lv-modal-hd">
      <div style="font-size:15px;font-weight:700;">${id ? 'Edit leave type' : 'Add leave type'}</div>
      <button class="lv-x" onclick="Leave.closeModal()">×</button>
    </div>
    <div class="lv-modal-bd">
      <div id="lv-type-err" class="alert ad" style="display:none;"></div>
      <div class="fg"><label class="flbl">Name</label>
        <input class="fin" id="lv-t-name" value="${esc(t.name || '')}" placeholder="e.g. Study Leave"/></div>
      <div class="fg"><label class="flbl">Code <span style="color:var(--txt3);font-weight:400;">(lowercase, no spaces)</span></label>
        <input class="fin" id="lv-t-code" value="${esc(t.code || '')}" placeholder="study" ${id ? 'disabled' : ''}/></div>
      <div class="fg"><label class="flbl">Description</label>
        <input class="fin" id="lv-t-desc" value="${esc(t.description || '')}" placeholder="Shown under the type when requesting"/></div>
      <div class="fgrid">
        <div class="fg"><label class="flbl">Max days per request</label>
          <input type="number" class="fin" id="lv-t-max" value="${t.max_days_per_request || ''}" placeholder="No limit" min="1"/></div>
        <div class="fg"><label class="flbl">Colour on calendar</label>
          <input type="color" class="fin" id="lv-t-color" value="${t.color || '#2451a0'}" style="height:38px;padding:3px;"/></div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;">
        <input type="checkbox" id="lv-t-att" ${t.requires_attachment ? 'checked' : ''}/> Require an attachment for this type
      </label>
    </div>
    <div class="lv-modal-ft">
      <button class="btn" onclick="Leave.closeModal()">Cancel</button>
      <button class="btn btn-royal" onclick="Leave.saveType(${id ? `'${id}'` : 'null'})">${id ? 'Save changes' : 'Add type'}</button>
    </div>`, 480);
}

async function saveType(id) {
  const name  = document.getElementById('lv-t-name').value.trim();
  const code  = document.getElementById('lv-t-code').value.trim().toLowerCase().replace(/\s+/g, '_');
  const err   = document.getElementById('lv-type-err');
  const fail  = m => { err.innerHTML = `<span>⚠️</span><div>${esc(m)}</div>`; err.style.display = 'flex'; };
  if (!name) return fail('Give the leave type a name.');
  if (!id && !code) return fail('Give the leave type a code.');

  const row = {
    name,
    description: document.getElementById('lv-t-desc').value.trim() || null,
    max_days_per_request: Number(document.getElementById('lv-t-max').value) || null,
    color: document.getElementById('lv-t-color').value,
    requires_attachment: document.getElementById('lv-t-att').checked,
  };
  let error;
  if (id) ({ error } = await DB().from('leave_types').update(row).eq('id', id));
  else    ({ error } = await DB().from('leave_types').insert({ ...row, code, is_active: true, sort_order: S.types.length + 1 }));
  if (error) return fail(error.message);

  closeModal();
  toast(id ? 'Leave type updated.' : 'Leave type added.');
  await refresh();
}

async function toggleType(id) {
  const t = S.types.find(x => x.id === id); if (!t) return;
  const { error } = await DB().from('leave_types').update({ is_active: !t.is_active }).eq('id', id);
  if (error) { toast(error.message, 'error'); return; }
  toast(t.is_active ? `${t.name} hidden from new requests.` : `${t.name} is selectable again.`);
  await refresh();
}

async function assign(employeeId, managerId) {
  if (!managerId) return;
  const { error } = await DB().from('leave_approvers').insert({
    employee_id: employeeId, manager_id: managerId, created_by: me()?.id,
  });
  if (error) { toast(error.message, 'error'); return; }
  toast(`${userName(managerId)} now approves ${userName(employeeId)}'s leave.`);
  await refresh();
}

async function unassign(rowId) {
  const { error } = await DB().from('leave_approvers').delete().eq('id', rowId);
  if (error) { toast(error.message, 'error'); return; }
  toast('Approver removed.');
  await refresh();
}

// ─── UI STATE ACTIONS ──────────────────────────────────────────────────────
function setTab(tab)          { S.tab = tab; render(); }
function setRepTab(tab)       { S.repTab = tab; render(); }
function setFilter(key, val)  { S.filters[key] = val; render(); }
function clearFilters()       { S.filters = { rep:'', manager:'', type:'', status:'', from:'', to:'' }; render(); }
function calMode(m)           { S.calMode = m; render(); }
function calToday()           { S.calCursor = new Date(); render(); }
function calDay(dISO)         { S.calMode = 'day'; S.calCursor = parseD(dISO); render(); }
function calStep(dir) {
  const c = new Date(S.calCursor);
  if (S.calMode === 'month')     c.setMonth(c.getMonth() + dir);
  else if (S.calMode === 'week') c.setDate(c.getDate() + 7 * dir);
  else                           c.setDate(c.getDate() + dir);
  S.calCursor = c; render();
}

// ═══════════════════════════════════════════════════════════════════════════
//  DASHBOARD WIDGET — compact team leave calendar
//  Call from the host app:  window.Leave?.mini('dash-leave-cal')
// ═══════════════════════════════════════════════════════════════════════════
let miniCursor = new Date();

async function mini(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!me()) { el.innerHTML = ''; return; }
  el.dataset.lvMini = '1';
  if (!S.booted) {
    el.innerHTML = '<div class="empty-state" style="padding:22px;">Loading leave…</div>';
    await Promise.all([loadTypes(), loadUsers(), loadApprovers()]);
    await resolveScope();
    await loadRequests();
    S.booted = true;
  }
  drawMini(elId);
}

function drawMini(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const c     = miniCursor;
  const t     = todayISO();
  const first = new Date(c.getFullYear(), c.getMonth(), 1);
  const start = startOfWeek(first);
  const monthKey = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}`;

  // Highest-priority status wins the day's colour.
  const rank = { active: 4, pending: 3, upcoming: 2, completed: 1 };

  // Only the first and last day of each leave is marked — not the whole span.
  const edgesOn = dISO => {
    const seen = new Set();
    return calendarItems().filter(r => {
      if (r.start_date !== dISO && r.end_date !== dISO) return false;
      if (seen.has(r.id)) return false;            // single-day leave: start === end
      seen.add(r.id); return true;
    });
  };
  const edgeWord = (r, dISO) =>
    r.start_date === dISO && r.end_date === dISO ? 'single day'
    : r.start_date === dISO ? 'first day' : 'last day';

  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d    = addDays(start, i);
    const dISO = iso(d);
    const out  = d.getMonth() !== c.getMonth();
    const list = edgesOn(dISO);
    let cls = 'lv-mini-d' + (out ? ' out' : '') + (dISO === t ? ' today' : '');
    let style = '';
    if (list.length && !out) {
      const top = list.map(liveStatus).sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0];
      cls += ' has';
      style = `background:${STATUS_COLOR[top]};`;
    }
    const tip = list.map(r => `${r.employee_name || userName(r.employee_id)} — ${r.leave_type_name || ''} (${edgeWord(r, dISO)}: ${fmtShort(r.start_date)} – ${fmtShort(r.end_date)})`).join(', ');
    cells += `<div class="${cls}" style="${style}"${list.length && !out ? ` onclick="Leave.miniOpenDay('${dISO}')" title="${esc(tip)}"` : ''}>${d.getDate()}</div>`;
  }

  const inMonth = calendarItems()
    .filter(r => r.start_date.slice(0, 7) === monthKey || r.end_date.slice(0, 7) === monthKey)
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
    .slice(0, 4);

  const dows = ['S','M','T','W','T','F','S'];
  el.innerHTML = `
    <div class="lv-mini-hd">
      <span class="lv-mini-m">${c.toLocaleDateString('en-UG', { month:'long', year:'numeric' })}</span>
      <span class="lv-mini-nav">
        <button class="lv-mini-btn" onclick="Leave.miniStep(-1)">‹</button>
        <button class="lv-mini-btn txt" onclick="Leave.miniToday()">Today</button>
        <button class="lv-mini-btn" onclick="Leave.miniStep(1)">›</button>
      </span>
    </div>
    <div class="lv-mini-grid">
      ${dows.map(d => `<div class="lv-mini-dow">${d}</div>`).join('')}
      ${cells}
    </div>
    <div class="lv-mini-list">
      ${inMonth.length ? inMonth.map(r => {
        const ls = liveStatus(r);
        const nm = r.employee_name || userName(r.employee_id);
        return `<div class="lv-mini-row" onclick="Leave.openDetail('${r.id}')">
          <span class="lv-mini-bar" style="background:${STATUS_COLOR[ls]};"></span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(nm)} — ${esc(r.leave_type_name || '')}</div>
            <div style="font-size:10.5px;color:var(--txt3);">${fmtShort(r.start_date)} – ${fmtShort(r.end_date)} · ${STATUS_LABEL[ls]}</div>
          </div>
        </div>`;
      }).join('') : `<div style="font-size:11.5px;color:var(--txt3);text-align:center;padding:8px 0;">No leave booked this month.</div>`}
    </div>
    <div style="font-size:10px;color:var(--txt3);margin-top:9px;">Marked days are the first and last day of a leave.</div>
    <div class="lv-legend" style="margin-top:5px;font-size:10px;gap:9px;">
      <span class="lv-lg"><span class="lv-lgd" style="width:8px;height:8px;background:${STATUS_COLOR.upcoming};"></span>Approved</span>
      <span class="lv-lg"><span class="lv-lgd" style="width:8px;height:8px;background:${STATUS_COLOR.pending};"></span>Pending</span>
      <span class="lv-lg"><span class="lv-lgd" style="width:8px;height:8px;background:${STATUS_COLOR.active};"></span>On leave</span>
      <span class="lv-lg"><span class="lv-lgd" style="width:8px;height:8px;background:${STATUS_COLOR.completed};"></span>Completed</span>
    </div>`;
}

function miniStep(dir) {
  const c = new Date(miniCursor);
  c.setDate(1); c.setMonth(c.getMonth() + dir);
  miniCursor = c;
  document.querySelectorAll('[data-lv-mini]').forEach(el => drawMini(el.id));
}
function miniToday() {
  miniCursor = new Date();
  document.querySelectorAll('[data-lv-mini]').forEach(el => drawMini(el.id));
}
function miniOpenDay(dISO) {
  S.calMode = 'day';
  S.calCursor = parseD(dISO);
  S.tab = 'calendar';
  goToLeave();
}

// ═══════════════════════════════════════════════════════════════════════════
//  INTEGRATION WITH THE HOST APP (nav, routing, boot)
// ═══════════════════════════════════════════════════════════════════════════
let leaveActive = false;
const NAV_ICON = 'M3 3h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zM1 7h14M5 1v4M9 1v4M6 11l1.5 1.5L11 9';

function ensureScreen() {
  if (document.getElementById('screen-leave')) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const div = document.createElement('div');
  div.className = 'screen';
  div.id = 'screen-leave';
  div.innerHTML = '<div id="lv-root"></div>';
  content.appendChild(div);
}

function injectNav(containerId, withClose) {
  const el = document.getElementById(containerId);
  if (!el || !me()) return;
  const cb = withClose ? "goTo('leave');closeDrawer()" : "goTo('leave')";
  const pending = roleRep() ? 0 : S.requests.filter(r => r.status === 'pending').length;
  const html = `<div class="nav-sec">Human Resource Management</div>
    <div class="nav-item${leaveActive ? ' active' : ''}" onclick="${cb}" style="justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:9px;">
        <svg class="ni" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="${NAV_ICON}"/></svg>Leave Management
      </div>
      ${pending ? `<span style="background:#E24B4A;color:#fff;font-size:9.5px;font-weight:700;border-radius:9px;padding:1px 6px;">${pending}</span>` : ''}
    </div>`;

  // Take the slot CRM used to occupy: directly above "Performance".
  // Falls back down the list if a section is missing for this role.
  const secs = [...el.querySelectorAll('.nav-sec')];
  const sec  = n => secs.find(s => s.textContent.trim().toLowerCase() === n);
  const anchor = sec('performance') || sec('administration') || sec('account');
  if (anchor) anchor.insertAdjacentHTML('beforebegin', html);
  else el.insertAdjacentHTML('beforeend', html);
}

function goToLeave() {
  if (!me()) return;
  ensureScreen();
  leaveActive = true;
  try { currentScreen = 'leave'; } catch (e) { /* host uses a lexical binding */ }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-leave')?.classList.add('active');
  const title = document.getElementById('page-title');
  const mob   = document.getElementById('mob-screen');
  if (title) title.textContent = 'Leave Management';
  if (mob)   mob.textContent   = 'Leave';
  try { buildNav('sidebar-nav'); buildNav('drawer-nav', true); } catch (e) {}
  if (!S.booted) { S.booted = true; refresh(true); }
  else { render(); refresh(); }
}

function patchHost() {
  if (window.__lvPatched) return;

  const origBuildNav = window.buildNav;
  if (typeof origBuildNav === 'function') {
    window.buildNav = function (containerId, withClose) {
      origBuildNav.apply(this, arguments);
      try { injectNav(containerId, withClose); } catch (e) { console.warn('[leave] nav:', e); }
    };
  }

  const origGoTo = window.goTo;
  if (typeof origGoTo === 'function') {
    window.goTo = function (screen) {
      if (screen === 'leave') { goToLeave(); return; }
      leaveActive = false;
      document.getElementById('screen-leave')?.classList.remove('active');
      return origGoTo.apply(this, arguments);
    };
  }

  const origSignOut = window.signOut;
  if (typeof origSignOut === 'function') {
    window.signOut = function () {
      S.booted = false; leaveActive = false;
      Object.assign(S, { types:[], users:[], approvers:[], requests:[], notifs:[], teamIds:null });
      document.getElementById('lv-panel')?.classList.remove('open');
      const dot = document.getElementById('lv-bell-dot');
      if (dot) dot.classList.remove('on');
      return origSignOut.apply(this, arguments);
    };
  }

  window.__lvPatched = true;
}

// ─── BOOT ──────────────────────────────────────────────────────────────────
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!me() || document.hidden) return;
    await loadNotifs();
    if (document.getElementById('lv-panel')?.classList.contains('open')) renderPanel();
  }, CFG.notifPollMs);
}

function waitForApp() {
  const app = document.getElementById('app');
  const signedIn = !!me() && app && !app.classList.contains('hidden');
  if (!signedIn) return;

  injectStyles();
  ensureScreen();
  mountBell();
  try { buildNav('sidebar-nav'); buildNav('drawer-nav', true); } catch (e) {}
  loadNotifs();
  startPolling();

  // Keep the sidebar badge honest without opening the screen.
  if (!roleRep() && !S.booted) {
    (async () => {
      await Promise.all([loadTypes(), loadUsers(), loadApprovers()]);
      await resolveScope();
      await loadRequests();
      try { buildNav('sidebar-nav'); buildNav('drawer-nav', true); } catch (e) {}
      S.booted = true;
      if (leaveActive) render();
      sweepUpcoming().catch(() => {});
    })();
  }

  clearInterval(bootTimer);
}

patchHost();
const bootTimer = setInterval(waitForApp, 600);
document.addEventListener('DOMContentLoaded', () => { patchHost(); waitForApp(); });

// ─── PUBLIC API (used by inline onclick handlers) ──────────────────────────
window.Leave = {
  // navigation / state
  setTab, setRepTab, setFilter, clearFilters, calMode, calToday, calStep, calDay,
  refresh, render, goTo: goToLeave,
  // requests
  openRequestForm, onTypeChange, recalc, submit, openDetail, openAttachment,
  approve, reject, confirmReject, cancel,
  // settings
  openTypeForm, saveType, toggleType, assign, unassign,
  // notifications
  markAllRead, openNotif,
  // dashboard widget
  mini, miniStep, miniToday, miniOpenDay,
  // misc
  closeModal, state: S, config: CFG,
};

console.log('%c[KTL] Leave Management module ready', 'color:#1a3a6b;font-weight:700');
})();
