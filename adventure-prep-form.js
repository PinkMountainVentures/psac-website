/* ============================================
   PSAC — Adventure Prep, Surface A ("Finish setting up your adventure")
   Vanilla JS, no deps, same convention as adventure-form.js. Drives
   /complete-adventure-prep against the adventurePrepToken in the URL.

   Built against claude/psac-adventure-prep-jtbd-prd-v1.md and the two
   confirmed mockups (psac-surface-a-06-trail-reveal.html,
   psac-surface-a-remaining-steps.html, psac-surface-a-cancelled-
   reservation.html). Every write goes through this repo's own thin
   api/*.js wrappers (get-adventure-prep, save-adventure-prep,
   run-trail-assignment, select-trail, save-waiver-signature,
   save-emergency-contact, send-signer-links) — this file never calls the
   Apps Script webapp or the Trail Selection engine directly.

   ============================================================================
   FLAGGED FOR AIREY — two things the PRD (Section 8) left open on purpose,
   this build's own answers, not silently invented:
   ============================================================================

   1. "Confirm which roster row is you" — implemented as a tap-to-select
      list folded into the top of the roster-reconfirmation step (matching
      the mockup), storing the SELECTED ROW'S ARRAY INDEX (stringified,
      e.g. "0") into adventurePrep.participatingRosterRef. "None of these
      are me" stores '' and leaves isParticipating's own yes/no answer as
      the only participation signal. This assumes reconfirmedRosterJson's
      array order stays stable within a session, true since only this
      page ever writes it. If a future edit ever reorders that array
      independent of this flow, participatingRosterRef would need to
      become a stabler identifier than a positional index — flagged here
      rather than solved speculatively.

   2. Non-owner adult email collection needed a place to live. Rather than
      a separate field/table, each roster entry in reconfirmedRosterJson
      optionally carries its own `email` property (adults only, never
      collected for a minor), read back out at Step 10 (Review & Send) to
      build the signer list api/send-signer-links.js emails. Simpler than
      a parallel array that has to stay in sync with the roster by index.

   Both are real product decisions, not just implementation details —
   confirm or redirect before this ships.
   ============================================================================ */

(function () {
  'use strict';

  var qs = new URLSearchParams(window.location.search);
  var TOKEN = qs.get('token') || '';
  var root = document.getElementById('ap-root');

  var BEST_FOR_ATTRIBUTES_OPTIONS = [
    'Big views', 'Solitude and quiet', 'Physical challenge', 'Wildlife and nature',
    'Interesting geology', 'Water (streams, pools, falls)', 'Photography opportunities',
    'Learning about the place', 'Moving fast', 'Moving slow and taking it all in',
  ];
  var TECHNICAL_COMFORT_OPTIONS = [
    { value: 'wide_easy_underfoot', label: 'Wide, easy-underfoot trail' },
    { value: 'some_rock_uneven_ground_fine', label: 'Some rock and uneven ground is fine' },
    { value: 'comfortable_scrambling_route_finding', label: 'Comfortable scrambling and route-finding' },
  ];
  var HEAT_COMFORT_OPTIONS = [
    { value: 'prefers_shade_or_cooler_start', label: 'I’d rather have shade, or an early, cooler start' },
    { value: 'heat_doesnt_slow_me_down', label: 'Heat doesn’t slow me down' },
  ];
  // BUG FIX (Aug 2026, independent bug pass): these bucket strings used
  // ASCII hyphens ('14-17', '18-24', ...), but adventure-form.js's roster
  // step (the only place these values actually get written) generates
  // them with an EN DASH ('14–17', U+2013), not a hyphen (U+002D) — see
  // adventure-form.js's cardWho(), the age <select> option values. Every
  // bucket past "Under 14" silently never matched here, so
  // MINOR_BUCKETS['14–17'] was always undefined: a real 14-17-year-old on
  // the roster was never recognized as a minor anywhere in this file (the
  // review screen would try to send them their own waiver-signer link
  // instead of covering them under the owner's guardian certification).
  // Same bug class apps-script/trail-swap-actions.gs's own header comment
  // already documents fixing in its local copy of an equivalent check —
  // this is the same fix, plus the matching one applied to
  // apps-script/adventure-prep-actions.gs's getSignerContext minors filter
  // and lib/trail-selection-engine.js's family-tier eligibility check,
  // which had the identical mismatch.
  var AGE_BUCKETS = ['Under 14', '14–17', '18–24', '25–34', '35–44', '45–54', '55–64', '65+'];
  var MINOR_BUCKETS = { 'Under 14': true, '14–17': true };
  // Matches adventure-form.js's roster step exactly (the only place these
  // get written). Previously held short labels ('Easygoing'/'Comfortable'/
  // 'Strong') that don't match any value this system actually stores —
  // corrected to the real stored strings so the editable fitness dropdown
  // below (rosterRowHtml) round-trips correctly against existing data.
  var FITNESS_OPTIONS = ['Easygoing pace', 'Comfortable hiker', 'Strong / experienced'];

  var state = {
    ctx: null,
    step: 'hub',
    // Working copies the guest edits before each step's own save call.
    roster: [],
    isParticipating: null,
    participatingRosterRef: '',
    bestForAttributes: [],
    technicalComfort: null,
    heatComfort: null,
    propertyType: null,
    deliveryAddressLine1: '',
    deliveryCity: '',
    deliveryState: '',
    deliveryZip: '',
    deliveryWindow: '7:00pm – 9:00pm',
    returnPreference: 'We’ll drop it back off ourselves',
    deliveryNote: '',
    returnSameAsDelivery: true,
    returnAddressLine1: '',
    returnLocation: null,
    returnWindow: null,
    returnNote: '',
    gearStep: 0, // 0 kit toggle | 1 delivery | 2 pickup — Round 2 (mockup-04) split of the old single-screen gear/delivery form
    waiverName: '',
    waiverAgreed: false,
    guardianForChildren: [],
    ecName: '',
    ecPhone: '',
    prefStep: 0, // 0 | 1 | 2 — which of the 3 Trail Recommendation question screens (Round 2, handoff Section 2: "Each question screen gets a step progress bar...")
    trailAssignmentPhase: 'idle', // idle | justChosen — 'justChosen' shows the one-time "[Trail] it is." confirmation instead of the Change Your Trail re-entry screen
    forceTrailRefresh: false, // set true by "Answer the questions differently" so loadCandidates() re-runs the engine (operation:'refresh') instead of reusing the existing candidateTrails
    busy: false,
    error: '',
  };

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function h(html) {
    var d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstElementChild;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function apiGet(path) {
    return fetch(path).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        return { ok: r.ok, status: r.status, body: body };
      });
    });
  }

  function apiPost(path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        return { ok: r.ok, status: r.status, body: body };
      });
    });
  }

  function saveFields(fields) {
    return apiPost('/api/adventure-prep', { action: 'saveFields', token: TOKEN, fields: fields }).then(function (res) {
      // BUG FIX (coordinating-session review, Aug 2026, live-reported): this
      // used to only POST — it never touched state.ctx.adventurePrep, which
      // is fetched from the server exactly once, in boot(). Since goHub()
      // (Trail, Gear Kits, Waivers) only flips state.step and re-renders
      // the SAME in-memory state.ctx, computeHubStatus() kept reading
      // whatever it read at page load, so a tile you'd just completed
      // (e.g. Attendees, once Gear Kits/Trail were already done from an
      // earlier visit) kept showing "Not done" on the hub until a full
      // page reload re-fetched context from the server. Mirroring every
      // successfully-saved field into the local state.ctx.adventurePrep
      // here fixes every hub tile at once, matching the hub model's own
      // "always current" premise, without adding an extra round trip.
      if (res.ok && state.ctx) {
        state.ctx.adventurePrep = state.ctx.adventurePrep || {};
        Object.keys(fields).forEach(function (k) { state.ctx.adventurePrep[k] = fields[k]; });
      }
      return res;
    });
  }

  // ---------------------------------------------------------------------
  // T-3, 10pm Pacific cutoff — browser-side copy of lib/t3-cutoff.js's
  // exact algorithm. Duplicated deliberately (a static HTML/JS page can't
  // require() a server-side lib file); see that file's own header for the
  // "no canonical helper exists yet" flag, which applies equally here.
  // ---------------------------------------------------------------------

  function pacificOffsetMinutes(utcInstant) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    var parts = {};
    dtf.formatToParts(utcInstant).forEach(function (p) { parts[p.type] = p.value; });
    var asIfUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) === 24 ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    return (asIfUtc - utcInstant.getTime()) / 60000;
  }

  function computeT3CutoffDate(tripDateStr) {
    var m = String(tripDateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var threeBack = new Date(Date.UTC(y, mo - 1, d) - 3 * 86400000);
    var cy = threeBack.getUTCFullYear(), cm = threeBack.getUTCMonth(), cd = threeBack.getUTCDate();
    var guess = new Date(Date.UTC(cy, cm, cd, 22, 0, 0) + 8 * 3600000);
    var offset = pacificOffsetMinutes(guess);
    return new Date(Date.UTC(cy, cm, cd, 22, 0, 0) - offset * 60000);
  }

  function isPastT3Cutoff() {
    var d = state.ctx && state.ctx.experienceBooking && state.ctx.experienceBooking.date;
    var cutoff = computeT3CutoffDate(d);
    return !!cutoff && new Date() >= cutoff;
  }

  function formatCutoffLabel() {
    var d = state.ctx && state.ctx.experienceBooking && state.ctx.experienceBooking.date;
    var cutoff = computeT3CutoffDate(d);
    if (!cutoff) return 'soon';
    var display = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric',
    }).format(cutoff);
    return '10:00pm Pacific on ' + display;
  }

  function formatTripDate(dateStr) {
    var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return 'your trail day';
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(d);
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  function boot() {
    if (!TOKEN) {
      renderMessage('This link isn’t quite right', 'We couldn’t find an adventure to set up here. If you followed a link from your confirmation email, try copying and pasting the full address, or reply to that email and we’ll send you a fresh one.');
      return;
    }
    apiGet('/api/adventure-prep?token=' + encodeURIComponent(TOKEN)).then(function (res) {
      if (!res.ok) {
        renderMessage('This link isn’t quite right', 'We couldn’t find an adventure for this link. Reply to your confirmation email and we’ll send you a fresh one.');
        return;
      }
      state.ctx = res.body;
      var status = res.body.experienceBooking && res.body.experienceBooking.bookingStatus;
      if (status && status !== 'active') {
        renderCancelled();
        return;
      }
      hydrateWorkingStateFromCtx();
      state.step = 'hub';
      render();
    });
  }

  function hydrateWorkingStateFromCtx() {
    var ap = state.ctx.adventurePrep || {};
    var fullPayload = {};
    try { fullPayload = JSON.parse(state.ctx.experienceBooking.fullPayloadJson || '{}'); } catch (e) { fullPayload = {}; }

    try {
      state.roster = ap.reconfirmedRosterJson ? JSON.parse(ap.reconfirmedRosterJson) : (fullPayload.roster || []);
    } catch (e) { state.roster = fullPayload.roster || []; }
    if (!Array.isArray(state.roster)) state.roster = [];

    state.isParticipating = ap.isParticipating === true || ap.isParticipating === 'true' ? true
      : (ap.isParticipating === false || ap.isParticipating === 'false' ? false : null);
    state.participatingRosterRef = ap.participatingRosterRef != null ? String(ap.participatingRosterRef) : '';
    state.bestForAttributes = ap.bestForAttributes ? String(ap.bestForAttributes).split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    state.technicalComfort = ap.technicalComfort || null;
    state.heatComfort = ap.heatComfort || null;
    state.propertyType = ap.propertyType || null;
    state.deliveryAddressLine1 = ap.deliveryAddressLine1 || '';
    state.deliveryCity = ap.deliveryCity || '';
    state.deliveryState = ap.deliveryState || '';
    state.deliveryZip = ap.deliveryZip || '';
    state.deliveryWindow = ap.deliveryWindow || state.deliveryWindow;
    state.returnPreference = ap.returnPreference || state.returnPreference;
    state.deliveryNote = ap.deliveryNote || '';
    state.returnSameAsDelivery = ap.returnSameAsDelivery === 'false' ? false : true;
    state.returnAddressLine1 = ap.returnAddressLine1 || '';
    state.returnLocation = ap.returnLocation || null;
    state.returnWindow = ap.returnWindow || null;
    state.returnNote = ap.returnNote || '';
  }

  // ---------------------------------------------------------------------
  // Render dispatch
  // ---------------------------------------------------------------------

  function render() {
    root.innerHTML = '';
    var frag;
    switch (state.step) {
      case 'hub': frag = renderHub(); break;
      case 'roster': frag = renderRoster(); break;
      case 'invite': frag = renderInvite(); break;
      case 'preferences': frag = renderPreferences(); break;
      case 'trail': frag = renderTrail(); break;
      case 'planning': frag = renderPlanning(); break;
      case 'waiver': frag = renderWaiver(); break;
      case 'summary': frag = renderSummary(); break;
      case 'waiverDetail': frag = renderWaiverDetail(); break;
      default: frag = renderHub();
    }
    root.appendChild(frag);
    // Cross-cutting styling item (handoff Section 10): every top-level step
    // change lands the guest at the top of the screen instead of wherever
    // they'd scrolled to on the previous one. NOTE: this only covers
    // top-level state.step changes (hub <-> each flow). The Trail
    // Recommendation, Gear Kits, and Waivers flows also swap #ap-*-content
    // internally (via contentEl.innerHTML) for their own sub-screens
    // without going through this function again, so a guest who scrolls
    // deep into e.g. the Waiver agreement text and then taps through to
    // the next sub-screen keeps their prior scroll position there. Flagging
    // this as a known remaining gap rather than silently claiming full
    // coverage — closing it means touching every internal contentEl.innerHTML
    // call site across three flows, which wasn't done here to avoid
    // re-touching already-smoke-tested code this late without re-running
    // every scenario.
    if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0);
  }

  function progressBar(sectionIndex, pct) {
    var sections = ['Your Adventure', 'Trail &amp; Prep', 'Your Kit'];
    var labels = sections.map(function (s, i) {
      return '<span class="ap-progress-section' + (i === sectionIndex ? ' is-active' : '') + '">' + s + '</span>';
    }).join('');
    return '<div class="ap-progress-bar"><div class="ap-progress-fill" style="width:' + pct + '%;"></div></div>' +
      '<div class="ap-progress-labels">' + labels + '</div>';
  }

  function renderMessage(title, body) {
    root.innerHTML = '';
    root.appendChild(h(
      '<div class="container"><div class="ap-card" style="text-align:center; max-width:520px; margin:0 auto; padding:3rem 2.2rem;">' +
      '<h1 class="ap-q" style="font-size:1.5rem;">' + escapeHtml(title) + '</h1>' +
      '<p class="ap-sub" style="margin:0 auto;">' + body + '</p>' +
      '</div></div>'
    ));
  }

  // ---------------------------------------------------------------------
  // Cancelled reservation (real marketing header/footer, own layout —
  // matches psac-surface-a-cancelled-reservation.html exactly)
  // ---------------------------------------------------------------------

  function renderCancelled() {
    var eb = state.ctx.experienceBooking;
    var reasons = eb.cancellationReasons;
    try { reasons = typeof reasons === 'string' ? JSON.parse(reasons) : reasons; } catch (e) { /* leave as-is */ }
    reasons = Array.isArray(reasons) ? reasons : (reasons ? [reasons] : []);

    var reasonPhrase = 'the adventure details we need';
    if (reasons.indexOf('zero_waivers') !== -1) reasonPhrase = 'your waiver signed';
    else if (reasons.indexOf('no_address') !== -1) reasonPhrase = 'a delivery address on file';
    else if (reasons.indexOf('hold_never_cleared') !== -1) reasonPhrase = 'your gear hold cleared in time';
    else if (reasons.indexOf('no_1.2a') !== -1) reasonPhrase = 'the adventure details we need';

    document.querySelector('header.ap-header') && document.querySelector('header.ap-header').remove();

    var refundAmount = eb.refundAmount != null ? '$' + Number(eb.refundAmount).toFixed(2) : 'in full';
    var cancelledAt = eb.cancelledAt ? new Date(eb.cancelledAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';

    document.body.insertAdjacentHTML('afterbegin',
      '<header class="site-header"><div class="container"><nav>' +
      '<a href="/" class="logo">Palm Springs Adventure Club</a>' +
      '<ul class="nav-links"><li><a href="/peaks-to-pools">Peaks to Pools</a></li><li><a href="/membership">The Club</a></li>' +
      '<li><a href="/how-it-works">How It Works</a></li><li><a href="#" class="nav-cta start-adventure-btn">Start My Adventure</a></li></ul>' +
      '</nav></div></header>'
    );

    root.className = '';
    root.innerHTML = '';
    root.appendChild(h(
      '<div class="cancel-shell"><div class="container"><div class="cancel-card">' +
      '<div class="cancel-badge"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5L9.5 17L19 7" stroke="#4a9d68" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
      '<h1 class="cancel-headline">This reservation has been cancelled</h1>' +
      '<p class="cancel-body">We weren’t able to get <strong>' + escapeHtml(reasonPhrase) + '</strong> in time to plan your trail day, so this reservation was cancelled. A refund has already been issued to the card on file, there’s nothing further owed on either side.</p>' +
      '<div class="cancel-detail">' +
      '<div class="cancel-detail-row"><span>Refund issued</span><span>' + escapeHtml(refundAmount) + '</span></div>' +
      (cancelledAt ? '<div class="cancel-detail-row"><span>Date</span><span>' + escapeHtml(cancelledAt) + '</span></div>' : '') +
      '<div class="cancel-detail-row"><span>Back in your account</span><span>5–10 business days</span></div>' +
      '</div>' +
      '<div class="cancel-ctas"><a href="#" class="btn start-adventure-btn">Book Again</a><a href="mailto:hello@palmspringsadventureclub.com" class="btn-outline">Contact Us</a></div>' +
      '<p class="cancel-footnote">Nothing further is needed from you. This reservation is fully closed out.</p>' +
      '</div></div></div>'
    ));

    document.body.insertAdjacentHTML('beforeend',
      '<footer class="site-footer"><div class="container"><div class="footer-content">' +
      '<div class="footer-column"><h3>Palm Springs Adventure Club</h3><p>Operated by Pink Mountain Ventures LLC, DBA Palm Springs Adventure Club<br>301 N Palm Canyon Drive, Suite 103179<br>Palm Springs, CA 92262<br><br>hello@palmspringsadventureclub.com</p></div>' +
      '<div class="footer-column"><h3>Explore</h3><ul><li><a href="/peaks-to-pools">Peaks to Pools</a></li><li><a href="/membership">The Club</a></li><li><a href="/how-it-works">How It Works</a></li></ul></div>' +
      '<div class="footer-column"><h3>Policies</h3><ul><li><a href="/refund-policy">Cancellation &amp; Refund Policy</a></li><li><a href="/terms">Terms of Service</a></li><li><a href="/privacy">Privacy Policy</a></li></ul></div>' +
      '<div class="footer-column"><h3>Connect</h3><div class="social-links"><a href="#">IG</a></div></div>' +
      '</div><div class="footer-tagline"><p>Peaks to Pools. Earn your peace.</p></div>' +
      '<div class="footer-bottom"><p>&copy; 2026 Palm Springs Adventure Club &nbsp;·&nbsp; Pink Mountain Ventures LLC &nbsp;·&nbsp; All Rights Reserved</p></div></div></footer>'
    );

    // adventure-form.js (already loaded on every page site-wide) wires up
    // .start-adventure-btn itself once the DOM has the elements — no
    // separate script include needed here beyond what index.html already
    // loads globally. FLAGGED: this static page does NOT currently load
    // adventure-form.js/Stripe.js the way index.html does, so "Start My
    // Adventure"/"Book Again" will render but not open the booking modal
    // until those two script tags are added here — a one-line follow-up,
    // called out in the handoff rather than silently left broken.
  }

  // ---------------------------------------------------------------------
  // Adventure Home — the hub (Round 2 redesign, handoff Section 1).
  // Replaces the old one-time "Landing" checklist screen entirely: this is
  // now the FIRST thing a guest sees, and everyone returns here after every
  // action instead of auto-advancing through a fixed linear order. Each
  // tile below routes to the same step-render functions that existed
  // before this redesign — those functions are what changed (see each
  // one's own comments), not the overall inventory of screens.
  // ---------------------------------------------------------------------

  // Only "Under 14" is excluded from gear rental (handoff Section 4: "Gear
  // rental restricted to age 14+ ... matches Section 6A of the waiver
  // draft" — 14-17 IS allowed a kit, only Under 14 is not).
  function isGearEligible(person) {
    return (person.age || person.ageRange || '') !== 'Under 14';
  }

  /**
   * Builds the per-signer status list used by both the hub's Waivers tile
   * sublabel ("3 of 4 signed") and the Adventure Summary waiver-detail
   * screen (handoff Section 6, frame 3 — "a tappable, per-person
   * breakdown," a genuinely new capability, the live code before this
   * redesign only ever tracked the current viewer's own status).
   *
   * FLAGGED — guardian-to-child assignment (Section 9 item 1) isn't a real,
   * separate data structure yet (no dedicated guardian-assignment UI exists
   * in this build; that's still open, see Confirm Attendees' own header
   * comment below). Until that lands, a minor's guardian is inferred here
   * from waiverSignatures.participantsCoveredJson — whichever signer's
   * covered-participants list already contains the minor's name — which
   * only works once someone has actually signed covering them. Before
   * that, a minor shows as "Needs a signing guardian" with no further
   * action available from this screen, which is honest about the gap
   * rather than guessing who it should be.
   */
  function waiverSigners() {
    var signatures = state.ctx.waiverSignatures || [];
    var ownerIdx = state.participatingRosterRef === '' || state.participatingRosterRef === 'none'
      ? -1 : Number(state.participatingRosterRef);
    return state.roster.map(function (p, i) {
      var age = p.age || p.ageRange || '';
      var isMinor = !!MINOR_BUCKETS[age];
      var isOwner = i === ownerIdx;
      var name = p.name || (isOwner ? 'You' : 'Unnamed');
      if (isMinor) {
        var coveringSig = signatures.filter(function (w) {
          var covered = [];
          try { covered = JSON.parse(w.participantsCoveredJson || '[]'); } catch (e) { covered = []; }
          return covered.indexOf(p.name) !== -1;
        })[0];
        return {
          index: i, name: name, isOwner: false, isMinor: true,
          isDone: !!coveringSig,
          subLabel: coveringSig ? ('Signed by ' + (coveringSig.signerName || 'their guardian') + ', guardian') : 'Needs a signing guardian assigned',
          canRemind: false,
        };
      }
      var sig = isOwner
        ? signatures.filter(function (w) { return w.role === 'owner'; })[0]
        : signatures.filter(function (w) { return String(w.rosterRef) === String(i); })[0];
      var isDone = !!sig && sig.status === 'signed';
      return {
        index: i, name: name, isOwner: isOwner, isMinor: false,
        isDone: isDone,
        subLabel: isDone ? 'Signed' : (sig ? 'Not yet' : (isOwner ? 'Not yet' : 'Not yet invited')),
        canRemind: !isDone && !isOwner && !!sig && !!p.email,
        email: p.email || '',
      };
    });
  }

  function computeHubStatus() {
    var ap = state.ctx.adventurePrep || {};
    var candidateTrails = ap.candidateTrails;
    try { candidateTrails = typeof candidateTrails === 'string' ? JSON.parse(candidateTrails || '[]') : (candidateTrails || []); } catch (e) { candidateTrails = []; }
    var hasUnreviewedManualPick = candidateTrails.some(function (c) { return c.source === 'manual_override' && c.trailId !== ap.selectedTrailId; });
    var rosterDone = !!ap.reconfirmedRosterJson;
    var gearDone = !!ap.propertyType && !!ap.deliveryAddressLine1;
    var signers = state.roster.length ? waiverSigners() : [];
    var waiversDone = signers.length > 0 && signers.every(function (s) { return s.isDone; });
    // BUG FIX (coordinating-session review, Aug 2026): this was the only one
    // of this file's three kitCount computations missing the
    // isGearEligible() filter (the Gear Kits screen itself and its own
    // confirmation recap both correctly gate on it — see draw() and
    // renderConfirmation() below). An "Under 14" roster member whose
    // gearKit field happens not to be exactly `false` (e.g. unset/default)
    // was getting counted here even though they're ineligible and no kit
    // ever ships for them, so the hub tile and Adventure Summary's kit
    // stats didn't match the real count from the Gear Kits screen.
    var eligibleCount = state.roster.filter(isGearEligible).length;
    var kitCount = state.roster.filter(function (p) { return isGearEligible(p) && p.gearKit !== false; }).length;
    return {
      trailSelected: !!ap.selectedTrailId,
      trailName: (candidateTrails.filter(function (c) { return c.trailId === ap.selectedTrailId; })[0] || {}).trailName || '',
      hasUnreviewedManualPick: hasUnreviewedManualPick,
      rosterDone: rosterDone,
      gearDone: gearDone,
      kitCount: kitCount,
      eligibleCount: eligibleCount,
      signers: signers,
      waiversDone: waiversDone,
      // FLAGGED, judgment call: the mockups don't fully reconcile the hub
      // tile's "Locked — unlocks once everything above is set" copy with
      // Adventure Summary's own "still finishing up" state (handoff
      // Section 6, frame 2), which deliberately shows an incomplete trail/
      // gear/waiver picture. Gating on 100% waiver completion would leave
      // Summary locked for most of a real trip's prep window, since
      // guests rarely all sign at once — so this unlocks on minimal real
      // engagement (roster reconfirmed) instead, with every other line
      // falling back to "To be confirmed" / "Not set yet" exactly as
      // mockup 06 frame 2 shows. Confirm this threshold if it should be
      // stricter.
      summaryUnlocked: rosterDone,
    };
  }

  function renderHub() {
    var eb = state.ctx.experienceBooking;
    var ap = state.ctx.adventurePrep || {};
    var status = computeHubStatus();
    var firstName = (eb.contactName || 'there').split(' ')[0];
    var depositAmount = eb.tier === 'p2p' ? 100 : 65;

    var pastT3 = status.trailSelected && isPastT3Cutoff();
    var trailSectionHtml = !status.trailSelected ? '' :
      '<div class="ap-trail-section"><div class="ap-trail-photo"><div class="ap-trail-photo-label">Trail photo</div></div>' +
      '<div class="ap-trail-body"><div class="ap-trail-eyebrow">Your Trail</div><div class="ap-trail-name">' + escapeHtml(status.trailName) + '</div>' +
      (pastT3
        ? '<div class="ap-trail-unlocked"><div class="ap-trail-unlocked-text">Your guide is ready: turn-by-turn navigation, waypoints, and everything else for the trail.</div><button type="button" class="ap-trail-download-btn" id="ap-get-guide">Get Guide</button></div>'
        : '<div class="ap-trail-locked-note"><span class="lock-icon">🔒</span> Your trail guide and turn-by-turn navigation unlock 3 days before your adventure day.</div>') +
      '</div></div>';

    function tile(icon, title, sub, status2, locked, onClick) {
      return { icon: icon, title: title, sub: sub, statusLabel: status2, locked: !!locked, onClick: onClick };
    }

    var tiles = [
      tile('🧭', 'Trail Recommendation',
        status.trailSelected ? status.trailName : 'Tell us what you’re after and we’ll find your trail',
        status.hasUnreviewedManualPick ? 'In review' : (status.trailSelected ? 'Done' : 'Not done'),
        false, function () { state.step = status.trailSelected ? 'trail' : 'preferences'; render(); }),
      tile('👥', 'Attendees',
        status.rosterDone ? (state.roster.length + ' in your group') : 'Confirm who’s coming and invite your group',
        status.rosterDone ? 'Done' : 'Not done', false,
        function () { state.step = 'roster'; render(); }),
      tile('🎒', 'Gear Kits &amp; Delivery/Pickup',
        status.gearDone ? (status.kitCount + ' kits · Gear delivery ' + (ap.deliveryWindow || state.deliveryWindow)) : 'Choose your kits and delivery details',
        status.gearDone ? 'Done' : 'Not done', false,
        function () { state.step = 'planning'; render(); }),
      tile('✍️', 'Waivers',
        status.signers.length ? (status.signers.filter(function (s) { return s.isDone; }).length + ' of ' + status.signers.length + ' signed') : 'Sign your waiver',
        status.waiversDone ? 'Done' : 'Not done', false,
        function () { state.step = 'waiver'; render(); }),
      tile('📋', 'Adventure Summary',
        status.summaryUnlocked ? 'See your full recap' : 'Unlocks once everything above is set',
        status.summaryUnlocked ? 'Done' : 'Locked', !status.summaryUnlocked,
        function () { if (status.summaryUnlocked) { state.step = 'summary'; render(); } }),
    ];

    var tilesHtml = tiles.map(function (t, i) {
      var statusClass = t.statusLabel === 'Done' ? 'status-done' : t.statusLabel === 'In review' ? 'status-review' : t.statusLabel === 'Locked' ? 'status-locked' : 'status-notdone';
      return '<div class="ap-tile' + (t.locked ? ' locked' : '') + '" data-tile="' + i + '">' +
        '<div class="ap-tile-icon">' + t.icon + '</div>' +
        '<div class="ap-tile-mid"><div class="ap-tile-title">' + t.title + '</div><div class="ap-tile-sub">' + escapeHtml(t.sub) + '</div></div>' +
        '<div class="ap-tile-status ' + statusClass + '">' + t.statusLabel + '</div>' +
        '</div>';
    }).join('');

    var alertHtml = '';
    if (status.rosterDone && !status.waiversDone && status.signers.length) {
      var missingCount = status.signers.filter(function (s) { return !s.isDone; }).length;
      alertHtml = '<div class="ap-alert"><div class="ap-alert-icon">!</div><div class="ap-alert-text"><b>Waivers lock at ' + formatCutoffLabel() + '.</b> ' + missingCount + ' ' + (missingCount === 1 ? 'person on your list hasn’t' : 'people on your list haven’t') + ' signed yet.</div></div>';
    }

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-eyebrow">Your Adventure</div>' +
      '<div class="ap-greeting">Hi ' + escapeHtml(firstName) + ', your trail day is ' + formatTripDate(eb.date) + '.</div>' +
      '<div class="ap-subline"></div>' +
      alertHtml +
      trailSectionHtml +
      '<div class="ap-tiles-label">Get ready</div>' +
      '<div class="ap-tiles" id="ap-hub-tiles">' + tilesHtml + '</div>' +
      '<div class="ap-deposit-note">One more thing: a <b>$' + depositAmount + ' refundable gear deposit hold</b> gets placed on your card the day before your adventure day (the day your gear arrives). We’ll let you know right before it happens.</div>' +
      '</div></div>'
    );

    Array.prototype.forEach.call(wrap.querySelectorAll('.ap-tile:not(.locked)'), function (el) {
      el.addEventListener('click', function () {
        var t = tiles[Number(el.getAttribute('data-tile'))];
        if (t && t.onClick) t.onClick();
      });
    });
    var guideBtn = wrap.querySelector('#ap-get-guide');
    if (guideBtn) guideBtn.addEventListener('click', function () {
      window.open((ap.rideWithGpsExperienceAccess && ap.rideWithGpsExperienceAccess.url) || 'https://ridewithgps.com/', '_blank');
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Are you joining? + roster reconfirmation + gear kit toggle
  // ---------------------------------------------------------------------

  // BUG FIX (Aug 2026): name/age/fitness used to render as permanently
  // `disabled` inputs, with a "email us to change this" note as the only
  // way to correct a typo or an age bucket picked wrong at booking time.
  // Airey's call: these should be editable right here. Name stays a plain
  // text input (updates on 'input', no re-render, same as the email field
  // below, so typing doesn't lose focus). Age is a <select> — changing it
  // can flip isMinor (which changes whether the email field or the
  // "Minor" tag renders at all), so its 'change' handler re-runs
  // renderRosterRows() to rebuild the row correctly; a <select> has no
  // cursor position to lose, so that's safe. Fitness is also a <select>,
  // doesn't affect layout, so it just updates state.
  function rosterRowHtml(person, index, isOwnerRow) {
    var age = person.age || person.ageRange || '';
    var isMinor = !!MINOR_BUCKETS[age];
    var emailField = (!isMinor && !isOwnerRow)
      ? '<input class="ap-roster-email" data-idx="' + index + '" type="email" placeholder="' + escapeHtml((person.name || 'Their') + '’s email, for their waiver link') + '" value="' + escapeHtml(person.email || '') + '" style="flex:2; min-width:180px; border:1px solid rgba(42,71,71,0.18); border-radius:6px; padding:0.6rem 0.7rem; background:var(--sand-beige); color:var(--dark-pine); font-family:inherit; font-size:0.82rem;">'
      : '';
    // Unlike adventure-form.js's own age <select> (which prepends a
    // non-selectable "Age range" placeholder), every entry in AGE_BUCKETS
    // is itself a real, selectable value — no placeholder needed here.
    var ageOptionsHtml = AGE_BUCKETS.map(function (bucket) {
      return '<option value="' + escapeHtml(bucket) + '"' + (age === bucket ? ' selected' : '') + '>' + escapeHtml(bucket) + '</option>';
    }).join('');
    var fitnessOptionsHtml = '<option value="">Fitness level</option>' + FITNESS_OPTIONS.map(function (f) {
      return '<option value="' + escapeHtml(f) + '"' + ((person.fitness || '') === f ? ' selected' : '') + '>' + escapeHtml(f) + '</option>';
    }).join('');
    return '<div class="paf-roster-row">' +
      '<input class="paf-roster-input paf-roster-name" data-idx="' + index + '" value="' + escapeHtml(person.name || '') + '" placeholder="Name">' +
      '<select class="paf-roster-input paf-roster-age" data-idx="' + index + '">' + ageOptionsHtml + '</select>' +
      (isMinor ? '<span class="paf-roster-tag">Minor</span>' : '<select class="paf-roster-input paf-roster-fit" data-idx="' + index + '">' + fitnessOptionsHtml + '</select>') +
      (isOwnerRow ? '<span class="paf-roster-tag is-you">You</span>' : emailField) +
      '</div>';
  }

  function renderRoster() {
    // BUG FIX (coordinating-session review, Aug 2026): this screen still had
    // the pre-redesign fixed 3-section progressBar(0, 14) header and a
    // Back/Continue bottom-nav pair, left over from the old linear wizard —
    // every sibling screen in this file was already converted to the
    // flow-top back-link + "Save & return to Adventure Home" pattern as
    // part of this same rewrite, this one screen was just missed. Fixed to
    // match, wired to the same state.step = 'hub' / saveFields() pattern
    // every other screen in this file already uses.
    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      '<div class="ap-flow-top"><div class="ap-back-link" id="ap-flow-back" style="cursor:pointer; margin-bottom:0;">&larr; Adventure Home</div><div></div></div>' +
      '<div class="ap-eyebrow">Your Adventure</div>' +
      '<h1 class="ap-q">Will you be out on the trail with them?</h1>' +
      '<p class="ap-sub">We ask everyone this directly, booking for a group doesn’t always mean joining it.</p>' +
      '<div class="ap-card">' +
      '<div class="paf-options" id="ap-joining-opts">' +
      '<button type="button" class="paf-option-btn" data-val="yes">Yes, I’m joining the adventure</button>' +
      '<button type="button" class="paf-option-btn" data-val="no">No, I’m just setting this up for the group</button>' +
      '</div>' +
      '<div class="paf-roster" id="ap-whoisyou-wrap" style="display:none;">' +
      '<div class="paf-roster-sub">Which one of these is you?</div>' +
      '<div class="paf-options" id="ap-whoisyou-opts"></div>' +
      '</div>' +
      '<div class="paf-roster" style="margin-top:1.6rem;">' +
      '<div class="paf-roster-sub">Your group</div>' +
      '<div id="ap-roster-rows"></div>' +
      '<div class="ap-helper" style="margin:0.4rem 0 1.2rem;">Need to add or remove someone? <a href="mailto:hello@palmspringsadventureclub.com" style="color:var(--mountain-pink);">Email us</a> and we’ll help you update it.</div>' +
      '</div>' +
      '<div id="ap-roster-error" class="ap-error"></div>' +
      '</div>' +
      '<button type="button" class="ap-cta-primary" id="ap-next">Continue</button>' +
      '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>' +
      '</div></div>'
    );

    function ownerIndex() { return state.participatingRosterRef === '' ? -1 : Number(state.participatingRosterRef); }

    function renderWhoIsYou() {
      var el = wrap.querySelector('#ap-whoisyou-opts');
      // BUG FIX (coordinating-session review, Aug 2026): this screen's
      // "None of these are me" option was left in from the pre-redesign
      // flow. The handoff doc (Section 3) locks this as removed — "'None
      // of these are me' option removed from the 'which one is you'
      // screen, per your future-state note" — but it was still rendered
      // here. Removed to match the locked decision.
      el.innerHTML = state.roster.map(function (p, i) {
        var age = p.age || p.ageRange || '';
        var label = (p.name || 'Unnamed') + ' · ' + age + (p.fitness ? ' · ' + p.fitness : '');
        return '<button type="button" class="paf-option-btn' + (ownerIndex() === i ? ' is-selected' : '') + '" data-idx="' + i + '">' + escapeHtml(label) + '</button>';
      }).join('');
      Array.prototype.forEach.call(el.querySelectorAll('button'), function (btn) {
        btn.addEventListener('click', function () {
          state.participatingRosterRef = btn.getAttribute('data-idx');
          renderWhoIsYou();
          renderRosterRows();
        });
      });
    }

    function renderRosterRows() {
      var oi = ownerIndex();
      wrap.querySelector('#ap-roster-rows').innerHTML = state.roster.map(function (p, i) {
        return rosterRowHtml(p, i, i === oi);
      }).join('');
      // Name: plain text input, update state on 'input' only, no
      // re-render — matches the existing email field's pattern below, so
      // typing a correction doesn't lose cursor focus mid-word.
      Array.prototype.forEach.call(wrap.querySelectorAll('.paf-roster-name'), function (input) {
        input.addEventListener('input', function () {
          var idx = Number(input.getAttribute('data-idx'));
          state.roster[idx].name = input.value;
        });
      });
      // Age: a <select>, no cursor position to lose, so a full
      // re-render is safe here — needed because changing age can flip
      // isMinor, which changes whether this row shows an email field, a
      // fitness dropdown, or a "Minor" tag. Also refreshes the "which one
      // is you" labels above, which embed age too.
      Array.prototype.forEach.call(wrap.querySelectorAll('.paf-roster-age'), function (select) {
        select.addEventListener('change', function () {
          var idx = Number(select.getAttribute('data-idx'));
          state.roster[idx].age = select.value;
          renderRosterRows();
          renderWhoIsYou();
        });
      });
      // Fitness: doesn't affect layout or minor status, just update state.
      Array.prototype.forEach.call(wrap.querySelectorAll('.paf-roster-fit'), function (select) {
        select.addEventListener('change', function () {
          var idx = Number(select.getAttribute('data-idx'));
          state.roster[idx].fitness = select.value;
        });
      });
      Array.prototype.forEach.call(wrap.querySelectorAll('.ap-roster-email'), function (input) {
        input.addEventListener('change', function () {
          var idx = Number(input.getAttribute('data-idx'));
          state.roster[idx].email = input.value.trim();
        });
      });
    }

    function setJoining(val) {
      state.isParticipating = val === 'yes';
      Array.prototype.forEach.call(wrap.querySelectorAll('#ap-joining-opts .paf-option-btn'), function (btn) {
        btn.classList.toggle('is-selected', btn.getAttribute('data-val') === val);
      });
      wrap.querySelector('#ap-whoisyou-wrap').style.display = state.isParticipating ? '' : 'none';
    }

    Array.prototype.forEach.call(wrap.querySelectorAll('#ap-joining-opts .paf-option-btn'), function (btn) {
      btn.addEventListener('click', function () { setJoining(btn.getAttribute('data-val')); });
    });

    if (state.isParticipating === true) setJoining('yes');
    else if (state.isParticipating === false) setJoining('no');
    renderWhoIsYou();
    renderRosterRows();

    wrap.querySelector('#ap-flow-back').addEventListener('click', function () { state.step = 'hub'; render(); });
    wrap.querySelector('#ap-save-and-return').addEventListener('click', function () {
      var participatingRosterRefValue = state.participatingRosterRef === 'none' ? '' : state.participatingRosterRef;
      saveFields({
        isParticipating: state.isParticipating,
        participatingRosterRef: participatingRosterRefValue,
        reconfirmedRosterJson: state.roster,
      }).then(function () { state.step = 'hub'; render(); });
    });
    wrap.querySelector('#ap-next').addEventListener('click', function () {
      if (state.isParticipating === null) {
        wrap.querySelector('#ap-roster-error').textContent = 'Let us know if you’re joining the adventure.';
        return;
      }
      if (state.isParticipating && !state.participatingRosterRef) {
        wrap.querySelector('#ap-roster-error').textContent = 'Tap which row on the roster is you.';
        return;
      }
      var participatingRosterRefValue = state.participatingRosterRef === 'none' ? '' : state.participatingRosterRef;
      saveFields({
        isParticipating: state.isParticipating,
        participatingRosterRef: participatingRosterRefValue,
        reconfirmedRosterJson: state.roster,
      }).then(function (res) {
        if (!res.ok) { wrap.querySelector('#ap-roster-error').textContent = 'Something went wrong saving that, try again.'; return; }
        // Attendees is now roster + invite only (handoff Section 3) — the
        // old linear flow's one-time end-of-flow "Confirm & Send" gate
        // (renderReview) moved here, as this tile's own next screen,
        // rather than staying a separate step at the very end of a fixed
        // sequence that no longer exists.
        state.step = 'invite';
        render();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Attendees tile, step 2: Send Invites (was renderReview — the old
  // one-time "Confirm and Send" end-of-flow gate). Handoff Section 6 FYI
  // note: this used to also serve as Adventure Summary's job; that recap
  // role now belongs entirely to renderSummary below, so this screen is
  // ONLY the invite-sending action, not a trail/kit recap. Reachable
  // repeatedly from the hub (e.g. to send a link to someone added late),
  // not just once.
  //
  // FLAGGED — guardian assignment (handoff Section 3, Section 9 item 1):
  // "the booker picks which attending adult signs for a child, or names an
  // external guardian (not on the trip) directly by name + email" is a new
  // capability this build does not yet implement — there's no schema
  // support today for attaching a non-attending adult as a signing
  // guardian, so this screen still only sends invites to adults already ON
  // the roster, exactly as the pre-redesign code did. Building that is
  // real backend/data-model work (a new guardian-assignment table or
  // column), called out here rather than bolted on as a workaround.
  // ---------------------------------------------------------------------

  function renderInvite() {
    var ap = state.ctx.adventurePrep || {};
    var ownerIdx = state.participatingRosterRef === '' || state.participatingRosterRef === 'none' ? -1 : Number(state.participatingRosterRef);
    var signers = state.roster.filter(function (p, i) {
      var age = p.age || p.ageRange || '';
      return i !== ownerIdx && !MINOR_BUCKETS[age];
    });
    var missingEmail = signers.filter(function (p) { return !p.email; });

    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      '<div class="ap-back-link" id="ap-back-to-hub" style="cursor:pointer;">&larr; Adventure Home</div>' +
      '<div class="ap-eyebrow">Attendees</div>' +
      '<h1 class="ap-q">Let’s reach the rest of your group</h1>' +
      '<p class="ap-sub">Everyone we haven’t already reached gets their own link to confirm their details and sign their own waiver.</p>' +
      '<div class="ap-card">' +
      (signers.length
        ? signers.map(function (s) {
          return '<div class="review-recipient"><div><div class="review-recipient-name">' + escapeHtml(s.name || '') + '</div><div class="review-recipient-email">' + escapeHtml(s.email || 'no email on file yet') + '</div></div><span class="review-recipient-tag">Waiver link</span></div>';
        }).join('')
        : '<p class="ap-helper">No one else on this booking needs their own waiver link.</p>') +
      '<div class="ap-helper" style="margin:0.6rem 0 1.2rem;">Any minors on this booking need a guardian assigned before we can reach them, that’s not built yet, see the note in Waivers.</div>' +
      (missingEmail.length ? '<div class="ap-error" style="margin-bottom:1rem;">Add an email for ' + missingEmail.map(function (p) { return escapeHtml(p.name || 'this person'); }).join(', ') + ' before sending, they need it for their own link. <a href="#" id="ap-back-to-roster" style="color:var(--mountain-pink);">Go back and add it</a></div>' : '') +
      '<div id="ap-invite-error" class="ap-error"></div>' +
      '<button class="ap-nav-next" id="ap-send-invites" style="width:100%; padding:1rem;"' + (missingEmail.length ? ' disabled' : '') + '>' + (ap.linksSentAt ? 'Resend Invites' : 'Send Invites') + '</button>' +
      '</div>' +
      '</div></div>'
    );

    wrap.querySelector('#ap-back-to-hub').addEventListener('click', function () { state.step = 'hub'; render(); });
    var backLink = wrap.querySelector('#ap-back-to-roster');
    if (backLink) backLink.addEventListener('click', function (e) { e.preventDefault(); state.step = 'roster'; render(); });

    wrap.querySelector('#ap-send-invites').addEventListener('click', function (e) {
      e.target.disabled = true;
      apiPost('/api/adventure-prep', {
        action: 'sendSignerLinks',
        token: TOKEN,
        signers: signers.map(function (s) { return { rosterRef: String(state.roster.indexOf(s)), name: s.name, email: s.email }; }),
      }).then(function (res) {
        if (!res.ok) {
          wrap.querySelector('#ap-invite-error').textContent = 'Something went wrong sending those links, try again.';
          e.target.disabled = false;
          return;
        }
        state.step = 'hub';
        render();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Preferences (bestForAttributes, technical comfort, heat comfort)
  // ---------------------------------------------------------------------

  // Round 2 build (mockup-02): each of the 3 preference questions is now
  // its own screen (state.prefStep 0|1|2), with a small step progress bar
  // and a persistent "Save & return to Adventure Home" link on every
  // screen, since the hub model means a guest can stop mid-flow and come
  // back later. Mechanic itself (pick up to 3 / single-select / single-
  // select) is unchanged from the old one-screen version.
  function renderPreferences() {
    function stepMeta() {
      return [
        { pct: 33, label: 'Step 1 of 3' },
        { pct: 66, label: 'Step 2 of 3' },
        { pct: 100, label: 'Step 3 of 3' },
      ][state.prefStep];
    }
    function flowTop(backLabel) {
      var meta = stepMeta();
      return '<div class="ap-flow-top"><div class="ap-back-link" id="ap-flow-back" style="cursor:pointer; margin-bottom:0;">' + backLabel + '</div><div class="ap-progress-label">' + meta.label + '</div></div>' +
        '<div class="ap-mini-progress-track"><div class="ap-mini-progress-fill" style="width:' + meta.pct + '%;"></div></div>';
    }
    function savePreferenceFields() {
      return saveFields({
        bestForAttributes: state.bestForAttributes.join(', '),
        technicalComfort: state.technicalComfort,
        heatComfort: state.heatComfort,
      });
    }
    function wireCommon(wrap) {
      wrap.querySelector('#ap-flow-back').addEventListener('click', function () {
        if (state.prefStep === 0) { state.step = 'hub'; render(); }
        else { state.prefStep -= 1; render(); }
      });
      wrap.querySelector('#ap-save-and-return').addEventListener('click', function () {
        savePreferenceFields().then(function () { state.step = 'hub'; render(); });
      });
    }

    if (state.prefStep === 0) {
      var wrap = h(
        '<div class="container"><div class="ap-shell">' +
        flowTop('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Trail Recommendation</div>' +
        '<div class="ap-q-title">What does your group want to experience on the trail?</div>' +
        '<div class="ap-q-help">Pick up to 3. This helps us place your group on the right trail.</div>' +
        '<div class="ap-chip-grid" id="ap-bfa"></div>' +
        '<div class="ap-chip-limit" id="ap-bfa-limit"></div>' +
        '<div id="ap-pref-error" class="ap-error"></div>' +
        '<button type="button" class="ap-cta-primary" id="ap-next">Continue</button>' +
        '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>' +
        '</div></div>'
      );
      function renderBfa() {
        wrap.querySelector('#ap-bfa').innerHTML = BEST_FOR_ATTRIBUTES_OPTIONS.map(function (opt) {
          var sel = state.bestForAttributes.indexOf(opt) !== -1;
          return '<div class="ap-chip' + (sel ? ' selected' : '') + '" data-opt="' + escapeHtml(opt) + '"><div class="ap-chip-check">' + (sel ? '&check;' : '') + '</div>' + escapeHtml(opt) + '</div>';
        }).join('');
        wrap.querySelector('#ap-bfa-limit').textContent = state.bestForAttributes.length + ' of 3 selected';
        Array.prototype.forEach.call(wrap.querySelectorAll('#ap-bfa .ap-chip'), function (el) {
          el.addEventListener('click', function () {
            var opt = el.getAttribute('data-opt');
            var idx = state.bestForAttributes.indexOf(opt);
            if (idx !== -1) { state.bestForAttributes.splice(idx, 1); }
            else if (state.bestForAttributes.length < 3) { state.bestForAttributes.push(opt); }
            renderBfa();
          });
        });
      }
      renderBfa();
      wireCommon(wrap);
      wrap.querySelector('#ap-next').addEventListener('click', function () { state.prefStep = 1; render(); });
      return wrap;
    }

    if (state.prefStep === 1) {
      var wrap = h(
        '<div class="container"><div class="ap-shell">' +
        flowTop('&larr; Back') +
        '<div class="ap-eyebrow">Trail Recommendation</div>' +
        '<div class="ap-q-title">How technical can the trail be for your group?</div>' +
        '<div class="ap-q-help">This helps us match your group’s technical abilities to the trail.</div>' +
        '<div class="ap-q-note"><span>&#9432;</span> Most trails have some large rocks and step-ups.</div>' +
        '<div class="ap-radio-list" id="ap-technical"></div>' +
        '<div id="ap-pref-error" class="ap-error"></div>' +
        '<button type="button" class="ap-cta-primary" id="ap-next">Continue</button>' +
        '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>' +
        '</div></div>'
      );
      function renderRadios() {
        wrap.querySelector('#ap-technical').innerHTML = TECHNICAL_COMFORT_OPTIONS.map(function (opt) {
          var sel = state.technicalComfort === opt.value;
          return '<div class="ap-radio' + (sel ? ' selected' : '') + '" data-val="' + opt.value + '"><div class="ap-radio-dot"></div><div class="ap-radio-text">' + escapeHtml(opt.label) + '</div></div>';
        }).join('');
        Array.prototype.forEach.call(wrap.querySelectorAll('#ap-technical .ap-radio'), function (el) {
          el.addEventListener('click', function () { state.technicalComfort = el.getAttribute('data-val'); renderRadios(); });
        });
      }
      renderRadios();
      wireCommon(wrap);
      wrap.querySelector('#ap-next').addEventListener('click', function () {
        if (!state.technicalComfort) { wrap.querySelector('#ap-pref-error').textContent = 'Choose one to continue.'; return; }
        state.prefStep = 2;
        render();
      });
      return wrap;
    }

    // prefStep === 2
    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      flowTop('&larr; Back') +
      '<div class="ap-eyebrow">Trail Recommendation</div>' +
      '<div class="ap-q-title">How much sun is acceptable for your group?</div>' +
      '<div class="ap-q-help">This helps us select a trail matched to the amount of sun exposure that’s okay for your group.</div>' +
      '<div class="ap-q-note"><span>&#9432;</span> Most trails are sun-exposed open-desert trails. We recommend an early start when temperatures are coolest.</div>' +
      '<div class="ap-radio-list" id="ap-heat"></div>' +
      '<div id="ap-pref-error" class="ap-error"></div>' +
      '<button type="button" class="ap-cta-primary" id="ap-next">Get Our Trail Recommendation</button>' +
      '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>' +
      '</div></div>'
    );
    function renderHeatRadios() {
      wrap.querySelector('#ap-heat').innerHTML = HEAT_COMFORT_OPTIONS.map(function (opt) {
        var sel = state.heatComfort === opt.value;
        return '<div class="ap-radio' + (sel ? ' selected' : '') + '" data-val="' + opt.value + '"><div class="ap-radio-dot"></div><div class="ap-radio-text">' + escapeHtml(opt.label) + '</div></div>';
      }).join('');
      Array.prototype.forEach.call(wrap.querySelectorAll('#ap-heat .ap-radio'), function (el) {
        el.addEventListener('click', function () { state.heatComfort = el.getAttribute('data-val'); renderHeatRadios(); });
      });
    }
    renderHeatRadios();
    wireCommon(wrap);
    wrap.querySelector('#ap-next').addEventListener('click', function () {
      if (!state.heatComfort) { wrap.querySelector('#ap-pref-error').textContent = 'Choose one to continue.'; return; }
      savePreferenceFields().then(function (res) {
        if (!res.ok) { wrap.querySelector('#ap-pref-error').textContent = 'Something went wrong saving that, try again.'; return; }
        state.step = 'trail';
        state.trailAssignmentPhase = 'idle';
        render();
      });
    });
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Trail assignment (pacing transition -> Choose Your Trail grid
  // -> confirmation), plus the "Change Your Trail" re-entry flow.
  // ---------------------------------------------------------------------

  // Round 2 build: the mockups' comparison-card stat grid shows text labels
  // ("Easy"/"Moderate"/"Hard", "Low"/"Moderate"/"High") for what the trail
  // database actually stores as a 1-5 numeric rating (lib/normalize.js's
  // 'Difficulty (1–5)' / 'Technical Rating (1–5)' columns). No canonical
  // number-to-label mapping exists anywhere in the PRD/handoff, so this
  // tertile split (1-2 / 3 / 4-5) is a build-session judgment call — flagged
  // for Airey to confirm rather than silently invented and left unflagged.
  function difficultyLabel(n) {
    if (n == null) return '—';
    if (n <= 2) return 'Easy';
    if (n === 3) return 'Moderate';
    return 'Hard';
  }
  function technicalLabel(n) {
    if (n == null) return '—';
    if (n <= 2) return 'Low';
    if (n === 3) return 'Moderate';
    return 'High';
  }

  function difficultyBadges(candidates) {
    var algo = candidates.filter(function (c) { return c.source !== 'manual_override'; });
    var ratings = algo.map(function (c) { return c.difficultyRating; }).filter(function (n) { return n != null; });
    if (!ratings.length) return {};
    var min = Math.min.apply(null, ratings), max = Math.max.apply(null, ratings);
    var badges = {};
    algo.forEach(function (c, i) {
      if (i === 0) return; // best-overall-match slot never gets an easier/harder badge
      if (c.difficultyRating === min && min !== max) badges[c.trailId] = 'Easier';
      else if (c.difficultyRating === max && min !== max) badges[c.trailId] = 'More Challenging';
    });
    return badges;
  }

  // Replaces the old single trail-card design with mockup-02's
  // ".ap-compare-card" comparison layout (photo + badge, name, a
  // Distance/Elevation/Difficulty/Technical stat grid, a short description,
  // one CTA). `badge` is {text, cls} or null/undefined for no badge.
  function compareCardHtml(candidate, badge, ctaLabel, ctaDisabled) {
    var desc = candidate.overviewCopy || ((candidate.matchedAttributes || []).length
      ? 'Matches what you told us: ' + candidate.matchedAttributes.join(', ') + '.'
      : 'A safe, solid fit for your group.');
    return '<div class="ap-compare-card">' +
      '<div class="ap-compare-photo"' + (candidate.photoUrl ? ' style="background-image:url(\'' + candidate.photoUrl + '\'); background-size:cover; background-position:center;"' : '') + '>' +
      (badge ? '<div class="ap-compare-badge ' + badge.cls + '">' + escapeHtml(badge.text) + '</div>' : '') +
      '</div>' +
      '<div class="ap-compare-body">' +
      '<div class="ap-compare-name">' + escapeHtml(candidate.trailName || '') + '</div>' +
      '<div class="ap-compare-stats">' +
      '<div><div class="ap-compare-stat-label">Distance</div><div class="ap-compare-stat-value">' + (candidate.distance != null ? candidate.distance + ' mi' : '—') + '</div></div>' +
      '<div><div class="ap-compare-stat-label">Elevation</div><div class="ap-compare-stat-value">' + (candidate.elevation != null ? candidate.elevation + ' ft' : '—') + '</div></div>' +
      '<div><div class="ap-compare-stat-label">Difficulty</div><div class="ap-compare-stat-value">' + difficultyLabel(candidate.difficultyRating) + '</div></div>' +
      '<div><div class="ap-compare-stat-label">Technical</div><div class="ap-compare-stat-value">' + technicalLabel(candidate.technicalRating) + '</div></div>' +
      '</div>' +
      '<div class="ap-compare-desc">' + escapeHtml(desc) + '</div>' +
      '<button type="button" class="ap-compare-cta"' + (ctaDisabled ? ' disabled' : '') + ' data-trail-id="' + escapeHtml(candidate.trailId) + '">' + escapeHtml(ctaLabel) + '</button>' +
      '</div></div>';
  }

  function renderTrail() {
    var ap = state.ctx.adventurePrep || {};
    var wrap = h('<div class="container"><div class="ap-shell"><div id="ap-trail-content"></div></div></div>');
    var contentEl = wrap.querySelector('#ap-trail-content');

    function flowTopHtml(backLabel) {
      return '<div class="ap-flow-top"><div class="ap-back-link" id="ap-flow-back" style="cursor:pointer; margin-bottom:0;">' + backLabel + '</div><div></div></div>';
    }
    function goHub() { state.trailAssignmentPhase = 'idle'; state.step = 'hub'; render(); }

    // ---- "[Trail] it is." confirmation, right after choosing ----
    function renderConfirmation(candidate) {
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Trail Recommendation</div>' +
        '<div class="ap-q-title" style="margin-bottom:1rem;">' + escapeHtml(candidate.trailName || 'Your trail') + ' it is.</div>' +
        '<div class="ap-reveal-photo"' + (candidate.photoUrl ? ' style="background-image:url(\'' + candidate.photoUrl + '\'); background-size:cover; background-position:center;"' : '') + '>' + (candidate.photoUrl ? '' : '<div class="ap-reveal-photo-label">Trail photo</div>') + '</div>' +
        '<div class="ap-reveal-card">' +
        '<div class="ap-reveal-eyebrow">Your Trail</div>' +
        '<div class="ap-reveal-name">' + escapeHtml(candidate.trailName || '') + '</div>' +
        '<div class="ap-reveal-body">' + escapeHtml(candidate.overviewCopy || 'Matched to your group’s pace and the sun you’re comfortable with.') + '</div>' +
        '</div>' +
        '<button type="button" class="ap-cta-primary" id="ap-continue-attendees">Continue to Attendees</button>' +
        '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer;">Return to Adventure Home</div>';
      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-continue-attendees').addEventListener('click', function () { state.trailAssignmentPhase = 'idle'; state.step = 'roster'; render(); });
      contentEl.querySelector('#ap-return-hub').addEventListener('click', goHub);
    }

    // ---- In review: 0 qualifying candidates, nothing manual yet ----
    function renderInReview() {
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Trail Recommendation</div>' +
        '<div class="ap-review-icon">&#128269;</div>' +
        '<div class="ap-review-title">We’re building your trail recommendation personally.</div>' +
        '<div class="ap-review-body">Your group’s preferences and trail day are a genuinely specific combination, so we’ve flagged this for a closer look by our team. You’ll hear from us with a trail recommendation before your trail day.</div>' +
        '<div class="ap-review-body">Continue to make sure your attendees, gear delivery details, and waivers are all set in the meantime.</div>' +
        '<button type="button" class="ap-cta-primary" id="ap-continue-attendees">Continue to Confirm Attendees</button>' +
        '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer;">Return to Adventure Home</div>';
      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-continue-attendees').addEventListener('click', function () { state.step = 'roster'; render(); });
      contentEl.querySelector('#ap-return-hub').addEventListener('click', goHub);
    }

    // ---- Choose Your Trail grid (first-time assignment or a refresh) ----
    function renderChooseGrid(candidates) {
      var algo = candidates.filter(function (c) { return c.source !== 'manual_override'; });
      var manual = candidates.filter(function (c) { return c.source === 'manual_override'; });
      var badgesMap = difficultyBadges(candidates);
      var isPartial = algo.length > 0 && algo.length < 3 && manual.length === 0;

      function badgeFor(c, algoIndex) {
        if (c.source === 'manual_override') {
          // Section 9 item 5 (trail-matching copy standardization): the
          // real trail-selection engine already ships "Suggested by our
          // team" / "Picked based on your note" copy for a manual staff
          // pick (lib/trail-selection-engine.js), while mockup-02 drafted
          // a separate "Staff Pick" badge before that real copy existed.
          // Standardizing on the real, already-shipped copy here instead
          // of introducing a second vocabulary for the same concept —
          // keeping the mockup's visual badge treatment (dark-pine badge),
          // just with the real string. Flagging in case "Staff Pick" is
          // actually preferred for guest-facing copy.
          return { text: 'Suggested by our team', cls: 'badge-staff' };
        }
        if (algoIndex === 0) return { text: 'Recommended', cls: 'badge-recommended' };
        var b = badgesMap[c.trailId];
        if (b === 'Easier') return { text: 'Easier', cls: 'badge-easier' };
        if (b === 'More Challenging') return { text: 'More Challenging', cls: 'badge-harder' };
        return null;
      }

      var cardsHtml = manual.map(function (c) { return compareCardHtml(c, badgeFor(c, -1), 'Choose This Trail', false); }).join('') +
        algo.map(function (c, i) { return compareCardHtml(c, badgeFor(c, i), 'Choose This Trail', false); }).join('');

      var help = manual.length && algo.length === 0
        ? 'A team member picked this one for your group personally.'
        : (manual.length
          ? 'A team member added one more option worth a look, alongside what we found for your group.'
          : (isPartial
            ? 'Your group and trail day narrowed things down more than usual. Here’s a strong option already lined up, while we look for another.'
            : 'Based on your group’s answers, here’s what fits. Pick the one that sounds right.'));

      // Combination of a manual pick plus a still-partial algorithmic
      // result isn't a case either mockup-02 or the handoff doc spells out
      // explicitly — treating a manual pick's presence as "staff has
      // already stepped in", so the "still searching" teaser below is
      // suppressed whenever there's a manual entry, not just at 3.
      var teaserHtml = isPartial
        ? '<div class="placeholder-wrap" style="margin-bottom:1rem;">' +
          '<div class="placeholder-dots"><div class="placeholder-dot"></div><div class="placeholder-dot"></div><div class="placeholder-dot"></div></div>' +
          '<div class="placeholder-title" style="font-size:1.1rem;">We’re finding you another option.</div>' +
          '<div class="placeholder-body">Our team is taking a personal look at your group’s day to round out your choices. We’ll let you know the moment there’s more to see, no need to check back.</div>' +
          '</div>'
        : '';

      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Trail Recommendation</div>' +
        '<div class="ap-q-title" style="margin-bottom:0.35rem;">Choose your trail.</div>' +
        '<div class="ap-q-help" style="margin-bottom:1.1rem;">' + help + '</div>' +
        '<div class="ap-compare-grid' + (candidates.length <= 2 ? ' is-thin' : '') + '">' + cardsHtml + '</div>' +
        teaserHtml +
        '<p class="reveal-footnote">Park entry fees may apply based on your group and trail day, we’ll confirm the exact amount closer to your date. Not loving what’s here? <a href="mailto:hello@palmspringsadventureclub.com">Tell us what’s not working</a> and we’ll take another look.</p>' +
        '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer; margin-top:0.4rem;">Return to Adventure Home</div>';

      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-return-hub').addEventListener('click', goHub);
      Array.prototype.forEach.call(contentEl.querySelectorAll('.ap-compare-cta'), function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          var trailId = btn.getAttribute('data-trail-id');
          apiPost('/api/adventure-prep', { action: 'selectTrail', token: TOKEN, trailId: trailId }).then(function (res) {
            if (!res.ok) { btn.disabled = false; return; }
            ap.selectedTrailId = res.body.selectedTrailId;
            ap.assignmentMethod = res.body.assignmentMethod;
            state.trailAssignmentPhase = 'justChosen';
            renderConfirmation(candidates.filter(function (c) { return c.trailId === trailId; })[0] || {});
          });
        });
      });
    }

    function renderPacing() {
      contentEl.innerHTML = '<div class="transition-wrap"><div class="transition-spinner"></div>' +
        '<div class="transition-line">Looking for trails that fit your group&hellip;</div></div>';
    }

    function routeReveal(candidates) {
      var algoCount = candidates.filter(function (c) { return c.source !== 'manual_override'; }).length;
      var manualCount = candidates.length - algoCount;
      if (algoCount === 0 && manualCount === 0) { renderInReview(); return; }
      renderChooseGrid(candidates);
    }

    function loadCandidates() {
      var existing = ap.candidateTrails;
      try { existing = typeof existing === 'string' ? JSON.parse(existing || '[]') : (existing || []); } catch (e) { existing = []; }
      var forceRefresh = state.forceTrailRefresh;
      state.forceTrailRefresh = false;
      if (!forceRefresh && existing.length && ap.assignedAt) {
        routeReveal(existing);
        return;
      }
      renderPacing();
      apiPost('/api/adventure-prep', { action: 'runTrailAssignment', token: TOKEN, operation: (forceRefresh || ap.assignedAt) ? 'refresh' : 'initial' }).then(function (res) {
        if (!res.ok) {
          if (res.body && res.body.status === 'refused') { renderInReview(); return; }
          contentEl.innerHTML = '<p class="ap-error">Something went wrong finding your trail. Refresh the page to try again, or reply to your confirmation email and we’ll take a look.</p>';
          return;
        }
        ap.candidateTrails = res.body.candidateTrails;
        ap.assignedAt = res.body.assignedAt;
        ap.assignmentMethod = res.body.assignmentMethod;
        routeReveal(res.body.candidateTrails);
      });
    }

    // ---- Change Your Trail: entry point (a trail is already set) ----
    function renderChangeEntry() {
      var candidates = ap.candidateTrails;
      try { candidates = typeof candidates === 'string' ? JSON.parse(candidates || '[]') : (candidates || []); } catch (e) { candidates = []; }
      var current = candidates.filter(function (c) { return c.trailId === ap.selectedTrailId; })[0] || {};
      var choice = 'different';

      function draw() {
        contentEl.innerHTML =
          flowTopHtml('&larr; Adventure Home') +
          '<div class="ap-eyebrow">Trail Recommendation</div>' +
          '<div class="ap-q-title" style="margin-bottom:1rem;">Want a different trail?</div>' +
          '<div class="ap-reveal-photo" style="margin-top:0;' + (current.photoUrl ? ' background-image:url(\'' + current.photoUrl + '\'); background-size:cover; background-position:center;' : '') + '">' + (current.photoUrl ? '' : '<div class="ap-reveal-photo-label">Trail photo</div>') + '</div>' +
          '<div class="ap-reveal-card" style="margin-bottom:1.4rem;">' +
          '<div class="ap-reveal-eyebrow">Currently Set</div>' +
          '<div class="ap-reveal-name">' + escapeHtml(current.trailName || 'Your trail') + '</div>' +
          '</div>' +
          '<div class="ap-radio-list" id="ap-change-options">' +
          '<div class="ap-radio' + (choice === 'different' ? ' selected' : '') + '" data-val="different"><div class="ap-radio-dot"></div><div class="ap-radio-text">Choose a different trail<br><span style="font-weight:400; color:var(--ap-muted); font-size:0.72rem;">Pick from the other trails that already fit your group</span></div></div>' +
          '<div class="ap-radio' + (choice === 'redo' ? ' selected' : '') + '" data-val="redo"><div class="ap-radio-dot"></div><div class="ap-radio-text">Answer the questions differently<br><span style="font-weight:400; color:var(--ap-muted); font-size:0.72rem;">Redo the 3 preference questions and get a new match</span></div></div>' +
          '<div class="ap-radio' + (choice === 'ask_team' ? ' selected' : '') + '" data-val="ask_team"><div class="ap-radio-dot"></div><div class="ap-radio-text">Ask our team to pick for you<br><span style="font-weight:400; color:var(--ap-muted); font-size:0.72rem;">We’ll recommend something else personally before your trail day</span></div></div>' +
          '</div>' +
          '<button type="button" class="ap-cta-primary" id="ap-change-continue">Continue</button>' +
          '<div class="ap-cta-secondary" id="ap-change-nevermind" style="cursor:pointer;">Never mind, keep ' + escapeHtml(current.trailName || 'your trail') + '</div>';

        contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
        contentEl.querySelector('#ap-change-nevermind').addEventListener('click', goHub);
        Array.prototype.forEach.call(contentEl.querySelectorAll('#ap-change-options .ap-radio'), function (el) {
          el.addEventListener('click', function () { choice = el.getAttribute('data-val'); draw(); });
        });
        contentEl.querySelector('#ap-change-continue').addEventListener('click', function () {
          if (choice === 'different') { renderChangeGrid(candidates, current); }
          else if (choice === 'redo') { state.prefStep = 0; state.forceTrailRefresh = true; state.step = 'preferences'; render(); }
          else { renderAskTeamConfirm(); }
        });
      }
      draw();
    }

    // ---- Change Your Trail: pick from the existing candidate set ----
    // Decided (handoff notes on mockup-02): reuses the full comparison-card
    // grid rather than a shortened list, with the current pick badged
    // "Currently Set" instead of "Recommended".
    function renderChangeGrid(candidates, current) {
      var badgesMap = difficultyBadges(candidates);
      var algoOnly = candidates.filter(function (c) { return c.source !== 'manual_override'; });
      function badgeFor(c) {
        if (c.trailId === current.trailId) return { text: 'Currently Set', cls: 'badge-current' };
        if (c.source === 'manual_override') return { text: 'Suggested by our team', cls: 'badge-staff' };
        if (algoOnly.indexOf(c) === 0) return { text: 'Recommended', cls: 'badge-recommended' };
        var b = badgesMap[c.trailId];
        if (b === 'Easier') return { text: 'Easier', cls: 'badge-easier' };
        if (b === 'More Challenging') return { text: 'More Challenging', cls: 'badge-harder' };
        return null;
      }
      var cardsHtml = candidates.map(function (c) {
        var isCurrent = c.trailId === current.trailId;
        return compareCardHtml(c, badgeFor(c), isCurrent ? 'Keep This Trail' : 'Choose This Trail', false);
      }).join('');

      contentEl.innerHTML =
        flowTopHtml('&larr; Back') +
        '<div class="ap-eyebrow">Trail Recommendation</div>' +
        '<div class="ap-q-title" style="margin-bottom:1.1rem;">Here are your other options.</div>' +
        '<div class="ap-compare-grid' + (candidates.length <= 2 ? ' is-thin' : '') + '">' + cardsHtml + '</div>' +
        '<div class="ap-cta-secondary" id="ap-change-cancel" style="cursor:pointer; margin-top:0.2rem;">Cancel</div>';

      contentEl.querySelector('#ap-flow-back').addEventListener('click', renderChangeEntry);
      contentEl.querySelector('#ap-change-cancel').addEventListener('click', renderChangeEntry);
      Array.prototype.forEach.call(contentEl.querySelectorAll('.ap-compare-cta'), function (btn) {
        btn.addEventListener('click', function () {
          var trailId = btn.getAttribute('data-trail-id');
          if (trailId === current.trailId) { goHub(); return; }
          btn.disabled = true;
          apiPost('/api/adventure-prep', { action: 'selectTrail', token: TOKEN, trailId: trailId }).then(function (res) {
            if (!res.ok) { btn.disabled = false; return; }
            ap.selectedTrailId = res.body.selectedTrailId;
            ap.assignmentMethod = res.body.assignmentMethod;
            state.trailAssignmentPhase = 'justChosen';
            renderConfirmation(candidates.filter(function (c) { return c.trailId === trailId; })[0] || {});
          });
        });
      });
    }

    // ---- "Ask our team" — no dedicated backend field/action exists for a
    // guest-initiated "please review my trail" flag (unlike manual_override,
    // which is staff-initiated from Ops). Reuses this file's existing
    // guest-to-team mailto pattern (see the reveal footnote's "Tell us
    // what's not working" link) rather than inventing a new Sheet column and
    // Apps Script action for a single button — flagged for Airey; a real
    // trackable "request review" field would be a clean follow-up if this
    // needs to show up in Ops.
    function renderAskTeamConfirm() {
      var bookingId = (state.ctx.experienceBooking && state.ctx.experienceBooking.bookingId) || '';
      var mailto = 'mailto:hello@palmspringsadventureclub.com?subject=' + encodeURIComponent('Please pick our trail personally') +
        '&body=' + encodeURIComponent('Hi team,\n\nCould someone take a personal look at our trail pick?\n\nBooking: ' + bookingId + '\n\nThanks!');
      window.location.href = mailto;
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Trail Recommendation</div>' +
        '<div class="ap-review-icon">&#9993;&#65039;</div>' +
        '<div class="ap-review-title">Got it, we’ll take a personal look.</div>' +
        '<div class="ap-review-body">A team member will follow up with a trail recommendation for your group before your trail day.</div>' +
        '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer;">Return to Adventure Home</div>';
      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-return-hub').addEventListener('click', goHub);
    }

    // ---- Entry point: a trail is already set and we're not mid-"just
    // chose it" transition -> show the Change Your Trail re-entry screen
    // instead of re-running assignment or re-showing the choose grid. ----
    if (ap.selectedTrailId && state.trailAssignmentPhase !== 'justChosen') {
      renderChangeEntry();
    } else {
      state.trailAssignmentPhase = 'idle';
      loadCandidates();
    }

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Planning details (property, address, delivery window, return pref)
  // ---------------------------------------------------------------------

  // Round 2 build (mockup-04): the old single-screen "who needs a kit +
  // delivery details" form is now 3 screens (state.gearStep 0|1|2 — kit
  // toggle, delivery, pickup), each with its own back link and a
  // persistent "Save & return to Adventure Home" link, ending on a
  // confirmation recap. Handoff notes on this mockup explicitly call the
  // combining of several single-field screens (Delivery Note folded into
  // the delivery screen; Return Address/Location/Time/Note combined into
  // one pickup screen) a presentation simplification, not a data-model
  // change — same posture kept here.
  function renderPlanning() {
    var wrap = h('<div class="container"><div class="ap-shell"><div id="ap-gear-content"></div></div></div>');
    var contentEl = wrap.querySelector('#ap-gear-content');

    function flowTopHtml(backLabel) {
      return '<div class="ap-flow-top"><div class="ap-back-link" id="ap-flow-back" style="cursor:pointer; margin-bottom:0;">' + backLabel + '</div><div></div></div>';
    }
    function goHub() { state.gearStep = 0; state.step = 'hub'; render(); }
    function initialsOf(name) {
      var parts = String(name || '').trim().split(/\s+/);
      return (((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '')).toUpperCase();
    }
    function isHotelPath() { return state.propertyType === 'Hotel / resort'; }

    // ---- Screen 0: gear kit toggles ----
    function renderKitScreen() {
      var infoOpen = false;
      function draw() {
        var eligibleCount = state.roster.filter(isGearEligible).length;
        var kitCount = state.roster.filter(function (p) { return isGearEligible(p) && p.gearKit !== false; }).length;
        contentEl.innerHTML =
          flowTopHtml('&larr; Adventure Home') +
          '<div class="ap-eyebrow">Gear Kits &amp; Delivery/Pickup</div>' +
          '<div class="ap-q-title">Is everyone renting a gear kit?</div>' +
          '<div class="ap-q-help">We recommend 1 gear kit per person so everyone can carry enough water, electrolytes, and snacks for a trek in the desert.</div>' +
          '<div class="ap-kit-info-link" id="ap-kit-info-toggle">What’s inside a gear kit? ' + (infoOpen ? '&ndash;' : '+') + '</div>' +
          (infoOpen
            ? '<div class="ap-kit-info-panel">' +
              '<div class="ap-kit-info-body"><b class="ap-kit-info-label">Rental gear:</b> a Gregory daypack, Leki trekking poles, two laser-engraved Hydro Flask 32oz bottles, and a first aid kit. Packed and delivered the evening before your trail day.</div>' +
              '<div class="ap-kit-info-body"><b class="ap-kit-info-label">Yours to keep:</b> LMNT electrolytes, Rancho Meladuco Medjool dates, and Blue Lizard mineral sunscreen.</div>' +
              '</div>'
            : '') +
          '<div id="ap-kit-rows"></div>' +
          '<div class="ap-kit-count">' + kitCount + ' of ' + eligibleCount + ' gear kit' + (eligibleCount === 1 ? '' : 's') + ' selected</div>' +
          '<div class="ap-min-note">At least 1 gear kit rental is required on every reservation. Gear rental is available only to participants age 14 and older.</div>' +
          '<div id="ap-kit-error" class="ap-error"></div>' +
          '<button type="button" class="ap-cta-primary" id="ap-next">Continue</button>' +
          '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>';

        drawRows();
        contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
        contentEl.querySelector('#ap-kit-info-toggle').addEventListener('click', function () { infoOpen = !infoOpen; draw(); });
        contentEl.querySelector('#ap-save-and-return').addEventListener('click', function () {
          saveFields({ reconfirmedRosterJson: state.roster }).then(goHub);
        });
        contentEl.querySelector('#ap-next').addEventListener('click', function () {
          if (kitCount < 1) {
            contentEl.querySelector('#ap-kit-error').textContent = 'At least 1 gear kit is required to continue.';
            return;
          }
          saveFields({ reconfirmedRosterJson: state.roster }).then(function (res) {
            if (!res.ok) { contentEl.querySelector('#ap-kit-error').textContent = 'Something went wrong saving that, try again.'; return; }
            state.gearStep = 1;
            render();
          });
        });
      }
      function drawRows() {
        contentEl.querySelector('#ap-kit-rows').innerHTML = state.roster.map(function (p, i) {
          var age = p.age || p.ageRange || '';
          var eligible = isGearEligible(p);
          var hasKit = eligible && p.gearKit !== false;
          if (!eligible) {
            return '<div class="ap-kit-row disabled">' +
              '<div class="ap-kit-avatar">' + escapeHtml(initialsOf(p.name)) + '</div>' +
              '<div class="ap-kit-mid"><div class="ap-kit-name">' + escapeHtml(p.name || '') + '</div>' +
              '<div class="ap-kit-note">' + escapeHtml(age) + ' &middot; gear rental starts at age 14</div></div>' +
              '<div class="ap-kit-unavailable">Not included</div>' +
              '</div>';
          }
          return '<div class="ap-kit-row">' +
            '<div class="ap-kit-avatar">' + escapeHtml(initialsOf(p.name)) + '</div>' +
            '<div class="ap-kit-name">' + escapeHtml(p.name || '') + '</div>' +
            '<div class="ap-kit-toggle" data-idx="' + i + '">' +
            '<div class="ap-kit-toggle-opt' + (hasKit ? ' on' : '') + '" data-kit="true">Yes</div>' +
            '<div class="ap-kit-toggle-opt' + (!hasKit ? ' on' : '') + '" data-kit="false">No</div>' +
            '</div></div>';
        }).join('');
        Array.prototype.forEach.call(contentEl.querySelectorAll('.ap-kit-toggle-opt'), function (el) {
          el.addEventListener('click', function () {
            var idx = Number(el.parentElement.getAttribute('data-idx'));
            state.roster[idx].gearKit = el.getAttribute('data-kit') === 'true';
            draw();
          });
        });
      }
      draw();
    }

    // ---- Screen 1: delivery ----
    function renderDeliveryScreen() {
      var PROPERTY_OPTS = ['Hotel / resort', 'Vacation rental (Airbnb/VRBO)', 'Private residence'];
      var PROPERTY_LABELS = { 'Hotel / resort': 'Hotel / Resort', 'Vacation rental (Airbnb/VRBO)': 'Vacation rental', 'Private residence': 'Private residence' };
      var DELIVERY_WINDOWS = ['3:00pm – 5:00pm', '5:00pm – 7:00pm', '7:00pm – 9:00pm'];
      contentEl.innerHTML =
        flowTopHtml('&larr; Back') +
        '<div class="ap-eyebrow">Gear Kits &amp; Delivery/Pickup</div>' +
        '<div class="ap-q-title">Where should your gear get delivered?</div>' +
        '<div class="ap-q-help">Your gear kit will be delivered the evening before your trail day.</div>' +
        '<div class="ap-field-label">Where are you staying?</div>' +
        '<div class="ap-choice-pills" id="ap-property"></div>' +
        '<div class="ap-field-label">Delivery Address</div>' +
        '<input class="ap-field-input" type="text" id="ap-address" placeholder="Property name or street address" value="' + escapeHtml(state.deliveryAddressLine1) + '">' +
        '<div class="ap-field-row2">' +
        '<div><div class="ap-field-label">City</div><input class="ap-field-input" type="text" id="ap-city" value="' + escapeHtml(state.deliveryCity) + '" placeholder="Palm Springs"></div>' +
        '<div><div class="ap-field-label">Zip</div><input class="ap-field-input" type="text" id="ap-zip" value="' + escapeHtml(state.deliveryZip) + '" placeholder="92264"></div>' +
        '</div>' +
        '<div class="ap-field-label">Delivery Window</div>' +
        '<div class="ap-window-list" id="ap-window-list"></div>' +
        '<div class="ap-field-label">Delivery Note (optional)</div>' +
        '<textarea class="ap-field-textarea" id="ap-delivery-note" placeholder="Any other note or instructions about delivery">' + escapeHtml(state.deliveryNote) + '</textarea>' +
        '<div id="ap-delivery-error" class="ap-error"></div>' +
        '<button type="button" class="ap-cta-primary" id="ap-next">Continue</button>' +
        '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>';

      function drawPills() {
        contentEl.querySelector('#ap-property').innerHTML = PROPERTY_OPTS.map(function (o) {
          return '<div class="ap-pill' + (state.propertyType === o ? ' selected' : '') + '" data-val="' + escapeHtml(o) + '">' + escapeHtml(PROPERTY_LABELS[o]) + '</div>';
        }).join('');
        Array.prototype.forEach.call(contentEl.querySelectorAll('#ap-property .ap-pill'), function (el) {
          el.addEventListener('click', function () { state.propertyType = el.getAttribute('data-val'); drawPills(); });
        });
      }
      function drawWindows() {
        contentEl.querySelector('#ap-window-list').innerHTML = DELIVERY_WINDOWS.map(function (w) {
          return '<div class="ap-window-opt' + (state.deliveryWindow === w ? ' selected' : '') + '" data-val="' + w + '">' + w + (w === '7:00pm – 9:00pm' ? ' <span class="ap-window-default">DEFAULT</span>' : '') + '</div>';
        }).join('');
        Array.prototype.forEach.call(contentEl.querySelectorAll('#ap-window-list .ap-window-opt'), function (el) {
          el.addEventListener('click', function () { state.deliveryWindow = el.getAttribute('data-val'); drawWindows(); });
        });
      }
      drawPills();
      drawWindows();

      function collectAndGoHub() {
        state.deliveryAddressLine1 = contentEl.querySelector('#ap-address').value.trim();
        state.deliveryCity = contentEl.querySelector('#ap-city').value.trim();
        state.deliveryZip = contentEl.querySelector('#ap-zip').value.trim();
        state.deliveryNote = contentEl.querySelector('#ap-delivery-note').value.trim();
        saveFields({
          propertyType: state.propertyType,
          deliveryAddressLine1: state.deliveryAddressLine1,
          deliveryCity: state.deliveryCity,
          deliveryZip: state.deliveryZip,
          deliveryWindow: state.deliveryWindow,
          deliveryNote: state.deliveryNote,
        }).then(goHub);
      }
      contentEl.querySelector('#ap-flow-back').addEventListener('click', function () { state.gearStep = 0; render(); });
      contentEl.querySelector('#ap-save-and-return').addEventListener('click', collectAndGoHub);
      contentEl.querySelector('#ap-next').addEventListener('click', function () {
        state.deliveryAddressLine1 = contentEl.querySelector('#ap-address').value.trim();
        state.deliveryCity = contentEl.querySelector('#ap-city').value.trim();
        state.deliveryZip = contentEl.querySelector('#ap-zip').value.trim();
        state.deliveryNote = contentEl.querySelector('#ap-delivery-note').value.trim();
        var errorEl = contentEl.querySelector('#ap-delivery-error');
        if (!state.propertyType || !state.deliveryAddressLine1) {
          errorEl.textContent = 'Let us know where you’re staying and your delivery address.';
          return;
        }
        // BUG FIX (Aug 2026, Airey's direct request): this used to always
        // send deliveryAddressValidated: false and never actually call
        // Google's Address Validation API — real validation existed as a
        // built, smoke-tested endpoint (api/validate-delivery-address.js)
        // but nothing in this flow ever called it. Now wired in: validate
        // first, save the standardized result if Google confirms it, fall
        // back to the guest's own typed values (still saved, just flagged
        // unvalidated) on a soft-fail. Never blocks the guest either way —
        // matches Section 18 item 17's "guest proceeds after a retry
        // prompt; booking flags for staff review" posture.
        var nextBtn = contentEl.querySelector('#ap-next');
        errorEl.textContent = '';
        nextBtn.disabled = true;
        var originalLabel = nextBtn.textContent;
        nextBtn.textContent = 'Checking address…';
        apiPost('/api/validate-delivery-address', {
          token: TOKEN,
          addressInput: { line1: state.deliveryAddressLine1, city: state.deliveryCity, state: 'CA', zip: state.deliveryZip },
        }).then(function (validationRes) {
          var v = validationRes.body || {};
          var std = v.standardized || null;
          var fields = {
            propertyType: state.propertyType,
            deliveryAddressLine1: (std && std.line1) || state.deliveryAddressLine1,
            deliveryCity: (std && std.city) || state.deliveryCity,
            deliveryState: 'CA',
            deliveryZip: (std && std.zip) || state.deliveryZip,
            deliveryAddressRaw: [
              (std && std.line1) || state.deliveryAddressLine1,
              (std && std.city) || state.deliveryCity, 'CA',
              (std && std.zip) || state.deliveryZip,
            ].filter(Boolean).join(', '),
            deliveryAddressValidated: !!v.validated,
            deliveryWindow: state.deliveryWindow,
            deliveryNote: state.deliveryNote,
          };
          if (std && std.lat != null) fields.deliveryLat = std.lat;
          if (std && std.lng != null) fields.deliveryLng = std.lng;
          if (!v.validated) {
            errorEl.textContent = 'We couldn’t fully confirm that address — you can continue, we’ll double check before delivery.';
          }
          return saveFields(fields);
        }).then(function (res) {
          nextBtn.disabled = false;
          nextBtn.textContent = originalLabel;
          if (!res.ok) { errorEl.textContent = 'Something went wrong saving that, try again.'; return; }
          state.gearStep = 2;
          render();
        }).catch(function () {
          nextBtn.disabled = false;
          nextBtn.textContent = originalLabel;
          errorEl.textContent = 'Something went wrong saving that, try again.';
        });
      });
    }

    // ---- Screen 2: pickup (hotel path: fixed windows + auto-sweep note;
    // non-hotel path: return location pills + all 4 windows, no auto-note) ----
    function renderPickupScreen() {
      var ALL_WINDOWS = ['3:00pm – 5:00pm', '5:00pm – 7:00pm', '7:00pm – 9:00pm', '9:00pm – 11:00pm'];
      var RETURN_LOCATIONS = ['Front door', 'Front gate', 'Hand delivery'];
      var hotel = isHotelPath();

      function draw() {
        contentEl.innerHTML =
          flowTopHtml('&larr; Back') +
          '<div class="ap-eyebrow">Gear Kits &amp; Delivery/Pickup</div>' +
          '<div class="ap-q-title">Where should your gear get picked up?</div>' +
          '<div class="ap-q-help">Your gear kit will be picked up the evening of your adventure from the location below.</div>' +
          '<div class="ap-toggle-row" id="ap-same-toggle"><div class="ap-toggle-row-text">Same as delivery address</div><div class="ap-switch' + (state.returnSameAsDelivery ? ' on' : '') + '"></div></div>' +
          (state.returnSameAsDelivery ? '' :
            '<div class="ap-field-label">Return Address</div>' +
            '<input class="ap-field-input" type="text" id="ap-return-address" placeholder="If different from your delivery address" value="' + escapeHtml(state.returnAddressLine1) + '">') +
          (hotel ? '' :
            '<div class="ap-field-label">Return Location</div>' +
            '<div class="ap-choice-pills" id="ap-return-location"></div>') +
          '<div class="ap-field-label">Return Time' + (hotel ? ' (optional)' : '') + '</div>' +
          '<div class="ap-window-list" id="ap-return-windows"></div>' +
          (hotel
            ? '<div class="ap-auto-note">Since you’re staying at a hotel, front desk pickup works well. Pick a time above if you know it, or leave it, we’ll do a <b>final pickup sweep at the front desk after 9:00pm</b> either way.</div>'
            : '') +
          '<div class="ap-field-label">Return Note (optional)</div>' +
          '<textarea class="ap-field-textarea" id="ap-return-note" placeholder="Any other note or instructions about pickup">' + escapeHtml(state.returnNote) + '</textarea>' +
          '<div id="ap-pickup-error" class="ap-error"></div>' +
          '<button type="button" class="ap-cta-primary" id="ap-next">Continue to Waivers</button>' +
          '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer;">Return to Adventure Home</div>';

        contentEl.querySelector('#ap-flow-back').addEventListener('click', function () { state.gearStep = 1; render(); });
        contentEl.querySelector('#ap-return-hub').addEventListener('click', collectAndGoHub);
        contentEl.querySelector('#ap-same-toggle').addEventListener('click', function () {
          state.returnAddressLine1 = contentEl.querySelector('#ap-return-address') ? contentEl.querySelector('#ap-return-address').value.trim() : state.returnAddressLine1;
          state.returnSameAsDelivery = !state.returnSameAsDelivery;
          draw();
        });
        if (!hotel) {
          drawLocationPills();
        }
        drawWindows();
        contentEl.querySelector('#ap-next').addEventListener('click', onContinue);
      }

      function drawLocationPills() {
        contentEl.querySelector('#ap-return-location').innerHTML = RETURN_LOCATIONS.map(function (loc) {
          return '<div class="ap-pill' + (state.returnLocation === loc ? ' selected' : '') + '" data-val="' + escapeHtml(loc) + '">' + escapeHtml(loc) + '</div>';
        }).join('');
        Array.prototype.forEach.call(contentEl.querySelectorAll('#ap-return-location .ap-pill'), function (el) {
          el.addEventListener('click', function () { state.returnLocation = el.getAttribute('data-val'); drawLocationPills(); });
        });
      }
      function drawWindows() {
        contentEl.querySelector('#ap-return-windows').innerHTML = ALL_WINDOWS.map(function (w) {
          return '<div class="ap-window-opt' + (state.returnWindow === w ? ' selected' : '') + '" data-val="' + w + '">' + w + '</div>';
        }).join('');
        Array.prototype.forEach.call(contentEl.querySelectorAll('#ap-return-windows .ap-window-opt'), function (el) {
          el.addEventListener('click', function () {
            state.returnWindow = state.returnWindow === el.getAttribute('data-val') ? null : el.getAttribute('data-val');
            drawWindows();
          });
        });
      }

      function collectAndGoHub() {
        collectFields();
        saveFields(currentFields()).then(goHub);
      }
      function collectFields() {
        if (contentEl.querySelector('#ap-return-address')) state.returnAddressLine1 = contentEl.querySelector('#ap-return-address').value.trim();
        state.returnNote = contentEl.querySelector('#ap-return-note').value.trim();
      }
      function currentFields() {
        return {
          returnSameAsDelivery: state.returnSameAsDelivery,
          returnAddressLine1: state.returnSameAsDelivery ? '' : state.returnAddressLine1,
          returnLocation: hotel ? '' : (state.returnLocation || ''),
          returnWindow: state.returnWindow || '',
          returnNote: state.returnNote,
          returnPreference: state.returnSameAsDelivery ? 'We’ll drop it back off ourselves' : 'Please arrange pickup',
        };
      }
      function onContinue() {
        collectFields();
        var errorEl = contentEl.querySelector('#ap-pickup-error');
        if (!hotel && !state.returnLocation) {
          errorEl.textContent = 'Choose a return location to continue.';
          return;
        }
        saveFields(currentFields()).then(function (res) {
          if (!res.ok) { errorEl.textContent = 'Something went wrong saving that, try again.'; return; }
          renderConfirmation();
        });
      }

      draw();
    }

    // ---- Confirmation recap ----
    function renderConfirmation() {
      var eb = state.ctx.experienceBooking;
      var depositAmount = eb.tier === 'p2p' ? 100 : 65;
      var kitCount = state.roster.filter(function (p) { return isGearEligible(p) && p.gearKit !== false; }).length;
      var hotel = isHotelPath();
      var pickupLine = hotel
        ? 'Front desk, final sweep after 9pm' + (state.returnWindow ? ' (requested ' + state.returnWindow + ')' : '')
        : (state.returnLocation || 'Return location TBD') + (state.returnWindow ? ', ' + state.returnWindow : '');
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Gear Kits &amp; Delivery/Pickup</div>' +
        '<div class="ap-recap-icon">&#10003;</div>' +
        '<div class="ap-recap-title">Your gear is all set.</div>' +
        '<div class="ap-recap-card">' +
        '<div class="ap-recap-line"><span>Gear Kits</span><b>' + kitCount + ' kit' + (kitCount === 1 ? '' : 's') + '</b></div>' +
        '<div class="ap-recap-line"><span>Gear Delivery</span><b>' + escapeHtml(state.deliveryWindow || '') + '</b></div>' +
        '<div class="ap-recap-line"><span>Gear Pickup</span><b>' + escapeHtml(pickupLine) + '</b></div>' +
        '</div>' +
        '<div class="ap-deposit-note">One more thing: a <b>$' + depositAmount + ' refundable gear deposit hold</b> gets placed on your card the day before your adventure day (the day your gear arrives). We’ll let you know right before it happens.</div>' +
        '<button type="button" class="ap-cta-primary" id="ap-continue-waivers">Continue to Waivers</button>' +
        '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer;">Return to Adventure Home</div>';
      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-continue-waivers').addEventListener('click', function () { state.gearStep = 0; state.step = 'waiver'; render(); });
      contentEl.querySelector('#ap-return-hub').addEventListener('click', goHub);
    }

    if (state.gearStep === 0) renderKitScreen();
    else if (state.gearStep === 1) renderDeliveryScreen();
    else renderPickupScreen();

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Waivers (Round 2 rebuild, mockup-05): "Sign Waiver" renamed to
  // "Waivers" and restructured as a group status list -> scroll-gated
  // sign screen -> confirmation. IMPORTANT SCOPE NOTE: the kickoff's file
  // list for this build was adventure-prep-form.js/ap-styles.css/
  // complete-adventure-prep.html/adventure-form.js plus the apps-script
  // files — NOT waiver-signer-form.js or sign-waiver.html. Mockup-05's
  // frames 1b ("Jordan," an attending guest with no dependents) and 1c
  // ("Taylor," a non-attending guardian) are both THAT separate page, not
  // this one — a non-booker signs via their own emailed signer-token link,
  // never through this hub. Only frame 1 (the booker's own "everyone's
  // status" list, tappable only on her own row) plus the sign screen and
  // confirmation are in scope here and built below. Matching this same
  // visual/scroll-gated redesign on waiver-signer-form.js's guest/guardian
  // views would be a clean, explicitly-flagged follow-up, not silently
  // done or silently skipped.
  function renderWaiver() {
    var wrap = h('<div class="container"><div class="ap-shell"><div id="ap-waiver-content"></div></div></div>');
    var contentEl = wrap.querySelector('#ap-waiver-content');

    function flowTopHtml(backLabel) {
      return '<div class="ap-flow-top"><div class="ap-back-link" id="ap-flow-back" style="cursor:pointer; margin-bottom:0;">' + backLabel + '</div><div></div></div>';
    }
    function goHub() { state.step = 'hub'; render(); }
    function initialsOf(name) {
      var parts = String(name || '').trim().split(/\s+/);
      return (((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '')).toUpperCase();
    }

    // ---- Screen: everyone's waiver status (booker only sees this; her
    // own row is tappable, everyone else's is read-only status) ----
    function renderList() {
      var signers = waiverSigners();
      var missingCount = signers.filter(function (s) { return !s.isDone; }).length;
      var alertHtml = missingCount
        ? '<div class="ap-alert"><div class="ap-alert-icon">!</div><div class="ap-alert-text"><b>Waivers lock at ' + formatCutoffLabel() + '.</b> Gear rental will be cancelled for anyone who hasn’t finished theirs.</div></div>'
        : '';
      var rowsHtml = signers.map(function (s) {
        var statusCls = s.isDone ? 'status-done' : 'status-notdone';
        var statusLabel = s.isDone ? 'Done' : 'Not done';
        if (s.isOwner) {
          return '<div class="ap-wv-row tappable" id="ap-wv-self">' +
            '<div class="ap-wv-avatar">' + escapeHtml(initialsOf(s.name)) + '</div>' +
            '<div class="ap-wv-mid"><div class="ap-wv-name">' + escapeHtml(s.name) + ' <span style="font-weight:400; color:var(--ap-muted); font-size:0.72rem;">(you)</span></div></div>' +
            '<div class="ap-wv-status ' + statusCls + '">' + statusLabel + '</div>' +
            '<div class="ap-wv-chevron">&rsaquo;</div>' +
            '</div>';
        }
        return '<div class="ap-wv-row readonly">' +
          '<div class="ap-wv-avatar">' + escapeHtml(initialsOf(s.name)) + '</div>' +
          '<div class="ap-wv-mid"><div class="ap-wv-name">' + escapeHtml(s.name) + '</div>' +
          (s.subLabel ? '<div class="ap-wv-sub">' + escapeHtml(s.subLabel) + '</div>' : '') + '</div>' +
          '<div class="ap-wv-status ' + statusCls + '">' + statusLabel + '</div>' +
          '</div>';
      }).join('');

      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Waivers</div>' +
        '<div class="ap-q-title">Your group’s waivers.</div>' +
        '<div class="ap-q-help">Sign yours, and see where everyone else stands.</div>' +
        alertHtml +
        rowsHtml +
        '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer; margin-top:0.6rem;">Return to Adventure Home</div>';

      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-return-hub').addEventListener('click', goHub);
      var selfRow = contentEl.querySelector('#ap-wv-self');
      if (selfRow) selfRow.addEventListener('click', renderSign);
    }

    // ---- Screen: sign (scroll-gated) ----
    function renderSign() {
      var wc = (state.ctx.waiverContent) || {};
      var version = wc.version || 'v1.5';
      // BUG FIX (coordinating-session review, Aug 2026): these two fallback
      // strings are new guest-facing copy from this build and used an em
      // dash, against this project's locked brand-voice rule (no em dashes
      // in guest copy). Rephrased.
      var statusTag = wc.statusTag == null ? 'Draft: Pending Final Attorney Review' : wc.statusTag;
      var bodyHtml = wc.bodyHtml || '<p>Waiver text is not available right now. Reply to your confirmation email and we’ll help you finish this.</p>';
      var minors = state.roster.filter(function (p) { return MINOR_BUCKETS[p.age || p.ageRange]; });
      var scrolledToEnd = false;
      var checked = false;

      contentEl.innerHTML =
        flowTopHtml('&larr; Back') +
        '<div class="ap-eyebrow">Waivers</div>' +
        '<div class="ap-q-title">Sign your waiver.</div>' +
        '<div class="ap-q-help">Scroll through the full agreement below, then confirm at the bottom.</div>' +
        '<div class="ap-waiver-scroll" id="ap-waiver-scroll">' +
        '<div class="doc-title"><div class="doc-name">PALM SPRINGS ADVENTURE CLUB</div>' +
        '<div class="doc-sub">Participant Agreement and Acknowledgment of Risk</div>' +
        '<div class="doc-version">Version ' + escapeHtml(version.replace(/^v/i, '')) + '</div></div>' +
        (statusTag ? '<div class="ap-draft-tag">' + escapeHtml(statusTag) + '</div>' : '') +
        bodyHtml +
        '<p style="font-style:italic; color:var(--ap-muted); font-size:0.68rem;">[Signed electronically as the name you type below, with a timestamped record kept on file, upon tapping “Sign &amp; Continue.”]</p>' +
        '</div>' +
        '<div class="ap-scroll-hint" id="ap-scroll-hint">&#8595; Scroll to review the full agreement</div>' +
        '<div class="ap-agree-row disabled" id="ap-agree-row">' +
        '<div class="ap-agree-box" id="ap-agree-box"></div>' +
        '<div class="ap-agree-text">I have read and agree to the Palm Springs Adventure Club waiver and release of liability.</div>' +
        '</div>' +
        '<div class="ap-field-label">Type your full legal name to sign</div>' +
        '<input class="ap-field-input" type="text" id="ap-waiver-name" placeholder="Full legal name" value="' + escapeHtml(state.waiverName) + '">' +
        (minors.length ? minors.map(function (m) {
          return '<div class="ap-toggle-row" data-guardian-name="' + escapeHtml(m.name || '') + '" style="cursor:pointer;">' +
            '<div class="ap-toggle-row-text" style="font-weight:500; font-size:0.78rem;">I am the parent/guardian of ' + escapeHtml(m.name || 'this child') + ' (' + escapeHtml(m.age || m.ageRange || '') + ') and I’m signing on their behalf</div>' +
            '<div class="ap-switch' + (state.guardianForChildren.indexOf(m.name) !== -1 ? ' on' : '') + '"></div>' +
            '</div>';
        }).join('') : '') +
        '<div class="ap-section-label">Emergency Contact (optional)</div>' +
        '<div class="ap-field-label">Name</div>' +
        '<input class="ap-field-input" type="text" id="ap-ec-name" placeholder="Full name" value="' + escapeHtml(state.ecName) + '">' +
        '<div class="ap-field-label">Phone</div>' +
        '<input class="ap-field-input" type="tel" id="ap-ec-phone" placeholder="Phone number" value="' + escapeHtml(state.ecPhone) + '">' +
        '<div id="ap-waiver-error" class="ap-error"></div>' +
        '<button type="button" class="ap-cta-primary" id="ap-sign-cta" disabled>Sign &amp; Continue</button>' +
        '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>';

      var scrollBox = contentEl.querySelector('#ap-waiver-scroll');
      var hint = contentEl.querySelector('#ap-scroll-hint');
      var agreeRow = contentEl.querySelector('#ap-agree-row');
      var agreeBox = contentEl.querySelector('#ap-agree-box');
      var signCta = contentEl.querySelector('#ap-sign-cta');

      // Scroll-gated ("scrollwrap") signature pattern (handoff Section 5):
      // the agree checkbox stays locked/greyed until the reader has
      // scrolled the full agreement to the bottom, then unlocks; "Sign &
      // Continue" only activates once the checkbox is also explicitly
      // checked. Belt-and-suspenders, matching mockup-05's frame 2 exactly.
      scrollBox.addEventListener('scroll', function () {
        if (scrolledToEnd) return;
        if (scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 6) {
          scrolledToEnd = true;
          agreeRow.classList.remove('disabled');
          hint.textContent = 'You’ve reviewed the full agreement. Tap the checkbox to confirm.';
          hint.classList.add('done');
        }
      });
      // A short scroll box (agreement fits without scrolling on a tall
      // viewport) should never trap the guest — treat it as already
      // reviewed on first render in that case.
      if (scrollBox.scrollHeight <= scrollBox.clientHeight + 6) {
        scrolledToEnd = true;
        agreeRow.classList.remove('disabled');
        hint.textContent = 'You’ve reviewed the full agreement — tap the checkbox to confirm.';
        hint.classList.add('done');
      }
      agreeRow.addEventListener('click', function () {
        if (!scrolledToEnd) return;
        checked = !checked;
        agreeBox.classList.toggle('checked', checked);
        agreeBox.innerHTML = checked ? '&check;' : '';
        signCta.disabled = !checked;
      });
      Array.prototype.forEach.call(contentEl.querySelectorAll('[data-guardian-name]'), function (row) {
        row.addEventListener('click', function () {
          var name = row.getAttribute('data-guardian-name');
          var idx = state.guardianForChildren.indexOf(name);
          if (idx === -1) state.guardianForChildren.push(name); else state.guardianForChildren.splice(idx, 1);
          row.querySelector('.ap-switch').classList.toggle('on', state.guardianForChildren.indexOf(name) !== -1);
        });
      });

      function collectFields() {
        state.waiverName = contentEl.querySelector('#ap-waiver-name').value.trim();
        state.ecName = contentEl.querySelector('#ap-ec-name').value.trim();
        state.ecPhone = contentEl.querySelector('#ap-ec-phone').value.trim();
      }

      contentEl.querySelector('#ap-flow-back').addEventListener('click', renderList);
      contentEl.querySelector('#ap-save-and-return').addEventListener('click', function () {
        collectFields();
        goHub();
      });
      signCta.addEventListener('click', function () {
        collectFields();
        if (!state.waiverName) {
          contentEl.querySelector('#ap-waiver-error').textContent = 'Type your full legal name to sign.';
          return;
        }
        signCta.disabled = true;
        var participantsCovered = [state.waiverName].concat(state.guardianForChildren);
        apiPost('/api/waiver', {
          action: 'saveWaiverSignature',
          token: TOKEN,
          signerName: state.waiverName,
          signerEmail: state.ctx.experienceBooking.contactEmail,
          isGuardian: state.guardianForChildren.length > 0,
          guardianForChildren: state.guardianForChildren,
          participantsCovered: participantsCovered,
        }).then(function (res) {
          if (!res.ok) {
            signCta.disabled = false;
            contentEl.querySelector('#ap-waiver-error').textContent = 'Something went wrong saving your signature, try again.';
            return;
          }
          var ecDone = state.ecName || state.ecPhone
            ? apiPost('/api/waiver', { action: 'saveEmergencyContact', token: TOKEN, contactName: state.ecName, contactPhone: state.ecPhone })
            : Promise.resolve({ ok: true });
          // BUG FIX (coordinating-session review, Aug 2026, live-reported): same
          // stale-state.ctx issue as saveFields() above. waiverSigners() (used by
          // computeHubStatus() and the hub tile render) reads state.ctx.waiverSignatures
          // directly, which was only ever populated once at boot() — so a successful
          // sign here never made the Waivers hub tile flip to "Done" until a full
          // page reload re-fetched context. Mirror the new owner signature locally,
          // matching the exact shape waiverSigners() expects.
          ecDone.then(function () {
            state.ctx.waiverSignatures = (state.ctx.waiverSignatures || []).filter(function (w) { return w.role !== 'owner'; });
            state.ctx.waiverSignatures.push({
              role: 'owner',
              status: 'signed',
              signerName: state.waiverName,
              participantsCoveredJson: JSON.stringify(participantsCovered),
            });
            renderConfirmation();
          });
        });
      });
    }

    // ---- Screen: confirmation ----
    function renderConfirmation() {
      var eb = state.ctx.experienceBooking;
      var depositAmount = eb.tier === 'p2p' ? 100 : 65;
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Waivers</div>' +
        '<div class="ap-recap-icon">&#9997;&#65039;</div>' +
        '<div class="ap-recap-title">Waiver signed.</div>' +
        '<div class="ap-recap-body">You’re all set on this one.</div>' +
        '<div class="ap-deposit-note">One more thing: a <b>$' + depositAmount + ' refundable gear deposit hold</b> gets placed on your card the day before your adventure day (the day your gear arrives). We’ll let you know right before it happens.</div>' +
        '<button type="button" class="ap-cta-primary" id="ap-return-hub-2">Return to Adventure Home</button>';
      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-return-hub-2').addEventListener('click', goHub);
    }

    renderList();
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Adventure Summary — an ongoing recap, not a one-time gate (handoff
  // Section 6). The old renderReview's "Confirm & Send" job moved to the
  // Attendees tile's own renderInvite above; this screen's only job now is
  // showing where things stand, matching mockup 06 frame 1 (everything
  // set) / frame 2 (still finishing up) — same markup, driven by whichever
  // pieces are actually done.
  // ---------------------------------------------------------------------

  function renderSummary() {
    var eb = state.ctx.experienceBooking;
    var ap = state.ctx.adventurePrep || {};
    var status = computeHubStatus();
    var missingSignerCount = status.signers.filter(function (s) { return !s.isDone; }).length;
    var allSet = status.trailSelected && status.gearDone && status.waiversDone;

    var headline = allSet ? 'Everything’s set.<br>The trail’s waiting.' : 'Almost there.<br>A few things left.';
    var kitStat = status.gearDone ? (status.kitCount + ' packed') : (status.kitCount + ' of ' + status.eligibleCount + ' selected');
    var pickupLine = status.gearDone ? (ap.returnPreference || state.returnPreference) : 'Not set yet';
    var waiverLine = status.signers.length
      ? (status.signers.filter(function (s) { return s.isDone; }).length + ' of ' + status.signers.length + ' signed')
      : 'Not started';

    var actionHtml = allSet
      ? (status.trailSelected && isPastT3Cutoff()
        ? '<div class="ap-receipt-guide-cta"><span>Your trail guide is ready to download.</span><button type="button" id="ap-get-guide">Get Guide</button></div>'
        : '')
      : (missingSignerCount
        ? '<div class="ap-receipt-nudge-cta"><span>' + missingSignerCount + ' ' + (missingSignerCount === 1 ? 'person' : 'people') + ' in your group still ' + (missingSignerCount === 1 ? 'needs' : 'need') + ' to sign their waiver.</span><button type="button" id="ap-send-reminder-all">Send Reminder</button></div>'
        : '');

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-back-link" id="ap-back-to-hub" style="cursor:pointer;">&larr; Adventure Home</div>' +
      '<div class="ap-receipt"><div class="ap-receipt-inner">' +
      '<div class="ap-receipt-mark"><img src="/images/logo.svg" alt="Palm Springs Adventure Club"></div>' +
      '<div class="ap-receipt-eyebrow">Your Adventure Day</div>' +
      '<div class="ap-receipt-headline">' + headline + '</div>' +
      '<div class="ap-receipt-grid">' +
      '<div><div class="ap-receipt-stat-label">Trail Day</div><div class="ap-receipt-stat-value">' + formatTripDate(eb.date) + '</div></div>' +
      '<div><div class="ap-receipt-stat-label">Trail</div><div class="ap-receipt-stat-value">' + escapeHtml(status.trailSelected ? status.trailName : 'To be confirmed') + '</div></div>' +
      '<div><div class="ap-receipt-stat-label">Group</div><div class="ap-receipt-stat-value">' + state.roster.length + ' adventurers</div></div>' +
      '<div><div class="ap-receipt-stat-label">Gear Kits</div><div class="ap-receipt-stat-value">' + kitStat + '</div></div>' +
      '</div>' +
      '<div class="ap-receipt-divider"></div>' +
      '<div class="ap-receipt-line"><span>Gear delivery</span><b>' + escapeHtml(status.gearDone ? (ap.deliveryWindow || state.deliveryWindow) : 'Not set yet') + '</b></div>' +
      '<div class="ap-receipt-line"><span>Gear pickup</span><b>' + escapeHtml(pickupLine) + '</b></div>' +
      '<div class="ap-receipt-line tappable" id="ap-open-waiver-detail"><span>Everyone’s waiver</span><b>' + escapeHtml(waiverLine) + '<span class="ap-receipt-line-arrow">&rsaquo;</span></b></div>' +
      '<div class="ap-receipt-line"><span>Gear deposit</span><b>Placed the day before, refunded after</b></div>' +
      actionHtml +
      '<div class="ap-receipt-footer">palmspringsadventureclub.com</div>' +
      '</div></div>' +
      '</div></div>'
    );

    wrap.querySelector('#ap-back-to-hub').addEventListener('click', function () { state.step = 'hub'; render(); });
    var waiverLink = wrap.querySelector('#ap-open-waiver-detail');
    if (waiverLink) waiverLink.addEventListener('click', function () { state.step = 'waiverDetail'; render(); });
    var guideBtn = wrap.querySelector('#ap-get-guide');
    if (guideBtn) guideBtn.addEventListener('click', function () {
      window.open((ap.rideWithGpsExperienceAccess && ap.rideWithGpsExperienceAccess.url) || 'https://ridewithgps.com/', '_blank');
    });
    var remindAllBtn = wrap.querySelector('#ap-send-reminder-all');
    if (remindAllBtn) remindAllBtn.addEventListener('click', function () {
      state.step = 'waiverDetail';
      render();
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Adventure Summary, frame 3: per-person waiver detail (handoff Section
  // 6 — "a genuinely new capability... the live code only ever tracks the
  // current viewer's own waiver status"). Confirmed: "Send Reminder" fires
  // an email to that person directly, their own waiver-link email, not the
  // booker's — reuses the same signer-invite email api/adventure-prep.js's
  // sendSignerLinks already sends, since that's the only signer-facing
  // email template this codebase has; a dedicated "reminder" template
  // (different subject/copy from the first invite) is a reasonable
  // follow-up but not required for the reminder to actually function.
  // ---------------------------------------------------------------------

  function renderWaiverDetail() {
    var signers = computeHubStatus().signers;

    function initials(name) {
      var parts = String(name || '').trim().split(/\s+/);
      return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '');
    }

    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      '<div class="ap-back-link" id="ap-back-to-summary" style="cursor:pointer;">&larr; Back to Adventure Summary</div>' +
      '<div class="ap-eyebrow">Adventure Summary</div>' +
      '<h1 class="ap-q" style="font-size:1.55rem;">Who’s signed their waiver</h1>' +
      '<div class="ap-waiver-panel">' +
      signers.map(function (s) {
        return '<div class="ap-waiver-person">' +
          '<div class="ap-waiver-avatar">' + escapeHtml(initials(s.name).toUpperCase()) + '</div>' +
          '<div class="ap-waiver-mid"><div class="ap-waiver-name">' + escapeHtml(s.name) + (s.isOwner ? ' (you)' : '') + '</div>' +
          (s.subLabel && !s.isDone ? '<div class="ap-waiver-sub">' + escapeHtml(s.subLabel) + '</div>' : '') +
          (s.canRemind ? '<button type="button" class="ap-waiver-remind-btn" data-idx="' + s.index + '">Send reminder</button>' : '') +
          '</div>' +
          '<div class="ap-waiver-status ' + (s.isDone ? 'signed' : 'pending') + '">' + (s.isDone ? 'Signed' : 'Not yet') + '</div>' +
          '</div>';
      }).join('') +
      '</div>' +
      '<div id="ap-remind-status" class="ap-helper"></div>' +
      '<div class="ap-back-to-receipt" id="ap-back-to-summary-2" style="cursor:pointer;">&larr; Back to Adventure Summary</div>' +
      '</div></div>'
    );

    function goBack() { state.step = 'summary'; render(); }
    wrap.querySelector('#ap-back-to-summary').addEventListener('click', goBack);
    wrap.querySelector('#ap-back-to-summary-2').addEventListener('click', goBack);

    Array.prototype.forEach.call(wrap.querySelectorAll('.ap-waiver-remind-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-idx'));
        var person = signers.filter(function (s) { return s.index === idx; })[0];
        btn.disabled = true;
        apiPost('/api/adventure-prep', {
          action: 'sendSignerLinks',
          token: TOKEN,
          signers: [{ rosterRef: String(idx), name: person.name, email: person.email }],
        }).then(function (res) {
          wrap.querySelector('#ap-remind-status').textContent = res.ok
            ? 'Reminder sent to ' + person.name + '.'
            : 'Something went wrong sending that reminder, try again.';
          btn.disabled = false;
        });
      });
    });

    return wrap;
  }

  boot();
})();
