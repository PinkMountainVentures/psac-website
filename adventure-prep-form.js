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
   REWRITTEN (Task 15, 2026-08-31, Postgres migration) — this file was
   built against the pre-migration positional-index roster model
   described just below in the two items this replaces. Once
   lib/adventure-prep-service.js moved the roster onto real
   booking_participants rows (Task 14), this file's own roster/waiver
   code was found to be completely non-functional against the real
   backend: the roster never loaded (hydrateWorkingStateFromCtx read
   fullPayloadJson/reconfirmedRosterJson, neither of which exist anymore),
   and every save silently no-opped (saveFields REJECTS isParticipating/
   participatingRosterRef/reconfirmedRosterJson now — confirmRoster is the
   only path that can touch them). This rewrite:

   1. "Confirm which roster row is you" now stores the REAL
      booking_participants.participant_id (state.ownerParticipantId), not
      a positional array index — the old design's own flagged risk ("if a
      future edit ever reorders that array independent of this flow,
      participatingRosterRef would need to become a stabler identifier
      than a positional index") is exactly what the Postgres migration did,
      so this closes that gap for real rather than hypothetically. The one
      capability this screen still doesn't have (unchanged from before):
      there's no "none of these are me, add me as a new person" option —
      isParticipating true always requires picking an existing roster row.
      That's a real product decision, not an oversight; flagging it again
      here rather than quietly building new UI for confirmRoster's
      ownerNewEntry path, which this screen never calls.

   2. Non-owner adult email still lives on the roster entry itself
      (entry.email), now persisted through confirmRoster's real
      per-participant write path instead of a JSON blob column that no
      longer exists.

   3. Per-person gear-kit toggle (Gear Kits screen) had the exact same
      problem — it saved via the same dead reconfirmedRosterJson blob.
      Now posts { action: 'setRosterGearKits', updates: [{participantId,
      gearKit}] } — a new, narrow action (lib/adventure-prep-service.js),
      deliberately NOT folded into confirmRoster (see that function's own
      header comment for why).

   4. waiverSigners() (feeds the hub tile, Waivers screen, and Adventure
      Summary) used to match waiver_signatures rows to roster entries by
      positional `rosterRef` string and infer minor guardian coverage by
      scanning participantsCoveredJson for a name match. Both are gone:
      waiver_signatures.participant_id is now a real column, and a
      minor's guardian coverage is booking_participants.guardian_verified_at
      (set by lib/waiver-service.js's applyGuardianCertification) — a
      real, structured fact instead of a name-string scan.

   5. The owner's own waiver-signing screen (renderSign) sent
      guardianForChildren as an array of NAMES. lib/waiver-service.js's
      saveWaiverSignature only reads guardianForChildrenParticipantIds —
      the name-based key was silently ignored, so applyGuardianCertification
      never ran for a booker signing on behalf of their own child. Fixed
      to send participant IDs (state.guardianForChildrenParticipantIds).

   6. Attendees' invite-sending screen (renderInvite) used to build its
      own `signers` array (name/email/rosterRef) and POST it to
      sendSignerLinks. lib/waiver-service.js's sendSignerLinksForBooking
      now derives its own signer list server-side (PRD Section 6) —
      the request is just { token }; this screen's `signers` value is
      now local-preview-only, built the same way the server derives
      eligibility, never sent.

   FLAG FOR AIREY, still open, NOT solved here: the invite screen's copy
   still says guardian assignment "isn't built yet" for a non-attending
   external guardian. That's now stale — confirmRoster's
   guardianAssignment (PRD Section 6 hybrid model) and
   sendSignerLinksForBooking's guardian_only handling are both real and
   live — but there is still no UI anywhere in this screen for the
   booker to actually NAME a guardian for a minor (existing-adult or
   external). Building that UI is a real, undecided product surface (what
   it looks like, where it lives), not a mechanical fix, so it's flagged
   again here rather than invented. Without it, minor waiver coverage
   still only ever happens via the self-declare fallback (Model 1,
   preserved) — an attending adult (this screen, renderSign, or
   waiver-signer-form.js) checking "I'm the parent/guardian of ___" when
   THEY sign, which works today and is what this rewrite fixes end to
   end.

   Also flagged, not fixed here (pre-existing, separate from roster): the
   single-person "Send Reminder" button (renderWaiverDetail) posts to the
   same sendSignerLinks action, which now unconditionally re-sends to
   EVERY eligible signer, not just the one tapped — the backend commits to
   bulk-derive-and-send only (see lib/waiver-service.js's own header
   comment). This is a real behavior change from the pre-migration
   single-recipient resend, not a bug this file can fix on its own; the
   button still works (mechanically the same call this build already
   makes for group-level sends), its copy is just updated below to stop
   promising a single-recipient send it can no longer make.
   ============================================================================ */

(function () {
  'use strict';

  var qs = new URLSearchParams(window.location.search);
  var TOKEN = qs.get('token') || '';
  var root = document.getElementById('ap-root');

  var BEST_FOR_ATTRIBUTES_OPTIONS = [
    'Big views', 'Solitude and quiet', 'Physical challenge', 'Wildlife and nature',
    'Interesting geology', 'Water (streams, pools, falls)', 'Photography opportunities',
    'Learning about the place',
  ];
  var TECHNICAL_COMFORT_OPTIONS = [
    { value: 'wide_easy_underfoot', label: 'Wide, easy-underfoot trail' },
    { value: 'some_rock_uneven_ground_fine', label: 'Some rock and uneven ground is fine' },
    { value: 'comfortable_scrambling_route_finding', label: 'Comfortable scrambling and route-finding' },
  ];
  var HEAT_COMFORT_OPTIONS = [
    { value: 'prefers_shade_or_cooler_start', label: 'We prefer shade' },
    { value: 'heat_doesnt_slow_me_down', label: 'We love the sun' },
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
    ownerParticipantId: '', // NEW (Task 15): real booking_participants.participant_id, replaces the old positional participatingRosterRef
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
    guardianForChildrenParticipantIds: [], // NEW (Task 15): array of participant_ids, replaces the old name-keyed guardianForChildren — matches lib/waiver-service.js's real saveWaiverSignature contract
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

    // NEW (Task 15, 2026-08-31): state.ctx.roster is now real,
    // camelCase-mapped booking_participants rows (lib/adventure-prep-
    // service.js's mapRosterRowForContext), not a JSON blob parsed out of
    // fullPayloadJson/reconfirmedRosterJson (neither field exists in the
    // new schema at all — see that file's own header comment, point 2).
    // Copied into a fresh array of fresh objects (not just aliased) so
    // this screen's in-place edits (renderRosterRows et al mutate
    // state.roster[i].name/.age/... directly) never mutate state.ctx
    // itself before a save actually commits — same behavior the old
    // JSON.parse() copy gave for free.
    state.roster = (state.ctx.roster || []).map(function (r) {
      return {
        participantId: r.participantId,
        name: r.name,
        age: r.age,
        fitness: r.fitness,
        email: r.email || '',
        gearKit: r.gearKit,
        roleOnBooking: r.roleOnBooking,
        isParticipating: r.isParticipating,
        guardianPersonId: r.guardianPersonId,
        guardianVerifiedAt: r.guardianVerifiedAt,
      };
    });

    // ap.isParticipating is a real Postgres boolean/null now (mapped
    // straight off adventure_prep.is_participating) — no more '"true"'/
    // '"false"' string tolerance needed, that was for the old Sheet-cell
    // storage, which serialized everything as text.
    state.isParticipating = ap.isParticipating === true ? true : (ap.isParticipating === false ? false : null);
    // NEW (Task 15): the booker's identity is now a real participant_id,
    // resolved from whichever roster row confirmRoster last marked
    // role_on_booking = 'owner' — replaces the old positional
    // participatingRosterRef entirely.
    var ownerRow = state.roster.filter(function (r) { return r.roleOnBooking === 'owner'; })[0];
    state.ownerParticipantId = ownerRow ? ownerRow.participantId : '';

    // bestForAttributes now comes back as a real TEXT[] (mapAdventurePrepRow),
    // not a comma-joined string cell — the old String(...).split(',') only
    // ever worked on an array by accident (Array.prototype.toString()
    // happens to comma-join). Handled explicitly here instead of relying
    // on that coincidence.
    state.bestForAttributes = Array.isArray(ap.bestForAttributes)
      ? ap.bestForAttributes
      : (ap.bestForAttributes ? String(ap.bestForAttributes).split(',').map(function (s) { return s.trim(); }).filter(Boolean) : []);
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
    // BUG FIX (Task 15): ap.returnSameAsDelivery is a real Postgres
    // boolean now, never the string 'false' — the old `=== 'false'` check
    // could never match a real false value, so a guest who explicitly set
    // a different return address always hydrated back to true (same
    // address) on their next visit. Compare to the real boolean instead;
    // undefined/null (never saved yet) still defaults to true.
    state.returnSameAsDelivery = ap.returnSameAsDelivery === false ? false : true;
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
      case 'rosterParticipation': frag = renderRosterParticipation(); break;
      case 'rosterContact': frag = renderRosterContact(); break;
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

  // Attendees micro-flow (roster -> invite) progress bar (feedback round,
  // Sep 2026): follow-up ask was to match the same pattern used across
  // every other micro-flow rather than invent a new one -- Trail
  // Recommendation's renderPreferences() uses flowTop()'s back-link +
  // "Step X of N" label + thin .ap-mini-progress-track fill bar, so this
  // mirrors that exactly (2 steps here instead of 3), parameterized on the
  // back-link's id since renderRoster and renderInvite each wire their own.
  function attendeesFlowTopHtml(stepIndex, backLinkId, backLabel) {
    var meta = [
      { pct: 25, label: 'Step 1 of 4' },
      { pct: 50, label: 'Step 2 of 4' },
      { pct: 75, label: 'Step 3 of 4' },
      { pct: 100, label: 'Step 4 of 4' },
    ][stepIndex];
    return '<div class="ap-flow-top"><div class="ap-back-link" id="' + backLinkId + '" style="cursor:pointer; margin-bottom:0;">' + backLabel + '</div><div class="ap-progress-label">' + meta.label + '</div></div>' +
      '<div class="ap-mini-progress-track"><div class="ap-mini-progress-fill" style="width:' + meta.pct + '%;"></div></div>';
  }

  // Shared "who needs their own waiver-link email" filter (feedback
  // round, Sep 2026 -- Contact Info split into its own screen): used by
  // renderRoster()'s Continue handler (to decide whether Contact Info is
  // needed at all), renderRosterContact() itself, and renderInvite().
  // Mirrors lib/waiver-service.js's own eligibility filter (attending,
  // non-owner, non-minor adults, plus any guardian_only rows).
  function computeAttendeeSigners() {
    return state.roster.filter(function (p) {
      return p.roleOnBooking !== 'owner'
        && (p.roleOnBooking === 'guardian_only' || (p.isParticipating !== false && !MINOR_BUCKETS[p.age]));
    });
  }

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
  }

  // REWRITTEN (Task 15): calls confirmRoster now, not saveFields (which
  // actively rejects isParticipating/participatingRosterRef/
  // reconfirmedRosterJson — see this file's header comment). The
  // `roster` array sent here deliberately EXCLUDES whichever row is
  // designated as the owner — that row is updated via ownerParticipantId
  // instead (a separate write inside confirmRoster), and the two paths
  // are mutually exclusive by design (see lib/adventure-prep-service.js's
  // confirmRoster, step 4's `role_on_booking != 'owner'` guard). Every
  // entry here always carries a real participantId (this screen has no
  // "add a new person" capability — see this file's header comment,
  // point 1) and is always sent isParticipating: true — this screen has
  // no per-attendee opt-out control either, matching its existing
  // "email us to add/remove someone" copy.
  //
  // Hoisted to top-level (feedback round, Sep 2026): used to live only
  // inside renderRoster(), but renderRosterContact() (the new Contact
  // Info step) needs to save the same combined roster/participation/
  // email state too, via its own Continue and Save & Return actions.
  function saveConfirmRoster() {
    var participating = !!state.isParticipating;
    var payload = {
      action: 'confirmRoster',
      token: TOKEN,
      isParticipating: participating,
      ownerParticipantId: participating ? (state.ownerParticipantId || null) : null,
      roster: state.roster
        .filter(function (p) { return p.participantId !== state.ownerParticipantId; })
        .map(function (p) {
          return { participantId: p.participantId, name: p.name, age: p.age, fitness: p.fitness, email: p.email, isParticipating: true };
        }),
    };
    return apiPost('/api/adventure-prep', payload).then(function (res) {
      // Mirror locally, same "don't wait for a reload to reflect a save"
      // reasoning as saveFields()'s own state.ctx.adventurePrep mirroring
      // above — computeHubStatus() reads state.ctx.adventurePrep.isParticipating,
      // not state.isParticipating.
      if (res.ok && state.ctx) {
        state.ctx.adventurePrep = state.ctx.adventurePrep || {};
        state.ctx.adventurePrep.isParticipating = !!state.isParticipating;
      }
      // BUG FIX (Task 17 jsdom smoke test, 2026-08-31): the above only
      // ever mirrored adventurePrep.isParticipating — nothing mirrored the
      // roster's own ownership designation into state.roster (as opposed
      // to state.ctx.roster, which is never re-fetched until a reload).
      // waiverSigners() and renderInvite() both read state.roster's
      // per-entry roleOnBooking directly, so without this, a guest who
      // just confirmed the roster for the first time couldn't tap their
      // own row on the Waivers screen (nothing was recognized as
      // roleOnBooking==='owner' yet) and the invite screen would still
      // list them as someone to send a waiver link to — both wrong until
      // a full page reload re-fetched context. Mirrors exactly what
      // lib/adventure-prep-service.js's confirmRoster itself does
      // server-side: reset any previous owner back to 'attendee', then
      // (only when participating) mark the designated row 'owner'; every
      // other roster entry actually sent keeps its existing
      // roleOnBooking and just gets isParticipating: true, matching what
      // was posted.
      if (res.ok) {
        var sentIds = {};
        payload.roster.forEach(function (e) { sentIds[e.participantId] = true; });
        state.roster.forEach(function (p) {
          if (participating && p.participantId === state.ownerParticipantId) {
            p.roleOnBooking = 'owner';
            p.isParticipating = true;
          } else if (p.roleOnBooking === 'owner') {
            p.roleOnBooking = 'attendee';
          }
          if (sentIds[p.participantId]) p.isParticipating = true;
        });
      }
      return res;
    });
  }

  // Guards saveConfirmRoster() against writing a premature "not
  // participating" for a guest who hasn't answered that question yet
  // (feedback round, Sep 2026 -- confirmRoster's payload.isParticipating
  // is server-side coerced with `!!`, so an undecided `null` would
  // otherwise be sent, and read back, as a real "no"). Used by every
  // Attendees screen's "Save & Return to Adventure Home" action; each
  // screen's own Continue already validates isParticipating is answered
  // before ever calling saveConfirmRoster() directly.
  function saveConfirmRosterIfDecided() {
    if (state.isParticipating === null) return Promise.resolve({ ok: true });
    return saveConfirmRoster();
  }

  // Shared icon-set follow-up (Sept 2026 walkthrough): the alert "!" badge
  // and the trail-guide lock note were still the pre-icon-set treatment
  // (a solid sunset-red circle with a literal "!" character, and a raw
  // 🔒 emoji) -- rebuilt in the same "Style B" line/salmon-accent language
  // as the .ap-tile-icon SVGs above (dark-pine #2A4747 strokes, #F58271
  // salmon accents) so every icon on the hub reads as one consistent set.
  var ALERT_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="#2A4747" stroke-width="1.4"/><path d="M12 7.6v6" stroke="#F58271" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="16.8" r="1.15" fill="#F58271"/></svg>';
  var LOCK_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="5.5" y="10.3" width="13" height="10.2" rx="2" stroke="#2A4747" stroke-width="1.4"/><path d="M8.2 10.3V7.7a3.8 3.8 0 0 1 7.6 0v2.6" stroke="#2A4747" stroke-width="1.4" stroke-linecap="round"/><circle cx="12" cy="15.1" r="1.2" fill="#F58271"/><path d="M12 16.3v1.5" stroke="#F58271" stroke-width="1.3" stroke-linecap="round"/></svg>';

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
  // REWRITTEN (Task 15, 2026-08-31): used to match waiver_signatures rows
  // to roster entries by positional index (`String(w.rosterRef) === String(i)`)
  // and infer minor guardian coverage by scanning
  // waiverSignatures[].participantsCoveredJson for a name match — both
  // gone now that waiver_signatures.participant_id is a real column
  // (lib/waiver-service.js) and guardian coverage is a real fact on the
  // roster row itself (guardianVerifiedAt, set by that file's
  // applyGuardianCertification). `index` is gone from this function's
  // return shape too — every caller now keys off `participantId`.
  // Also now excludes anyone the booker has marked not participating
  // (isParticipating === false) from the list entirely — a person who's
  // not on the trip doesn't need a waiver, matching
  // sendSignerLinksForBooking's own server-side eligibility filter — but
  // keeps guardian_only rows (non-attending assigned guardians, who do
  // still need to sign).
  function waiverSigners() {
    var signatures = state.ctx.waiverSignatures || [];
    return state.roster
      .filter(function (p) { return p.isParticipating !== false || p.roleOnBooking === 'guardian_only'; })
      .map(function (p) {
        var isOwner = p.roleOnBooking === 'owner';
        var isMinor = !!MINOR_BUCKETS[p.age];
        var name = p.name || (isOwner ? 'You' : 'Unnamed');
        if (isMinor) {
          var isDone = !!p.guardianVerifiedAt;
          return {
            participantId: p.participantId, name: name, isOwner: false, isMinor: true,
            isDone: isDone,
            subLabel: isDone ? 'Guardian confirmed' : (p.guardianPersonId ? 'Guardian invited, not yet confirmed' : 'Needs a signing guardian assigned'),
            canRemind: false,
            email: '',
          };
        }
        var sig = isOwner
          ? signatures.filter(function (w) { return w.role === 'owner'; })[0]
          : signatures.filter(function (w) { return w.participant_id === p.participantId; })[0];
        var isDone = !!sig && sig.status === 'signed';
        return {
          participantId: p.participantId, name: name, isOwner: isOwner, isMinor: false,
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
    // BUG FIX (Task 15): ap.reconfirmedRosterJson no longer exists (see
    // this file's header comment) — "has the roster reconfirmation step
    // run at least once" is now the same signal confirmRoster itself
    // commits to: adventure_prep.is_participating starts NULL (see
    // db/schema.sql) and is only ever set (true or false) by a real
    // confirmRoster call.
    var rosterDone = ap.isParticipating !== null && ap.isParticipating !== undefined;
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
    // Sept 2026 walkthrough follow-up: the hub used to show just the
    // trail name here (a separate, name-only ap-trail-* block) -- Airey
    // asked for the same card styling used on the selection/confirmation
    // screens (distance/elevation/brief description) to carry through
    // once a trail is picked and the guest is back on the hub. Reuses
    // compareCardHtml() with the full candidate object from
    // ap.candidateTrails rather than just status.trailName.
    var selectedTrailCandidate = null;
    if (status.trailSelected) {
      var hubCandidateTrails = ap.candidateTrails;
      try { hubCandidateTrails = typeof hubCandidateTrails === 'string' ? JSON.parse(hubCandidateTrails || '[]') : (hubCandidateTrails || []); } catch (e) { hubCandidateTrails = []; }
      selectedTrailCandidate = hubCandidateTrails.filter(function (c) { return c.trailId === ap.selectedTrailId; })[0] || { trailName: status.trailName };
    }
    var trailSectionHtml = !status.trailSelected ? '' :
      '<div class="ap-trail-section-wide">' +
      compareCardHtml(selectedTrailCandidate, null, null, false) +
      (pastT3
        ? '<div class="ap-trail-unlocked"><div class="ap-trail-unlocked-text">Your guide is ready: turn-by-turn navigation, waypoints, and everything else for the trail.</div><button type="button" class="ap-trail-download-btn" id="ap-get-guide">Get Guide</button></div>'
        : '<div class="ap-trail-locked-note"><span class="lock-icon">' + LOCK_ICON_SVG + '</span> Your trail guide and turn-by-turn navigation unlock 3 days before your adventure day.</div>') +
      '</div>';

    // Icons: Style B ("Line, salmon accent") from the icon-options
    // comparison Airey picked from, 2026-09-02 -- inline SVG strings,
    // same 42px sand-beige .ap-tile-icon square as before, replacing the
    // raw emoji this used to hold.
    function tile(icon, title, sub, status2, locked, onClick) {
      return { icon: icon, title: title, sub: sub, statusLabel: status2, locked: !!locked, onClick: onClick };
    }

    var tiles = [
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.3" stroke="#2A4747" stroke-width="1.4"/><path d="M12 3.3v1.6" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round"/><path d="M12 12l3-5-1 5.6z" fill="#F58271"/><path d="M12 12l-3 5 1-5.6z" fill="#2A4747"/><circle cx="12" cy="12" r="1" fill="#2A4747"/></svg>', 'Trail Recommendation',
        status.trailSelected ? status.trailName : 'Tell us what you’re after and we’ll find your trail',
        status.hasUnreviewedManualPick ? 'In review' : (status.trailSelected ? 'Done' : 'Not done'),
        false, function () { state.step = status.trailSelected ? 'trail' : 'preferences'; render(); }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8.6" r="2.9" stroke="#F58271" stroke-width="1.3"/><path d="M4 19.3c0-3.7 2.2-6.1 5-6.1s5 2.4 5 6.1" stroke="#F58271" stroke-width="1.3" stroke-linecap="round"/><circle cx="15.3" cy="9.2" r="2.3" stroke="#2A4747" stroke-width="1.2"/><path d="M12.6 19.3c.2-3 1.9-4.9 3.9-4.9 2.3 0 4.1 2.4 4.1 5.4" stroke="#2A4747" stroke-width="1.2" stroke-linecap="round"/></svg>', 'Attendees',
        status.rosterDone ? (state.roster.length + ' in your group') : 'Confirm who’s coming and invite your group',
        status.rosterDone ? 'Done' : 'Not done', false,
        function () { state.step = 'roster'; render(); }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M8.3 8.2c0-2.4 1.7-4.3 3.7-4.3s3.7 1.9 3.7 4.3" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round"/><rect x="5.8" y="8.2" width="12.4" height="12" rx="3" stroke="#2A4747" stroke-width="1.4"/><path d="M9 8.2v2.6" stroke="#2A4747" stroke-width="1.2" stroke-linecap="round"/><path d="M15 8.2v2.6" stroke="#2A4747" stroke-width="1.2" stroke-linecap="round"/><rect x="9" y="13.4" width="6" height="4.4" rx="1.2" stroke="#F58271" stroke-width="1.2"/></svg>', 'Gear Kits &amp; Delivery/Pickup',
        status.gearDone ? (status.kitCount + ' kits · Gear delivery ' + (ap.deliveryWindow || state.deliveryWindow)) : 'Choose your kits and delivery details',
        status.gearDone ? 'Done' : 'Not done', false,
        function () { state.step = 'planning'; render(); }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4.3 16.6c1.7-2.6 2.6 2.6 4.3 0s2.6 2.6 4.3 0 2.6 2.6 4.3 0" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 6.3l4.3 4.3" stroke="#F58271" stroke-width="1.4" stroke-linecap="round"/><circle cx="18.7" cy="11" r="1.2" fill="#F58271"/></svg>', 'Waivers',
        status.signers.length ? (status.signers.filter(function (s) { return s.isDone; }).length + ' of ' + status.signers.length + ' signed') : 'Sign your waiver',
        status.waiversDone ? 'Done' : 'Not done', false,
        function () { state.step = 'waiver'; render(); }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="5.2" y="4.4" width="13.6" height="16.6" rx="2" stroke="#2A4747" stroke-width="1.3"/><rect x="9" y="2.7" width="6" height="3" rx="1" stroke="#2A4747" stroke-width="1.2"/><path d="M8.3 10h6.4M8.3 13.4h4.6" stroke="#2A4747" stroke-width="1.1" stroke-linecap="round"/><path d="M8.3 17l1.9 1.9 3.7-3.9" stroke="#F58271" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>', 'Adventure Summary',
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
      alertHtml = '<div class="ap-alert"><div class="ap-alert-icon">' + ALERT_ICON_SVG + '</div><div class="ap-alert-text"><b>Waivers lock at ' + formatCutoffLabel() + '.</b><br>' + missingCount + ' ' + (missingCount === 1 ? 'person on your list hasn’t' : 'people on your list haven’t') + ' signed yet.</div></div>';
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
  // `index` (the roster row's position in state.roster) is still used
  // here purely as a DOM-wiring convenience (data-idx, read back via
  // state.roster[idx]) — safe within one render cycle since state.roster
  // doesn't reorder itself; it is NEVER sent to the server anymore (see
  // renderRoster's save handlers below, which build their payload from
  // each entry's real participantId).
  function rosterRowHtml(person, index) {
    var age = person.age || person.ageRange || '';
    var isMinor = !!MINOR_BUCKETS[age];
    // Unlike adventure-form.js's own age <select> (which prepends a
    // non-selectable "Age range" placeholder), every entry in AGE_BUCKETS
    // is itself a real, selectable value — no placeholder needed here.
    var ageOptionsHtml = AGE_BUCKETS.map(function (bucket) {
      return '<option value="' + escapeHtml(bucket) + '"' + (age === bucket ? ' selected' : '') + '>' + escapeHtml(bucket) + '</option>';
    }).join('');
    var fitnessOptionsHtml = '<option value="">Fitness level</option>' + FITNESS_OPTIONS.map(function (f) {
      return '<option value="' + escapeHtml(f) + '"' + ((person.fitness || '') === f ? ' selected' : '') + '>' + escapeHtml(f) + '</option>';
    }).join('');
    // Email capture moved to its own screen (renderRosterContact, feedback
    // round Sep 2026) -- this row is now just name/age/fitness, matching
    // this screen's narrowed purpose ("confirm the participating roster").
    return '<div class="paf-roster-row">' +
      '<input class="paf-roster-input paf-roster-name" data-idx="' + index + '" value="' + escapeHtml(person.name || '') + '" placeholder="Name">' +
      '<select class="paf-roster-input paf-roster-age" data-idx="' + index + '">' + ageOptionsHtml + '</select>' +
      (isMinor ? '<span class="paf-roster-tag">Minor</span>' : '<select class="paf-roster-input paf-roster-fit" data-idx="' + index + '">' + fitnessOptionsHtml + '</select>') +
      '</div>';
  }

  // ---------------------------------------------------------------------
  // Attendees micro-flow, step 1 of 4 ("confirm the participating
  // roster"). Feedback round, Sep 2026: this used to be one screen doing
  // three things at once -- roster edits, the "are you joining" question,
  // and email capture. Split into four: this screen (roster basics only),
  // renderRosterParticipation (step 2, the Yes/No + "which one is you"
  // question), renderRosterContact (step 3, email addresses), and the
  // existing renderInvite (step 4, confirm & send).
  //
  // Deliberately does NOT call saveConfirmRoster() on its own Continue --
  // that action requires a decided isParticipating (server-side coerced
  // with `!!`, see lib/adventure-prep-service.js's confirmRoster), and
  // this screen runs before that question is ever asked. The real save
  // happens once, on renderRosterParticipation's Continue, combining both
  // screens' edits together exactly as the original single screen did.
  // "Save & Return" here goes through saveConfirmRosterIfDecided() instead
  // (a no-op network-wise until isParticipating is known) so a returning
  // guest tweaking their roster mid-flow still saves correctly, without
  // ever risking writing a premature "not participating" for a guest who
  // hasn't answered that yet -- a real risk in the original screen's own
  // "Save & Return", which called saveConfirmRoster() unconditionally.
  // ---------------------------------------------------------------------
  function renderRoster() {
    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      attendeesFlowTopHtml(0, 'ap-flow-back', '&larr; Adventure Home') +
      '<div class="ap-eyebrow">Attendees</div>' +
      '<h1 class="ap-q">Confirm your group</h1>' +
      '<p class="ap-sub">Make sure everyone’s name, age, and fitness level are right before we reach out to your group.</p>' +
      '<div class="ap-card">' +
      '<div class="paf-roster" style="border-top:none; padding-top:0; margin-top:0;">' +
      '<div class="paf-roster-sub">Your group</div>' +
      '<div id="ap-roster-rows"></div>' +
      '<div class="ap-helper" style="margin:0.4rem 0 0;">Need to add or remove someone? <a href="mailto:hello@palmspringsadventureclub.com" style="color:var(--mountain-pink);">Email us</a> and we’ll help you update it.</div>' +
      '</div>' +
      '</div>' +
      '<button type="button" class="ap-cta-primary" id="ap-next">Continue</button>' +
      '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>' +
      '</div></div>'
    );

    function renderRosterRows() {
      wrap.querySelector('#ap-roster-rows').innerHTML = state.roster.map(function (p, i) {
        return rosterRowHtml(p, i);
      }).join('');
      // Name: plain text input, update state on 'input' only, no
      // re-render, so typing a correction doesn't lose cursor focus
      // mid-word.
      Array.prototype.forEach.call(wrap.querySelectorAll('.paf-roster-name'), function (input) {
        input.addEventListener('input', function () {
          var idx = Number(input.getAttribute('data-idx'));
          state.roster[idx].name = input.value;
        });
      });
      // Age: a <select>, no cursor position to lose, so a full
      // re-render is safe here — needed because changing age can flip
      // isMinor, which changes whether this row shows a fitness dropdown
      // or a "Minor" tag.
      Array.prototype.forEach.call(wrap.querySelectorAll('.paf-roster-age'), function (select) {
        select.addEventListener('change', function () {
          var idx = Number(select.getAttribute('data-idx'));
          state.roster[idx].age = select.value;
          renderRosterRows();
        });
      });
      // Fitness: doesn't affect layout or minor status, just update state.
      Array.prototype.forEach.call(wrap.querySelectorAll('.paf-roster-fit'), function (select) {
        select.addEventListener('change', function () {
          var idx = Number(select.getAttribute('data-idx'));
          state.roster[idx].fitness = select.value;
        });
      });
    }

    renderRosterRows();

    wrap.querySelector('#ap-flow-back').addEventListener('click', function () { state.step = 'hub'; render(); });
    wrap.querySelector('#ap-save-and-return').addEventListener('click', function () {
      saveConfirmRosterIfDecided().then(function () { state.step = 'hub'; render(); });
    });
    wrap.querySelector('#ap-next').addEventListener('click', function () {
      state.step = 'rosterParticipation';
      render();
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Attendees micro-flow, step 2 of 4 ("verify if the booker is one of
  // the participants"). Split out from the old combined roster screen --
  // see renderRoster's own header comment above. This is where the real
  // confirmRoster save happens: step 1's roster edits plus this screen's
  // isParticipating/ownerParticipantId, all together in one call, exactly
  // matching what the original single screen sent.
  // ---------------------------------------------------------------------
  function renderRosterParticipation() {
    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      attendeesFlowTopHtml(1, 'ap-flow-back', '&larr; Back') +
      '<div class="ap-eyebrow">Attendees</div>' +
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
      '<div id="ap-roster-error" class="ap-error"></div>' +
      '</div>' +
      '<button type="button" class="ap-cta-primary" id="ap-next">Continue</button>' +
      '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>' +
      '</div></div>'
    );

    // REWRITTEN (Task 15): keyed on the real participantId now, not a
    // positional array index (see this file's header comment, point 1).
    function renderWhoIsYou() {
      var el = wrap.querySelector('#ap-whoisyou-opts');
      el.innerHTML = state.roster.map(function (p) {
        var age = p.age || p.ageRange || '';
        var label = (p.name || 'Unnamed') + ' · ' + age + (p.fitness ? ' · ' + p.fitness : '');
        return '<button type="button" class="paf-option-btn' + (state.ownerParticipantId === p.participantId ? ' is-selected' : '') + '" data-participant-id="' + escapeHtml(p.participantId) + '">' + escapeHtml(label) + '</button>';
      }).join('');
      Array.prototype.forEach.call(el.querySelectorAll('button'), function (btn) {
        btn.addEventListener('click', function () {
          state.ownerParticipantId = btn.getAttribute('data-participant-id');
          renderWhoIsYou();
        });
      });
    }

    function setJoining(val) {
      state.isParticipating = val === 'yes';
      Array.prototype.forEach.call(wrap.querySelectorAll('#ap-joining-opts .paf-option-btn'), function (btn) {
        btn.classList.toggle('is-selected', btn.getAttribute('data-val') === val);
      });
      wrap.querySelector('#ap-whoisyou-wrap').style.display = state.isParticipating ? '' : 'none';
      // BUG FIX (Attendees walkthrough, Sep 2026): switching the answer to
      // "No" needs to clear any prior "which one of these is you" selection
      // -- otherwise that roster row would carry a stale owner designation
      // with no way left on this screen to un-mark it.
      if (!state.isParticipating) {
        if (state.ownerParticipantId) {
          state.ownerParticipantId = '';
          renderWhoIsYou();
        }
      } else if (state.roster.length === 1 && !state.ownerParticipantId) {
        // On a single-person booking there’s nothing to ask "which
        // one of these is you" -- it can only be them.
        state.ownerParticipantId = state.roster[0].participantId;
        renderWhoIsYou();
      }
    }

    Array.prototype.forEach.call(wrap.querySelectorAll('#ap-joining-opts .paf-option-btn'), function (btn) {
      btn.addEventListener('click', function () { setJoining(btn.getAttribute('data-val')); });
    });

    if (state.isParticipating === true) setJoining('yes');
    else if (state.isParticipating === false) setJoining('no');
    renderWhoIsYou();

    wrap.querySelector('#ap-flow-back').addEventListener('click', function () { state.step = 'roster'; render(); });
    wrap.querySelector('#ap-save-and-return').addEventListener('click', function () {
      saveConfirmRosterIfDecided().then(function () { state.step = 'hub'; render(); });
    });
    wrap.querySelector('#ap-next').addEventListener('click', function () {
      if (state.isParticipating === null) {
        wrap.querySelector('#ap-roster-error').textContent = 'Let us know if you’re joining the adventure.';
        return;
      }
      if (state.isParticipating && !state.ownerParticipantId) {
        wrap.querySelector('#ap-roster-error').textContent = 'Tap which row on the roster is you.';
        return;
      }
      saveConfirmRoster().then(function (res) {
        if (!res.ok) { wrap.querySelector('#ap-roster-error').textContent = 'Something went wrong saving that, try again.'; return; }
        var signers = computeAttendeeSigners();
        // Skip straight to Send Invites when nobody needs a waiver-link
        // email (e.g. a solo booking where the booker is the only
        // participant) -- there's nothing for the Contact Info screen to
        // collect in that case.
        state.step = signers.length ? 'rosterContact' : 'invite';
        render();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Attendees micro-flow, step 3 of 4 ("Contact Info" -- collect a waiver
  // email for everyone who needs one). New screen, feedback round Sep
  // 2026: "we're asking this screen to do a lot" was the original single
  // screen's problem; this is the piece that used to be an inline email
  // field on each roster row. Skipped entirely (see
  // renderRosterParticipation's Continue handler) when
  // computeAttendeeSigners() comes back empty.
  // ---------------------------------------------------------------------
  function renderRosterContact() {
    var signers = computeAttendeeSigners();

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      attendeesFlowTopHtml(2, 'ap-flow-back', '&larr; Back') +
      '<div class="ap-eyebrow">Attendees</div>' +
      '<h1 class="ap-q">Add an email for each person</h1>' +
      '<p class="ap-sub">Please enter a valid email address for each person so they can sign a participation waiver.</p>' +
      '<div class="ap-card">' +
      '<div id="ap-contact-rows">' + signers.map(function (p) {
        var meta = [p.age, p.fitness].filter(Boolean).join(' · ');
        return '<div class="paf-roster-row">' +
          '<div style="flex:2; min-width:0;"><div style="font-weight:600; font-size:0.86rem; color:var(--dark-pine);">' + escapeHtml(p.name || '') + '</div><div style="font-size:0.74rem; color:var(--ap-muted);">' + escapeHtml(meta) + '</div></div>' +
          '<input class="ap-contact-email" data-participant-id="' + escapeHtml(p.participantId) + '" type="email" placeholder="' + escapeHtml((p.name || 'Their') + '’s email') + '" value="' + escapeHtml(p.email || '') + '" style="flex:2; min-width:220px; border:1px solid rgba(42,71,71,0.18); border-radius:6px; padding:0.6rem 0.7rem; background:var(--sand-beige); color:var(--dark-pine); font-family:inherit; font-size:0.82rem;">' +
          '</div>';
      }).join('') + '</div>' +
      '<div id="ap-contact-error" class="ap-error"></div>' +
      '</div>' +
      '<div class="ap-deposit-note" style="margin-bottom:1.2rem;">A waiver is required to be completed by each participant 3 days prior to the adventure day or gear will not be delivered for any participant with an unsigned waiver.</div>' +
      '<button type="button" class="ap-cta-primary" id="ap-next">Continue</button>' +
      '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>' +
      '</div></div>'
    );

    Array.prototype.forEach.call(wrap.querySelectorAll('.ap-contact-email'), function (input) {
      input.addEventListener('change', function () {
        var pid = input.getAttribute('data-participant-id');
        var person = state.roster.filter(function (r) { return r.participantId === pid; })[0];
        if (person) person.email = input.value.trim();
      });
    });

    wrap.querySelector('#ap-flow-back').addEventListener('click', function () { state.step = 'rosterParticipation'; render(); });
    wrap.querySelector('#ap-save-and-return').addEventListener('click', function () {
      saveConfirmRosterIfDecided().then(function () { state.step = 'hub'; render(); });
    });
    wrap.querySelector('#ap-next').addEventListener('click', function () {
      var errEl = wrap.querySelector('#ap-contact-error');
      var invalid = signers.filter(function (p) { return !isValidEmail(p.email); });
      if (invalid.length) {
        errEl.textContent = 'Add a valid email for ' + invalid.map(function (p) { return p.name || 'this person'; }).join(', ') + ' before continuing.';
        return;
      }
      errEl.textContent = '';
      saveConfirmRoster().then(function (res) {
        if (!res.ok) { errEl.textContent = 'Something went wrong saving that, try again.'; return; }
        state.step = 'invite';
        render();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Attendees micro-flow, step 4 of 4: Send Invites (was renderReview — the old
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

  // REWRITTEN (Task 15): `signers` here is now local-preview-only — it
  // mirrors lib/waiver-service.js's sendSignerLinksForBooking's own
  // eligibility filter (attending, non-owner, non-minor adults, plus any
  // guardian_only rows) purely so the guest can see who's about to get a
  // link. It is NEVER sent to the server — the server derives its own
  // list from booking_participants now (see this file's header comment,
  // point 6).
  function renderInvite() {
    var ap = state.ctx.adventurePrep || {};
    var signers = computeAttendeeSigners();
    var missingEmail = signers.filter(function (p) { return !isValidEmail(p.email); });
    // ap.linksSentAt never existed in the new schema — this field was
    // never written by sendSignerLinksForBooking, which only ever touches
    // waiver_signatures, not adventure_prep. Approximate the same "have we
    // sent before" signal locally instead of a field that doesn't exist.
    var hasSentBefore = (state.ctx.waiverSignatures || []).some(function (w) { return w.role === 'non_owner'; });

    // BUG FIX (Attendees walkthrough, Sep 2026): "this screen is useless on
    // a solo booking" — when the booker is the only person on the roster
    // and they said "Yes, I'm joining", `signers` is always empty by
    // construction (the owner is filtered out and there's no one else).
    // The old copy ("Let's reach the rest of your group") plus an enabled
    // "Send Invites" button that sent to zero people was confusing on
    // exactly this booking shape. Split into two variants: a pure
    // roster-confirmation screen here, and the existing send-links screen
    // for every other booking shape (booker not participating, or more
    // than one person on the roster).
    var soloBookerOnly = state.roster.length === 1 && state.isParticipating === true;

    if (soloBookerOnly) {
      var soloWrap = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        attendeesFlowTopHtml(3, 'ap-back-to-hub', '&larr; Adventure Home') +
        '<div class="ap-eyebrow">Attendees</div>' +
        '<h1 class="ap-q">Your roster is confirmed</h1>' +
        '<div class="ap-card">' +
        state.roster.map(function (s) {
          var meta = [s.age, s.fitness].filter(Boolean).join(' · ');
          return '<div class="review-recipient"><div><div class="review-recipient-name">' + escapeHtml(s.name || '') + '</div><div class="review-recipient-email">' + escapeHtml(meta) + '</div></div><span class="review-recipient-tag">You</span></div>';
        }).join('') +
        '</div>' +
        '<button type="button" class="ap-cta-primary" id="ap-invite-done">Return to Adventure Home</button>' +
        '</div></div>'
      );
      soloWrap.querySelector('#ap-back-to-hub').addEventListener('click', function () { state.step = 'hub'; render(); });
      soloWrap.querySelector('#ap-invite-done').addEventListener('click', function () { state.step = 'hub'; render(); });
      return soloWrap;
    }

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      attendeesFlowTopHtml(3, 'ap-back-to-hub', '&larr; Adventure Home') +
      '<div class="ap-eyebrow">Attendees</div>' +
      '<h1 class="ap-q">Send waiver links and adventure invites to your group</h1>' +
      '<p class="ap-sub">Your group will receive an invite email from Palm Springs Adventure Club so they can confirm their participation and complete their waiver.</p>' +
      '<div class="ap-card">' +
      (signers.length
        ? signers.map(function (s) {
          return '<div class="review-recipient"><div><div class="review-recipient-name">' + escapeHtml(s.name || '') + '</div><div class="review-recipient-email">' + escapeHtml(s.email || 'no email on file yet') + '</div></div></div>';
        }).join('')
        : '<p class="ap-helper">No one else on this booking needs their own waiver link.</p>') +
      (missingEmail.length ? '<div class="ap-error" style="margin-bottom:1rem;">Add an email for ' + missingEmail.map(function (p) { return escapeHtml(p.name || 'this person'); }).join(', ') + ' before sending, they need it for their own link. <a href="#" id="ap-back-to-roster" style="color:var(--mountain-pink);">Go back and add it</a></div>' : '') +
      '<div id="ap-invite-error" class="ap-error"></div>' +
      (signers.length
        ? '<button class="ap-nav-next" id="ap-send-invites" style="width:100%; padding:1rem;"' + (missingEmail.length ? ' disabled' : '') + '>' + (hasSentBefore ? 'Resend Invites' : 'Send Invites') + '</button>'
        : '') +
      '</div>' +
      '</div></div>'
    );

    wrap.querySelector('#ap-back-to-hub').addEventListener('click', function () { state.step = 'hub'; render(); });
    var backLink = wrap.querySelector('#ap-back-to-roster');
    if (backLink) backLink.addEventListener('click', function (e) { e.preventDefault(); state.step = 'rosterContact'; render(); });

    var sendBtn = wrap.querySelector('#ap-send-invites');
    if (sendBtn) sendBtn.addEventListener('click', function (e) {
      e.target.disabled = true;
      // No `signers` payload anymore — the server derives its own list
      // (see this function's own header comment above).
      apiPost('/api/adventure-prep', {
        action: 'sendSignerLinks',
        token: TOKEN,
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
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
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
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
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
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
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
  // Short-summary generator for trail cards (Sept 2026 walkthrough: full
  // opening_description made the cards "far too compact"/overflowing).
  // trails.what_makes_it_special exists in the schema as a possible short-
  // copy source, but it's unpopulated/unused everywhere in the app today
  // and there's no way to inspect real values from here -- so this derives
  // a summary from the existing overviewCopy (opening_description) instead,
  // which ships without any data/schema dependency. Cuts at the last full
  // sentence that fits within maxLen, falling back to the last word
  // boundary + an ellipsis. If Airey populates what_makes_it_special with
  // real short-form copy later, swap the summarize() call below for that
  // field directly.
  function summarize(text, maxLen) {
    if (!text) return '';
    var trimmed = text.trim();
    if (trimmed.length <= maxLen) return trimmed;
    var slice = trimmed.slice(0, maxLen);
    var lastSentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
    if (lastSentenceEnd > maxLen * 0.4) {
      return slice.slice(0, lastSentenceEnd + 1);
    }
    var lastSpace = slice.lastIndexOf(' ');
    return slice.slice(0, lastSpace > 0 ? lastSpace : maxLen).replace(/[,;:\s]+$/, '') + '…';
  }

  // `ctaLabel` falsy (null/undefined) renders the card with no CTA button,
  // so the confirmation screen (renderConfirmation) can reuse this exact
  // component just for the consistent name/stats/summary presentation.
  function compareCardHtml(candidate, badge, ctaLabel, ctaDisabled) {
    var desc = summarize(candidate.overviewCopy, 250) || ((candidate.matchedAttributes || []).length
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
      (ctaLabel ? '<button type="button" class="ap-compare-cta' + (badge && (badge.cls === 'badge-recommended' || badge.cls === 'badge-current') ? ' ap-compare-cta-primary' : '') + '"' + (ctaDisabled ? ' disabled' : '') + ' data-trail-id="' + escapeHtml(candidate.trailId) + '">' + escapeHtml(ctaLabel) + '</button>' : '') +
      '</div></div>';
  }

  function renderTrail() {
    var ap = state.ctx.adventurePrep || {};
    var wrap = h('<div class="container ap-wide"><div class="ap-shell" style="padding-top:0;"><div id="ap-trail-content"></div></div></div>');
    var contentEl = wrap.querySelector('#ap-trail-content');

    function flowTopHtml(backLabel) {
      return '<div class="ap-flow-top"><div class="ap-back-link" id="ap-flow-back" style="cursor:pointer; margin-bottom:0;">' + backLabel + '</div><div></div></div>';
    }
    function goHub() { state.trailAssignmentPhase = 'idle'; state.step = 'hub'; render(); }

    // ---- "[Trail] is a great choice!" confirmation, right after choosing ----
    function renderConfirmation(candidate) {
      wrap.classList.remove('ap-wide');
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Trail Recommendation</div>' +
        '<div class="ap-q-title" style="margin-bottom:1rem;">' + escapeHtml(candidate.trailName || 'Your trail') + ' is a great choice!</div>' +
        '<div style="margin-bottom:1.2rem;">' + compareCardHtml(candidate, null, null, false) + '</div>' +
        '<button type="button" class="ap-cta-primary" id="ap-continue-attendees">Continue to Attendees</button>' +
        '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer;">Return to Adventure Home</div>';
      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-continue-attendees').addEventListener('click', function () { state.trailAssignmentPhase = 'idle'; state.step = 'roster'; render(); });
      contentEl.querySelector('#ap-return-hub').addEventListener('click', goHub);
    }

    // ---- In review: 0 qualifying candidates, nothing manual yet ----
    function renderInReview() {
      wrap.classList.remove('ap-wide');
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
      wrap.classList.add('ap-wide');
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
      wrap.classList.remove('ap-wide');
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
        wrap.classList.remove('ap-wide');
        contentEl.innerHTML =
          flowTopHtml('&larr; Adventure Home') +
          '<div class="ap-eyebrow">Trail Recommendation</div>' +
          '<div class="ap-q-title" style="margin-bottom:1rem;">Want a different trail?</div>' +
          '<div style="margin-bottom:1.4rem;">' + compareCardHtml(current, { text: 'Currently Set', cls: 'badge-current' }, null, false) + '</div>' +
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
          else { renderAskTeamForm(); }
        });
      }
      draw();
    }

    // ---- Change Your Trail: pick from the existing candidate set ----
    // Decided (handoff notes on mockup-02): reuses the full comparison-card
    // grid rather than a shortened list, with the current pick badged
    // "Currently Set" instead of "Recommended".
    function renderChangeGrid(candidates, current) {
      wrap.classList.add('ap-wide');
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

    // ---- "Ask our team": a guest-typed note, sent the same way the
    // header's "Questions?" panel sends (Resend, to reservations@, guest
    // email as reply-to -- api/send-help-message.js), plus a real
    // trail_swap_requests row via that endpoint's requestType: 'trail_swap'
    // handling, so this now surfaces in Ops' Trail Swap Requests alert
    // like a staff-logged one does. Replaces the previous mailto: fallback
    // this file used to flag as a known gap ("no dedicated backend field/
    // action exists for a guest-initiated 'please review my trail' flag").
    function renderAskTeamForm() {
      wrap.classList.remove('ap-wide');
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Trail Recommendation</div>' +
        '<div class="ap-q-title" style="margin-bottom:0.5rem;">Tell us what you’re looking for.</div>' +
        '<div class="ap-q-help">Didn’t love the recommended trails? Tell us what you’re looking for and a team member will pick one personally.</div>' +
        '<textarea class="ap-field-textarea" id="ap-ask-team-textarea" style="min-height:90px;" placeholder="What kind of trail do you want?"></textarea>' +
        '<div id="ap-ask-team-error" class="ap-error"></div>' +
        '<button type="button" class="ap-cta-primary" id="ap-ask-team-send">Send Request</button>' +
        '<div class="ap-cta-secondary" id="ap-ask-team-cancel" style="cursor:pointer;">Never mind, go back</div>';
      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-ask-team-cancel').addEventListener('click', renderChangeEntry);
      var sendBtn = contentEl.querySelector('#ap-ask-team-send');
      var errEl = contentEl.querySelector('#ap-ask-team-error');
      var textarea = contentEl.querySelector('#ap-ask-team-textarea');
      sendBtn.addEventListener('click', function () {
        var message = textarea.value.trim();
        errEl.textContent = '';
        if (!message) { errEl.textContent = 'Let us know what you’re looking for.'; textarea.focus(); return; }
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending…';
        apiPost('/api/send-help-message', { token: TOKEN, message: message, requestType: 'trail_swap' }).then(function (res) {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send Request';
          if (res.ok && res.body && res.body.status === 'sent') {
            renderAskTeamConfirm();
          } else {
            errEl.textContent = (res.body && res.body.message) || 'Something went wrong sending that -- try again, or email us directly at reservations@palmspringsadventureclub.com.';
          }
        }).catch(function () {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send Request';
          errEl.textContent = 'Something went wrong sending that -- try again, or email us directly at reservations@palmspringsadventureclub.com.';
        });
      });
    }

    function renderAskTeamConfirm() {
      wrap.classList.remove('ap-wide');
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
    // instead of re-running assignment or re-showing the choose grid.
    // BUG FIX (Sept 2026): state.forceTrailRefresh also has to bypass this
    // -- "Answer the questions differently" sets it and routes back here
    // via state.step = 'trail' with trailAssignmentPhase left 'idle' (not
    // 'justChosen'), so without this check the gate below always matched
    // ap.selectedTrailId still being set and sent the guest right back to
    // the "Want a different trail?" screen instead of actually
    // re-running the assignment and showing new candidates. ----
    if (ap.selectedTrailId && state.trailAssignmentPhase !== 'justChosen' && !state.forceTrailRefresh) {
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

    // NEW (Task 15, 2026-08-31): reconfirmedRosterJson no longer exists
    // (see this file's header comment, point 3) — saveFields silently
    // rejected it, so this screen's kit toggle never actually persisted
    // against the real backend. Posts to the new, narrow
    // setRosterGearKits action instead (lib/adventure-prep-service.js),
    // sending every roster entry's current gearKit value (not just the
    // eligible ones — harmless to also write false for an ineligible
    // entry, and simpler than tracking which entries actually changed).
    function saveRosterGearKits() {
      var updates = state.roster.map(function (p) {
        return { participantId: p.participantId, gearKit: p.gearKit !== false };
      });
      return apiPost('/api/adventure-prep', { action: 'setRosterGearKits', token: TOKEN, updates: updates });
    }

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
          saveRosterGearKits().then(goHub);
        });
        contentEl.querySelector('#ap-next').addEventListener('click', function () {
          if (kitCount < 1) {
            contentEl.querySelector('#ap-kit-error').textContent = 'At least 1 gear kit is required to continue.';
            return;
          }
          saveRosterGearKits().then(function (res) {
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
        ? '<div class="ap-alert"><div class="ap-alert-icon">' + ALERT_ICON_SVG + '</div><div class="ap-alert-text"><b>Waivers lock at ' + formatCutoffLabel() + '.</b> Gear rental will be cancelled for anyone who hasn’t finished theirs.</div></div>'
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
          return '<div class="ap-toggle-row" data-guardian-participant-id="' + escapeHtml(m.participantId || '') + '" style="cursor:pointer;">' +
            '<div class="ap-toggle-row-text" style="font-weight:500; font-size:0.78rem;">I am the parent/guardian of ' + escapeHtml(m.name || 'this child') + ' (' + escapeHtml(m.age || m.ageRange || '') + ') and I’m signing on their behalf</div>' +
            '<div class="ap-switch' + (state.guardianForChildrenParticipantIds.indexOf(m.participantId) !== -1 ? ' on' : '') + '"></div>' +
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
      Array.prototype.forEach.call(contentEl.querySelectorAll('[data-guardian-participant-id]'), function (row) {
        row.addEventListener('click', function () {
          var participantId = row.getAttribute('data-guardian-participant-id');
          var idx = state.guardianForChildrenParticipantIds.indexOf(participantId);
          if (idx === -1) state.guardianForChildrenParticipantIds.push(participantId); else state.guardianForChildrenParticipantIds.splice(idx, 1);
          row.querySelector('.ap-switch').classList.toggle('on', state.guardianForChildrenParticipantIds.indexOf(participantId) !== -1);
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
        // BUG FIX (Task 15): this used to send `guardianForChildren`
        // (an array of names). lib/waiver-service.js's saveWaiverSignature
        // only ever reads `guardianForChildrenParticipantIds` — the old key
        // was silently ignored, so applyGuardianCertification never ran
        // for a booker signing on behalf of their own child.
        // participantsCovered stays name-based (still stored for the
        // record on the signature row), but is no longer this file's own
        // source of truth for guardian coverage — waiverSigners() now
        // reads booking_participants.guardian_verified_at instead (see
        // that function's own header comment).
        var participantsCovered = [state.waiverName].concat(
          state.roster.filter(function (p) { return state.guardianForChildrenParticipantIds.indexOf(p.participantId) !== -1; }).map(function (p) { return p.name; })
        );
        apiPost('/api/waiver', {
          action: 'saveWaiverSignature',
          token: TOKEN,
          signerName: state.waiverName,
          signerEmail: state.ctx.experienceBooking.contactEmail,
          isGuardian: state.guardianForChildrenParticipantIds.length > 0,
          guardianForChildrenParticipantIds: state.guardianForChildrenParticipantIds,
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
      var ecLine = state.ecName || state.ecPhone
        ? escapeHtml([state.ecName, state.ecPhone].filter(Boolean).join(' \u00b7 '))
        : 'Not provided';
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Waivers</div>' +
        '<div class="ap-recap-title">Your waiver is complete.</div>' +
        '<div class="ap-recap-body">This is confirmation of your waiver signature and emergency contact.</div>' +
        '<div class="ap-recap-card">' +
        '<div class="ap-recap-line"><span>Waiver Signed By</span><b>' + escapeHtml(state.waiverName || '') + '</b></div>' +
        '<div class="ap-recap-line"><span>Emergency Contact</span><b>' + ecLine + '</b></div>' +
        '</div>' +
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
          (s.canRemind ? '<button type="button" class="ap-waiver-remind-btn" data-participant-id="' + escapeHtml(s.participantId) + '">Send reminder</button>' : '') +
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

    // BUG FIX (Task 15): sendSignerLinks no longer accepts a `signers`
    // subset (lib/waiver-service.js's sendSignerLinksForBooking derives
    // and re-sends to EVERY eligible signer every time it's called — see
    // this file's header comment for the flagged behavior change from the
    // old single-recipient resend). This button still triggers the same
    // real call this build already makes elsewhere (renderInvite's own
    // "Send/Resend Invites"), just with honest copy about what it
    // actually does now, rather than a `signers` payload the server
    // ignores.
    Array.prototype.forEach.call(wrap.querySelectorAll('.ap-waiver-remind-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var participantId = btn.getAttribute('data-participant-id');
        var person = signers.filter(function (s) { return s.participantId === participantId; })[0];
        btn.disabled = true;
        apiPost('/api/adventure-prep', {
          action: 'sendSignerLinks',
          token: TOKEN,
        }).then(function (res) {
          wrap.querySelector('#ap-remind-status').textContent = res.ok
            ? 'Reminder emails resent to everyone who hasn\'t signed yet (including ' + (person ? person.name : 'this person') + ').'
            : 'Something went wrong sending that reminder, try again.';
          btn.disabled = false;
        });
      });
    });

    return wrap;
  }

  boot();
})();
