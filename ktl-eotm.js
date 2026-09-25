/* ════════════════════════════════════════════════════════════════════════
   KTL-EOTM — "Star of the Day" recognition module
   Drop-in script, loaded the same way as ktl-stock.js / ktl-leave.js:
     <script src="ktl-eotm.js"></script>

   WHAT IT DOES
   • Adds a vertical ribbon tab pinned to the right edge of the screen
     (a floating round button on mobile), same interaction pattern as the
     "Special Offers" reference: badge circle, vertical label, slide-in
     panel. Visual language (colors, card style, inputs) is pulled from
     clockin.html's own CSS variables and existing classes, not invented.
   • Clicking it slides in a panel where the signed-in user picks ONE
     teammate they think stood out today, and writes a short reason.
   • That submission earns the nominee 10 points for the current month.
   • Each person can vote once per calendar day. No self-votes.
   • Nobody — including managers/admins — sees any running tally. The
     panel never queries or displays this month's point totals. The
     *previous* month's winner is revealed automatically once the new
     month starts, and stays visible after that, but the current month
     always stays a mystery.

   DATA MODEL (see eotm_schema.sql)
   • eotm_votes            — one row per vote (voter, nominee, reason, day)
   • eotm_monthly_results  — one row per month, written once that month
                              is over, holding the computed leaderboard.

   A HONEST NOTE ON "hidden until reveal"
   This app's Supabase client (`sb`, defined in clockin.html) is created
   with a key whose JWT payload decodes to role:"service_role" — that
   role bypasses Row-Level Security entirely, for every table, app-wide.
   That's already true for the rest of the app today (e.g. any signed-in
   user's browser could already call sb.from('users').delete(...)), so
   this module doesn't newly introduce that trust model — but it does
   mean RLS policies can't be the thing enforcing "no one sees the
   leaderboard early" the way they normally would. This module enforces
   it the same way the rest of the app enforces things: the client code
   simply never fetches or renders current-month totals, only ever the
   viewer's own vote and already-finalized past months. That stops
   everyone using the app normally, but not someone deliberately opening
   dev tools and querying eotm_votes directly. If that matters for this
   feature, the real fix is switching clockin.html to the project's
   *anon* key and adding real RLS policies — a bigger change than this
   drop-in file, flagged here rather than silently assumed away.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__eotmLoaded) return;
  window.__eotmLoaded = true;

  // ── small helpers ─────────────────────────────────────────────────────
  function eotmEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function eotmPad(n) { return n < 10 ? '0' + n : '' + n; }
  function eotmTodayISO(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${eotmPad(d.getMonth() + 1)}-${eotmPad(d.getDate())}`;
  }
  function eotmMonthKey(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${eotmPad(d.getMonth() + 1)}`;
  }
  function eotmPrevMonthKey(d) {
    d = d || new Date();
    const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
    const m = d.getMonth() === 0 ? 12 : d.getMonth();
    return `${y}-${eotmPad(m)}`;
  }
  function eotmDaysUntilReveal() {
    const now = new Date();
    const firstOfNext = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return Math.max(1, Math.ceil((firstOfNext - now) / 86400000));
  }
  function eotmMonthLabel(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  // Plain outline icon — deliberately not a colored avatar-with-initials;
  // the reference list style is a flat card with a single muted-line icon.
  const EOTM_ICON_PERSON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.3"/><path d="M5 19.5c0-3.6 3.1-6 7-6s7 2.4 7 6"/></svg>`;
  const EOTM_ICON_TROPHY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 5H4v1a4 4 0 0 0 3.6 4"/><path d="M17 5h3v1a4 4 0 0 1-3.6 4"/><path d="M12 13v3M9 20h6M9 20a3 3 0 0 1 3-3 3 3 0 0 1 3 3"/></svg>`;

  // ── styles ───────────────────────────────────────────────────────────
  // Typography + interaction chrome for just this module. Colors, card
  // radii and spacing lean on clockin.html's own tokens (--royal, --gold,
  // --bg2, --brd, --txt, --txt2, --txt3) rather than new ones, so this
  // reads as part of the app, not a bolted-on widget.
  const EOTM_CSS = `
#eotm-tab,.eotm-panel{font-family:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
#eotm-tab{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:150;
  width:44px;padding:34px 0 14px;background:linear-gradient(180deg,#E24B4A,#A32D2D);
  border-radius:9px 0 0 9px;box-shadow:-2px 2px 10px rgba(0,0,0,.18);cursor:pointer;
  display:flex;justify-content:center;transition:width .15s,box-shadow .15s;user-select:none;}
#eotm-tab:hover{width:48px;box-shadow:-3px 3px 14px rgba(0,0,0,.24);}
#eotm-tab.eotm-attn{animation:eotmAttnPulse 1.1s ease-out infinite;}
@keyframes eotmAttnPulse{
  0%{box-shadow:-2px 2px 10px rgba(0,0,0,.18),0 0 0 0 rgba(226,75,74,.55);}
  70%{box-shadow:-2px 2px 10px rgba(0,0,0,.18),0 0 0 14px rgba(226,75,74,0);}
  100%{box-shadow:-2px 2px 10px rgba(0,0,0,.18),0 0 0 0 rgba(226,75,74,0);}
}
@media(prefers-reduced-motion:reduce){#eotm-tab.eotm-attn{animation:none;}}
.eotm-tab-badge{position:absolute;top:-15px;left:50%;transform:translateX(-50%);width:30px;height:30px;
  border-radius:50%;background:#fff;color:#A32D2D;display:flex;align-items:center;justify-content:center;
  box-shadow:0 2px 6px rgba(0,0,0,.25);}
.eotm-tab-badge svg{width:15px;height:15px;}
.eotm-tab-badge .eotm-dot{position:absolute;top:-2px;right:-2px;width:10px;height:10px;border-radius:50%;
  background:#E24B4A;border:2px solid #fff;animation:eotmPulse 1.8s infinite;}
.eotm-tab-badge .eotm-dot.hidden{display:none;}
@keyframes eotmPulse{0%,100%{transform:scale(1);opacity:1;}50%{transform:scale(1.3);opacity:.65;}}
.eotm-tab-text{writing-mode:vertical-rl;color:#fff;font-size:11px;font-weight:700;letter-spacing:.07em;
  text-transform:uppercase;}
@media (max-width:700px){
  #eotm-tab{width:50px;height:50px;padding:0;border-radius:50%;top:auto;bottom:84px;right:14px;
    transform:none;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 14px rgba(0,0,0,.28);}
  #eotm-tab:hover{width:50px;}
  .eotm-tab-badge{position:static;transform:none;box-shadow:none;background:transparent;color:#fff;width:22px;height:22px;}
  .eotm-tab-badge svg{width:22px;height:22px;}
  .eotm-tab-badge .eotm-dot{top:-1px;right:-1px;}
  .eotm-tab-text{display:none;}
}
.eotm-ov{display:none;position:fixed;inset:0;background:rgba(10,16,28,.45);z-index:400;backdrop-filter:blur(2px);}
.eotm-ov.open{display:block;}
.eotm-panel{position:fixed;top:0;right:-420px;width:400px;max-width:92vw;height:100vh;
  background:var(--bg);z-index:401;box-shadow:-10px 0 36px rgba(0,0,0,.2);
  transition:right .28s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;}
.eotm-panel.open{right:0;}
.eotm-hdr-band{background:var(--royal);color:#fff;font-size:12.5px;font-weight:500;text-align:center;
  padding:11px 14px;letter-spacing:.01em;flex-shrink:0;}
.eotm-hdr-top{padding:22px 24px 16px;display:flex;align-items:center;justify-content:space-between;
  gap:10px;flex-shrink:0;}
.eotm-hdr-title{font-size:22px;font-weight:700;letter-spacing:-.02em;color:var(--txt);}
.eotm-close{width:34px;height:34px;border-radius:50%;border:none;background:var(--bg2);
  color:var(--txt2);font-size:19px;cursor:pointer;display:flex;align-items:center;justify-content:center;
  flex-shrink:0;transition:all .12s;}
.eotm-close:hover{background:var(--bg3);color:var(--txt);}
.eotm-hdr-rule{border:none;border-top:.5px solid var(--brd);margin:0;flex-shrink:0;}
.eotm-body{flex:1;overflow-y:auto;padding:20px 24px 24px;}
.eotm-note{font-size:11.5px;color:var(--txt3);line-height:1.5;margin-bottom:16px;}
.eotm-search.f-inp{margin-bottom:14px;}
.eotm-row{display:flex;align-items:center;gap:13px;padding:14px 16px;border-radius:14px;
  background:var(--bg2);margin-bottom:10px;transition:background .15s;}
.eotm-row:hover{background:var(--bg3);}
.eotm-row-icon{width:22px;height:22px;flex-shrink:0;color:var(--txt2);}
.eotm-row-text{flex:1;min-width:0;}
.eotm-row-name{font-weight:600;font-size:14.5px;color:var(--txt);letter-spacing:-.01em;}
.eotm-row-role{font-size:12px;color:var(--txt3);text-transform:capitalize;margin-top:1px;}
.eotm-row-btn{flex-shrink:0;padding:9px 18px;border-radius:999px;border:none;
  background:var(--royal);color:#fff;font-size:12px;font-weight:700;cursor:pointer;
  font-family:inherit;transition:background .15s;}
.eotm-row-btn:hover{background:#0f2550;}
.eotm-reason-who{display:flex;align-items:center;gap:13px;padding:14px 16px;border-radius:14px;
  background:var(--bg2);margin-bottom:16px;}
.eotm-back{background:none;border:none;color:var(--txt3);font-size:12px;cursor:pointer;
  padding:0;margin-bottom:14px;font-family:inherit;display:flex;align-items:center;gap:4px;}
.eotm-back:hover{color:var(--royal);}
.eotm-reason-label{font-size:12.5px;font-weight:600;color:var(--txt);display:block;margin-bottom:7px;}
.eotm-reason-textarea.f-inp{min-height:96px;resize:vertical;margin-bottom:0;}
.eotm-char-count{font-size:10.5px;color:var(--txt3);text-align:right;margin-top:5px;}
.eotm-submit-btn{width:100%;padding:12px;border-radius:9px;background:var(--royal);color:#fff;
  border:none;font-weight:700;font-size:13.5px;cursor:pointer;margin-top:14px;font-family:inherit;
  transition:background .15s;}
.eotm-submit-btn:hover{background:#0f2550;}
.eotm-submit-btn:disabled{opacity:.5;cursor:not-allowed;}
.eotm-err{background:#FCEBEB;color:#A32D2D;border:.5px solid #F7C1C1;border-radius:8px;
  padding:8px 11px;font-size:11.5px;margin-top:10px;}
.eotm-done-title{font-size:16px;font-weight:700;color:var(--txt);margin-bottom:14px;}
.eotm-done-card{background:var(--bg2);border-radius:14px;padding:16px;font-size:12.5px;
  color:var(--txt2);line-height:1.55;}
.eotm-done-card b{color:var(--txt);}
.eotm-countdown{margin-top:16px;font-size:11px;color:var(--txt3);}
.eotm-hof{background:var(--bg);border:.5px solid var(--brd);border-radius:12px;padding:14px 16px;
  margin-bottom:18px;display:flex;align-items:flex-start;gap:12px;position:relative;overflow:hidden;}
.eotm-hof::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;
  background:linear-gradient(90deg,var(--gold-mid),var(--gold));opacity:.5;}
.eotm-hof-icon{width:34px;height:34px;border-radius:50%;background:var(--gold-light);color:var(--gold-mid);
  display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}
.eotm-hof-icon svg{width:17px;height:17px;}
.eotm-hof-eyebrow{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--txt3);}
.eotm-hof-name{font-size:14px;font-weight:700;color:var(--txt);margin-top:2px;letter-spacing:-.01em;}
.eotm-hof-summary{font-size:11.5px;color:var(--txt2);line-height:1.5;margin-top:6px;}
.eotm-empty{text-align:center;padding:24px 10px;color:var(--txt3);font-size:12px;}
`;

  // ── markup ───────────────────────────────────────────────────────────
  const EOTM_HTML = `
<div id="eotm-tab" onclick="eotmOpen()">
  <div class="eotm-tab-badge">${EOTM_ICON_TROPHY}<span class="eotm-dot hidden" id="eotm-dot"></span></div>
  <div class="eotm-tab-text">RECOGNIZE A TEAMMATE</div>
</div>
<div class="eotm-ov" id="eotm-ov" onclick="eotmClose()"></div>
<div class="eotm-panel" id="eotm-panel">
  <div class="eotm-hdr-band">🏆 One shout-out a day — standings stay secret until month-end</div>
  <div class="eotm-hdr-top">
    <div class="eotm-hdr-title">Star of the Day</div>
    <button class="eotm-close" onclick="eotmClose()">&times;</button>
  </div>
  <hr class="eotm-hdr-rule"/>
  <div class="eotm-body" id="eotm-body">
    <div class="eotm-empty">Loading…</div>
  </div>
</div>`;

  function eotmInjectFont() {
    if (document.getElementById('eotm-font-link')) return;
    const preconnect = document.createElement('link');
    preconnect.rel = 'preconnect';
    preconnect.href = 'https://fonts.googleapis.com';
    const link = document.createElement('link');
    link.id = 'eotm-font-link';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap';
    document.head.appendChild(preconnect);
    document.head.appendChild(link);
  }

  function eotmInjectOnce() {
    eotmInjectFont();
    if (!document.getElementById('eotm-styles')) {
      const style = document.createElement('style');
      style.id = 'eotm-styles';
      style.textContent = EOTM_CSS;
      document.head.appendChild(style);
    }
    if (!document.getElementById('eotm-tab')) {
      const wrap = document.createElement('div');
      wrap.innerHTML = EOTM_HTML;
      while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
    }
  }

  // ── state ────────────────────────────────────────────────────────────
  const eotmState = {
    users: [],
    selected: null, // {id, name}
    step: 'loading', // loading | list | reason | done | error
    todayVote: null,
    hof: null, // previous month's finalized result row, if any
    busy: false,
  };

  // ── open / close ─────────────────────────────────────────────────────
  window.eotmOpen = async function () {
    document.getElementById('eotm-ov').classList.add('open');
    document.getElementById('eotm-panel').classList.add('open');
    await eotmLoadState();
  };
  window.eotmClose = function () {
    document.getElementById('eotm-ov').classList.remove('open');
    document.getElementById('eotm-panel').classList.remove('open');
  };

  // ── data loading ─────────────────────────────────────────────────────
  async function eotmLoadState() {
    eotmRenderLoading();
    try {
      await eotmEnsurePreviousMonthComputed();

      const today = eotmTodayISO();
      const { data: myVote, error: voteErr } = await sb
        .from('eotm_votes')
        .select('id,nominee_id,reason,created_at')
        .eq('voter_id', currentUser.id)
        .eq('vote_date', today)
        .maybeSingle();
      if (voteErr) throw voteErr;

      if (myVote) {
        let nomineeName = '—';
        const { data: nomineeRow } = await sb.from('users').select('full_name').eq('id', myVote.nominee_id).maybeSingle();
        if (nomineeRow) nomineeName = nomineeRow.full_name;
        eotmState.todayVote = { ...myVote, nomineeName };
        eotmState.step = 'done';
        eotmSetDotVisible(false);
        eotmRenderDone();
        return;
      }
      eotmSetDotVisible(true);

      const { data: users, error: usersErr } = await sb
        .from('users').select('id,full_name,role').eq('is_active', true).order('full_name');
      if (usersErr) throw usersErr;
      eotmState.users = (users || []).filter(u => u.id !== currentUser.id);
      eotmState.step = 'list';
      eotmState.selected = null;
      eotmRenderList('');
    } catch (err) {
      console.error('EOTM load error', err);
      eotmState.step = 'error';
      eotmRenderError(err);
    }
  }

  async function eotmEnsurePreviousMonthComputed() {
    const prevKey = eotmPrevMonthKey();
    const { data: existing } = await sb
      .from('eotm_monthly_results').select('*').eq('month_key', prevKey).maybeSingle();
    if (existing) { eotmState.hof = existing; return; }

    // Not computed yet — aggregate this once and store it. Idempotent:
    // an upsert on month_key means a near-simultaneous second computation
    // from another device just overwrites with the same deterministic result.
    const { data: votes, error } = await sb
      .from('eotm_votes').select('nominee_id,reason').eq('month_key', prevKey);
    if (error || !votes || votes.length === 0) { eotmState.hof = null; return; }

    const tally = {};
    votes.forEach(v => {
      if (!tally[v.nominee_id]) tally[v.nominee_id] = { votes: 0, reasons: [] };
      tally[v.nominee_id].votes += 1;
      if (v.reason) tally[v.nominee_id].reasons.push(v.reason);
    });
    const nomineeIds = Object.keys(tally);
    const { data: nomineeUsers } = await sb.from('users').select('id,full_name').in('id', nomineeIds);
    const nameOf = {}; (nomineeUsers || []).forEach(u => { nameOf[u.id] = u.full_name; });

    const leaderboard = nomineeIds.map(id => ({
      employee_id: id,
      full_name: nameOf[id] || 'Unknown',
      points: tally[id].votes * 10,
      vote_count: tally[id].votes,
      reasons: tally[id].reasons.slice(0, 3),
    })).sort((a, b) => b.points - a.points);

    const winner = leaderboard[0] || null;
    let winnerSummary = null;
    if (winner) {
      // The leaderboard entry above only keeps a 3-reason sample; the
      // summary needs every reason the winner actually received this month.
      const allWinnerReasons = tally[winner.employee_id].reasons;
      winnerSummary = await eotmFetchWinnerSummary(winner.full_name, allWinnerReasons);
    }
    const payload = {
      month_key: prevKey,
      winner_id: winner ? winner.employee_id : null,
      winner_name: winner ? winner.full_name : null,
      winner_points: winner ? winner.points : 0,
      winner_summary: winnerSummary,
      leaderboard,
    };
    const { data: saved, error: saveErr } = await sb
      .from('eotm_monthly_results').upsert(payload, { onConflict: 'month_key' }).select().maybeSingle();
    eotmState.hof = saveErr ? payload : saved;
  }

  // Turns every reason the winner received that month into one genuine
  // summary paragraph, via a Supabase Edge Function that holds the
  // Anthropic key server-side (see eotm-summarize/index.ts) — this file
  // never calls api.anthropic.com directly, which would mean shipping an
  // API key to every browser that loads the app. If the function isn't
  // deployed yet, or the call fails for any reason, this just returns
  // null: the reveal still shows the name and points, it simply doesn't
  // have a summary line, rather than breaking the whole reveal.
  async function eotmFetchWinnerSummary(winnerName, reasons) {
    try {
      const { data, error } = await sb.functions.invoke('eotm-summarize', {
        body: { winnerName, reasons }
      });
      if (error) { console.warn('eotm-summarize:', error.message || error); return null; }
      if (!data || !data.summary) return null;
      // The prompt asks for ~100 characters, but models don't count
      // precisely — this is the hard backstop so the card never shows
      // something absurdly long even if it overshoots.
      let s = String(data.summary).trim();
      if (s.length > 100) s = s.slice(0, 99).trim() + '…';
      return s;
    } catch (err) {
      console.warn('eotm-summarize unreachable:', err);
      return null;
    }
  }

  function eotmHofBlock() {
    if (!eotmState.hof || !eotmState.hof.winner_name) return '';
    return `
      <div class="eotm-hof">
        <div class="eotm-hof-icon">${EOTM_ICON_TROPHY}</div>
        <div>
          <div class="eotm-hof-eyebrow">${eotmEsc(eotmMonthLabel(eotmState.hof.month_key))} Star</div>
          <div class="eotm-hof-name">${eotmEsc(eotmState.hof.winner_name)} — ${eotmState.hof.winner_points} pts</div>
          ${eotmState.hof.winner_summary ? `<div class="eotm-hof-summary">${eotmEsc(eotmState.hof.winner_summary)}</div>` : ''}
        </div>
      </div>`;
  }

  // ── renders ──────────────────────────────────────────────────────────
  function eotmRenderLoading() {
    document.getElementById('eotm-body').innerHTML = `<div class="eotm-empty">Loading…</div>`;
  }

  function eotmRenderError(err) {
    document.getElementById('eotm-body').innerHTML = `
      <div class="eotm-empty">Couldn't load this right now.</div>
      <div class="eotm-err">${eotmEsc(err?.message || 'Unknown error')}</div>`;
  }

  function eotmRenderList(filterText) {
    const q = (filterText || '').toLowerCase();
    const rows = eotmState.users.filter(u => u.full_name.toLowerCase().includes(q));
    document.getElementById('eotm-body').innerHTML = `
      ${eotmHofBlock()}
      <div class="eotm-note">Pick the teammate who stood out today and say why — they earn 10 points. Nothing is shown until the winner is announced on the 1st.</div>
      <input class="eotm-search f-inp" id="eotm-search" placeholder="Search teammates…" oninput="eotmFilterList(this.value)" value="${eotmEsc(filterText || '')}"/>
      <div id="eotm-list">
        ${rows.length === 0 ? '<div class="eotm-empty">No matching teammates.</div>' : rows.map(u => `
          <div class="eotm-row">
            <span class="eotm-row-icon">${EOTM_ICON_PERSON}</span>
            <div class="eotm-row-text">
              <div class="eotm-row-name">${eotmEsc(u.full_name)}</div>
              <div class="eotm-row-role">${eotmEsc((u.role || '').replace('_', ' '))}</div>
            </div>
            <button class="eotm-row-btn" onclick="eotmSelectNominee('${u.id}','${eotmEsc(u.full_name).replace(/'/g, "\\'")}')">Recognize</button>
          </div>`).join('')}
      </div>`;
  }

  window.eotmFilterList = function (val) { eotmRenderList(val); };

  window.eotmSelectNominee = function (id, name) {
    eotmState.selected = { id, name };
    eotmState.step = 'reason';
    eotmRenderReasonStep();
  };

  window.eotmBackToList = function () {
    eotmState.step = 'list';
    eotmState.selected = null;
    eotmRenderList('');
  };

  function eotmRenderReasonStep() {
    document.getElementById('eotm-body').innerHTML = `
      <button class="eotm-back" onclick="eotmBackToList()">‹ Choose someone else</button>
      <div class="eotm-reason-who">
        <span class="eotm-row-icon">${EOTM_ICON_PERSON}</span>
        <div class="eotm-row-text">
          <div class="eotm-row-name">${eotmEsc(eotmState.selected.name)}</div>
          <div class="eotm-row-role">Earns 10 points if you submit</div>
        </div>
      </div>
      <label class="eotm-reason-label">What did they do well today?</label>
      <textarea class="eotm-reason-textarea f-inp" id="eotm-reason" maxlength="75" placeholder="e.g. Closed a tricky order and helped a teammate hit their target too."></textarea>
      <div class="eotm-char-count"><span id="eotm-char-count">0</span>/75</div>
      <button class="eotm-submit-btn" id="eotm-submit-btn" onclick="eotmSubmitVote()">Submit recognition</button>
      <div id="eotm-submit-err"></div>`;
    const ta = document.getElementById('eotm-reason');
    ta.addEventListener('input', () => {
      if (ta.value.length > 75) ta.value = ta.value.slice(0, 75);
      document.getElementById('eotm-char-count').textContent = ta.value.length;
    });
    ta.focus();
  }

  window.eotmSubmitVote = async function () {
    if (eotmState.busy) return;
    const ta = document.getElementById('eotm-reason');
    const reason = (ta.value || '').trim();
    const errEl = document.getElementById('eotm-submit-err');
    errEl.innerHTML = '';
    if (reason.length > 75) {
      errEl.innerHTML = `<div class="eotm-err">Keep it to 75 characters or fewer (you have ${reason.length}).</div>`;
      return;
    }
    eotmState.busy = true;
    const btn = document.getElementById('eotm-submit-btn');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      const today = eotmTodayISO();
      const { error } = await sb.from('eotm_votes').insert({
        voter_id: currentUser.id,
        nominee_id: eotmState.selected.id,
        reason,
        vote_date: today,
        month_key: eotmMonthKey(),
      });
      if (error) {
        if (error.code === '23505') {
          // Someone else on this account already voted today (race / second tab) —
          // just reload state rather than showing a confusing error.
          await eotmLoadState();
          return;
        }
        throw error;
      }
      await eotmLoadState();
    } catch (err) {
      console.error('EOTM submit error', err);
      errEl.innerHTML = `<div class="eotm-err">Couldn't submit — ${eotmEsc(err?.message || 'try again')}.</div>`;
      btn.disabled = false; btn.textContent = 'Submit recognition';
    } finally {
      eotmState.busy = false;
    }
  };

  function eotmRenderDone() {
    const v = eotmState.todayVote;
    const days = eotmDaysUntilReveal();
    document.getElementById('eotm-body').innerHTML = `
      ${eotmHofBlock()}
      <div class="eotm-done-title">You've recognized someone today</div>
      <div class="eotm-done-card">
        You picked <b>${eotmEsc(v.nomineeName)}</b>:<br/>"${eotmEsc(v.reason)}"
      </div>
      <div class="eotm-countdown">🔒 Standings stay hidden — the winner is revealed in ${days} day${days === 1 ? '' : 's'}, on the 1st. Come back tomorrow for another shout-out.</div>`;
  }

  function eotmSetDotVisible(visible) {
    const dot = document.getElementById('eotm-dot');
    if (dot) dot.classList.toggle('hidden', !visible);
    const tab = document.getElementById('eotm-tab');
    if (tab) tab.classList.toggle('eotm-attn', visible);
  }

  // ── boot ─────────────────────────────────────────────────────────────
  // Mirrors the other ktl-*.js modules: wait for login to complete before
  // injecting anything.
  //
  // NOTE: currentUser/sb are declared with let/const in clockin.html's
  // inline script, so they are NOT window.currentUser / window.sb —
  // let/const never attach to window the way var does. They ARE reachable
  // as bare identifiers here because this file loads as a second <script>
  // tag sharing the same top-level scope, so that's what we check instead.
  const eotmReadyPoll = setInterval(() => {
    const appEl = document.getElementById('app');
    const hasUser = typeof currentUser !== 'undefined' && currentUser;
    const hasSb = typeof sb !== 'undefined' && sb;
    if (hasUser && appEl && !appEl.classList.contains('hidden') && hasSb) {
      clearInterval(eotmReadyPoll);
      eotmInjectOnce();
      // Quietly check today's vote status up front so the reminder dot
      // is accurate before the user ever opens the panel.
      sb.from('eotm_votes').select('id').eq('voter_id', currentUser.id).eq('vote_date', eotmTodayISO()).maybeSingle()
        .then(({ data }) => eotmSetDotVisible(!data))
        .catch(() => {});
    }
  }, 300);
})();
