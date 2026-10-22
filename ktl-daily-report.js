/* ════════════════════════════════════════════════════════════════════════
   KTL-DAILY-REPORT — Daily Activity Reports
   Drop-in script, loaded after ktl-country.js:
     <script src="ktl-daily-report.js"></script>

   WHAT IT DOES
   • Reps: "📤 Send today's report" (Attendance → Field Visits) opens the day's
     report — every COMPLETED visit with date, store, activity type, reason,
     outcome, issues at the store and time spent, plus day totals — and they
     add end-of-day remarks and submit. Submitted = locked; if they complete
     more visits later that day they can send an updated version.
   • Reviewers (set per country, e.g. Uganda → Raymond Mpamizo): a
     "Daily Reports" screen listing every rep for a chosen day — submitted
     (New / Updated / Seen) or not yet — with a red count of unopened reports.
     Opening a report marks it Seen. Admins can view everything (read-only)
     and change the reviewer in User Management.

   DATA (see supabase/daily_reports.sql)
   • daily_reports    — one row per rep per day, a snapshot of the visits
   • report_reviewers — who reviews each country's reports
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__dailyReportLoaded) return;
  window.__dailyReportLoaded = true;

  const SCREEN = 'dailyreports';
  const me = () => (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
  const VC = () => { try { return viewCountry(); } catch (e) { return me()?.country || 'UG'; } };
  const COUNTRY = c => ({ UG: 'Uganda', KE: 'Kenya' }[c] || c);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayRange = s => [new Date(s + 'T00:00:00').toISOString(), new Date(s + 'T23:59:59.999').toISOString()];
  const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
  const fmtDur = m => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
  const fmtTime = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const fmtDate = s => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

  const R = { reviewerOf: {}, unseen: 0 };
  const isReviewerOf = c => R.reviewerOf[c] === String(me()?.id);
  const canReview = () => me()?.role === 'admin' || Object.values(R.reviewerOf).includes(String(me()?.id));

  async function loadReviewers() {
    const { data } = await sb.from('report_reviewers').select('country,reviewer_id');
    R.reviewerOf = {};
    (data || []).forEach(r => { R.reviewerOf[r.country] = String(r.reviewer_id); });
  }

  // ── styles ────────────────────────────────────────────────────────────
  const CSS = `
.dr-ov{position:fixed;inset:0;background:rgba(16,24,40,.45);z-index:900;display:flex;align-items:center;justify-content:center;padding:16px;}
.dr-modal{background:var(--bg);border-radius:12px;width:100%;max-width:980px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(16,24,40,.25);}
.dr-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--brd);}
.dr-title{font-size:16px;font-weight:600;color:var(--txt);}
.dr-sub{font-size:12px;color:var(--txt2);margin-top:2px;}
.dr-x{width:32px;height:32px;border-radius:8px;border:1px solid var(--brd);background:var(--bg);cursor:pointer;font-size:18px;color:var(--txt2);flex-shrink:0;}
.dr-bd{padding:16px 20px;overflow:auto;}
.dr-ft{padding:14px 20px;border-top:1px solid var(--brd);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;}
.dr-stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;}
.dr-stat{border:1px solid var(--brd);border-radius:10px;padding:10px 14px;min-width:120px;}
.dr-stat-v{font-size:20px;font-weight:600;color:var(--txt);}
.dr-stat-l{font-size:11.5px;color:var(--txt2);}
.dr-types{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;}
.dr-type{font-size:11px;padding:3px 9px;border-radius:999px;background:var(--royal-light);color:var(--royal);}
.dr-tbl{width:100%;border-collapse:collapse;font-size:12.5px;min-width:820px;}
.dr-tbl th{text-align:left;font-size:11.5px;font-weight:500;color:var(--txt3);padding:8px 10px;border-bottom:1px solid var(--brd);white-space:nowrap;}
.dr-tbl td{padding:9px 10px;border-bottom:1px solid var(--brd);vertical-align:top;}
.dr-muted{color:var(--txt3);}
.dr-warn{background:#fdf1e0;color:#b6650a;border:1px solid #f6d7ae;border-radius:8px;padding:9px 12px;font-size:12px;margin-bottom:12px;}
.dr-ok{background:#e7f6ee;color:#17864f;border:1px solid #bfe5cf;border-radius:8px;padding:9px 12px;font-size:12px;margin-bottom:12px;}
.dr-remarks{width:100%;min-height:80px;resize:vertical;border:1px solid var(--brd2);border-radius:8px;padding:9px 11px;font-size:13px;font-family:inherit;}
.dr-badge{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#d0361c;color:#fff;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;margin-left:auto;}
.dr-pill{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;}
.dr-pill.new{background:#eaf1ff;color:#2563eb;} .dr-pill.upd{background:#fdf1e0;color:#b6650a;} .dr-pill.seen{background:#e7f6ee;color:#17864f;} .dr-pill.none{background:var(--bg2);color:var(--txt3);}
`;
  function injectStylesOnce() {
    if (document.getElementById('dr-styles')) return;
    const s = document.createElement('style'); s.id = 'dr-styles'; s.textContent = CSS; document.head.appendChild(s);
  }

  // ── shared: the visits table ─────────────────────────────────────────
  function reportBody(rep) {
    const t = rep.totals || {};
    const types = Object.entries(t.by_type || {});
    return `
      <div class="dr-stats">
        <div class="dr-stat"><div class="dr-stat-v">${t.visits || 0}</div><div class="dr-stat-l">Completed visits</div></div>
        <div class="dr-stat"><div class="dr-stat-v">${fmtDur(t.minutes || 0)}</div><div class="dr-stat-l">Time at stores</div></div>
      </div>
      ${types.length ? `<div class="dr-types">${types.map(([k, v]) => `<span class="dr-type">${esc(k)}: ${v}</span>`).join('')}</div>` : ''}
      <div style="overflow-x:auto;"><table class="dr-tbl">
        <thead><tr><th>Date</th><th>Store</th><th>Activity type</th><th>Reason</th><th>Outcome</th><th>Issues at the store</th><th>Time spent</th></tr></thead>
        <tbody>${(rep.visits || []).length ? rep.visits.map(v => `<tr>
          <td style="white-space:nowrap;">${esc(fmtDate(rep.report_date))}</td>
          <td><strong>${esc(v.store)}</strong></td>
          <td>${esc(v.type)}</td>
          <td>${esc(v.reason) || '<span class="dr-muted">—</span>'}</td>
          <td>${esc(v.outcome) || '<span class="dr-muted">—</span>'}</td>
          <td>${esc(v.issues) || '<span class="dr-muted">—</span>'}</td>
          <td style="white-space:nowrap;">${fmtDur(v.minutes)}<div class="dr-muted" style="font-size:11px;">${fmtTime(v.time_in)}–${fmtTime(v.time_out)}</div></td>
        </tr>`).join('') : `<tr><td colspan="7" class="dr-muted" style="text-align:center;padding:18px;">No completed visits.</td></tr>`}</tbody>
      </table></div>`;
  }
  function openModal(html) {
    closeModal();
    const ov = document.createElement('div'); ov.className = 'dr-ov'; ov.id = 'dr-ov';
    ov.innerHTML = `<div class="dr-modal">${html}</div>`;
    ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
    document.body.appendChild(ov);
  }
  function closeModal() { document.getElementById('dr-ov')?.remove(); }

  // ── rep: build + send ─────────────────────────────────────────────────
  async function buildDay(dateStr) {
    const [from, to] = dayRange(dateStr);
    const { data, error } = await sb.from('field_visits').select('*')
      .eq('employee_id', me().id).gte('punch_in_time', from).lte('punch_in_time', to).order('punch_in_time', { ascending: true });
    if (error) throw error;
    const rows = data || [];
    const done = rows.filter(v => v.status === 'Completed' && v.punch_out_time);
    const open = rows.filter(v => v.status !== 'Completed');
    const visits = done.map(v => ({
      id: v.id, store: v.contact_name || '', type: v.type || '', reason: (v.notes || '').trim(),
      outcome: (v.feedback || '').trim(), issues: (v.issues_note || '').trim(),
      time_in: v.punch_in_time, time_out: v.punch_out_time, minutes: minutesBetween(v.punch_in_time, v.punch_out_time),
    }));
    const by_type = {};
    visits.forEach(v => { by_type[v.type] = (by_type[v.type] || 0) + 1; });
    return { visits, open, totals: { visits: visits.length, minutes: visits.reduce((s, v) => s + v.minutes, 0), by_type } };
  }

  let _send = null;
  async function openSend() {
    const dateStr = ymd(new Date());
    openModal(`<div class="dr-bd" style="padding:28px;text-align:center;color:var(--txt3);">Preparing your report…</div>`);
    try {
      const [day, { data: existing }] = await Promise.all([
        buildDay(dateStr),
        sb.from('daily_reports').select('*').eq('employee_id', me().id).eq('report_date', dateStr).maybeSingle(),
      ]);
      const sentIds = new Set((existing?.visits || []).map(v => v.id));
      const hasNew = day.visits.some(v => !sentIds.has(v.id));
      const locked = !!existing && !hasNew;
      _send = { dateStr, day, existing, locked };
      const status = !existing ? ''
        : locked ? `<div class="dr-ok">✅ Report sent at ${fmtTime(existing.submitted_at)}${existing.is_update ? ' (updated)' : ''}. It's locked — complete more visits today to send an updated version.</div>`
        : `<div class="dr-warn">You sent this report at ${fmtTime(existing.submitted_at)}, and have completed more visits since. Send an updated version below.</div>`;
      openModal(`
        <div class="dr-hd"><div><div class="dr-title">Daily Activity Report</div><div class="dr-sub">${esc(me().full_name)} · ${esc(fmtDate(dateStr))}</div></div>
          <button class="dr-x" onclick="DailyReport.close()" aria-label="Close">&times;</button></div>
        <div class="dr-bd">
          ${status}
          ${day.open.length ? `<div class="dr-warn">⚠ You still have ${day.open.length} open visit${day.open.length > 1 ? 's' : ''} (${day.open.map(v => esc(v.contact_name)).join(', ')}). Punch out first, or ${day.open.length > 1 ? 'they' : 'it'} won't be in your report.</div>` : ''}
          ${reportBody({ ...day, report_date: dateStr })}
          <div style="margin-top:14px;"><label class="flbl" style="display:block;margin-bottom:5px;">End-of-day remarks — required</label>
            <textarea class="dr-remarks" id="dr-remarks" maxlength="1000" ${locked ? 'readonly style="background:var(--bg2);"' : ''}
              placeholder="Challenges today, anything the manager should know, plans for tomorrow…">${esc(existing?.remarks || '')}</textarea></div>
          <div id="dr-err"></div>
        </div>
        <div class="dr-ft">
          <button class="btn" onclick="DailyReport.close()">Close</button>
          ${locked ? '' : `<button class="btn btn-royal" id="dr-submit" onclick="DailyReport.submit()" ${day.visits.length ? '' : 'disabled title="No completed visits today"'}>
            ${existing ? '📤 Send updated report' : '📤 Submit report'}</button>`}
        </div>`);
    } catch (e) {
      openModal(`<div class="dr-bd"><div class="dr-warn">Couldn't load your report: ${esc(e.message || e)}</div></div>
        <div class="dr-ft"><button class="btn" onclick="DailyReport.close()">Close</button></div>`);
    }
  }

  async function submit() {
    const { dateStr, day, existing } = _send || {};
    const remarks = (document.getElementById('dr-remarks')?.value || '').trim();
    const err = document.getElementById('dr-err');
    if (!remarks) { err.innerHTML = '<div class="dr-warn" style="margin-top:10px;">Please write your end-of-day remarks before submitting.</div>'; return; }
    if (!day.visits.length) return;
    const btn = document.getElementById('dr-submit'); btn.disabled = true; btn.textContent = 'Sending…';
    const country = me().country || 'UG';
    const row = {
      employee_id: me().id, employee_name: me().full_name, country, report_date: dateStr,
      visits: day.visits, totals: day.totals, remarks, reviewer_id: R.reviewerOf[country] || null,
      submitted_at: new Date().toISOString(), is_update: !!existing, seen_at: null,
    };
    const { error } = await sb.from('daily_reports').upsert(row, { onConflict: 'employee_id,report_date' });
    if (error) { btn.disabled = false; btn.textContent = existing ? '📤 Send updated report' : '📤 Submit report'; err.innerHTML = `<div class="dr-warn" style="margin-top:10px;">Couldn't send: ${esc(error.message)}</div>`; return; }
    closeModal();
    alert(`✅ Daily report sent${R.reviewerOf[country] ? '' : ' (no reviewer is set for ' + COUNTRY(country) + ' yet — an admin can set one in User Management)'}.`);
  }

  // ── reviewer: Daily Reports screen ────────────────────────────────────
  let _date = null;
  async function renderScreen() {
    const content = document.querySelector('.screen')?.parentElement; if (!content) return;
    let el = document.getElementById('screen-' + SCREEN);
    if (!el) { el = document.createElement('div'); el.className = 'screen'; el.id = 'screen-' + SCREEN; content.appendChild(el); }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el.classList.add('active');
    const pt = document.getElementById('page-title'); if (pt) pt.textContent = 'Daily Reports';
    const ms = document.getElementById('mob-screen'); if (ms) ms.textContent = 'Daily Reports';
    if (!canReview()) { el.innerHTML = '<div class="card"><div class="empty-state">You don\'t have access to Daily Reports.</div></div>'; return; }

    const c = VC();
    _date = _date || ymd(new Date());
    el.innerHTML = `<div class="card"><div class="card-hdr"><span class="card-title">Daily Activity Reports — ${esc(COUNTRY(c))}</span>
      <input type="date" class="sel" id="dr-date" value="${_date}" max="${ymd(new Date())}" onchange="DailyReport.setDate(this.value)"/></div>
      <div id="dr-list"><div class="empty-state">Loading…</div></div></div>`;
    const [{ data: reps }, { data: reports }] = await Promise.all([
      sb.from('users').select('id,full_name,role').eq('country', c).eq('status', 'approved').eq('is_active', true)
        .in('role', ['sales_rep', 'other']).order('full_name'),
      sb.from('daily_reports').select('id,employee_id,employee_name,submitted_at,is_update,seen_at,totals').eq('country', c).eq('report_date', _date),
    ]);
    const byRep = new Map((reports || []).map(r => [String(r.employee_id), r]));
    const people = (reps || []).slice();
    (reports || []).forEach(r => { if (!people.some(p => String(p.id) === String(r.employee_id))) people.push({ id: r.employee_id, full_name: r.employee_name }); });
    const sent = people.filter(p => byRep.has(String(p.id))).length;
    const pill = r => !r ? '<span class="dr-pill none">Not submitted</span>'
      : r.seen_at ? '<span class="dr-pill seen">Seen</span>' : r.is_update ? '<span class="dr-pill upd">Updated</span>' : '<span class="dr-pill new">New</span>';
    document.getElementById('dr-list').innerHTML = `
      <div style="font-size:12.5px;color:var(--txt2);margin-bottom:10px;"><strong>${sent}</strong> of ${people.length} reps submitted for ${esc(fmtDate(_date))}${isReviewerOf(c) ? '' : me()?.role === 'admin' ? ' · viewing as admin (read-only)' : ''}</div>
      <div style="overflow-x:auto;"><table><thead><tr><th>Rep</th><th>Status</th><th>Sent</th><th>Visits</th><th>Time at stores</th><th></th></tr></thead><tbody>
      ${people.sort((a, b) => (byRep.has(String(b.id)) - byRep.has(String(a.id))) || String(a.full_name).localeCompare(String(b.full_name))).map(p => {
        const r = byRep.get(String(p.id));
        return `<tr><td><strong>${esc(p.full_name)}</strong></td><td>${pill(r)}</td>
          <td>${r ? fmtTime(r.submitted_at) : '—'}</td><td>${r ? (r.totals?.visits || 0) : '—'}</td><td>${r ? fmtDur(r.totals?.minutes || 0) : '—'}</td>
          <td style="text-align:right;">${r ? `<button class="btn btn-sm btn-royal" onclick="DailyReport.view('${r.id}')">View report</button>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="empty-state">No reps found.</td></tr>'}
      </tbody></table></div>`;
  }

  async function view(id) {
    const { data: r, error } = await sb.from('daily_reports').select('*').eq('id', id).maybeSingle();
    if (error || !r) { alert('Could not open this report.'); return; }
    openModal(`
      <div class="dr-hd"><div><div class="dr-title">${esc(r.employee_name)} — Daily Activity Report</div>
        <div class="dr-sub">${esc(fmtDate(r.report_date))} · sent ${fmtTime(r.submitted_at)}${r.is_update ? ' (updated)' : ''}</div></div>
        <button class="dr-x" onclick="DailyReport.close()" aria-label="Close">&times;</button></div>
      <div class="dr-bd">${reportBody(r)}
        <div style="margin-top:14px;"><div class="flbl" style="margin-bottom:5px;">End-of-day remarks</div>
          <div style="white-space:pre-wrap;font-size:13px;background:var(--bg2);border-radius:8px;padding:10px 12px;">${esc(r.remarks)}</div></div>
      </div>
      <div class="dr-ft"><button class="btn" onclick="DailyReport.close()">Close</button></div>`);
    if (!r.seen_at && isReviewerOf(r.country)) {
      await sb.from('daily_reports').update({ seen_at: new Date().toISOString() }).eq('id', id);
      refreshBadge(); if (currentScreen === SCREEN) renderScreen();
    }
  }

  // ── admin: choose each country's reviewer (User Management) ───────────
  async function renderReviewerCard() {
    if (me()?.role !== 'admin') return;
    const screen = document.getElementById('screen-admin'); if (!screen) return;
    let card = document.getElementById('dr-reviewer-card');
    if (!card) { card = document.createElement('div'); card.className = 'card'; card.id = 'dr-reviewer-card'; screen.insertBefore(card, screen.querySelector('.card')); }
    const { data: mgrs } = await sb.from('users').select('id,full_name,role,country').in('role', ['manager', 'admin'])
      .eq('is_active', true).eq('status', 'approved').order('full_name');
    const opts = c => `<option value="">— Not set —</option>` + (mgrs || []).map(m =>
      `<option value="${m.id}"${R.reviewerOf[c] === String(m.id) ? ' selected' : ''}>${esc(m.full_name)} (${esc(COUNTRY(m.country || 'UG'))})</option>`).join('');
    card.innerHTML = `<div class="card-hdr"><span class="card-title">Daily report reviewers</span>
      <span style="font-size:11.5px;color:var(--txt3);">Reps' daily activity reports go to this person</span></div>
      <div class="fgrid">
        <div class="fg"><label class="flbl">Uganda</label><select class="fin" onchange="DailyReport.setReviewer('UG', this.value)">${opts('UG')}</select></div>
        <div class="fg"><label class="flbl">Kenya</label><select class="fin" onchange="DailyReport.setReviewer('KE', this.value)">${opts('KE')}</select></div>
      </div>`;
  }
  async function setReviewer(country, userId) {
    const q = userId
      ? sb.from('report_reviewers').upsert({ country, reviewer_id: userId, updated_at: new Date().toISOString() }, { onConflict: 'country' })
      : sb.from('report_reviewers').delete().eq('country', country);
    const { error } = await q;
    if (error) { alert('Could not save: ' + error.message); return; }
    await loadReviewers(); rebuildNav();
  }

  // ── nav item + badge ──────────────────────────────────────────────────
  async function refreshBadge() {
    if (!Object.values(R.reviewerOf).includes(String(me()?.id))) { R.unseen = 0; rebuildNav(); return; }
    const { count } = await sb.from('daily_reports').select('id', { count: 'exact', head: true }).eq('reviewer_id', me().id).is('seen_at', null);
    R.unseen = count || 0; rebuildNav();
  }
  function addNavItem(containerId) {
    const el = document.getElementById(containerId);
    if (!el || !canReview() || el.querySelector('[data-dr-nav]')) return;
    const att = [...el.querySelectorAll('.nav-item')].find(i => /goTo\('attendance'\)/.test(i.getAttribute('onclick') || ''));
    const inDrawer = containerId === 'drawer-nav';
    const item = document.createElement('div');
    item.className = 'nav-item' + (typeof currentScreen !== 'undefined' && currentScreen === SCREEN ? ' active' : '');
    item.setAttribute('data-dr-nav', '1');
    item.setAttribute('onclick', `goTo('${SCREEN}')${inDrawer ? ';closeDrawer()' : ''}`);
    item.innerHTML = `<svg class="ni" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 2h6l3 3v9H4zM10 2v3h3M6 8h5M6 11h5"/></svg>Daily Reports${R.unseen ? `<span class="dr-badge">${R.unseen}</span>` : ''}`;
    if (att) att.after(item); else el.prepend(item);
  }
  function rebuildNav() { ['sidebar-nav', 'drawer-nav'].forEach(id => { document.querySelector(`#${id} [data-dr-nav]`)?.remove(); addNavItem(id); }); }
  function wrapOnce() {
    if (window.__drWrapped || typeof buildNav !== 'function' || typeof goTo !== 'function') return;
    window.__drWrapped = true;
    const ob = buildNav;
    window.buildNav = function (id, wc) { ob(id, wc); addNavItem(id); };
    const og = goTo;
    window.goTo = function (screen) {
      if (screen !== SCREEN) return og(screen);
      currentScreen = SCREEN;
      renderScreen();
      buildNav('sidebar-nav'); buildNav('drawer-nav', true);
    };
    if (typeof loadAdmin === 'function') {
      const oa = loadAdmin;
      window.loadAdmin = async function () { const r = await oa.apply(this, arguments); renderReviewerCard().catch(() => {}); return r; };
    }
  }

  window.DailyReport = {
    openSend, submit, view, setReviewer, close: closeModal,
    setDate: d => { _date = d; renderScreen(); },
  };

  // ── boot ─────────────────────────────────────────────────────────────
  injectStylesOnce();
  wrapOnce();
  const readyPoll = setInterval(async () => {
    const appEl = document.getElementById('app');
    if (!(me() && typeof sb !== 'undefined' && appEl && !appEl.classList.contains('hidden'))) return;
    clearInterval(readyPoll);
    try { await loadReviewers(); } catch (e) { console.warn('Daily reports not ready — has supabase/daily_reports.sql been run?', e?.message || e); }
    rebuildNav();
    refreshBadge().catch(() => {});
    setInterval(() => refreshBadge().catch(() => {}), 120000);
  }, 300);
})();
