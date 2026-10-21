/* ════════════════════════════════════════════════════════════════════════
   KTL-COUNTRY — Uganda / Kenya interfaces + pending sign-up badge
   Drop-in script, loaded after ktl-role-other.js:
     <script src="ktl-country.js"></script>

   WHAT IT DOES
   • Kenya view (Kenyan accounts, or a Ugandan admin/manager who switched to
     Kenya): only Attendance and Leave Management work. Every other sidebar
     item stays where it is but faded; clicking it shows
     "Coming soon for Kenyan Team". Ugandan admins also keep User Management
     in Kenya view, so they can approve and manage Kenyan staff.
   • Ugandan admins/managers get a Uganda / Kenya switcher in the top bar.
     Switching reloads the app so every screen reloads for that country.
   • Admins see a red count on User Management while sign-ups are waiting.

   Country itself lives in index.html (myCountry / viewCountry /
   countryUserIds), so every screen and module can filter by it.

   Same technique as ktl-role-other.js: buildNav() is wrapped so the gating
   survives every re-render, goTo() is wrapped so a blocked screen can't be
   reached from anywhere, and a MutationObserver re-applies it if a module
   touches the nav DOM directly.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__ktlCountryLoaded) return;
  window.__ktlCountryLoaded = true;

  const KENYA_SOON_TEXT = 'Coming soon for Kenyan Team';

  const user = () => (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
  const kenyaView = () => { try { return viewCountry() === 'KE'; } catch (e) { return false; } };
  function allowedInKenya(screen) {
    if (screen === 'attendance' || screen === 'leave') return true;
    // Ugandan admins keep User Management so they can approve and manage Kenyan staff
    return screen === 'admin' && user()?.role === 'admin' && (user()?.country || 'UG') === 'UG';
  }

  // ── styles ────────────────────────────────────────────────────────────
  const CSS = `
.nav-item.ktl-soon{opacity:.42;}
.nav-item.ktl-soon:hover{opacity:.6;}
.ktl-pending-badge{margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#d0361c;color:#fff;
  font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;}
.ktl-soon-wrap{display:flex;align-items:center;justify-content:center;min-height:60vh;}
.ktl-soon-card{text-align:center;max-width:380px;padding:36px 28px;background:var(--bg);border:1px solid var(--brd);border-radius:12px;}
.ktl-soon-ico{width:48px;height:48px;border-radius:50%;background:var(--royal-light);color:var(--royal);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:22px;}
.ktl-soon-t{font-size:18px;font-weight:600;color:var(--txt);}
.ktl-soon-s{font-size:12.5px;color:var(--txt2);margin-top:6px;line-height:1.55;}
#ktl-country-switch{height:34px;padding:0 10px;border:1px solid var(--brd);border-radius:8px;background:var(--bg);color:var(--txt);
  font-size:12.5px;font-weight:500;font-family:inherit;cursor:pointer;}
#ktl-country-chip{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 11px;border:1px solid var(--brd);border-radius:8px;
  background:var(--bg);font-size:12.5px;font-weight:500;color:var(--txt);}
@media(max-width:768px){#ktl-country-switch,#ktl-country-chip{height:31px;font-size:11.5px;padding:0 8px;}}
`;
  function injectStylesOnce() {
    if (document.getElementById('ktl-country-styles')) return;
    const s = document.createElement('style'); s.id = 'ktl-country-styles'; s.textContent = CSS; document.head.appendChild(s);
  }

  // ── nav: fade blocked items in Kenya view, badge pending sign-ups ─────
  let pendingCount = 0;
  function screenOf(item) {
    const m = (item.getAttribute('onclick') || '').match(/goTo\('([\w-]+)'\)/);
    return m ? m[1] : null;
  }
  function applyNav(containerId) {
    const el = document.getElementById(containerId);
    if (!el || !user()) return;
    const inDrawer = containerId === 'drawer-nav';
    el.querySelectorAll('.nav-item').forEach(item => {
      const screen = screenOf(item);
      if (!screen) return;
      if (kenyaView() && !allowedInKenya(screen)) {
        item.classList.add('ktl-soon');
        item.setAttribute('onclick', `ktlComingSoon('${screen}')${inDrawer ? ';closeDrawer()' : ''}`);
        item.title = KENYA_SOON_TEXT;
      }
      if (screen === 'admin' && pendingCount > 0 && !item.querySelector('.ktl-pending-badge')) {
        item.insertAdjacentHTML('beforeend', `<span class="ktl-pending-badge" title="Sign-ups waiting for approval">${pendingCount}</span>`);
      }
    });
  }
  function wrapBuildNavOnce() {
    if (typeof buildNav !== 'function' || window.__ktlCountryNavWrapped) return;
    window.__ktlCountryNavWrapped = true;
    const original = buildNav;
    window.buildNav = function (containerId, withClose) {
      original(containerId, withClose);
      applyNav(containerId);
    };
  }
  function observeNav(containerId) {
    const el = document.getElementById(containerId);
    if (!el || el.__ktlCountryObserved) return;
    el.__ktlCountryObserved = true;
    new MutationObserver(() => {
      // only act on items not yet processed, to avoid loops
      if ([...el.querySelectorAll('.nav-item')].some(i => kenyaView() && !i.classList.contains('ktl-soon') && screenOf(i) && !allowedInKenya(screenOf(i)))) applyNav(containerId);
    }).observe(el, { childList: true });
  }

  // ── screen guard: blocked screens show "Coming soon" ──────────────────
  function wrapGoToOnce() {
    if (typeof goTo !== 'function' || window.__ktlCountryGoToWrapped) return;
    window.__ktlCountryGoToWrapped = true;
    const original = goTo;
    window.goTo = function (screen) {
      if (user() && kenyaView() && typeof screen === 'string' && !allowedInKenya(screen)) {
        return window.ktlComingSoon(screen);
      }
      return original(screen);
    };
  }
  window.ktlComingSoon = function (screen) {
    const content = document.querySelector('.screen')?.parentElement;
    if (!content) return;
    let soon = document.getElementById('screen-ktl-soon');
    if (!soon) {
      soon = document.createElement('div');
      soon.className = 'screen'; soon.id = 'screen-ktl-soon';
      soon.innerHTML = `<div class="ktl-soon-wrap"><div class="ktl-soon-card">
        <div class="ktl-soon-ico">🚧</div>
        <div class="ktl-soon-t">${KENYA_SOON_TEXT}</div>
        <div class="ktl-soon-s">This section isn't available for the Kenya team yet. Attendance and Leave Management are ready to use.</div>
      </div></div>`;
      content.appendChild(soon);
    }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    soon.classList.add('active');
    const label = { dashboard: 'Dashboard', clients: 'Clients', orders: 'Place Listing', targets: 'Targets', wallet: 'My Wallet',
                    reports: 'Reports', admin: 'User Management', team: 'Sales Team', stock: 'Stock Position' }[screen] || 'Coming soon';
    const pt = document.getElementById('page-title'); if (pt) pt.textContent = label;
    const ms = document.getElementById('mob-screen'); if (ms) ms.textContent = label;
  };

  // ── top bar: country switcher (Ugandan admins/managers) or Kenya chip ─
  window.ktlSwitchCountry = function (c) {
    try { localStorage.setItem('ktl_view_country', c); } catch (e) {}
    location.reload();   // every screen and module reloads for the chosen country
  };
  function renderCountryControl() {
    const right = document.querySelector('.topbar-right');
    const u = user();
    if (!right || !u || document.getElementById('ktl-country-switch') || document.getElementById('ktl-country-chip')) return;
    const mine = u.country || 'UG';
    let html;
    if (mine === 'UG' && ['admin', 'manager'].includes(u.role)) {
      const v = viewCountry();
      html = `<select id="ktl-country-switch" onchange="ktlSwitchCountry(this.value)" aria-label="Country">
        <option value="UG"${v === 'UG' ? ' selected' : ''}>Uganda</option>
        <option value="KE"${v === 'KE' ? ' selected' : ''}>Kenya</option></select>`;
    } else if (mine === 'KE') {
      html = `<span id="ktl-country-chip">Kenya</span>`;
    } else return;
    right.insertAdjacentHTML('afterbegin', html);
  }
  // "Sync Zoho" syncs Uganda's Zoho — hide it while viewing Kenya
  function hideUgandaOnlyControls() {
    if (!kenyaView()) return;
    const sync = document.getElementById('sync-zoho-btn');
    if (sync) sync.style.display = 'none';
  }

  // ── pending sign-ups (admins) ─────────────────────────────────────────
  async function refreshPendingCount() {
    if (user()?.role !== 'admin') return;
    const { count } = await sb.from('users').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    pendingCount = count || 0;
    document.querySelectorAll('.ktl-pending-badge').forEach(b => b.remove());
    applyNav('sidebar-nav'); applyNav('drawer-nav');
  }
  window.ktlRefreshPending = refreshPendingCount;

  // ── boot ─────────────────────────────────────────────────────────────
  injectStylesOnce();
  wrapBuildNavOnce();
  wrapGoToOnce();
  const readyPoll = setInterval(() => {
    const appEl = document.getElementById('app');
    if (!(user() && appEl && !appEl.classList.contains('hidden'))) return;
    clearInterval(readyPoll);
    applyNav('sidebar-nav'); applyNav('drawer-nav');
    observeNav('sidebar-nav'); observeNav('drawer-nav');
    renderCountryControl();
    hideUgandaOnlyControls();
    refreshPendingCount().catch(() => {});
    setInterval(() => refreshPendingCount().catch(() => {}), 120000);
  }, 300);
})();
