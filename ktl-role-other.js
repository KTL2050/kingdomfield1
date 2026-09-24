/* ════════════════════════════════════════════════════════════════════════
   KTL-ROLE-OTHER — adds a fourth account type: "Other"
   Drop-in script, loaded the same way as ktl-stock.js / ktl-eotm.js:
     <script src="ktl-role-other.js"></script>

   WHAT IT DOES
   • Lets a user account be created with role "other" (added as an option
     to the login screen's "Sign in as" select and the Add User form's
     Role select — both required, since the login check rejects a
     mismatch between the selected role and the account's stored role).
   • Someone signed in as "other" sees only Dashboard, Attendance, Leave
     Management, Clients and Stock Position in the sidebar/drawer nav —
     everything else (Place Listing, Targets, My Wallet, Reports, User
     Management, Sales Team) is removed from the nav for them.
   • As a second line of defense (not just hiding the links), direct
     navigation to any other screen — from an old bookmark, a stray
     button elsewhere in the app, anything — is redirected back to the
     dashboard, with a small toast (same Instrument Sans font + flat card
     look as ktl-eotm.js) explaining why.

   HOW THE NAV FILTER STAYS CORRECT ACROSS RE-RENDERS
   buildNav() fully replaces the nav container's innerHTML every time it
   runs (initial load, opening the mobile drawer, toggling the CRM
   section, etc.), which would wipe out a one-time filter. So this wraps
   buildNav() itself and re-applies the filter after every call, plus adds
   a MutationObserver on both nav containers as a safety net in case
   something (e.g. ktl-leave.js's own injection) ever changes the nav DOM
   without going through buildNav().

   ONE THING TO VERIFY BEFORE ROLLING THIS OUT
   clockin.html's Attendance screen branches on isSalesRep() — true means
   "show my own clock-in card", false means "show the admin/manager team
   oversight view" (present/absent counts, everyone's map, admin
   controls) — see the comment at that branch: "admins/managers don't
   punch themselves". Since "other" is not sales_rep, isSalesRep() is
   false for them too, so today an Other account would land on that
   oversight view, not a personal clock-in button. isSalesRep() is a
   `const` arrow function, so unlike buildNav/goTo it genuinely can't be
   safely monkey-patched from a separate file. Test with a real Other
   account before handing this to anyone — if the oversight view isn't
   what you want them seeing, tell me what an Other's Attendance screen
   should actually show and I'll add a proper redirect/render for that
   specific case.

   A NOTE ON THE DATABASE SIDE
   If public.users.role has a CHECK constraint or enum type limiting it to
   ('admin','manager','sales_rep'), creating a user with role='other' will
   be rejected by Postgres before this file ever runs. See the SQL note at
   the bottom of this comment block for how to check and fix that.

     select conname, pg_get_constraintdef(oid)
     from pg_constraint
     where conrelid = 'public.users'::regclass and contype = 'c';

     -- if one exists restricting the role column, widen it, e.g.:
     alter table public.users drop constraint <constraint_name>;
     alter table public.users add constraint <constraint_name>
       check (role in ('admin','manager','sales_rep','other'));

   If role is a plain text/varchar column with no CHECK constraint,
   nothing needs to change on the database side.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__ktlOtherRoleLoaded) return;
  window.__ktlOtherRoleLoaded = true;

  const OTHER_ROLE = 'other';
  const ALLOWED_NAV_LABELS = ['Attendance', 'Dashboard', 'Leave Management', 'Clients', 'Stock Position', 'Sign out'];
  const ALLOWED_SCREEN_PREFIXES = ['dashboard', 'attendance', 'leave', 'clients'];
  // ktl-stock.js's Stock Position screen isn't referenced anywhere inside
  // clockin.html itself (same as Leave Management — it's self-contained),
  // so its exact screen id can't be read off with certainty. Matching on
  // "contains stock" fits this app's plain-word screen-id pattern
  // (dashboard/attendance/clients/leave) and only ever allows too much,
  // never too little, if that guess is wrong.

  // ── font (idempotent even if ktl-eotm.js already loaded it) ────────────
  function injectFontOnce() {
    if (document.querySelector('link[href*="Instrument+Sans"]')) return;
    const pre = document.createElement('link');
    pre.rel = 'preconnect'; pre.href = 'https://fonts.googleapis.com';
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap';
    document.head.appendChild(pre);
    document.head.appendChild(link);
  }

  // ── toast (same visual language as the eotm cards: flat bg, hairline
  //    border, rounded corners, Instrument Sans) ─────────────────────────
  const TOAST_CSS = `
#ktl-role-toast{position:fixed;top:18px;left:50%;transform:translateX(-50%) translateY(-14px);z-index:500;
  background:var(--bg2);border:0.5px solid var(--brd);border-radius:12px;padding:10px 18px;
  display:flex;align-items:center;gap:8px;white-space:nowrap;
  font-family:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  font-size:12.5px;font-weight:500;color:var(--txt2);opacity:0;pointer-events:none;
  transition:opacity .2s,transform .2s;box-shadow:0 4px 18px rgba(0,0,0,.14);}
#ktl-role-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
`;
  function injectToastStylesOnce() {
    if (document.getElementById('ktl-role-toast-styles')) return;
    const s = document.createElement('style');
    s.id = 'ktl-role-toast-styles';
    s.textContent = TOAST_CSS;
    document.head.appendChild(s);
  }
  function showRoleToast(msg) {
    injectToastStylesOnce();
    let el = document.getElementById('ktl-role-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ktl-role-toast';
      el.innerHTML = `<span>🔒</span><span id="ktl-role-toast-text"></span>`;
      document.body.appendChild(el);
    }
    document.getElementById('ktl-role-toast-text').textContent = msg;
    el.classList.add('show');
    clearTimeout(window.__ktlRoleToastTimer);
    window.__ktlRoleToastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ── nav filtering ────────────────────────────────────────────────────
  function isAllowedNavLabel(text) {
    return ALLOWED_NAV_LABELS.some(l => text.includes(l));
  }
  function filterNavContainer(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    Array.from(el.children).forEach(child => {
      if (child.classList.contains('nav-item')) {
        if (!isAllowedNavLabel(child.textContent.trim())) child.remove();
      }
    });
    // Drop any section header left with nothing under it.
    const remaining = Array.from(el.children);
    remaining.forEach((child, idx) => {
      if (!child.classList.contains('nav-sec')) return;
      let hasItem = false;
      for (let i = idx + 1; i < remaining.length; i++) {
        if (remaining[i].classList.contains('nav-sec')) break;
        if (remaining[i].classList.contains('nav-item')) { hasItem = true; break; }
      }
      if (!hasItem) child.remove();
    });
  }
  function applyFilterIfOther(containerId) {
    if (typeof currentUser !== 'undefined' && currentUser?.role === OTHER_ROLE) {
      filterNavContainer(containerId);
    }
  }

  // Wrap buildNav so the filter survives every re-render (drawer open,
  // CRM section toggle, etc. all call buildNav() again and replace the
  // whole innerHTML).
  function wrapBuildNavOnce() {
    if (typeof buildNav !== 'function' || window.__ktlBuildNavWrapped) return;
    window.__ktlBuildNavWrapped = true;
    const originalBuildNav = buildNav;
    window.buildNav = function (containerId, withClose) {
      originalBuildNav(containerId, withClose);
      applyFilterIfOther(containerId);
    };
  }

  // Safety net for nav content added outside a buildNav() call (e.g. if
  // ktl-leave.js injects its section by touching the DOM directly rather
  // than through buildNav).
  function observeNavContainer(containerId) {
    const el = document.getElementById(containerId);
    if (!el || el.__ktlOtherObserved) return;
    el.__ktlOtherObserved = true;
    new MutationObserver(() => applyFilterIfOther(containerId)).observe(el, { childList: true });
  }

  // ── screen-level guard ───────────────────────────────────────────────
  function isAllowedScreen(screen) {
    if (ALLOWED_SCREEN_PREFIXES.some(p => screen === p || screen.startsWith(p + '-'))) return true;
    return typeof screen === 'string' && screen.toLowerCase().includes('stock');
  }
  function wrapGoToOnce() {
    if (typeof goTo !== 'function' || window.__ktlGoToWrapped) return;
    window.__ktlGoToWrapped = true;
    const originalGoTo = goTo;
    window.goTo = function (screen) {
      if (typeof currentUser !== 'undefined' && currentUser?.role === OTHER_ROLE && !isAllowedScreen(screen)) {
        showRoleToast("That section isn't available for your account.");
        screen = 'dashboard';
      }
      return originalGoTo(screen);
    };
  }

  // ── role dropdown options ───────────────────────────────────────────
  // Both selects are static markup already present by the time this
  // script (loaded at the end of body) runs, so no need to wait for
  // login or DOMContentLoaded.
  function addRoleOptionOnce(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel || sel.querySelector(`option[value="${OTHER_ROLE}"]`)) return;
    const opt = document.createElement('option');
    opt.value = OTHER_ROLE;
    opt.textContent = 'Other';
    sel.appendChild(opt);
  }

  // ── boot ─────────────────────────────────────────────────────────────
  injectFontOnce();
  addRoleOptionOnce('login-role');
  addRoleOptionOnce('u-role');
  wrapBuildNavOnce();
  wrapGoToOnce();

  const readyPoll = setInterval(() => {
    const appEl = document.getElementById('app');
    const hasUser = typeof currentUser !== 'undefined' && currentUser;
    if (hasUser && appEl && !appEl.classList.contains('hidden')) {
      clearInterval(readyPoll);
      filterNavContainer('sidebar-nav');
      filterNavContainer('drawer-nav');
      observeNavContainer('sidebar-nav');
      observeNavContainer('drawer-nav');
    }
  }, 300);
})();