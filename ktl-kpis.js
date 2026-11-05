/* ════════════════════════════════════════════════════════════════════════
   KTL-KPIS — Department KPIs (Uganda)
   Drop-in script, loaded last:
     <script src="ktl-kpis.js"></script>

   WHAT IT DOES
   • Five departments (DEPARTMENTS in index.html). Each user has one, set by
     admins in User Management.
   • A manager sets their own department's KPIs for each month — a statement,
     optionally with a target figure — and posts dated progress updates
     (status + optional figure so far + note). "Copy last month's KPIs"
     starts a new month from the previous one.
   • Staff see their own department's KPIs and can comment on them.
     Managers see every department (others read-only); admins view only.
   • A KPI with no manager update for more than 7 days (current month) shows
     an amber "No update for N days" flag.
   • Uganda only for now: in Kenya view ktl-country.js shows "Coming soon".

   DATA (see supabase/dept_kpis.sql)
   • users.department
   • dept_kpis        — one row per KPI per month per department
   • dept_kpi_updates — dated manager updates and staff comments on a KPI
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__kpisLoaded) return;
  window.__kpisLoaded = true;

  const SCREEN = 'kpis';
  const TITLE = 'Department KPIs';
  const DEPTS = (typeof DEPARTMENTS !== 'undefined') ? DEPARTMENTS : ['IT', 'Finance', 'Store & Delivery', 'Sales', 'Marketing'];
  const STATUSES = [
    ['on_track', 'On track', 'ok'], ['at_risk', 'At risk', 'warn'],
    ['achieved', 'Achieved', 'ok'], ['partly', 'Partly achieved', 'warn'], ['not_achieved', 'Not achieved', 'bad'],
  ];
  const STATUS = Object.fromEntries(STATUSES.map(([k, l, c]) => [k, { label: l, cls: c }]));
  const STALE_DAYS = 7;

  const me = () => (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
  const isKenyaView = () => { try { return viewCountry() === 'KE'; } catch (e) { return false; } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const prevMonthKey = mk => { const [y, m] = mk.split('-').map(Number); return monthKey(new Date(y, m - 2, 1)); };
  const monthLabel = mk => { const [y, m] = mk.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); };
  const fmtNum = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fmtWhen = iso => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const daysSince = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  const parseNum = v => { const s = String(v == null ? '' : v).replace(/,/g, '').trim(); if (!s) return null; const n = Number(s); return isFinite(n) ? n : NaN; };
  const val = id => document.getElementById(id)?.value ?? '';

  const K = { month: null, dept: null, kpis: [], updates: {}, open: {} };
  const role = () => me()?.role;
  const seesAll = () => ['manager', 'admin'].includes(role());
  const isManagerOf = d => role() === 'manager' && !!K.dept && K.dept === d;
  const isStaffOf = d => !seesAll() && !!K.dept && K.dept === d;
  const unitTxt = k => k.unit ? ' ' + esc(k.unit) : '';

  // ── styles ────────────────────────────────────────────────────────────
  const CSS = `
.kp-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;}
.kp-note{font-size:12px;color:var(--txt2);}
.kp-dept{margin-bottom:16px;}
.kp-dept-sum{font-size:11.5px;color:var(--txt3);margin-top:2px;}
.kp-item{border:1px solid var(--brd);border-radius:10px;padding:12px 14px;margin-top:10px;}
.kp-top{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;}
.kp-stmt{font-size:13.5px;font-weight:600;color:var(--txt);line-height:1.45;white-space:pre-wrap;}
.kp-flags{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0;max-width:45%;}
.kp-meta{font-size:12px;color:var(--txt2);margin-top:5px;line-height:1.5;}
.kp-prog{height:6px;border-radius:999px;background:var(--bg2);overflow:hidden;margin-top:6px;max-width:320px;}
.kp-prog>span{display:block;height:100%;background:var(--royal);}
.kp-pill{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap;}
.kp-pill.ok{background:#e7f6ee;color:#17864f;} .kp-pill.warn{background:#fdf1e0;color:#b6650a;}
.kp-pill.bad{background:#fcebeb;color:#a32d2d;} .kp-pill.none{background:var(--bg2);color:var(--txt3);}
.kp-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;}
.kp-tl{margin-top:10px;border-top:1px dashed var(--brd);padding-top:4px;}
.kp-ev{padding:8px 0;border-bottom:1px solid var(--bg2);font-size:12.5px;}
.kp-ev:last-child{border-bottom:none;}
.kp-ev-hd{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11.5px;color:var(--txt3);}
.kp-ev-hd b{color:var(--txt);font-weight:600;}
.kp-ev-note{margin-top:3px;white-space:pre-wrap;color:var(--txt2);}
.kp-link{background:none;border:none;padding:0;color:var(--royal);font-size:11.5px;cursor:pointer;font-family:inherit;}
.kp-ov{position:fixed;inset:0;background:rgba(16,24,40,.45);z-index:900;display:flex;align-items:center;justify-content:center;padding:16px;}
.kp-modal{background:var(--bg);border-radius:12px;width:100%;max-width:520px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(16,24,40,.25);}
.kp-hd{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--brd);}
.kp-title{font-size:15px;font-weight:600;color:var(--txt);}
.kp-x{width:32px;height:32px;border-radius:8px;border:1px solid var(--brd);background:var(--bg);cursor:pointer;font-size:18px;color:var(--txt2);flex-shrink:0;}
.kp-bd{padding:16px 20px;overflow:auto;}
.kp-ft{padding:14px 20px;border-top:1px solid var(--brd);display:flex;gap:8px;justify-content:flex-end;}
.kp-fld{margin-bottom:12px;}
.kp-fld .flbl{display:block;margin-bottom:5px;}
.kp-in{width:100%;box-sizing:border-box;border:1px solid var(--brd2);border-radius:8px;padding:9px 11px;font-size:13px;font-family:inherit;background:var(--bg);color:var(--txt);}
textarea.kp-in{resize:vertical;}
.kp-err{background:#fcebeb;color:#a32d2d;border:1px solid #f7c1c1;border-radius:8px;padding:8px 11px;font-size:12px;margin-top:8px;}
@media(max-width:600px){.kp-top{flex-direction:column;}.kp-flags{max-width:none;justify-content:flex-start;}}
`;
  function injectStylesOnce() {
    if (document.getElementById('kp-styles')) return;
    const s = document.createElement('style'); s.id = 'kp-styles'; s.textContent = CSS; document.head.appendChild(s);
  }

  // ── data ──────────────────────────────────────────────────────────────
  async function loadMyDept() {
    const { data } = await sb.from('users').select('department').eq('id', me().id).maybeSingle();
    K.dept = data?.department || null;
    me().department = K.dept;
  }
  async function loadMonth() {
    const { data: kpis, error } = await sb.from('dept_kpis').select('*').eq('country', 'UG').eq('month_key', K.month);
    if (error) throw error;
    K.kpis = (kpis || []).sort((a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || String(a.created_at).localeCompare(String(b.created_at)));
    K.updates = {};
    if (!K.kpis.length) return;
    const { data: ups, error: e2 } = await sb.from('dept_kpi_updates').select('*').in('kpi_id', K.kpis.map(k => k.id));
    if (e2) throw e2;
    (ups || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))   // newest first
      .forEach(u => { (K.updates[u.kpi_id] = K.updates[u.kpi_id] || []).push(u); });
  }
  const latestUpdate = k => (K.updates[k.id] || []).find(u => u.kind === 'update') || null;
  const findKpi = id => K.kpis.find(k => String(k.id) === String(id));
  const findEntry = id => { for (const list of Object.values(K.updates)) { const e = list.find(x => String(x.id) === String(id)); if (e) return e; } return null; };

  // ── screen ────────────────────────────────────────────────────────────
  async function renderScreen() {
    const content = document.querySelector('.screen')?.parentElement; if (!content) return;
    let el = document.getElementById('screen-' + SCREEN);
    if (!el) { el = document.createElement('div'); el.className = 'screen'; el.id = 'screen-' + SCREEN; content.appendChild(el); }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el.classList.add('active');
    const pt = document.getElementById('page-title'); if (pt) pt.textContent = TITLE;
    const ms = document.getElementById('mob-screen'); if (ms) ms.textContent = TITLE;

    K.month = K.month || monthKey(new Date());
    if (!el.innerHTML) el.innerHTML = '<div class="card"><div class="empty-state">Loading…</div></div>';
    try { await loadMyDept(); await loadMonth(); }
    catch (e) {
      el.innerHTML = `<div class="card"><div class="kp-err">Couldn't load KPIs: ${esc(e.message || e)}</div></div>`;
      console.warn('Department KPIs not ready — has supabase/dept_kpis.sql been run?', e);
      return;
    }
    if (!seesAll() && !K.dept) {
      el.innerHTML = '<div class="card"><div class="empty-state">Your department hasn\'t been set yet — ask an admin to set it in User Management.</div></div>';
      return;
    }
    const depts = seesAll()
      ? (K.dept && DEPTS.includes(K.dept) ? [K.dept, ...DEPTS.filter(d => d !== K.dept)] : DEPTS)
      : [K.dept];
    const note = role() === 'admin' ? 'Viewing all departments (read-only).'
      : role() === 'manager' ? (K.dept ? `You manage <strong>${esc(K.dept)}</strong> — other departments are read-only.`
                                       : 'Your department isn\'t set — ask an admin to set it so you can add KPIs.')
      : `Your department: <strong>${esc(K.dept)}</strong>`;
    el.innerHTML = `
      <div class="kp-bar">
        <input type="month" class="sel" value="${K.month}" onchange="KPIs.setMonth(this.value)" aria-label="Month"/>
        <span class="kp-note">${note}</span>
      </div>
      ${depts.map(deptCard).join('')}`;
  }

  function deptCard(d) {
    const i = DEPTS.indexOf(d);
    const list = K.kpis.filter(k => k.department === d);
    const counts = {}; let none = 0;
    list.forEach(k => { const u = latestUpdate(k); if (u?.status) counts[u.status] = (counts[u.status] || 0) + 1; else none++; });
    const sum = list.length
      ? [`${list.length} KPI${list.length > 1 ? 's' : ''}`,
         ...STATUSES.filter(([s]) => counts[s]).map(([s, l]) => `${counts[s]} ${l.toLowerCase()}`),
         none ? `${none} no update yet` : ''].filter(Boolean).join(' · ')
      : 'No KPIs set for this month';
    const mgr = isManagerOf(d);
    return `<div class="card kp-dept">
      <div class="card-hdr"><div><span class="card-title">${esc(d)}</span><div class="kp-dept-sum">${sum}</div></div>
        ${mgr && i >= 0 ? `<div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm" onclick="KPIs.copyLast(${i})">Copy last month's KPIs</button>
          <button class="btn btn-sm btn-royal" onclick="KPIs.addKpi(${i})">+ Add KPI</button></div>` : ''}
      </div>
      ${list.length ? list.map(kpiItem).join('')
        : `<div class="empty-state">No KPIs set for ${esc(monthLabel(K.month))}${mgr ? ' — add one, or copy last month\'s.' : '.'}</div>`}
    </div>`;
  }

  function kpiItem(k) {
    const evs = K.updates[k.id] || [];
    const u = latestUpdate(k);
    const st = u?.status ? STATUS[u.status] : null;
    let flags = st ? `<span class="kp-pill ${st.cls}">${esc(st.label)}</span>` : '<span class="kp-pill none">No update yet</span>';
    if (K.month === monthKey(new Date())) {
      const n = daysSince(u ? u.created_at : k.created_at);
      if (n > STALE_DAYS) flags += `<span class="kp-pill warn">No update for ${n} days</span>`;
    }
    let fig = '';
    if (k.target != null) {
      const actual = (evs.find(e => e.kind === 'update' && e.actual != null) || {}).actual;
      const pct = actual != null && Number(k.target) ? Math.round(actual / k.target * 100) : null;
      fig = `<div class="kp-meta">Target: <strong>${fmtNum(k.target)}${unitTxt(k)}</strong>${actual != null
          ? ` · So far: <strong>${fmtNum(actual)}${unitTxt(k)}</strong>${pct != null ? ` (${pct}%)` : ''}` : ''}</div>
        ${pct != null ? `<div class="kp-prog"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>` : ''}`;
    }
    const latest = u?.note ? `<div class="kp-meta">Latest update (${esc(fmtWhen(u.created_at))}): ${esc(u.note)}</div>` : '';
    const mgr = isManagerOf(k.department), staff = isStaffOf(k.department), open = !!K.open[k.id];
    const acts = [
      mgr ? `<button class="btn btn-sm btn-royal" onclick="KPIs.postUpdate('${k.id}')">Post update</button>` : '',
      staff ? `<button class="btn btn-sm btn-royal" onclick="KPIs.addComment('${k.id}')">Add comment</button>` : '',
      evs.length ? `<button class="btn btn-sm" onclick="KPIs.toggle('${k.id}')">${open ? 'Hide' : 'Show'} progress (${evs.length})</button>` : '',
      mgr ? `<button class="btn btn-sm" onclick="KPIs.editKpi('${k.id}')">Edit</button>
             <button class="btn btn-sm btn-danger" onclick="KPIs.deleteKpi('${k.id}')">Delete</button>` : '',
    ].join('');
    return `<div class="kp-item">
      <div class="kp-top"><div class="kp-stmt">${esc(k.statement)}</div><div class="kp-flags">${flags}</div></div>
      ${fig}${latest}
      ${acts.trim() ? `<div class="kp-acts">${acts}</div>` : ''}
      ${open && evs.length ? `<div class="kp-tl">${evs.map(e => entryRow(k, e)).join('')}</div>` : ''}
    </div>`;
  }

  function entryRow(k, e) {
    const mine = String(e.author_id) === String(me()?.id);
    const st = e.status ? STATUS[e.status] : null;
    const tag = e.kind === 'update' ? (st ? `<span class="kp-pill ${st.cls}">${esc(st.label)}</span>` : '') : '<span class="kp-pill none">Comment</span>';
    return `<div class="kp-ev"><div class="kp-ev-hd">
        <b>${esc(e.author_name || '—')}</b><span>${esc(fmtWhen(e.created_at))}${e.edited_at ? ' (edited)' : ''}</span>${tag}
        ${e.actual != null ? `<span>${fmtNum(e.actual)}${unitTxt(k)}</span>` : ''}
        ${mine ? `<span style="margin-left:auto;"><button class="kp-link" onclick="KPIs.editEntry('${e.id}')">Edit</button> ·
          <button class="kp-link" style="color:#a32d2d;" onclick="KPIs.deleteEntry('${e.id}')">Delete</button></span>` : ''}
      </div>${e.note ? `<div class="kp-ev-note">${esc(e.note)}</div>` : ''}</div>`;
  }

  // ── modal + confirm ───────────────────────────────────────────────────
  function closeModal() { document.getElementById('kp-ov')?.remove(); }
  function openModal(title, body, onSave) {
    closeModal();
    const ov = document.createElement('div'); ov.className = 'kp-ov'; ov.id = 'kp-ov';
    ov.innerHTML = `<div class="kp-modal">
      <div class="kp-hd"><div class="kp-title">${esc(title)}</div><button class="kp-x" onclick="KPIs.close()" aria-label="Close">&times;</button></div>
      <div class="kp-bd">${body}<div id="kp-err"></div></div>
      <div class="kp-ft"><button class="btn" onclick="KPIs.close()">Cancel</button><button class="btn btn-royal" id="kp-save">Save</button></div></div>`;
    ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
    document.body.appendChild(ov);
    const btn = document.getElementById('kp-save');
    btn.onclick = async () => {
      const err = document.getElementById('kp-err'); err.innerHTML = '';
      btn.disabled = true;
      try {
        const msg = await onSave();
        if (msg) { err.innerHTML = `<div class="kp-err">${esc(msg)}</div>`; btn.disabled = false; return; }
        closeModal(); renderScreen();
      } catch (e) { err.innerHTML = `<div class="kp-err">Couldn't save: ${esc(e.message || e)}</div>`; btn.disabled = false; }
    };
  }
  function confirmBox(title, messageHtml, label, fn, danger) {
    if (typeof showConfirmDialog === 'function') {
      showConfirmDialog({ icon: danger ? '🗑️' : '📋', title: esc(title), message: messageHtml, confirmLabel: label,
        confirmStyle: danger ? 'background:#A32D2D;color:#fff;border:none;' : 'background:var(--royal);color:#fff;border:none;', onConfirm: fn });
    } else if (confirm(title)) fn();
  }

  // ── manager: KPIs ─────────────────────────────────────────────────────
  function kpiForm(k) {
    return `<div class="kp-fld"><label class="flbl">KPI statement — required</label>
        <textarea class="kp-in" id="kp-stmt" maxlength="300" rows="3" placeholder="e.g. Post all supplier invoices within 48 hours of receipt">${esc(k?.statement || '')}</textarea></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <div class="kp-fld" style="flex:2;min-width:150px;"><label class="flbl">Target figure (optional)</label>
          <input class="kp-in" id="kp-target" inputmode="decimal" placeholder="e.g. 120,000,000" value="${k?.target != null ? esc(k.target) : ''}"/></div>
        <div class="kp-fld" style="flex:1;min-width:110px;"><label class="flbl">Unit (optional)</label>
          <input class="kp-in" id="kp-unit" maxlength="20" placeholder="UGX, leads, %" value="${esc(k?.unit || '')}"/></div>
      </div>`;
  }
  function readKpiForm() {
    const statement = val('kp-stmt').trim(), target = parseNum(val('kp-target')), unit = val('kp-unit').trim() || null;
    if (!statement) return { err: 'Write the KPI statement.' };
    if (Number.isNaN(target)) return { err: 'The target must be a number, e.g. 120000000.' };
    return { row: { statement, target, unit } };
  }
  const nextOrder = d => K.kpis.filter(k => k.department === d).reduce((m, k) => Math.max(m, k.sort_order || 0), 0) + 1;

  function addKpi(i) {
    const d = DEPTS[i]; if (!isManagerOf(d)) return;
    openModal(`Add KPI — ${d}, ${monthLabel(K.month)}`, kpiForm(null), async () => {
      const r = readKpiForm(); if (r.err) return r.err;
      const { error } = await sb.from('dept_kpis').insert({ ...r.row, country: 'UG', month_key: K.month, department: d, sort_order: nextOrder(d), created_by: me().id });
      if (error) throw error;
    });
  }
  function editKpi(id) {
    const k = findKpi(id); if (!k || !isManagerOf(k.department)) return;
    openModal(`Edit KPI — ${k.department}`, kpiForm(k), async () => {
      const r = readKpiForm(); if (r.err) return r.err;
      const { error } = await sb.from('dept_kpis').update(r.row).eq('id', k.id);
      if (error) throw error;
    });
  }
  function deleteKpi(id) {
    const k = findKpi(id); if (!k || !isManagerOf(k.department)) return;
    const n = (K.updates[k.id] || []).length;
    confirmBox('Delete this KPI?', `"${esc(k.statement)}"${n ? `<br/>Its ${n} update${n > 1 ? 's and comments' : '/comment'} will be deleted too.` : ''}`, 'Delete', async () => {
      await sb.from('dept_kpi_updates').delete().eq('kpi_id', k.id);
      const { error } = await sb.from('dept_kpis').delete().eq('id', k.id);
      if (error) alert('Could not delete: ' + error.message);
      renderScreen();
    }, true);
  }
  async function copyLast(i) {
    const d = DEPTS[i]; if (!isManagerOf(d)) return;
    const prev = prevMonthKey(K.month);
    const { data, error } = await sb.from('dept_kpis').select('statement,target,unit,sort_order').eq('country', 'UG').eq('month_key', prev).eq('department', d);
    if (error) { alert('Could not read last month: ' + error.message); return; }
    if (!(data || []).length) { alert(`No ${d} KPIs were set for ${monthLabel(prev)}.`); return; }
    const have = K.kpis.filter(k => k.department === d).length;
    confirmBox(`Copy ${data.length} KPI${data.length > 1 ? 's' : ''} from ${monthLabel(prev)}?`,
      (have ? `${esc(d)} already has ${have} KPI${have > 1 ? 's' : ''} this month — the copied ones are added below them.<br/>` : '')
        + 'Statements and targets are copied; progress starts fresh.', 'Copy', async () => {
      const base = nextOrder(d);
      const rows = data.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map((k, n) => ({
        statement: k.statement, target: k.target, unit: k.unit, sort_order: base + n,
        country: 'UG', month_key: K.month, department: d, created_by: me().id,
      }));
      const { error: e2 } = await sb.from('dept_kpis').insert(rows);
      if (e2) alert('Could not copy: ' + e2.message);
      renderScreen();
    });
  }

  // ── progress updates (manager) and comments (staff) ───────────────────
  function updateForm(k, e) {
    return `<div class="kp-meta" style="margin:0 0 12px;">${esc(k.statement)}</div>
      <div class="kp-fld"><label class="flbl">Status — required</label>
        <select class="kp-in" id="kp-status"><option value="">— Choose —</option>
          ${STATUSES.map(([s, l]) => `<option value="${s}"${e?.status === s ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      ${k.target != null ? `<div class="kp-fld"><label class="flbl">Figure so far (optional) — target ${fmtNum(k.target)}${unitTxt(k)}</label>
        <input class="kp-in" id="kp-actual" inputmode="decimal" value="${e?.actual != null ? esc(e.actual) : ''}"/></div>` : ''}
      <div class="kp-fld"><label class="flbl">Progress note (optional)</label>
        <textarea class="kp-in" id="kp-note" maxlength="500" rows="3" placeholder="What's been done, what's next…">${esc(e?.note || '')}</textarea></div>`;
  }
  function readUpdateForm(k) {
    const status = val('kp-status'), actual = k.target != null ? parseNum(val('kp-actual')) : null, note = val('kp-note').trim() || null;
    if (!status) return { err: 'Choose a status.' };
    if (Number.isNaN(actual)) return { err: 'The figure must be a number.' };
    return { row: { status, actual, note } };
  }
  function commentForm(k, e) {
    return `<div class="kp-meta" style="margin:0 0 12px;">${esc(k.statement)}</div>
      <div class="kp-fld"><label class="flbl">Your comment — required</label>
        <textarea class="kp-in" id="kp-note" maxlength="500" rows="4" placeholder="e.g. What you did towards this KPI this week">${esc(e?.note || '')}</textarea></div>`;
  }
  function postUpdate(id) {
    const k = findKpi(id); if (!k || !isManagerOf(k.department)) return;
    openModal('Post progress update', updateForm(k, null), async () => {
      const r = readUpdateForm(k); if (r.err) return r.err;
      const { error } = await sb.from('dept_kpi_updates').insert({ ...r.row, kpi_id: k.id, author_id: me().id, author_name: me().full_name, kind: 'update' });
      if (error) throw error;
      K.open[k.id] = true;
    });
  }
  function addComment(id) {
    const k = findKpi(id); if (!k || !isStaffOf(k.department)) return;
    openModal('Add comment', commentForm(k, null), async () => {
      const note = val('kp-note').trim(); if (!note) return 'Write your comment.';
      const { error } = await sb.from('dept_kpi_updates').insert({ kpi_id: k.id, author_id: me().id, author_name: me().full_name, kind: 'comment', note });
      if (error) throw error;
      K.open[k.id] = true;
    });
  }
  function editEntry(id) {
    const e = findEntry(id); if (!e || String(e.author_id) !== String(me()?.id)) return;
    const k = findKpi(e.kpi_id); if (!k) return;
    if (e.kind === 'update') {
      openModal('Edit progress update', updateForm(k, e), async () => {
        const r = readUpdateForm(k); if (r.err) return r.err;
        const { error } = await sb.from('dept_kpi_updates').update({ ...r.row, edited_at: new Date().toISOString() }).eq('id', e.id);
        if (error) throw error;
      });
    } else {
      openModal('Edit comment', commentForm(k, e), async () => {
        const note = val('kp-note').trim(); if (!note) return 'Write your comment.';
        const { error } = await sb.from('dept_kpi_updates').update({ note, edited_at: new Date().toISOString() }).eq('id', e.id);
        if (error) throw error;
      });
    }
  }
  function deleteEntry(id) {
    const e = findEntry(id); if (!e || String(e.author_id) !== String(me()?.id)) return;
    confirmBox(e.kind === 'update' ? 'Delete this update?' : 'Delete this comment?', 'This can\'t be undone.', 'Delete', async () => {
      const { error } = await sb.from('dept_kpi_updates').delete().eq('id', e.id);
      if (error) alert('Could not delete: ' + error.message);
      renderScreen();
    }, true);
  }

  // ── nav item + screen routing ─────────────────────────────────────────
  function addNavItem(containerId) {
    const el = document.getElementById(containerId);
    if (!el || !me() || el.querySelector('[data-kp-nav]')) return;
    const items = [...el.querySelectorAll('.nav-item')];
    const on = s => i => new RegExp(`goTo\\('${s}'\\)`).test(i.getAttribute('onclick') || '');
    const after = items.find(on('targets')) || el.querySelector('[data-dr-nav]') || items.find(on('attendance'));
    const inDrawer = containerId === 'drawer-nav';
    const item = document.createElement('div');
    item.className = 'nav-item' + (typeof currentScreen !== 'undefined' && currentScreen === SCREEN ? ' active' : '');
    item.setAttribute('data-kp-nav', '1');
    item.setAttribute('onclick', `goTo('${SCREEN}')${inDrawer ? ';closeDrawer()' : ''}`);
    item.innerHTML = `<svg class="ni" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 14h12M4 12V8M8 12V3M12 12V6"/></svg>${TITLE}`;
    if (after) after.after(item); else el.appendChild(item);
  }
  function rebuildNav() { ['sidebar-nav', 'drawer-nav'].forEach(id => { document.querySelector(`#${id} [data-kp-nav]`)?.remove(); addNavItem(id); }); }
  function wrapOnce() {
    if (window.__kpWrapped || typeof buildNav !== 'function' || typeof goTo !== 'function') return;
    window.__kpWrapped = true;
    const ob = buildNav;
    window.buildNav = function (id, wc) { ob(id, wc); addNavItem(id); };
    const og = goTo;
    window.goTo = function (screen) {
      if (screen !== SCREEN || isKenyaView()) return og(screen);   // Kenya view → ktl-country.js "Coming soon"
      currentScreen = SCREEN;
      renderScreen();
      buildNav('sidebar-nav'); buildNav('drawer-nav', true);
    };
  }

  window.KPIs = {
    addKpi, editKpi, deleteKpi, copyLast, postUpdate, addComment, editEntry, deleteEntry, close: closeModal,
    setMonth: v => { if (v) { K.month = v; K.open = {}; renderScreen(); } },
    toggle: id => { K.open[id] = !K.open[id]; renderScreen(); },
  };

  // ── boot ─────────────────────────────────────────────────────────────
  injectStylesOnce();
  wrapOnce();
  const readyPoll = setInterval(() => {
    const appEl = document.getElementById('app');
    if (!(me() && typeof sb !== 'undefined' && appEl && !appEl.classList.contains('hidden'))) return;
    clearInterval(readyPoll);
    rebuildNav();
  }, 300);
})();
