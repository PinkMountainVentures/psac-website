/**
 * ops-shell.js
 *
 * Shared shell for every internal ops page (Ops App Redesign, Phase 4
 * Round 1 item 10 / Phase 3 "rest of redesign" items 1+3+4). A NEW file —
 * every ops-*.html page up to this point has been fully self-contained
 * (inline <style>/<script>, no shared JS), and this deliberately breaks
 * that convention on purpose: the sidebar order, the shared search bar, and
 * the branded loading/timeout convention all need to behave IDENTICALLY on
 * every page (new and existing), and nine separate copy-pasted copies would
 * drift the first time any one of them got a bugfix. Loaded via a plain
 * `<script src="ops-shell.js"></script>` tag, same "no build step" posture
 * as everything else in this repo — this is a static file Vercel serves
 * as-is, not a bundled dependency.
 *
 * Every ops page still owns its own inline <style> and its own page-specific
 * logic — this file only owns what has to be identical everywhere: opsCall,
 * escapeHtml, the sidebar nav list + active-item highlighting, the shared
 * search bar, the auth-check-then-boot sequence, and the branded
 * Loading→timeout→error convention.
 */
'use strict';

var OpsShell = (function () {
  var NAV_ITEMS = [
    { href: 'ops-all-bookings.html', label: 'All Bookings', pinned: true },
    { href: 'ops-alerts.html', label: 'Ops Alerts', pinned: true },
    { href: 'ops-trail-swap-requests.html', label: 'Trail Swap Requests' },
    { href: 'ops-stalled-bookings.html', label: 'Stalled Bookings' },
    { href: 'ops-cancellations.html', label: 'Cancellations' },
    { href: 'ops-manual-adjustment.html', label: 'Manual Adjustment' },
    { href: 'ops-gear-checkout.html', label: 'Gear Assembly & Checkout' },
    { href: 'ops-gear-units.html', label: 'Gear Units' },
    { href: 'ops-gear-checkin.html', label: 'Return Check-In' },
    { href: 'ops-reconciliation-review.html', label: 'Reconciliation Review' },
  ];

  var LOADING_TIMEOUT_MS = 12000;

  // Render-time-only translation of the source cancellationReasons enum —
  // NEVER touch the underlying stored values (VALID_REASONS in api/cancel-
  // and-refund-booking.js: 'no_1.2a', 'zero_waivers', 'no_address',
  // 'hold_never_cleared'). Same pattern the existing 16-string Ops Alerts
  // label-mapping table already uses. Used by All Bookings and Cancellations.
  var CANCELLATION_REASON_LABELS = {
    no_1_2a: 'Trail Details',
    'no_1.2a': 'Trail Details',
    zero_waivers: 'No Waivers Signed',
    no_address: 'No Delivery Address',
    hold_never_cleared: 'Deposit Hold Never Cleared',
  };
  function cancellationReasonLabel(reason) {
    return CANCELLATION_REASON_LABELS[reason] || reason;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function opsCall(action, payload) {
    return fetch('/api/ops-proxy', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); });
  }

  function sidebarHtml(activeHref) {
    var html = '<div class="ops-sidebar-brand">PSAC Ops</div>';
    NAV_ITEMS.forEach(function (item, i) {
      var cls = 'ops-nav-item' + (item.href === activeHref ? ' is-active' : '') + (item.pinned ? ' is-pinned-hub' : '');
      html += '<a class="' + cls + '" href="' + item.href + '">' + escapeHtml(item.label) + '</a>';
      if (i === 1) html += '<div class="ops-nav-divider"></div>'; // divider after the two pinned hubs
    });
    return html;
  }

  /**
   * Shared search bar markup — present on every page (Phase 3, "rest of
   * redesign" item 1). Submitting from ANY page routes into All Bookings,
   * pre-filtered to the query; never a bespoke per-page redirect.
   */
  function searchBarHtml(placeholder) {
    return '<div class="ops-search-row">'
      + '<input class="ops-search-input" type="text" id="ops-shell-search-input" placeholder="' + escapeHtml(placeholder || 'Search booking ID or email…') + '">'
      + '<button class="ops-btn-secondary" id="ops-shell-search-btn">Search</button>'
      + '</div>';
  }

  function wireSearchBar() {
    var input = document.getElementById('ops-shell-search-input');
    var btn = document.getElementById('ops-shell-search-btn');
    if (!input || !btn) return;
    function go() {
      var q = input.value.trim();
      window.location.href = 'ops-all-bookings.html' + (q ? ('?q=' + encodeURIComponent(q)) : '');
    }
    btn.addEventListener('click', go);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }

  /** Standard branded loading state, with a hard timeout falling back to an explicit retryable error — Phase 3 item 3, closing Ops Alerts' old silent-blank-render gap. */
  function withLoadingState(containerEl, loaderFn) {
    var timedOut = false;
    containerEl.innerHTML = '<div class="ops-loading"><div class="ops-spinner"></div>Loading…</div>';
    var timer = setTimeout(function () {
      timedOut = true;
      containerEl.innerHTML = '<div class="ops-loading-error">Couldn\'t load — this took longer than expected.<br><button class="ops-btn-secondary" id="ops-shell-retry">Try again</button></div>';
      var retryBtn = document.getElementById('ops-shell-retry');
      if (retryBtn) retryBtn.addEventListener('click', function () { withLoadingState(containerEl, loaderFn); });
    }, LOADING_TIMEOUT_MS);

    loaderFn().then(function () {
      if (timedOut) return; // timeout already rendered the retry state; a late-arriving success just gets ignored, staff already clicked Try again or will
      clearTimeout(timer);
    }).catch(function () {
      if (timedOut) return;
      clearTimeout(timer);
      containerEl.innerHTML = '<div class="ops-loading-error">Couldn\'t load — something went wrong.<br><button class="ops-btn-secondary" id="ops-shell-retry">Try again</button></div>';
      var retryBtn = document.getElementById('ops-shell-retry');
      if (retryBtn) retryBtn.addEventListener('click', function () { withLoadingState(containerEl, loaderFn); });
    });
  }

  /**
   * Full boot sequence: session check -> redirect to login if absent,
   * otherwise paints the sidebar/topbar/search bar and calls onReady(email).
   * `opts.activeHref` picks the highlighted nav item; `opts.title` and
   * `opts.subtitle` fill the topbar; `opts.searchPlaceholder` is optional.
   */
  function boot(opts) {
    var sidebarEl = document.getElementById('ops-sidebar');
    var titleEl = document.getElementById('ops-title');
    var subtitleEl = document.getElementById('ops-subtitle');
    var searchContainer = document.getElementById('ops-search-container');
    if (sidebarEl) sidebarEl.innerHTML = sidebarHtml(opts.activeHref);
    if (titleEl) titleEl.textContent = opts.title || '';
    if (subtitleEl) subtitleEl.textContent = opts.subtitle || '';
    if (searchContainer) {
      searchContainer.innerHTML = searchBarHtml(opts.searchPlaceholder);
      wireSearchBar();
    }

    fetch('/api/ops-auth', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'check' }) })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) { window.location.href = 'ops-login.html'; return; }
        var emailEl = document.getElementById('user-email');
        if (emailEl) emailEl.textContent = result.data.email;
        var loadingGate = document.getElementById('loading-gate');
        var appShell = document.getElementById('app-shell');
        if (loadingGate) loadingGate.classList.add('hidden');
        if (appShell) appShell.classList.remove('hidden');
        var signoutBtn = document.getElementById('signout-btn');
        if (signoutBtn) {
          signoutBtn.addEventListener('click', function () {
            fetch('/api/ops-auth', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) })
              .then(function () { window.location.href = 'ops-login.html'; });
          });
        }
        if (opts.onReady) opts.onReady(result.data.email);
      })
      .catch(function () { window.location.href = 'ops-login.html'; });
  }

  return {
    escapeHtml: escapeHtml,
    opsCall: opsCall,
    sidebarHtml: sidebarHtml,
    searchBarHtml: searchBarHtml,
    wireSearchBar: wireSearchBar,
    withLoadingState: withLoadingState,
    boot: boot,
    cancellationReasonLabel: cancellationReasonLabel,
    NAV_ITEMS: NAV_ITEMS,
  };
})();
