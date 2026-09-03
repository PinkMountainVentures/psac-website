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

   RESOLVED (guardian-assignment UI, 2026-09-02, per Airey's direct
   request and mockup03confirmattendees.html's frames 3a/3b): this screen
   now DOES let the booker proactively name a guardian for each minor —
   renderRosterGuardians(), one screen per participating minor, inserted
   right after the "are you joining" question -- BEFORE Contact Info, not
   after (see the 2026-09-02 update below for why this moved). Picks either
   an attending adult already on the roster (including the owner) or
   captures a non-attending guardian's name + email directly, and calls
   confirmRoster() with the guardianAssignment shape that function has
   supported all along. renderInvite() now also surfaces the minor
   (dimmed, "child, no invite needed") and any non-attending guardian_only
   row (highlighted, badged with which child they're signing for) instead
   of silently omitting both. The self-declare fallback (Model 1,
   preserved in renderSign()/waiver-signer-form.js — an attending adult
   checking "I'm the parent/guardian of ___" at their own signing screen)
   still exists alongside this and still works if a booker skips or gets
   an assignment wrong; the two are independent and don't conflict, since
   saveWaiverSignature's own certification write is idempotent per minor.

   UPDATED (flow-order + hidden guardian rows, live-test feedback,
   2026-09-02): testing on a real "minor + non-attending external
   guardian" booking surfaced three bugs in the above. (1) renderRoster()
   and renderRosterContact() were both rendering the external guardian's
   own guardian_only row as if it were a normal attendee (wrong age/
   fitness placeholders, a bogus "needs an email" prompt) -- both now
   filter guardian_only rows out; only renderInvite() still shows them
   (deliberately, badged). (2) renderRosterContact()'s copy ("Add an
   email for each person") read as if it covered the guardian too --
   retitled to "Add an email for each adult participating in the
   adventure". (3) The guardian-assignment screen(s) now run BEFORE
   Contact Info, not after, per Airey's direct request -- collecting the
   guardian's identity before nagging for email addresses reads better.
   This reopens the exact ordering risk this file used to route around (a
   same-booking adult named as guardian needs a person_id or an email on
   file before confirmRoster() will accept the assignment, and Contact
   Info -- the screen that used to guarantee that -- now runs later):
   renderRosterGuardians() itself now detects an eligible adult with
   neither and collects their email inline, right there on the guardian
   screen, before letting the booker continue (see adultNeedsEmail()
   inside that function). That email round-trips through confirmRoster()'s
   existing person_id-backfill path (lib/adventure-prep-service.js), so
   it's already on file -- and pre-filled -- by the time Contact Info
   actually runs for that same adult.

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

   UPDATED (hub-tile audit + waivers width + guardian self-sign, live-test
   feedback, 2026-09-02): three more follow-ups from the same round. (1)
   Audited every other hub tile for the same "answered part of the
   micro-flow, tile still says Done" gap the Attendees tile had --
   Trail Recommendation's `trailSelected` is fine as-is (selecting a
   trail commits and shows its own terminal confirmation screen in the
   same synchronous step, nothing required comes after), but Gear Kits'
   `gearDone` had the identical bug: propertyType/deliveryAddressLine1
   are saved at the end of the Delivery screen (gearStep 1), but that
   screen's own "Save & return to Adventure Home" exit skips the Pickup
   screen (gearStep 2) entirely, leaving return_preference (and every
   other pickup field) NULL. `gearDone` now also requires
   `ap.returnPreference`, which only ever gets written once the Pickup
   screen itself has been saved. (2) `.ap-alert` and `.ap-wv-row`
   (ap-styles.css) each carried their own hardcoded max-width (720px/
   640px) smaller than the Waivers list screen's new 960px `ap-wide`
   container and with no margin:auto of their own -- inside that wider,
   correctly-centered container they shrank to their own caps and sat
   flush-left. Both caps removed; they now fill their parent exactly
   like .ap-card already did. (3) A booker who's already declared
   themself their minor's legal guardian (renderRosterGuardians(),
   Attendees flow) had no way to actually sign that child's waiver here
   -- the child's row was always readonly, and even the booker's own
   tappable row's guardian toggle (renderSign(), Waivers flow) started
   unchecked every time. Fixed both ends: hydrateWorkingStateFromCtx()
   now pre-populates state.guardianForChildrenParticipantIds with any
   minor whose guardian_person_id already resolves to the booker's own
   person_id and isn't guardian_verified_at yet, and renderList() now
   makes that child's row tappable too (routing into the same
   renderSign() the booker's own row uses). Scoped deliberately to the
   booker-is-the-attending-guardian case, per Airey's own stated
   boundary -- a minor whose assigned guardian isn't attending this trip
   still has to be signed for on Surface B (waiver-signer-form.js) by
   that guardian directly.
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
    guardianChildLegalNames: {}, // NEW (child-waiver capture, 2026-09-03): participantId -> the full legal name the guardian types at signing, keyed separately from the roster's own display name so a nickname/shorthand entered at roster time doesn't silently become the name on the signed record
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

  // NEW (Airey's direct request, 2026-09-05): the Adventure Summary
  // receipt's Gear delivery/pickup lines only ever showed a time window,
  // with no day attached -- ambiguous on a card meant to be read at a
  // glance (and possibly shared). Delivery happens the evening BEFORE the
  // trail day; pickup happens the evening OF the trail day itself (see
  // this file's own Gear Kits Pickup screen copy: "picked up the evening
  // after your adventure"). dayOffset lets both reuse the same date math
  // against experienceBooking.date instead of two copies.
  function formatOffsetDate(dateStr, dayOffset) {
    var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dayOffset));
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(d);
  }

  // NEW (Phase 1/2 escalating hub arc, 2026-09-03): the countdown/
  // delivery-day/trail-day states in renderHub() below need to know
  // TODAY's own Pacific calendar date, not the UTC one -- same
  // technique lib/cadence.js's own pacificDateString already uses
  // server-side, ported here since this file has no shared import path
  // with lib/ (separate client bundle, see this file's header comment).
  function pacificDateString(date) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    var parts = dtf.formatToParts(date).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
    return parts.year + '-' + parts.month + '-' + parts.day;
  }

  // ISO ('YYYY-MM-DD') sibling of formatOffsetDate above -- that one
  // returns a display string ("Tuesday, September 8"), this returns the
  // plain date so it can be compared against pacificDateString(new
  // Date()) to detect "today is delivery day."
  function isoOffsetDateStr(dateStr, dayOffset) {
    var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dayOffset));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  // Small Oxford-style joiner for the "Building momentum" state's "just
  // [X], [Y] and [Z] left" copy below -- no equivalent existed anywhere
  // in this file since nothing previously needed to name a variable-
  // length list of remaining items in one sentence.
  function joinWithAnd(items) {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return items[0] + ' and ' + items[1];
    return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  // NEW (Airey's nav-experience discussion, 2026-09-03): Adventure Prep
  // has no per-screen URL routing at all -- state.step just swaps
  // in-memory and re-renders against one single URL -- so the browser
  // back button (and iOS's edge-swipe-back gesture) never had anything
  // of ours to step back through. The very first back press just left
  // the app entirely, to whatever page preceded this one (usually an
  // email link), silently discarding whatever screen the guest was on.
  // Real step-by-step routing (a URL/history entry per screen) would fix
  // this completely but is a much bigger, riskier lift across the many
  // `state.step = '...'; render();` call sites in this file. This is the
  // agreed middle ground instead: one extra history entry pushed on top
  // of the page's real one, so a back press always lands on THIS
  // document first rather than skipping straight past it. From there, a
  // back press while on any screen other than the hub re-arms the guard
  // and returns to the hub instead of leaving -- one press never dumps
  // you out mid-task. A back press from the hub itself is let through
  // untouched (nothing re-armed), so leaving is still one deliberate
  // press away, not permanently blocked.
  //
  // Deliberately armed only after a successful boot into an active
  // booking, from inside boot()'s own success path below -- the "link
  // isn't quite right" and cancelled-booking screens are dead ends on
  // purpose, so back should behave completely normally there.
  function armBackButtonGuard() {
    history.pushState({ apGuard: true }, '', location.href);
    window.addEventListener('popstate', function () {
      if (state.step !== 'hub') {
        history.pushState({ apGuard: true }, '', location.href);
        state.step = 'hub';
        render();
      }
    });
  }

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
      armBackButtonGuard();
    });
  }

  // NEW (guardian-assignment UI, 2026-09-02): re-fetches this booking's
  // full context and re-hydrates working state from it, without
  // resetting state.step -- used by the new guardian-assignment screen
  // after each save, since confirmRoster() can create a brand new
  // guardian_only booking_participants row (a non-attending external
  // guardian, named for the first time) that this session's in-memory
  // state.roster has no way to know about otherwise (saveConfirmRoster's
  // own local mirror only ever updates existing array entries -- see its
  // own comment -- it doesn't know the new row's server-generated
  // participant_id/person_id). Without this, a guest who names an
  // external guardian and moves straight to Send Invites would see a
  // preview list missing that guardian entirely (the exact class of bug
  // this feature exists to fix), even though the actual send -- which
  // the server derives independently -- would still work correctly.
  function reloadContext() {
    return apiGet('/api/adventure-prep?token=' + encodeURIComponent(TOKEN)).then(function (res) {
      if (res.ok) {
        state.ctx = res.body;
        hydrateWorkingStateFromCtx();
      }
      return res;
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
        personId: r.personId,
        guardianPersonId: r.guardianPersonId,
        guardianVerifiedAt: r.guardianVerifiedAt,
      };
    });

    // NEW (guardian-assignment UI, 2026-09-02): rebuilds the frontend's
    // own guardianAssignments map (minorParticipantId -> {mode, ...})
    // from server truth every time context is (re)hydrated -- both on
    // initial boot() and after the guardian-assignment screen's own
    // reloadContext() call. Resolves each minor's guardianPersonId (an
    // opaque person_id) back to either an attending adult already on
    // this roster (mode 'participant') or a non-attending guardian_only
    // row (mode 'external'), so a guest revisiting this screen, or
    // reaching Send Invites right after assigning someone, sees the
    // choice they already made instead of a blank/inconsistent screen.
    var guardianCandidateAdults = state.roster.filter(function (p) {
      return p.isParticipating !== false && !MINOR_BUCKETS[p.age] && p.roleOnBooking !== 'guardian_only';
    });
    var guardianOnlyRows = state.roster.filter(function (p) { return p.roleOnBooking === 'guardian_only'; });
    state.guardianAssignments = {};
    state.roster.forEach(function (m) {
      if (!MINOR_BUCKETS[m.age] || !m.guardianPersonId) return;
      var adultMatch = guardianCandidateAdults.filter(function (a) { return a.personId && a.personId === m.guardianPersonId; })[0];
      if (adultMatch) {
        state.guardianAssignments[m.participantId] = { mode: 'participant', participantId: adultMatch.participantId };
        return;
      }
      var guardianMatch = guardianOnlyRows.filter(function (g) { return g.personId && g.personId === m.guardianPersonId; })[0];
      if (guardianMatch) {
        state.guardianAssignments[m.participantId] = { mode: 'external', name: guardianMatch.name, email: guardianMatch.email };
      }
    });
    if (typeof state.guardianStepIndex !== 'number') state.guardianStepIndex = 0;

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

    // NEW (guardian-signing gap, live-test feedback, 2026-09-02): the
    // Waivers Sign screen's per-minor "I am the parent/guardian ... and
    // I'm signing on their behalf" toggle (state.guardianForChildrenParticipantIds)
    // used to always start empty, even for a minor the booker had already
    // declared themself the legal guardian of back in the Attendees flow's
    // guardian-assignment screen -- so re-signing there meant remembering
    // to manually flip a toggle for a fact the guest had already told us.
    // Pre-populate it here (runs on every boot() and reloadContext(), same
    // as guardianAssignments above) with every minor whose guardian_person_id
    // already resolves to the booker's own person_id and isn't confirmed
    // yet -- safe to recompute from server truth every hydrate since
    // nothing calls reloadContext() again once a guest reaches renderSign().
    var ownerPersonId = ownerRow ? ownerRow.personId : null;
    state.guardianForChildrenParticipantIds = state.roster
      .filter(function (m) {
        return MINOR_BUCKETS[m.age] && m.isParticipating !== false &&
          !m.guardianVerifiedAt && ownerPersonId && m.guardianPersonId === ownerPersonId;
      })
      .map(function (m) { return m.participantId; });

    // bestForAttributes now comes back as a real TEXT[] (mapAdventurePrepRow),
    // not a comma-joined string cell — the old String(...).split(',') only
    // ever worked on an array by accident (Array.prototype.toString()
    // happens to comma-join). Handled explicitly here instead of relying
    // on that coincidence.
    var rawBestForAttributes = Array.isArray(ap.bestForAttributes)
      ? ap.bestForAttributes
      : (ap.bestForAttributes ? String(ap.bestForAttributes).split(',').map(function (s) { return s.trim(); }).filter(Boolean) : []);
    // BUG FIX (Sept 2026): a stored value that no longer matches one of
    // BEST_FOR_ATTRIBUTES_OPTIONS exactly (stale copy, manual DB edit,
    // whatever) used to pass straight through into state.bestForAttributes.
    // It never rendered as a checked chip (the render loop matches against
    // the live options list), but it still counted toward "X of 3 selected"
    // and toward the length<3 gate in the click handler -- so the guest saw
    // only 2 chips checked yet was blocked from picking a 3rd. Filtering to
    // known options here keeps the displayed count and the actual
    // selectable slots in sync.
    state.bestForAttributes = rawBestForAttributes.filter(function (v) {
      return BEST_FOR_ATTRIBUTES_OPTIONS.indexOf(v) !== -1;
    });
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
      case 'rosterGuardians': frag = renderRosterGuardians(); break;
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
  // UPDATED (guardian-assignment UI, 2026-09-02): totalSteps is now a
  // parameter instead of a hardcoded 4 -- a booking with a participating
  // minor gets a 5th step (the new guardian-assignment screen, one pass
  // per minor but counted as a single step in this progress bar, same as
  // Trail Recommendation's own 3-screens-one-bar pattern), a booking with
  // no minors keeps the original 4. See attendeesTotalSteps() below.
  function attendeesFlowTopHtml(stepIndex, backLinkId, backLabel, totalSteps) {
    var total = totalSteps || 4;
    var pct = Math.round(((stepIndex + 1) / total) * 100);
    var label = 'Step ' + (stepIndex + 1) + ' of ' + total;
    return '<div class="ap-flow-top"><div class="ap-back-link" id="' + backLinkId + '" style="cursor:pointer; margin-bottom:0;">' + backLabel + '</div><div class="ap-progress-label">' + label + '</div></div>' +
      '<div class="ap-mini-progress-track"><div class="ap-mini-progress-fill" style="width:' + pct + '%;"></div></div>';
  }

  // NEW (guardian-assignment UI, 2026-09-02): a participating minor on
  // the roster adds one extra step to the Attendees flow's progress bar
  // -- see attendeesFlowTopHtml above.
  function attendeesTotalSteps() {
    return minorsNeedingGuardian().length ? 5 : 4;
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

  // NEW (live-test feedback, 2026-09-02): renderRosterContact() ("add an
  // email for each adult participating in the adventure") was reusing
  // computeAttendeeSigners() above, which deliberately INCLUDES
  // guardian_only rows (renderInvite() needs that) -- on a booking with a
  // non-attending named guardian, that guardian showed up on the Contact
  // Info screen as if they were a roster attendee needing an email, which
  // is wrong (a guardian_only row's email is collected on the
  // guardian-assignment screen itself, or was already on file). This is
  // the narrower "adults actually on the adventure" filter Contact Info
  // should have been using all along: same as computeAttendeeSigners()
  // minus the guardian_only carve-out.
  function computeParticipatingAdultSigners() {
    return state.roster.filter(function (p) {
      return p.roleOnBooking !== 'owner' && p.roleOnBooking !== 'guardian_only'
        && p.isParticipating !== false && !MINOR_BUCKETS[p.age];
    });
  }

  // BUG FIX (live-test feedback, 2026-09-02): the hub's "Attendees" tile
  // and Adventure Summary's "Group" stat both used to just read
  // state.roster.length directly -- on a booking with a non-attending
  // named guardian (role_on_booking = 'guardian_only'), that inflated the
  // headcount by however many external guardians were named, none of whom
  // are actually coming on the adventure. Every OTHER roster row (owner,
  // every attendee, every participating minor) still always counts here,
  // same as state.roster.length used to -- this screen has no per-
  // attendee opt-out control (see this file's header comment), so the
  // only category that was ever wrongly included is guardian_only.
  function attendingRosterCount() {
    return state.roster.filter(function (p) { return p.roleOnBooking !== 'guardian_only'; }).length;
  }

  // NEW (guardian-assignment UI, 2026-09-02): every participating minor
  // needs a booker-named signing guardian -- this drives both whether
  // the new Attendees screen appears at all (renderRosterParticipation's
  // and renderRosterContact's own Continue handlers) and, together with
  // state.guardianStepIndex, which minor renderRosterGuardians() is
  // currently asking about.
  function minorsNeedingGuardian() {
    return state.roster.filter(function (p) {
      return MINOR_BUCKETS[p.age] && p.isParticipating !== false;
    });
  }

  // The adults a booker can pick as a minor's signing guardian: every
  // attending, non-minor roster member (including the owner -- labeled
  // "(you)" on the guardian-assignment screen itself) except any
  // guardian_only row (those are themselves the "not on this trip"
  // answer for some other minor, never a candidate to pick from).
  function eligibleGuardianAdults() {
    return state.roster.filter(function (p) {
      return p.isParticipating !== false && !MINOR_BUCKETS[p.age] && p.roleOnBooking !== 'guardian_only';
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
          var entry = { participantId: p.participantId, name: p.name, age: p.age, fitness: p.fitness, email: p.email, isParticipating: true };
          // NEW (guardian-assignment UI, 2026-09-02): attaches the
          // booker's guardian pick for this minor, if any, in exactly the
          // shape lib/adventure-prep-service.js's confirmRoster() already
          // expects (see that function's own header comment). Sending
          // the assigned adult's own current email alongside their
          // participantId is deliberate and harmless either way -- the
          // server only consults it when that adult has no person_id on
          // file yet, and ignores it otherwise.
          var ga = state.guardianAssignments[p.participantId];
          if (ga && ga.mode === 'participant') {
            var assignedAdult = state.roster.filter(function (r) { return r.participantId === ga.participantId; })[0];
            // UPDATED (flow-order feedback, 2026-09-02): ga.email is now
            // sometimes populated too -- renderRosterGuardians() collects
            // it inline when the assigned adult has neither a person_id
            // nor an email on file yet (guardian-assignment can now run
            // before Contact Info, see this file's header comment).
            // Prefer that freshly-collected value; fall back to whatever
            // the roster row itself already has on file, same as before.
            entry.guardianAssignment = { participantId: ga.participantId, email: ga.email || (assignedAdult && assignedAdult.email) || undefined };
          } else if (ga && ga.mode === 'external' && ga.name && ga.email) {
            entry.guardianAssignment = { name: ga.name, email: ga.email };
          }
          return entry;
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
    else if (reasons.indexOf('hold_never_cleared') !== -1) reasonPhrase = 'your gear hold cleared';
    else if (reasons.indexOf('no_1.2a') !== -1) reasonPhrase = 'the adventure details we need';

    // UPDATED (buggy-items follow-up, 2026-09-03): this used to remove
    // the shared .ap-header (logo + "Questions?" pill, the same header
    // every other Adventure Prep screen uses) and replace it with a
    // one-off marketing site-header/nav that doesn't exist anywhere else
    // in this flow -- wrong header entirely, flagged by Airey. The real
    // .ap-header from complete-adventure-prep.html's static shell is left
    // in place untouched; nothing to remove or insert here anymore.
    var refundAmount = eb.refundAmount != null ? '$' + Number(eb.refundAmount).toFixed(2) : 'in full';
    var cancelledAt = eb.cancelledAt ? new Date(eb.cancelledAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';

    root.className = '';
    root.innerHTML = '';
    root.appendChild(h(
      '<div class="cancel-shell"><div class="container"><div class="cancel-card">' +
      '<div class="cancel-badge"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5L9.5 17L19 7" stroke="#4a9d68" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
      '<h1 class="cancel-headline">This reservation has been cancelled</h1>' +
      '<p class="cancel-body">We weren’t able to get <strong>' + escapeHtml(reasonPhrase) + '</strong> in time to plan your trail day, so this reservation was cancelled. We’ve already sent your refund to the card on file, and there’s nothing further owed on either side.</p>' +
      '<div class="cancel-detail">' +
      '<div class="cancel-detail-row"><span>Refund issued</span><span>' + escapeHtml(refundAmount) + '</span></div>' +
      (cancelledAt ? '<div class="cancel-detail-row"><span>Date</span><span>' + escapeHtml(cancelledAt) + '</span></div>' : '') +
      '<div class="cancel-detail-row"><span>Back in your account</span><span>5–10 business days</span></div>' +
      '</div>' +
      // UPDATED (buggy-items follow-up, 2026-09-03): "Contact Us" removed --
      // the shared .ap-header now stays on this screen (see above), and its
      // "Questions?" pill already covers this, so a second contact path
      // here was redundant.
      '<div class="cancel-ctas"><a href="#" class="btn start-adventure-btn">Book Again</a></div>' +
      '<p class="cancel-footnote">There’s nothing left for you to do here. Whenever you’re ready to give the trail another try, we’ll be here.</p>' +
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
  // not on the trip doesn't need a waiver.
  // UPDATED (Airey's direct request, live-test feedback, 2026-09-02): used
  // to also keep guardian_only rows (non-attending assigned guardians) in
  // this list, on the theory that their own certification was "just as
  // required as an attending signer's" (see lib/waiver-service.js's own
  // header comment, point 4). Live-testing showed this reads wrong on
  // Surface A -- a guardian who isn't coming on the trip shouldn't show
  // up in "Your group's waivers" needing to sign one, and the hub tile's
  // "X of Y signed" count shouldn't count them either. Reverted to a
  // plain isParticipating check, same as any other non-attending person.
  // FLAGGED, not fixed here: the backend still sends that guardian a real
  // signer link and still needs their certification
  // (booking_participants.guardian_verified_at) so this minor's gear kit
  // doesn't get wrongly flagged as "uncovered" at the T-3 waiver cutoff
  // (lib/t3-cutoff-service.js's listUncoveredKitParticipants) -- removing
  // that requirement is a real backend/product decision (and Surface B's
  // hub still has no distinct "certify guardianship" experience for a
  // non-attending guardian at all, per waiver-signer-form.js's own header
  // comment), not something to change silently as part of this display
  // fix. Left for a follow-up.
  function waiverSigners() {
    var signatures = state.ctx.waiverSignatures || [];
    return state.roster
      .filter(function (p) { return p.isParticipating !== false; })
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

  // NEW (Airey's direct request, 2026-09-02): the refundable gear
  // deposit hold is per-kit, not a flat fee -- $65/kit on the Trail Guide
  // Experience, $100/kit on Peaks to Pools once that tier opens up
  // (matches TIERS.gear in api/create-deposit-hold.js exactly, on
  // purpose -- see that file's own TIERS table). Every "One more thing"
  // deposit note in this file (Hub, Gear Kits confirmation, Waiver
  // confirmation) was computing the correct per-tier RATE but never
  // multiplying by how many kits the booking actually has, so a 2-kit
  // Trail booking still showed "$65" instead of "$130". Kit count here
  // is computeHubStatus().kitCount -- the same isGearEligible-gated,
  // live gearKit-toggle count already shown on the hub tile and
  // Adventure Summary -- so a guest never sees a different kit count on
  // two different screens. Floors at 1 kit even if every roster member
  // somehow opted out, matching api/create-deposit-hold.js's own "every
  // booking requires at least 1 kit" floor.
  function computeDepositAmount() {
    var eb = state.ctx.experienceBooking;
    var perKit = eb.tier === 'p2p' ? 100 : 65;
    var kitCount = Math.max(computeHubStatus().kitCount, 1);
    return perKit * kitCount;
  }

  function computeHubStatus() {
    var ap = state.ctx.adventurePrep || {};
    var candidateTrails = ap.candidateTrails;
    try { candidateTrails = typeof candidateTrails === 'string' ? JSON.parse(candidateTrails || '[]') : (candidateTrails || []); } catch (e) { candidateTrails = []; }
    var hasUnreviewedManualPick = candidateTrails.some(function (c) { return c.source === 'manual_override' && c.trailId !== ap.selectedTrailId; });
    // NEW (hub tile copy pass, 2026-09-03): distinct from
    // hasUnreviewedManualPick above (which means "something's ready for
    // you to look at") -- this is the opposite: preferences were
    // submitted, assignment ran, and it came back with zero automated
    // matches (renderInReview()'s "we're building it personally" screen).
    // The hub tile used to have no way to tell this apart from "hasn't
    // started yet," showing the same "Not done" / "Tell us what you're
    // after" copy for both -- flagged by Airey as actively misleading
    // once a guest has already answered everything and is just waiting
    // on the team.
    var awaitingTeamTrail = !!ap.assignedAt && !ap.selectedTrailId && candidateTrails.length === 0;
    // BUG FIX (Task 15): ap.reconfirmedRosterJson no longer exists (see
    // this file's header comment) — "has the roster reconfirmation step
    // run at least once" is now the same signal confirmRoster itself
    // commits to: adventure_prep.is_participating starts NULL (see
    // db/schema.sql) and is only ever set (true or false) by a real
    // confirmRoster call.
    var rosterDone = ap.isParticipating !== null && ap.isParticipating !== undefined;
    // NEW (live-test feedback, 2026-09-02): rosterDone above only means
    // "the are-you-joining question has been answered" -- it used to
    // drive the hub tile's own "Done" pill directly, which meant tapping
    // Continue on renderRosterParticipation and then backing all the way
    // out to Adventure Home (skipping guardian assignment and/or Contact
    // Info entirely) still showed "Done." A micro-flow should only read
    // Done once every screen it actually requires has been satisfied --
    // on the LAST screen (Send Invites / the solo "roster confirmed"
    // variant), "satisfied" just means reachable/viewed, not that
    // invites were actually sent, which is exactly what "every
    // participating minor has a resolved guardian and every adult who
    // needs a waiver email has a valid one on file" already guarantees
    // (the flow's Continue handlers are the only way to get there, and
    // do so on their own -- see renderRosterParticipation's and
    // renderRosterGuardians' own routing). Kept separate from rosterDone
    // itself, which still (deliberately, see summaryUnlocked below)
    // unlocks Adventure Summary on minimal engagement alone.
    var minorsAllGuardianed = state.roster
      .filter(function (p) { return MINOR_BUCKETS[p.age] && p.isParticipating !== false; })
      .every(function (m) { return !!m.guardianPersonId; });
    var participatingAdultsAllEmailed = computeParticipatingAdultSigners()
      .every(function (p) { return isValidEmail(p.email); });
    var attendeesDone = rosterDone && minorsAllGuardianed && participatingAdultsAllEmailed;
    // NEW (live-test feedback follow-up audit, 2026-09-02): also
    // requires the Pickup screen (gearStep 2) to have been saved at
    // least once -- propertyType/deliveryAddressLine1 alone only prove
    // the earlier Delivery screen (gearStep 1) was saved, and that
    // screen's own "Save & return to Adventure Home" exit skips Pickup
    // entirely, leaving return_preference (and every other pickup field)
    // NULL in the database -- same "answered part of the flow, tile
    // still says Done" gap Attendees had.
    var gearDone = !!ap.propertyType && !!ap.deliveryAddressLine1 && !!ap.returnPreference;
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
      awaitingTeamTrail: awaitingTeamTrail,
      rosterDone: rosterDone,
      attendeesDone: attendeesDone,
      gearDone: gearDone,
      kitCount: kitCount,
      eligibleCount: eligibleCount,
      signers: signers,
      waiversDone: waiversDone,
      // NEW (Phase 1/2 escalating hub arc, 2026-09-03): bookerWaiverDone
      // is one of the four "first thing done" signals the top-card state
      // machine below needs (trailSelected/attendeesDone/gearDone are
      // already here; the booker's own signature wasn't previously
      // surfaced as its own flag, only bundled into waiversDone/signers).
      // allSet is renderSummary()'s own gate, hoisted here per the
      // lifecycle-alerts proposal's explicit note that it's "already
      // computed in renderSummary(), just needs hoisting" -- renderSummary
      // itself is updated below to read status.allSet instead of
      // recomputing it.
      bookerWaiverDone: signers.some(function (s) { return s.isOwner && s.isDone; }),
      allSet: !!ap.selectedTrailId && gearDone && waiversDone,
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
    var depositAmount = computeDepositAmount();

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
      compareCardHtml(selectedTrailCandidate, null, null, false, status.allSet) +
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
        status.trailSelected ? status.trailName : (status.awaitingTeamTrail ? 'We’re placing your group personally, no action needed.' : 'Tell us what you’re after and we’ll find your trail'),
        status.hasUnreviewedManualPick ? 'In review' : (status.trailSelected ? 'Done' : (status.awaitingTeamTrail ? 'With Our Team' : 'Not done')),
        false, function () { state.step = (status.trailSelected || ap.assignedAt) ? 'trail' : 'preferences'; render(); }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8.6" r="2.9" stroke="#F58271" stroke-width="1.3"/><path d="M4 19.3c0-3.7 2.2-6.1 5-6.1s5 2.4 5 6.1" stroke="#F58271" stroke-width="1.3" stroke-linecap="round"/><circle cx="15.3" cy="9.2" r="2.3" stroke="#2A4747" stroke-width="1.2"/><path d="M12.6 19.3c.2-3 1.9-4.9 3.9-4.9 2.3 0 4.1 2.4 4.1 5.4" stroke="#2A4747" stroke-width="1.2" stroke-linecap="round"/></svg>', 'Attendees',
        status.rosterDone ? (attendingRosterCount() + ' in your group') : 'Confirm who’s coming and invite your group',
        status.attendeesDone ? 'Done' : 'Not done', false,
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
      var statusClass = t.statusLabel === 'Done' ? 'status-done' : (t.statusLabel === 'In review' || t.statusLabel === 'With Our Team') ? 'status-review' : t.statusLabel === 'Locked' ? 'status-locked' : 'status-notdone';
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

    // -----------------------------------------------------------------
    // Phase 1/2 escalating top card (hub-lifecycle-alerts-proposal.md,
    // 2026-09-03). Pure function of computeHubStatus() plus today's own
    // date, same "no new tracking" principle as the rest of this hub --
    // a guest who steps away for a week and comes back sees the state
    // that matches where they actually are.
    //
    // Climax vs Phase 2A Countdown, resolved per Airey's direct call:
    // since nothing here tracks "have they already seen the climax
    // moment," the richer climax copy (with the trail/date/adventurers/
    // gear stat line) fills the ENTIRE pre-T3 window rather than handing
    // off to a plainer day-count line after one visit -- simpler, more
    // information-rich, and consistent with this hub's own "pure
    // function of current state" rule.
    // -----------------------------------------------------------------
    var bookerWaiverDone = status.bookerWaiverDone;
    var doneFlags = [status.trailSelected, status.attendeesDone, status.gearDone, bookerWaiverDone];
    var doneCount = doneFlags.filter(Boolean).length;
    var groupPendingState = status.trailSelected && status.gearDone && bookerWaiverDone && !status.waiversDone;

    var topGreetingHtml = 'Hi ' + escapeHtml(firstName) + '. You could have spent ' + formatTripDate(eb.date) + ' by the pool. You picked the trail instead. Here’s everything left before you’re on it.';
    var topSublineHtml = '';

    if (status.allSet) {
      var statLine = escapeHtml(status.trailName) + ' \u00b7 ' + formatTripDate(eb.date) + ' \u00b7 ' + attendingRosterCount() + ' adventurers \u00b7 ' + status.kitCount + ' gear kits packed';
      var todayStr = pacificDateString(new Date());
      var tripDateMatch = String(eb.date || '').match(/^\d{4}-\d{2}-\d{2}/);
      var tripDateStr = tripDateMatch ? tripDateMatch[0] : '';
      var deliveryDateStr = isoOffsetDateStr(eb.date, -1);

      if (todayStr === tripDateStr) {
        // 2D: Trail-day. oneTripTip (Trail Database column AU) is
        // wired through already but empty for every trail today -- see
        // this doc's own flagged content gap -- so this falls back to
        // the audit's own confirmed-good sun-exposure line until a
        // trail actually has one written.
        var tripTip = (selectedTrailCandidate && selectedTrailCandidate.oneTripTip) ||
          'Most trails are sun-exposed open-desert trails. We recommend an early start when temperatures are coolest.';
        topGreetingHtml = 'It\u2019s adventure day! ' + escapeHtml(status.trailName) + ' is waiting.';
        topSublineHtml = escapeHtml(tripTip);
      } else if (todayStr === deliveryDateStr) {
        // 2C: Delivery-day reminder. Property type, never the full
        // address, on a card meant to be shareable -- same reasoning
        // renderSummary()'s own delivery line already follows.
        var deliveryWin = ap.deliveryWindow || state.deliveryWindow;
        var propertyLabels = { 'Hotel / resort': 'Hotel / Resort', 'Vacation rental (Airbnb/VRBO)': 'Vacation rental', 'Private residence': 'Private residence' };
        var propertyRaw = ap.propertyType || state.propertyType;
        var propertyLabel = propertyLabels[propertyRaw] || 'your place';
        topGreetingHtml = 'Your gear arrives tonight' + (deliveryWin ? ', ' + escapeHtml(deliveryWin) : '') + ', at your ' + escapeHtml(propertyLabel) + '.';
        topSublineHtml = 'Inside: a Gregory daypack, Leki trekking poles, two Hydro Flask 32oz bottles, and a first aid kit. Yours to keep after: LMNT electrolytes, Rancho Meladuco Medjool dates, and Blue Lizard mineral sunscreen.';
      } else if (pastT3) {
        // 2B: Guide unlocked. The trail section below already carries
        // its own Get Guide button once pastT3, so this doesn't repeat
        // one -- just names the moment.
        topGreetingHtml = 'Your guide\u2019s ready. Turn-by-turn navigation, waypoints, and everything for ' + escapeHtml(status.trailName) + ' is yours now.';
        topSublineHtml = statLine;
      } else {
        // Climax through 2A Countdown, merged per the call above.
        topGreetingHtml = 'That\u2019s everything. The trail is ready for you.';
        topSublineHtml = statLine;
      }
    } else if (groupPendingState) {
      var missingSignerCount = status.signers.filter(function (s) { return !s.isDone; }).length;
      topGreetingHtml = 'Your part\u2019s done. ' + missingSignerCount + ' more signature' + (missingSignerCount === 1 ? '' : 's') + ' from your group and you\u2019re fully clear for gear.';
    } else if (doneCount === 1) {
      if (status.trailSelected) {
        topGreetingHtml = escapeHtml(status.trailName) + '\u2019s locked in. A few more things and you\u2019re fully set for the day.';
      } else if (status.attendeesDone) {
        topGreetingHtml = 'Your group\u2019s confirmed. A few more things and you\u2019re fully set for the day.';
      } else if (status.gearDone) {
        topGreetingHtml = 'Your gear\u2019s sorted. A few more things and you\u2019re fully set for the day.';
      } else if (bookerWaiverDone) {
        topGreetingHtml = 'Your waiver\u2019s signed. A few more things and you\u2019re fully set for the day.';
      }
    } else if (doneCount >= 2) {
      var remaining = [];
      if (!status.trailSelected) remaining.push('your trail');
      if (!status.attendeesDone) remaining.push('your group');
      if (!status.gearDone) remaining.push('gear');
      if (!bookerWaiverDone) remaining.push('your waiver');
      topGreetingHtml = 'Almost there, just ' + joinWithAnd(remaining) + ' left before you\u2019re all set.';
    }
    // else doneCount === 0 (or a guest who hasn't reconfirmed their
    // roster yet): topGreetingHtml/topSublineHtml stay the Part 2.1
    // continuity-beat opener set above.

    var topCardHtml = status.allSet
      ? heroCardHtml('Your Adventure', topGreetingHtml, topSublineHtml, selectedTrailCandidate && selectedTrailCandidate.photoUrl)
      : '<div class="ap-eyebrow">Your Adventure</div>' +
        '<div class="ap-greeting">' + topGreetingHtml + '</div>' +
        '<div class="ap-subline">' + topSublineHtml + '</div>';

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      topCardHtml +
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
      '<select class="paf-roster-input paf-roster-fit" data-idx="' + index + '">' + fitnessOptionsHtml + '</select>' +
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
      attendeesFlowTopHtml(0, 'ap-flow-back', '&larr; Adventure Home', attendeesTotalSteps()) +
      '<div class="ap-eyebrow">Attendees</div>' +
      '<h1 class="ap-q">Confirm your group</h1>' +
      '<p class="ap-sub">Make sure everyone’s name, age, and fitness level are right to ensure we place your group on the right trail.</p>' +
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
      // BUG FIX (live-test feedback, 2026-09-02): a non-attending named
      // guardian (role_on_booking = 'guardian_only') isn't a roster
      // attendee at all -- it used to render here as a 4th "person" with
      // a bogus age/fitness picker. Filter it out, but keep mapping
      // rosterRowHtml against each row's REAL index in state.roster (not
      // the filtered array's index) -- data-idx on the name/age/fitness
      // inputs above has to keep pointing at the right state.roster
      // entry for edits to land correctly.
      wrap.querySelector('#ap-roster-rows').innerHTML = state.roster
        .map(function (p, i) { return { p: p, i: i }; })
        .filter(function (x) { return x.p.roleOnBooking !== 'guardian_only'; })
        .map(function (x) { return rosterRowHtml(x.p, x.i); })
        .join('');
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
      // re-render is safe here. (Every row shows the same name/age/
      // fitness fields regardless of age bucket, per Airey's request --
      // this used to swap a minor's fitness dropdown for a plain "Minor"
      // tag, but a full re-render on age change is still harmless/cheap
      // to keep.)
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
      attendeesFlowTopHtml(1, 'ap-flow-back', '&larr; Back', attendeesTotalSteps()) +
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
        // BUG FIX (live-test feedback, 2026-09-02): refetch context right
        // here, before ever deciding where to go next. This save is very
        // often the FIRST time the booker's own roster row gets a
        // person_id (confirmRoster() sets it the moment ownerParticipantId
        // is confirmed, right above) -- without a refetch, state.roster's
        // local copy still shows whatever personId it had on page load
        // (usually none), so renderRosterGuardians()'s adultNeedsEmail()
        // check would wrongly think the booker's own email still needs
        // collecting when they pick themselves as a minor's guardian,
        // even though the server already has it on file. Mirrors the same
        // reloadContext() call renderRosterGuardians() already makes
        // after each of its own saves, one screen later in the flow.
        //
        // UPDATED (flow-order feedback, 2026-09-02): guardian assignment
        // now runs BEFORE Contact Info (see this file's header comment) --
        // any participating minor sends the booker there first. Only
        // when there's nothing left needing a guardian pick do we fall
        // through to Contact Info (skipped entirely on a solo booking,
        // same as before) or straight to Send Invites.
        reloadContext().then(function () {
          if (minorsNeedingGuardian().length) {
            state.guardianStepIndex = 0;
            state.step = 'rosterGuardians';
          } else if (computeParticipatingAdultSigners().length) {
            state.step = 'rosterContact';
          } else {
            state.step = 'invite';
          }
          render();
        });
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Attendees micro-flow, "Contact Info" step (collect a waiver email for
  // every adult actually on the adventure). New screen, feedback round
  // Sep 2026: "we're asking this screen to do a lot" was the original
  // single screen's problem; this is the piece that used to be an inline
  // email field on each roster row. Skipped entirely (see
  // renderRosterParticipation's and renderRosterGuardians' own Continue
  // handlers) when computeParticipatingAdultSigners() comes back empty.
  // UPDATED (flow-order feedback, 2026-09-02): now runs AFTER
  // guardian-assignment, not before (see this file's header comment) --
  // and uses computeParticipatingAdultSigners(), not
  // computeAttendeeSigners(), so a non-attending named guardian
  // (guardian_only) never shows up here needing an email of their own.
  // ---------------------------------------------------------------------
  function renderRosterContact() {
    var signers = computeParticipatingAdultSigners();
    // BUG FIX (flow-order feedback, 2026-09-02): Contact Info sits right
    // after the guardian-assignment screen(s) when this booking has any
    // participating minor (index 3 of 5), but right after Participation
    // when it doesn't -- renderRosterGuardians() never renders at all in
    // that case, so Contact Info is really the 3rd screen (index 2 of 4).
    var contactStepIndex = minorsNeedingGuardian().length ? 3 : 2;

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      attendeesFlowTopHtml(contactStepIndex, 'ap-flow-back', '&larr; Back', attendeesTotalSteps()) +
      '<div class="ap-eyebrow">Attendees</div>' +
      '<h1 class="ap-q">Add an email for each adult participating in the adventure</h1>' +
      '<p class="ap-sub">Enter a valid email for each adult joining you, that’s how we get each of them their own waiver and their own invite.</p>' +
      '<div class="ap-card">' +
      '<div id="ap-contact-rows">' + signers.map(function (p) {
        var meta = [p.age, p.fitness].filter(Boolean).join(' · ');
        // BUG FIX (Airey's live-test report, 2026-09-03): this row's
        // sizing used to be entirely inline (flex:2 on both pieces, the
        // input pinned to a 220px minimum) with no narrow-screen stacking
        // rule of its own -- on a phone-width viewport that squeezed the
        // name/meta column down to almost nothing while the input held
        // its floor, and vertical centering then landed the input right
        // in the middle of the compressed, multi-line-wrapped name/meta
        // text, reading as the two overlapping. Moved to real classes
        // (styles.css) with a 600px breakpoint that now stacks both onto
        // their own full-width row instead, matching the equivalent
        // roster-row treatment elsewhere in this same file.
        return '<div class="paf-contact-row">' +
          '<div class="paf-contact-name"><div class="paf-contact-name-text">' + escapeHtml(p.name || '') + '</div><div class="paf-contact-meta">' + escapeHtml(meta) + '</div></div>' +
          '<input class="ap-contact-email" data-participant-id="' + escapeHtml(p.participantId) + '" type="email" placeholder="' + escapeHtml((p.name || 'Their') + '’s email') + '" value="' + escapeHtml(p.email || '') + '">' +
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

    wrap.querySelector('#ap-flow-back').addEventListener('click', function () {
      // UPDATED (flow-order feedback, 2026-09-02): Contact Info now
      // always comes after guardian-assignment (when there is any) --
      // Back returns to the last minor's guardian screen instead of
      // straight to rosterParticipation.
      var minors = minorsNeedingGuardian();
      if (minors.length) {
        state.guardianStepIndex = minors.length - 1;
        state.step = 'rosterGuardians';
      } else {
        state.step = 'rosterParticipation';
      }
      render();
    });
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
        // UPDATED (flow-order feedback, 2026-09-02): guardian-assignment
        // already ran before this screen (see renderRosterParticipation's
        // and renderRosterGuardians' own Continue handlers) -- Contact
        // Info is always the last stop before Send Invites now.
        state.step = 'invite';
        render();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Attendees micro-flow, guardian-assignment step (NEW, Sep 2026 --
  // Airey's direct request: "we need to add some kind of identification
  // of the minor's guardian... are they on the adventure? if so they need
  // to be identified from the roster. if not, then an email address for
  // the parent / guardian needs to be provided"). One screen per
  // participating minor, shown right after the "are you joining" question
  // -- BEFORE Contact Info, per Airey's follow-up ask (live-test feedback,
  // 2026-09-02): "it feels like the parent / legal guardian identification
  // screen needs to be pulled forward ahead of the 'add an email for each
  // person' screen." See renderRosterParticipation's Continue handler for
  // the hand-off, and renderRosterContact's Back handler for the return
  // trip.
  // Pattern matches mockup03confirmattendees.html's frames 3a/3b, rebuilt
  // with this codebase's own existing "which one of these is you" control
  // (paf-options/.paf-option-btn, already used just above in
  // renderRosterParticipation) instead of the mockup's own bespoke
  // .ap-radio-list markup, per this whole build's "reuse before
  // inventing" convention.
  //
  // Writes into state.guardianAssignments[minorParticipantId] as either
  // {mode:'participant', participantId[, email]} (an attending adult
  // already on the roster -- including the owner, labeled "(you)") or
  // {mode:'external', name, email} (a non-attending guardian named
  // directly, per Section 6's hybrid model). saveConfirmRoster() reads
  // this map and turns it into the guardianAssignment payload shape
  // lib/adventure-prep-service.js's confirmRoster() already expects.
  //
  // UPDATED (flow-order feedback, 2026-09-02): moving this screen ahead
  // of Contact Info reopens a real gap -- confirmRoster() rejects
  // {participantId} guardianAssignment for an existing participant who
  // has neither a person_id nor an email on file yet (see that function's
  // own header comment, "KNOWN ORDERING LIMITATION"), which Contact Info
  // running first used to guarantee against. adultNeedsEmail() below
  // detects exactly that case (true for almost any non-owner adult who
  // hasn't been through Contact Info yet -- the owner always has a
  // person_id, set the moment they're confirmed as the booker) and this
  // screen collects that one adult's email inline, right where they're
  // picked, instead of silently failing to save. That email round-trips
  // through confirmRoster()'s own person_id-backfill path, so it's
  // already on file (and pre-filled) by the time Contact Info runs later
  // for that same adult.
  // ---------------------------------------------------------------------
  function renderRosterGuardians() {
    var minors = minorsNeedingGuardian();
    // Guards against a stale/out-of-range index (e.g. a minor was somehow
    // removed between visits) rather than throwing on minors[idx] being
    // undefined.
    var idx = Math.max(0, Math.min(state.guardianStepIndex || 0, minors.length - 1));
    var minor = minors[idx];
    if (!minor) {
      // Nothing left to ask -- shouldn't normally be reachable (every
      // hand-off into this screen checks minorsNeedingGuardian().length
      // first), but falls back to Send Invites rather than rendering a
      // broken screen if it ever is.
      state.step = 'invite';
      render();
      return document.createDocumentFragment();
    }
    var adults = eligibleGuardianAdults();
    var current = state.guardianAssignments[minor.participantId] || null;
    var EXTERNAL_VAL = '__external__';
    var selectedVal = current ? (current.mode === 'external' ? EXTERNAL_VAL : current.participantId) : null;

    // NEW (flow-order feedback, 2026-09-02): see this function's own
    // header comment -- true when picking this adult as guardian would
    // otherwise fail server-side (no person_id, no email on file yet).
    function adultNeedsEmail(participantId) {
      var a = adults.filter(function (x) { return x.participantId === participantId; })[0];
      return !!a && !a.personId && !a.email;
    }
    function adultLabelById(participantId) {
      var a = adults.filter(function (x) { return x.participantId === participantId; })[0];
      return a ? (a.name || 'their') : 'their';
    }
    var selectedNeedsEmail = !!selectedVal && selectedVal !== EXTERNAL_VAL && adultNeedsEmail(selectedVal);

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      attendeesFlowTopHtml(2, 'ap-flow-back', '&larr; Back', attendeesTotalSteps()) +
      '<div class="ap-eyebrow">Attendees</div>' +
      '<h1 class="ap-q">Who is ' + escapeHtml(minor.name || 'their') + '&rsquo;s legal parent or guardian?</h1>' +
      '<p class="ap-sub">' + escapeHtml(minor.name || 'This person') + ' needs a parent or guardian on record for their adventure, so every child on the trail has a real adult accountable for them, not just a name on a roster. You’ll confirm the details together in a later step.</p>' +
      '<div class="ap-card">' +
      '<div class="paf-options" id="ap-guardian-opts">' +
      adults.map(function (a) {
        var label = escapeHtml(a.name || 'Unnamed') + (a.participantId === state.ownerParticipantId ? ' (you)' : '');
        return '<button type="button" class="paf-option-btn' + (selectedVal === a.participantId ? ' is-selected' : '') + '" data-val="' + escapeHtml(a.participantId) + '">' + label + '</button>';
      }).join('') +
      '<button type="button" class="paf-option-btn' + (selectedVal === EXTERNAL_VAL ? ' is-selected' : '') + '" data-val="' + EXTERNAL_VAL + '">' + escapeHtml(minor.name || 'Their') + '&rsquo;s guardian isn&rsquo;t on this trip</button>' +
      '</div>' +
      '<div id="ap-guardian-adult-email-wrap" style="display:' + (selectedNeedsEmail ? '' : 'none') + '; margin-top:0.9rem;">' +
      '<div class="paf-roster-sub" id="ap-guardian-adult-email-label">' + escapeHtml(adultLabelById(selectedVal || '')) + '&rsquo;s email</div>' +
      '<div class="ap-helper" style="margin:0 0 0.5rem;">We don&rsquo;t have an email on file for them yet -- add one so they can be reached about signing ' + escapeHtml(minor.name || 'this') + '&rsquo;s waiver.</div>' +
      '<input id="ap-guardian-adult-email" type="email" placeholder="Email address" value="' + escapeHtml((current && current.mode === 'participant' && current.email) || '') + '" style="width:100%; box-sizing:border-box; border:1px solid rgba(42,71,71,0.18); border-radius:6px; padding:0.6rem 0.7rem; background:var(--sand-beige); color:var(--dark-pine); font-family:inherit; font-size:0.82rem;">' +
      '</div>' +
      '<div id="ap-guardian-external-wrap" style="display:' + (selectedVal === EXTERNAL_VAL ? '' : 'none') + '; margin-top:0.9rem;">' +
      '<div class="paf-roster-sub">Legal parent / guardian&rsquo;s name</div>' +
      '<input id="ap-guardian-name" type="text" placeholder="Full name" value="' + escapeHtml((current && current.name) || '') + '" style="width:100%; box-sizing:border-box; margin-bottom:0.7rem; border:1px solid rgba(42,71,71,0.18); border-radius:6px; padding:0.6rem 0.7rem; background:var(--sand-beige); color:var(--dark-pine); font-family:inherit; font-size:0.82rem;">' +
      '<div class="paf-roster-sub">Legal parent / guardian&rsquo;s email</div>' +
      '<input id="ap-guardian-email" type="email" placeholder="Email address" value="' + escapeHtml((current && current.email) || '') + '" style="width:100%; box-sizing:border-box; border:1px solid rgba(42,71,71,0.18); border-radius:6px; padding:0.6rem 0.7rem; background:var(--sand-beige); color:var(--dark-pine); font-family:inherit; font-size:0.82rem;">' +
      '</div>' +
      '<div id="ap-guardian-error" class="ap-error"></div>' +
      '</div>' +
      '<button type="button" class="ap-cta-primary" id="ap-next">Continue</button>' +
      '<div class="ap-cta-secondary" id="ap-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>' +
      '</div></div>'
    );

    function selectOpt(val) {
      selectedVal = val;
      Array.prototype.forEach.call(wrap.querySelectorAll('#ap-guardian-opts .paf-option-btn'), function (btn) {
        btn.classList.toggle('is-selected', btn.getAttribute('data-val') === val);
      });
      wrap.querySelector('#ap-guardian-external-wrap').style.display = val === EXTERNAL_VAL ? '' : 'none';
      var needsEmail = val !== EXTERNAL_VAL && adultNeedsEmail(val);
      var adultEmailWrap = wrap.querySelector('#ap-guardian-adult-email-wrap');
      adultEmailWrap.style.display = needsEmail ? '' : 'none';
      if (needsEmail) {
        wrap.querySelector('#ap-guardian-adult-email-label').textContent = adultLabelById(val) + '’s email';
      }
    }

    Array.prototype.forEach.call(wrap.querySelectorAll('#ap-guardian-opts .paf-option-btn'), function (btn) {
      btn.addEventListener('click', function () { selectOpt(btn.getAttribute('data-val')); });
    });

    wrap.querySelector('#ap-flow-back').addEventListener('click', function () {
      if (idx > 0) { state.guardianStepIndex = idx - 1; render(); return; }
      // Guardian-assignment always runs right after the "are you joining"
      // question now (see this file's header comment) -- Back on the
      // first minor's screen never returns to Contact Info.
      state.step = 'rosterParticipation';
      render();
    });

    function currentSelection() {
      if (!selectedVal) return null;
      if (selectedVal === EXTERNAL_VAL) {
        return {
          mode: 'external',
          name: wrap.querySelector('#ap-guardian-name').value.trim(),
          email: wrap.querySelector('#ap-guardian-email').value.trim(),
        };
      }
      var sel = { mode: 'participant', participantId: selectedVal };
      if (adultNeedsEmail(selectedVal)) {
        sel.email = wrap.querySelector('#ap-guardian-adult-email').value.trim();
      }
      return sel;
    }

    function saveAndAdvance(onSaved) {
      var errEl = wrap.querySelector('#ap-guardian-error');
      var sel = currentSelection();
      if (!sel) {
        errEl.textContent = 'Pick who signs for ' + (minor.name || 'this child') + ', or that their guardian isn’t on this trip.';
        return;
      }
      if (sel.mode === 'external' && (!sel.name || !isValidEmail(sel.email))) {
        errEl.textContent = 'Add the guardian’s name and a valid email before continuing.';
        return;
      }
      if (sel.mode === 'participant' && adultNeedsEmail(sel.participantId) && !isValidEmail(sel.email)) {
        errEl.textContent = 'Add a valid email for ' + adultLabelById(sel.participantId) + ' before continuing.';
        return;
      }
      errEl.textContent = '';
      state.guardianAssignments[minor.participantId] = sel;
      saveConfirmRoster().then(function (res) {
        if (!res.ok) { errEl.textContent = 'Something went wrong saving that, try again.'; return; }
        // See reloadContext()'s own comment: a newly-named external
        // guardian only becomes a real, ID-bearing roster row on the
        // server, and this refetch is what brings it into state.roster
        // (and re-resolves state.guardianAssignments from server truth)
        // before Send Invites' preview list would otherwise need it.
        reloadContext().then(onSaved);
      });
    }

    wrap.querySelector('#ap-save-and-return').addEventListener('click', function () {
      var sel = currentSelection();
      var incomplete = sel && (
        (sel.mode === 'external' && (!sel.name || !isValidEmail(sel.email)))
        || (sel.mode === 'participant' && adultNeedsEmail(sel.participantId) && !isValidEmail(sel.email))
      );
      if (sel && !incomplete) {
        state.guardianAssignments[minor.participantId] = sel;
      }
      saveConfirmRosterIfDecided().then(function () {
        return reloadContext();
      }).then(function () { state.step = 'hub'; render(); });
    });

    wrap.querySelector('#ap-next').addEventListener('click', function () {
      saveAndAdvance(function () {
        var freshMinors = minorsNeedingGuardian();
        if (idx + 1 < freshMinors.length) {
          state.guardianStepIndex = idx + 1;
        } else if (computeParticipatingAdultSigners().length) {
          // UPDATED (flow-order feedback, 2026-09-02): Contact Info now
          // runs after guardian-assignment, not before.
          state.step = 'rosterContact';
        } else {
          state.step = 'invite';
        }
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
  // RESOLVED — guardian assignment (handoff Section 3, Section 9 item
  // 1), 2026-09-02: "the booker picks which attending adult signs for a
  // child, or names an external guardian (not on the trip) directly by
  // name + email" — see renderRosterGuardians() above, which now runs
  // right before this screen. This screen's own displayRows below (a
  // superset of `signers`) surfaces the result: minors show dimmed with
  // no invite, and any non-attending guardian_only row shows highlighted
  // with a badge naming which child(ren) they're signing for.
  // ---------------------------------------------------------------------

  // REWRITTEN (Task 15): `signers` here is now local-preview-only — it
  // mirrors lib/waiver-service.js's sendSignerLinksForBooking's own
  // eligibility filter (attending, non-owner, non-minor adults, plus any
  // guardian_only rows) purely so the guest can see who's about to get a
  // link. It is NEVER sent to the server — the server derives its own
  // list from booking_participants now (see this file's header comment,
  // point 6).
  // NEW (guardian-assignment UI, 2026-09-02): finds every minor this
  // guardian_only row (`row`) was named for, per state.guardianAssignments
  // (the frontend's own live record of what the booker just picked --
  // reading guardianPersonId back off state.roster instead would require
  // a fresh reloadContext() to have already run, which it always has by
  // the time this renders, but this is simpler and doesn't depend on
  // that). Matches by lowercased email since a brand-new guardian_only
  // row's own participantId is only known after reloadContext() anyway.
  function minorsSignedForByGuardianEmail(email) {
    var emailNorm = String(email || '').trim().toLowerCase();
    if (!emailNorm) return [];
    var names = [];
    Object.keys(state.guardianAssignments).forEach(function (minorId) {
      var ga = state.guardianAssignments[minorId];
      if (ga && ga.mode === 'external' && String(ga.email || '').trim().toLowerCase() === emailNorm) {
        var m = state.roster.filter(function (r) { return r.participantId === minorId; })[0];
        if (m) names.push(m.name || 'a child');
      }
    });
    return names;
  }

  // Same idea for an attending adult who was picked (mode 'participant')
  // as a minor's guardian -- surfaced as a small suffix on their own
  // invite row so the booker can see that assignment took, without
  // having to revisit the guardian-assignment screen itself.
  function minorsSignedForByParticipantId(participantId) {
    var names = [];
    Object.keys(state.guardianAssignments).forEach(function (minorId) {
      var ga = state.guardianAssignments[minorId];
      if (ga && ga.mode === 'participant' && ga.participantId === participantId) {
        var m = state.roster.filter(function (r) { return r.participantId === minorId; })[0];
        if (m) names.push(m.name || 'a child');
      }
    });
    return names;
  }

  function renderInvite() {
    var ap = state.ctx.adventurePrep || {};
    var signers = computeAttendeeSigners();
    var missingEmail = signers.filter(function (p) { return !isValidEmail(p.email); });
    // ap.linksSentAt never existed in the new schema — this field was
    // never written by sendSignerLinksForBooking, which only ever touches
    // waiver_signatures, not adventure_prep. Approximate the same "have we
    // sent before" signal locally instead of a field that doesn't exist.
    var hasSentBefore = (state.ctx.waiverSignatures || []).some(function (w) { return w.role === 'non_owner'; });

    // BUG FIX (Attendees walkthrough, Sep 2026, generalized live-test
    // feedback 2026-09-02): "this screen is useless when there's no one
    // to invite" — signers is empty whenever the only people on this
    // roster are the participating owner and/or their own minor
    // children (the owner is filtered out of `signers` by construction,
    // and a minor never needs their own waiver link — see
    // computeAttendeeSigners()'s own header comment). This used to only
    // catch the true solo-booker case (roster.length === 1); a booker
    // travelling with their own minor child, naming themselves as
    // guardian, hit the exact same "nothing to send" problem (Airey:
    // "there is nobody to send invites to so the content on the final
    // screen about sending invites isn't relevant... we should instead
    // confirm the participants with a summary screen of who is
    // attending") but didn't trigger the old, narrower check. Broadened
    // to noOneToInvite = !signers.length, and the roster recap below now
    // handles minors (guardian noted, no "You" tag) alongside the
    // booker, not just a single owner row.
    var noOneToInvite = !signers.length;
    var inviteStepIndex = minorsNeedingGuardian().length ? 4 : 3;

    if (noOneToInvite) {
      // Resolves a minor's already-assigned guardian (renderRosterGuardians())
      // back to a display label for this recap -- "You" when it's the
      // booker themselves (the only case reachable here, see this
      // branch's own header comment: signers.length === 0 rules out any
      // OTHER participating adult or non-attending named guardian), with
      // a defensive fallback to another adult's name or an external
      // guardian's name/email in case that invariant ever changes.
      function guardianLabelForMinor(m) {
        var ga = state.guardianAssignments[m.participantId];
        if (!ga) return '';
        if (ga.mode === 'participant') {
          if (ga.participantId === state.ownerParticipantId) return 'Guardian: You';
          var adult = state.roster.filter(function (r) { return r.participantId === ga.participantId; })[0];
          return adult ? 'Guardian: ' + (adult.name || '') : '';
        }
        if (ga.mode === 'external') return 'Guardian: ' + (ga.name || ga.email || '');
        return '';
      }
      var summaryRows = state.roster.filter(function (p) { return p.roleOnBooking !== 'guardian_only'; });
      var soloWrap = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        attendeesFlowTopHtml(inviteStepIndex, 'ap-back-to-hub', '&larr; Adventure Home', attendeesTotalSteps()) +
        '<div class="ap-eyebrow">Attendees</div>' +
        '<h1 class="ap-q">Your roster is confirmed</h1>' +
        '<p class="ap-sub">Here\u2019s who\u2019s coming on your adventure.</p>' +
        '<div class="ap-card">' +
        summaryRows.map(function (s) {
          var isOwner = s.participantId === state.ownerParticipantId;
          var isMinor = !!MINOR_BUCKETS[s.age];
          var meta = [s.age, isMinor ? guardianLabelForMinor(s) : s.fitness].filter(Boolean).join(' \u00b7 ');
          var tag = isOwner ? '<span class="review-recipient-tag">You</span>' : (isMinor ? '<span class="review-recipient-tag">Minor</span>' : '');
          return '<div class="review-recipient"><div><div class="review-recipient-name">' + escapeHtml(s.name || '') + '</div><div class="review-recipient-email">' + escapeHtml(meta) + '</div></div>' + tag + '</div>';
        }).join('') +
        '</div>' +
        '<button type="button" class="ap-cta-primary" id="ap-invite-done">Continue to Gear</button>' +
        '<div class="ap-cta-secondary" id="ap-invite-save" style="cursor:pointer;">Save &amp; return to Adventure Home</div>' +
        '</div></div>'
      );
      soloWrap.querySelector('#ap-back-to-hub').addEventListener('click', function () { state.step = 'hub'; render(); });
      // UPDATED (Airey's direct request, 2026-09-03): this screen's only
      // action used to be "Return to Adventure Home", which just dropped
      // the guest back at the hub to find and tap into Gear Kits
      // themselves -- an extra step when the natural next thing to do,
      // right after confirming the roster, is start on gear. Primary CTA
      // now moves straight into Gear Kits; "Save & return to Adventure
      // Home" (same wording/pattern as the other flows' secondary link)
      // is still there for anyone who wants to stop here instead.
      soloWrap.querySelector('#ap-invite-done').addEventListener('click', function () { state.step = 'planning'; render(); });
      soloWrap.querySelector('#ap-invite-save').addEventListener('click', function () { state.step = 'hub'; render(); });
      return soloWrap;
    }

    // NEW (guardian-assignment UI, 2026-09-02): everyone who belongs on
    // this screen for display purposes -- a superset of `signers` (which
    // stays exactly what it always was: who actually gets sent a link,
    // and drives the missingEmail/Send-button logic below). Minors are
    // shown dimmed with no email field ("no invite needed" -- they never
    // get one), and a non-attending guardian_only row is shown with a
    // small badge naming which child(ren) they're signing for, per
    // Airey's direct request: "there is also no minor listed on the
    // waiver links and invites screen... we need to add some kind of
    // identification of the minor's guardian."
    var displayRows = state.roster.filter(function (p) {
      if (p.roleOnBooking === 'owner') return false;
      if (p.roleOnBooking === 'guardian_only') return true;
      return p.isParticipating !== false;
    });

    var rowsHtml = displayRows.map(function (p) {
      if (MINOR_BUCKETS[p.age]) {
        return '<div class="review-recipient" style="opacity:0.55;"><div><div class="review-recipient-name">' + escapeHtml(p.name || '') + ' <span style="font-weight:400; color:var(--ap-muted); font-size:0.68rem;">&middot; child, no invite needed</span></div></div></div>';
      }
      var isGuardianOnly = p.roleOnBooking === 'guardian_only';
      var badgeKids = isGuardianOnly ? minorsSignedForByGuardianEmail(p.email) : minorsSignedForByParticipantId(p.participantId);
      var badge = badgeKids.length
        ? ' <span style="font-weight:400; color:var(--ap-muted); font-size:0.68rem;">&middot; ' + escapeHtml(badgeKids.join(' &amp; ')) + '&rsquo;s guardian' + (isGuardianOnly ? ', not attending' : '') + '</span>'
        : '';
      var rowStyle = isGuardianOnly ? ' style="border:1.5px solid var(--mountain-pink); background:rgba(245,130,113,0.06);"' : '';
      return '<div class="review-recipient"' + rowStyle + '><div><div class="review-recipient-name">' + escapeHtml(p.name || '') + badge + '</div><div class="review-recipient-email">' + escapeHtml(p.email || 'no email on file yet') + '</div></div></div>';
    }).join('');

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      attendeesFlowTopHtml(inviteStepIndex, 'ap-back-to-hub', '&larr; Adventure Home', attendeesTotalSteps()) +
      '<div class="ap-eyebrow">Attendees</div>' +
      '<h1 class="ap-q">Send waiver links and adventure invites to your group</h1>' +
      '<p class="ap-sub">Your group will receive an invite email from Palm Springs Adventure Club so they can confirm their participation and complete their waiver.</p>' +
      '<div class="ap-card">' +
      (displayRows.length ? rowsHtml : '') +
      (!signers.length ? '<p class="ap-helper">No one else on this booking needs their own waiver link.</p>' : '') +
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
        '<div class="ap-q-help">This helps us place your group on a trail that fits their technical comfort.</div>' +
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
      '<div class="ap-q-help">This helps us place your group on a trail with the right amount of sun for them.</div>' +
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

  // Hub top card, Climax onward -- hero-photo treatment with a dark-card
  // fallback when a trail has no photo yet
  // (hub-top-card-visual-options.html, 2026-09-03). headlineHtml/
  // sublineHtml are passed through as already-safe HTML, matching how
  // topGreetingHtml/topSublineHtml are built and inserted everywhere else
  // in this file.
  function heroCardHtml(eyebrowText, headlineHtml, sublineHtml, photoUrl) {
    return '<div class="ap-hero-card' + (photoUrl ? '' : ' no-photo') + '"' +
      (photoUrl ? ' style="background-image:url(\'' + photoUrl + '\');"' : '') + '>' +
      '<div class="ap-hero-card-inner">' +
      '<div class="ap-hero-mark"><img src="/images/logo.svg" alt="Palm Springs Adventure Club"></div>' +
      '<div class="ap-hero-eyebrow">' + escapeHtml(eyebrowText) + '</div>' +
      '<div class="ap-hero-headline">' + headlineHtml + '</div>' +
      '<div class="ap-hero-subline">' + sublineHtml + '</div>' +
      '</div></div>';
  }

  // `ctaLabel` falsy (null/undefined) renders the card with no CTA button,
  // so the confirmation screen (renderConfirmation) can reuse this exact
  // component just for the consistent name/stats/summary presentation.
  // `lean` (new, hub-trail-card-placement-options.html) renders without
  // the photo bar -- used once the hero card above already carries the
  // photo, so the page isn't showing the same photo twice.
  function compareCardHtml(candidate, badge, ctaLabel, ctaDisabled, lean) {
    var desc = summarize(candidate.overviewCopy, 250) || ((candidate.matchedAttributes || []).length
      ? 'What you told us you wanted: ' + candidate.matchedAttributes.join(', ') + '.'
      : 'A safe, solid fit for your group.');
    return '<div class="ap-compare-card' + (lean ? ' lean' : '') + '">' +
      (lean ? '' :
      '<div class="ap-compare-photo"' + (candidate.photoUrl ? ' style="background-image:url(\'' + candidate.photoUrl + '\'); background-size:cover; background-position:center;"' : '') + '>' +
      (badge ? '<div class="ap-compare-badge ' + badge.cls + '">' + escapeHtml(badge.text) + '</div>' : '') +
      '</div>') +
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
        '<div class="ap-review-title">We’re building your trail recommendation personally.</div>' +
        '<div class="ap-review-body">Your group’s preferences and trail day are a genuinely specific combination, so we’ve flagged this for a closer look by our team. You’ll hear from us with a trail recommendation before your trail day.</div>' +
        '<div class="ap-review-body">Continue to make sure your attendees, gear delivery details, and waivers are all set in the meantime.</div>' +
        '<button type="button" class="ap-cta-primary" id="ap-continue-attendees">Continue to Confirm Attendees</button>' +
        '<div class="ap-cta-secondary" id="ap-modify" style="cursor:pointer;">Want to change something?</div>' +
        '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer;">Return to Adventure Home</div>';
      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-continue-attendees').addEventListener('click', function () { state.step = 'roster'; render(); });
      contentEl.querySelector('#ap-modify').addEventListener('click', renderInReviewModify);
      contentEl.querySelector('#ap-return-hub').addEventListener('click', goHub);
    }

    // ---- In review, guest wants to change something: the redo-questions
    // / ask-team-for-more-detail options from renderChangeEntry's 3-option
    // list, minus "pick from existing results" (nothing exists yet to
    // pick from in this state).
    function renderInReviewModify() {
      var choice = 'redo';
      function draw() {
        wrap.classList.remove('ap-wide');
        contentEl.innerHTML =
          flowTopHtml('&larr; Adventure Home') +
          '<div class="ap-eyebrow">Trail Recommendation</div>' +
          '<div class="ap-q-title" style="margin-bottom:1rem;">Want to change something?</div>' +
          '<div class="ap-radio-list" id="ap-review-modify-options">' +
          '<div class="ap-radio' + (choice === 'redo' ? ' selected' : '') + '" data-val="redo"><div class="ap-radio-dot"></div><div class="ap-radio-text">Answer the questions differently<br><span style="font-weight:400; color:var(--ap-muted); font-size:0.72rem;">Redo the 3 preference questions and see what fits better</span></div></div>' +
          '<div class="ap-radio' + (choice === 'ask_team' ? ' selected' : '') + '" data-val="ask_team"><div class="ap-radio-dot"></div><div class="ap-radio-text">Tell us more about what you’re looking for<br><span style="font-weight:400; color:var(--ap-muted); font-size:0.72rem;">Give our team a few more details to work with</span></div></div>' +
          '</div>' +
          '<button type="button" class="ap-cta-primary" id="ap-review-modify-continue">Continue</button>' +
          '<div class="ap-cta-secondary" id="ap-review-modify-cancel" style="cursor:pointer;">Never mind, go back</div>';
        contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
        contentEl.querySelector('#ap-review-modify-cancel').addEventListener('click', renderInReview);
        Array.prototype.forEach.call(contentEl.querySelectorAll('#ap-review-modify-options .ap-radio'), function (el) {
          el.addEventListener('click', function () { choice = el.getAttribute('data-val'); draw(); });
        });
        contentEl.querySelector('#ap-review-modify-continue').addEventListener('click', function () {
          if (choice === 'redo') { state.prefStep = 0; state.forceTrailRefresh = true; state.step = 'preferences'; render(); }
          else { renderAskTeamForm(renderInReviewModify); }
        });
      }
      draw();
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
      if (!forceRefresh && ap.assignedAt) {
        if (existing.length) { routeReveal(existing); return; }
        renderInReview();
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
        // BUG FIX (Airey's live-test report, 2026-09-03): a refresh can
        // clear ap.selectedTrailId server-side (api/adventure-prep.js's
        // runTrailAssignment action, see its own comment) when whatever
        // was previously selected -- almost always a staff manual_override
        // -- doesn't survive into the fresh candidateTrails. This client
        // copy of ap used to never hear about that: it kept pointing at a
        // trailId no candidate row matched anymore, which is exactly what
        // made the hub's trail card (and this tile's own subtitle, both of
        // which resolve "the selected trail" by filtering candidateTrails
        // for this id) render blank -- dashes for every stat, the generic
        // "A safe, solid fit for your group." fallback description, no
        // name. Syncing it here means a cleared selection is reflected
        // the moment this response comes back, routing the guest into
        // renderInReview()'s "awaiting team trail" state below instead.
        ap.selectedTrailId = res.body.selectedTrailId;
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
          '<div class="ap-radio' + (choice === 'redo' ? ' selected' : '') + '" data-val="redo"><div class="ap-radio-dot"></div><div class="ap-radio-text">Answer the questions differently<br><span style="font-weight:400; color:var(--ap-muted); font-size:0.72rem;">Redo the 3 preference questions and see what fits better</span></div></div>' +
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
    function renderAskTeamForm(backFn) {
      var goBack = backFn || renderChangeEntry;
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
      contentEl.querySelector('#ap-ask-team-cancel').addEventListener('click', goBack);
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
    var wrap = h('<div class="container"><div class="ap-shell" style="padding-top:0;"><div id="ap-gear-content"></div></div></div>');
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
    // Shared with renderConfirmation()'s delivery recap, so both screens
    // show the same human label for a given propertyType value.
    var PROPERTY_LABELS = { 'Hotel / resort': 'Hotel / Resort', 'Vacation rental (Airbnb/VRBO)': 'Vacation rental', 'Private residence': 'Private residence' };

    // ---- Address autocomplete (Airey's direct request, 2026-09-02) ----
    // Shared by renderDeliveryScreen and renderPickupScreen's return-
    // address field: wraps Google's Places API (New) -- `:autocomplete`
    // for the live-typing suggestion list, Place Details for the
    // standardized address once a guest picks one. Same Google Maps
    // Platform project/key as the existing Address Validation call
    // (process.env.GOOGLE_MAPS_API_KEY server-side; the key is never sent
    // to the browser). One session token covers every keystroke's
    // prediction call plus the eventual Details call for whichever
    // suggestion gets picked, then a fresh token starts for the next
    // address search, per Google's session-token billing guidance.
    // Soft-fails to a quiet no-suggestions dropdown if the Places call
    // errors or the key isn't configured -- never blocks a guest from
    // just typing the address out by hand instead.
    function newAddressSessionToken() {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    // @param addressInput the <input> element guests type into
    // @param suggestionsEl the dropdown container rendered just below it
    // @param onFilled(std) called with the standardized address (or null)
    //   after a suggestion's Place Details call resolves, so each screen
    //   can fill whatever fields it has beyond the address line itself.
    function wireAddressAutocomplete(addressInput, suggestionsEl, onFilled) {
      if (!addressInput || !suggestionsEl) return;
      var sessionToken = newAddressSessionToken();
      var debounceTimer = null;
      var requestSeq = 0;
      var suppressNextInput = false;

      function closeSuggestions() {
        suggestionsEl.innerHTML = '';
        suggestionsEl.classList.remove('open');
      }

      function drawSuggestions(predictions) {
        if (!predictions || !predictions.length) { closeSuggestions(); return; }
        suggestionsEl.innerHTML = predictions.map(function (p, i) {
          return '<div class="ap-address-suggestion" data-idx="' + i + '">' +
            '<div class="ap-address-suggestion-main">' + escapeHtml(p.mainText || p.text || '') + '</div>' +
            (p.secondaryText ? '<div class="ap-address-suggestion-sub">' + escapeHtml(p.secondaryText) + '</div>' : '') +
            '</div>';
        }).join('');
        suggestionsEl.classList.add('open');
        Array.prototype.forEach.call(suggestionsEl.querySelectorAll('.ap-address-suggestion'), function (el) {
          // mousedown, not click: fires before the address input's own
          // blur handler would otherwise close this dropdown out from
          // under the click.
          el.addEventListener('mousedown', function (ev) {
            ev.preventDefault();
            selectPrediction(predictions[Number(el.getAttribute('data-idx'))]);
          });
        });
      }

      function selectPrediction(prediction) {
        suppressNextInput = true;
        addressInput.value = prediction.mainText || prediction.text || addressInput.value;
        closeSuggestions();
        apiPost('/api/address-autocomplete', {
          token: TOKEN,
          mode: 'details',
          placeId: prediction.placeId,
          sessionToken: sessionToken,
        }).then(function (res) {
          var std = res.body && res.body.standardized;
          if (std && std.line1) addressInput.value = std.line1;
          if (onFilled) onFilled(std);
          // A session token is spent once a Details call uses it -- start
          // a fresh one for the next address this guest searches.
          sessionToken = newAddressSessionToken();
        });
      }

      addressInput.addEventListener('input', function () {
        if (suppressNextInput) { suppressNextInput = false; return; }
        var query = addressInput.value.trim();
        if (debounceTimer) clearTimeout(debounceTimer);
        if (query.length < 4) { closeSuggestions(); return; }
        debounceTimer = setTimeout(function () {
          var seq = ++requestSeq;
          apiPost('/api/address-autocomplete', { token: TOKEN, mode: 'predict', input: query, sessionToken: sessionToken })
            .then(function (res) {
              if (seq !== requestSeq) return; // a newer keystroke already superseded this request
              drawSuggestions(res.body && res.body.predictions);
            });
        }, 300);
      });
      addressInput.addEventListener('blur', function () {
        // Short delay so a suggestion's mousedown handler still gets to
        // fire before the dropdown disappears.
        setTimeout(closeSuggestions, 150);
      });
    }

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
        return {
          participantId: p.participantId,
          gearKit: p.gearKit !== false,
          packSizePreference: p.packSizePreference === 'plus' ? 'plus' : 'standard',
        };
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
          '<div class="ap-q-help">We recommend 1 gear kit per person so everyone can carry enough water, electrolytes, and snacks for an adventure in the desert.</div>' +
          '<div class="ap-kit-info-link" id="ap-kit-info-toggle">What’s inside a gear kit? ' + (infoOpen ? '&ndash;' : '+') + '</div>' +
          (infoOpen
            ? '<div class="ap-kit-info-panel">' +
              '<div class="ap-kit-info-body"><b class="ap-kit-info-label">Rental gear:</b> a Gregory daypack, Leki trekking poles, two Hydro Flask 32oz bottles, and a first aid kit. Packed and delivered the evening before your trail day.</div>' +
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
        var kitSelectedCount = state.roster.filter(function (p) { return isGearEligible(p) && p.gearKit !== false; }).length;
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
          // Every booking needs at least one gear kit -- whoever is
          // currently the only remaining "yes" (which trivially covers a
          // solo booking) has their "no" option locked so the count can
          // never drop to zero. Mirrors the same rule already used on
          // Surface A's original booking flow (see adventure-form.js,
          // cardGearList).
          var isLastYes = hasKit && kitSelectedCount === 1;
          var packSize = p.packSizePreference === 'plus' ? 'plus' : 'standard';
          return '<div class="ap-kit-row' + (hasKit ? ' has-pack' : '') + '">' +
            '<div class="ap-kit-row-top">' +
            '<div class="ap-kit-avatar">' + escapeHtml(initialsOf(p.name)) + '</div>' +
            '<div class="ap-kit-name">' + escapeHtml(p.name || '') + '</div>' +
            '<div class="ap-kit-toggle" data-idx="' + i + '">' +
            '<div class="ap-kit-toggle-opt' + (hasKit ? ' on' : '') + '" data-kit="true">Yes</div>' +
            '<div class="ap-kit-toggle-opt' + (!hasKit ? ' on' : '') + (isLastYes ? ' disabled' : '') + '" data-kit="false"' + (isLastYes ? ' title="Every booking needs at least one gear kit"' : '') + '>No</div>' +
            '</div>' +
            '</div>' +
            (hasKit
              ? '<div class="ap-kit-pack-row">' +
                '<div class="ap-kit-pack-label">Backpack size</div>' +
                '<div class="ap-kit-pack-toggle" data-idx="' + i + '">' +
                '<div class="ap-kit-pack-opt' + (packSize === 'standard' ? ' on' : '') + '" data-pack="standard">Standard</div>' +
                '<div class="ap-kit-pack-opt' + (packSize === 'plus' ? ' on' : '') + '" data-pack="plus">Plus</div>' +
                '</div></div>'
              : '') +
            '</div>';
        }).join('');
        Array.prototype.forEach.call(contentEl.querySelectorAll('.ap-kit-toggle-opt'), function (el) {
          el.addEventListener('click', function () {
            if (el.classList.contains('disabled')) return;
            var idx = Number(el.parentElement.getAttribute('data-idx'));
            state.roster[idx].gearKit = el.getAttribute('data-kit') === 'true';
            draw();
          });
        });
        Array.prototype.forEach.call(contentEl.querySelectorAll('.ap-kit-pack-opt'), function (el) {
          el.addEventListener('click', function () {
            var idx = Number(el.parentElement.getAttribute('data-idx'));
            state.roster[idx].packSizePreference = el.getAttribute('data-pack');
            draw();
          });
        });
      }
      draw();
    }

    // ---- Screen 1: delivery ----
    function renderDeliveryScreen() {
      var PROPERTY_OPTS = ['Hotel / resort', 'Vacation rental (Airbnb/VRBO)', 'Private residence'];
      var DELIVERY_WINDOWS = ['3:00pm – 5:00pm', '5:00pm – 7:00pm', '7:00pm – 9:00pm'];
      contentEl.innerHTML =
        flowTopHtml('&larr; Back') +
        '<div class="ap-eyebrow">Gear Kits &amp; Delivery/Pickup</div>' +
        '<div class="ap-q-title">Where should your gear get delivered?</div>' +
        '<div class="ap-q-help">Your gear kit will be delivered the evening before your trail day, so it’s waiting for you, not something you have to think about on trail-day morning.</div>' +
        '<div class="ap-card">' +
        '<div class="ap-field-label">Where are you staying?</div>' +
        '<div class="ap-choice-pills" id="ap-property"></div>' +
        '<div class="ap-field-label">Delivery Address</div>' +
        '<div class="ap-address-field" id="ap-address-field">' +
        '<input class="ap-field-input" type="text" id="ap-address" placeholder="Start typing your address…" autocomplete="off" value="' + escapeHtml(state.deliveryAddressLine1) + '">' +
        '<div class="ap-address-suggestions" id="ap-address-suggestions"></div>' +
        '</div>' +
        '<div class="ap-field-row2">' +
        '<div><div class="ap-field-label">City</div><input class="ap-field-input" type="text" id="ap-city" value="' + escapeHtml(state.deliveryCity) + '" placeholder="Palm Springs"></div>' +
        '<div><div class="ap-field-label">Zip</div><input class="ap-field-input" type="text" id="ap-zip" value="' + escapeHtml(state.deliveryZip) + '" placeholder="92264"></div>' +
        '</div>' +
        '<div class="ap-field-label">Delivery Window</div>' +
        '<div class="ap-window-list" id="ap-window-list"></div>' +
        '<div class="ap-field-label">Delivery Note (optional)</div>' +
        '<textarea class="ap-field-textarea" id="ap-delivery-note" placeholder="Any other note or instructions about delivery">' + escapeHtml(state.deliveryNote) + '</textarea>' +
        '<div id="ap-delivery-error" class="ap-error"></div>' +
        '</div>' +
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

      wireAddressAutocomplete(
        contentEl.querySelector('#ap-address'),
        contentEl.querySelector('#ap-address-suggestions'),
        function (std) {
          if (!std) return;
          if (std.city) contentEl.querySelector('#ap-city').value = std.city;
          if (std.zip) contentEl.querySelector('#ap-zip').value = std.zip;
        }
      );

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
          '<div class="ap-q-help">Your gear will be picked up the evening after your adventure from the location specified below.</div>' +
          '<div class="ap-card">' +
          '<div class="ap-toggle-row" id="ap-same-toggle"><div class="ap-toggle-row-text">Same as delivery address</div><div class="ap-switch' + (state.returnSameAsDelivery ? ' on' : '') + '"></div></div>' +
          (state.returnSameAsDelivery ? '' :
            '<div class="ap-field-label">Return Address</div>' +
            '<div class="ap-address-field" id="ap-return-address-field">' +
            '<input class="ap-field-input" type="text" id="ap-return-address" placeholder="If different from your delivery address" autocomplete="off" value="' + escapeHtml(state.returnAddressLine1) + '">' +
            '<div class="ap-address-suggestions" id="ap-return-address-suggestions"></div>' +
            '</div>') +
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
          '</div>' +
          '<button type="button" class="ap-cta-primary" id="ap-next">Finish Gear Kits &amp; Delivery/Pickup</button>' +
          '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer;">Save &amp; return to Adventure Home</div>';

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
        wireAddressAutocomplete(
          contentEl.querySelector('#ap-return-address'),
          contentEl.querySelector('#ap-return-address-suggestions'),
          null
        );
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
    // REBUILT (Airey's direct request, 2026-09-02): the old version of
    // this screen only recapped a kit count plus the delivery/pickup
    // windows -- easy to miss on a first pass since the summary card was
    // so sparse. Now recaps the full picture in one place: every roster
    // member's kit + pack size decision, the full delivery confirmation,
    // and the full pickup confirmation, so a guest leaves this screen
    // actually knowing what was saved instead of just that "something"
    // was saved.
    function renderConfirmation() {
      var eb = state.ctx.experienceBooking;
      var depositAmount = computeDepositAmount();
      var hotel = isHotelPath();

      var rosterRowsHtml = state.roster.map(function (p) {
        var eligible = isGearEligible(p);
        var status;
        if (!eligible) {
          status = 'Not included';
        } else if (p.gearKit === false) {
          status = 'No kit';
        } else {
          status = 'Kit &middot; ' + (p.packSizePreference === 'plus' ? 'Plus' : 'Standard');
        }
        return '<div class="ap-recap-line"><span>' + escapeHtml(p.name || '') + '</span><b>' + status + '</b></div>';
      }).join('');

      var deliveryAddressLine = [state.deliveryAddressLine1, state.deliveryCity, state.deliveryZip ? ('CA ' + state.deliveryZip) : 'CA']
        .filter(Boolean).join(', ');
      var deliveryRowsHtml =
        '<div class="ap-recap-line"><span>Property</span><b>' + escapeHtml(PROPERTY_LABELS[state.propertyType] || state.propertyType || 'Not set') + '</b></div>' +
        '<div class="ap-recap-line"><span>Address</span><b>' + escapeHtml(deliveryAddressLine || 'Not set') + '</b></div>' +
        '<div class="ap-recap-line"><span>Delivery Window</span><b>' + escapeHtml(state.deliveryWindow || 'Not set') + '</b></div>' +
        (state.deliveryNote ? '<div class="ap-recap-line"><span>Note</span><b>' + escapeHtml(state.deliveryNote) + '</b></div>' : '');

      var pickupRowsHtml =
        '<div class="ap-recap-line"><span>Return Address</span><b>' + (state.returnSameAsDelivery ? 'Same as delivery' : escapeHtml(state.returnAddressLine1 || 'Not set')) + '</b></div>' +
        (hotel
          ? '<div class="ap-recap-line"><span>Return Location</span><b>Front desk, final sweep after 9pm</b></div>'
          : '<div class="ap-recap-line"><span>Return Location</span><b>' + escapeHtml(state.returnLocation || 'Not set') + '</b></div>') +
        '<div class="ap-recap-line"><span>Return Time</span><b>' + escapeHtml(state.returnWindow || 'Not specified') + '</b></div>' +
        (state.returnNote ? '<div class="ap-recap-line"><span>Note</span><b>' + escapeHtml(state.returnNote) + '</b></div>' : '');

      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Gear Kits &amp; Delivery/Pickup</div>' +
        '<div class="ap-recap-title">Your gear is on its way to being ready.</div>' +
        '<div class="ap-recap-body">You will be able to make changes to gear kits and delivery/pickup instructions until 10:00pm Pacific 3 days before your adventure day.</div>' +
        '<div class="ap-recap-card">' +
        '<div class="ap-recap-section">' +
        '<div class="ap-field-label">Roster &amp; Gear Kits</div>' +
        rosterRowsHtml +
        '</div>' +
        '<div class="ap-recap-section">' +
        '<div class="ap-field-label">Delivery</div>' +
        deliveryRowsHtml +
        '</div>' +
        '<div class="ap-recap-section">' +
        '<div class="ap-field-label">Pickup</div>' +
        pickupRowsHtml +
        '</div>' +
        '</div>' +
        '<div class="ap-deposit-note">One more thing: a <b>$' + depositAmount + ' refundable gear deposit hold</b> gets placed on your card the day before your adventure day (the day your gear arrives). We’ll let you know right before it happens.</div>' +
        '<button type="button" class="ap-cta-primary" id="ap-continue-waivers">Continue to Waivers</button>' +
        '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer;">Save &amp; return to Adventure Home</div>';
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
    // UPDATED (live-test feedback, 2026-09-02): matches
    // waiver-signer-form.js's own renderWaiver() wrap exactly -- ap-wide
    // (960px, was the standard 640px) and padding-top:0 (removes the
    // default 2.6rem .ap-shell gap under the header bar, same fix already
    // applied to nearly every other Adventure Prep screen).
    var wrap = h('<div class="container ap-wide"><div class="ap-shell" style="padding-top:0;"><div id="ap-waiver-content"></div></div></div>');
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
      // NEW (Airey's direct request, 2026-09-02): a minor whose legal
      // guardian is the booker themself -- declared back in the
      // Attendees flow's guardian-assignment screen -- can be signed for
      // right here, instead of only ever showing as a readonly "Guardian
      // invited, not yet confirmed" row with nothing to tap. Scoped
      // specifically to the booker-is-the-guardian case: a minor whose
      // assigned guardian is someone else (not attending this trip)
      // still has to be signed for on Surface B (waiver-signer-form.js)
      // by that guardian directly -- out of scope here, matching Airey's
      // own stated boundary.
      var ownerPersonId = (state.roster.filter(function (r) { return r.participantId === state.ownerParticipantId; })[0] || {}).personId;
      function minorGuardianedByOwner(s) {
        if (!s.isMinor || !ownerPersonId) return false;
        var rosterRow = state.roster.filter(function (r) { return r.participantId === s.participantId; })[0];
        return !!rosterRow && rosterRow.guardianPersonId === ownerPersonId;
      }
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
        if (minorGuardianedByOwner(s) && !s.isDone) {
          return '<div class="ap-wv-row tappable" data-wv-minor-id="' + escapeHtml(s.participantId) + '">' +
            '<div class="ap-wv-avatar">' + escapeHtml(initialsOf(s.name)) + '</div>' +
            '<div class="ap-wv-mid"><div class="ap-wv-name">' + escapeHtml(s.name) + '</div>' +
            '<div class="ap-wv-sub">Tap to sign as their parent/guardian</div></div>' +
            '<div class="ap-wv-status ' + statusCls + '">' + statusLabel + '</div>' +
            '<div class="ap-wv-chevron">&rsaquo;</div>' +
            '</div>';
        }
        // NEW (Airey's direct request, 2026-09-03): a readonly row for
        // someone who hasn't signed yet -- any non-owner adult, or a
        // non-attending assigned guardian -- gets its own "Resend waiver
        // invite" action (s.canRemind is already exactly this: not done,
        // not the owner, already has a live invite on file, has an
        // email to send it to -- see waiverSigners()'s own header
        // comment). A minor's row never gets one: either it's guardianed
        // by the booker themself (tappable above, signed in-app, no
        // email involved) or it's guardianed by someone else, in which
        // case the GUARDIAN's own row -- not the child's -- is what
        // shows the resend action.
        return '<div class="ap-wv-row readonly">' +
          '<div class="ap-wv-avatar">' + escapeHtml(initialsOf(s.name)) + '</div>' +
          '<div class="ap-wv-mid"><div class="ap-wv-name">' + escapeHtml(s.name) + '</div>' +
          (s.subLabel ? '<div class="ap-wv-sub">' + escapeHtml(s.subLabel) + '</div>' : '') +
          (s.canRemind ? '<button type="button" class="ap-waiver-remind-btn" data-resend-participant-id="' + escapeHtml(s.participantId) + '">Resend waiver invite</button>' +
            '<div class="ap-helper" data-resend-status-for="' + escapeHtml(s.participantId) + '" style="margin-top:0.15rem;"></div>' : '') +
          '</div>' +
          '<div class="ap-wv-status ' + statusCls + '">' + statusLabel + '</div>' +
          '</div>';
      }).join('');

      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Waivers</div>' +
        '<div class="ap-q-title">Your group’s waivers.</div>' +
        '<div class="ap-q-help">Current status of your group’s waivers.</div>' +
        alertHtml +
        rowsHtml +
        '<div class="ap-cta-secondary" id="ap-return-hub" style="cursor:pointer; margin-top:0.6rem;">Return to Adventure Home</div>';

      contentEl.querySelector('#ap-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#ap-return-hub').addEventListener('click', goHub);
      var selfRow = contentEl.querySelector('#ap-wv-self');
      if (selfRow) selfRow.addEventListener('click', renderSign);
      Array.prototype.forEach.call(contentEl.querySelectorAll('[data-wv-minor-id]'), function (row) {
        row.addEventListener('click', renderSign);
      });
      // NEW (per-row "Resend waiver invite," 2026-09-03): fires a
      // single-recipient resend (api/adventure-prep.js's sendSignerLinks
      // now takes an optional participantId, see that file's own comment)
      // rather than the whole-booking resend the same action used to
      // always do -- so clicking this on one person's row only emails
      // that person, not everyone still missing a signature.
      Array.prototype.forEach.call(contentEl.querySelectorAll('[data-resend-participant-id]'), function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var participantId = btn.getAttribute('data-resend-participant-id');
          var statusEl = contentEl.querySelector('[data-resend-status-for="' + participantId + '"]');
          btn.disabled = true;
          apiPost('/api/adventure-prep', {
            action: 'sendSignerLinks',
            token: TOKEN,
            participantId: participantId,
          }).then(function (res) {
            if (statusEl) statusEl.textContent = res.ok ? 'Invite resent.' : 'Something went wrong, try again.';
            btn.disabled = false;
          });
        });
      });
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
        '<div class="ap-card">' +
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
          var isGuardianOn = state.guardianForChildrenParticipantIds.indexOf(m.participantId) !== -1;
          var childLegalName = state.guardianChildLegalNames[m.participantId] != null ? state.guardianChildLegalNames[m.participantId] : (m.name || '');
          return '<div class="ap-toggle-row" data-guardian-participant-id="' + escapeHtml(m.participantId || '') + '" style="cursor:pointer;">' +
            '<div class="ap-toggle-row-text" style="font-weight:500; font-size:0.78rem;">I am the parent / legal guardian of ' + escapeHtml(m.name || 'this child') + ' (' + escapeHtml(m.age || m.ageRange || '') + ') and I’m signing on their behalf</div>' +
            '<div class="ap-switch' + (isGuardianOn ? ' on' : '') + '"></div>' +
            '</div>' +
            '<div class="ap-toggle-legalname-wrap" data-legalname-for="' + escapeHtml(m.participantId || '') + '" style="margin:-0.4rem 0 0.9rem;' + (isGuardianOn ? '' : ' display:none;') + '">' +
            '<div class="ap-field-label">' + escapeHtml(m.name || 'Child') + '’s full legal name</div>' +
            '<input class="ap-field-input" type="text" data-child-legalname-input="' + escapeHtml(m.participantId || '') + '" placeholder="Full legal name" value="' + escapeHtml(childLegalName) + '">' +
            '</div>';
        }).join('') : '') +
        '<div class="ap-section-label">Emergency Contact (optional)</div>' +
        '<div class="ap-field-label">Name</div>' +
        '<input class="ap-field-input" type="text" id="ap-ec-name" placeholder="Full name" value="' + escapeHtml(state.ecName) + '">' +
        '<div class="ap-field-label">Phone</div>' +
        '<input class="ap-field-input" type="tel" id="ap-ec-phone" placeholder="Phone number" value="' + escapeHtml(state.ecPhone) + '">' +
        '<div id="ap-waiver-error" class="ap-error"></div>' +
        '</div>' +
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
          var turningOn = idx === -1;
          if (turningOn) state.guardianForChildrenParticipantIds.push(participantId); else state.guardianForChildrenParticipantIds.splice(idx, 1);
          row.querySelector('.ap-switch').classList.toggle('on', state.guardianForChildrenParticipantIds.indexOf(participantId) !== -1);
          // NEW (child-waiver capture, 2026-09-03): the legal-name field
          // lives in a sibling wrap immediately after this toggle row
          // (see renderSign()'s minors.map() above) -- reveal it the
          // moment the guardian toggle flips on, so the name is captured
          // as part of the same certifying action, and hide it again if
          // they flip it back off.
          var wrap = row.nextElementSibling;
          if (wrap && wrap.getAttribute('data-legalname-for') === participantId) {
            wrap.style.display = turningOn ? '' : 'none';
            if (turningOn) {
              var nameInput = wrap.querySelector('[data-child-legalname-input]');
              if (nameInput) nameInput.focus();
            }
          }
        });
      });

      function collectFields() {
        state.waiverName = contentEl.querySelector('#ap-waiver-name').value.trim();
        state.ecName = contentEl.querySelector('#ap-ec-name').value.trim();
        state.ecPhone = contentEl.querySelector('#ap-ec-phone').value.trim();
        Array.prototype.forEach.call(contentEl.querySelectorAll('[data-child-legalname-input]'), function (input) {
          state.guardianChildLegalNames[input.getAttribute('data-child-legalname-input')] = input.value.trim();
        });
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
        // NEW (child-waiver capture, 2026-09-03): require the guardian to
        // have actually typed each toggled-on minor's full legal name,
        // same as their own signature above -- an untouched toggle
        // shouldn't be able to fall through to whatever the roster's
        // display name happened to be.
        var missingChildName = state.roster.filter(function (p) {
          return state.guardianForChildrenParticipantIds.indexOf(p.participantId) !== -1 &&
            !(state.guardianChildLegalNames[p.participantId] || '').trim();
        })[0];
        if (missingChildName) {
          contentEl.querySelector('#ap-waiver-error').textContent = 'Enter ' + missingChildName.name + '’s full legal name.';
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
        // UPDATED (child-waiver capture, 2026-09-03): a covered minor now
        // uses the full legal name the guardian typed at signing (see
        // above) rather than the roster's own display name, so the
        // record reflects what was actually certified.
        var participantsCovered = [state.waiverName].concat(
          state.roster.filter(function (p) { return state.guardianForChildrenParticipantIds.indexOf(p.participantId) !== -1; })
            .map(function (p) { return state.guardianChildLegalNames[p.participantId] || p.name; })
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
      // BUG FIX (Airey's direct request, 2026-09-03): renderWaiver()'s
      // outer wrap is ap-wide (960px, for the list/sign screens' wider
      // layouts) and this screen never shrank it back down the way every
      // other single-column recap/confirmation screen in this file does
      // (renderTrail's own renderConfirmation, Gear Kits' confirmation,
      // etc. -- see this function's neighbors for the same one-liner).
      // The recap card/title/body all cap themselves at max-width:640px
      // (ap-styles.css) but with no auto-margin centering of their own,
      // so inside a 960px-wide container they just hugged the left edge
      // instead of sitting centered on the page.
      wrap.classList.remove('ap-wide');
      var eb = state.ctx.experienceBooking;
      var ecLine = state.ecName || state.ecPhone
        ? escapeHtml([state.ecName, state.ecPhone].filter(Boolean).join(' \u00b7 '))
        : 'Not provided';
      // BUG FIX (live-test feedback, 2026-09-02): dropped the gear-deposit
      // note that used to sit here -- not relevant to a waiver-signing
      // confirmation, and already called out on the Gear Kits screen and
      // the Adventure Home hub (see this file's own other two
      // ap-deposit-note instances).
      var bookerConfirmStatus = computeHubStatus();
      var bookerConfirmBody = 'This confirms your waiver and emergency contact are on file.' +
        (bookerConfirmStatus.waiversDone ? '' : ' Once the rest of your group signs, you\u2019re fully clear for gear delivery.');
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Waivers</div>' +
        '<div class="ap-recap-title">Signed. One more thing off your list before the trail.</div>' +
        '<div class="ap-recap-body">' + bookerConfirmBody + '</div>' +
        '<div class="ap-recap-card">' +
        '<div class="ap-recap-line"><span>Waiver Signed By</span><b>' + escapeHtml(state.waiverName || '') + '</b></div>' +
        '<div class="ap-recap-line"><span>Emergency Contact</span><b>' + ecLine + '</b></div>' +
        '</div>' +
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
    var allSet = status.allSet;

    var headline = allSet ? 'Everything’s set.<br>The trail’s waiting.' : 'Almost there.<br>A few things left.';
    var kitStat = status.gearDone ? (status.kitCount + ' packed') : (status.kitCount + ' of ' + status.eligibleCount + ' selected');

    // FIX (Airey's direct request, 2026-09-05): Gear pickup used to show
    // returnPreference -- a leftover field whose "We’ll drop it back off
    // ourselves" copy describes the wrong direction entirely (that's not
    // even an option this flow offers; PSAC picks gear up from the guest,
    // the guest never drops anything off). Delivery and pickup now both
    // show the actual day (derived from experienceBooking.date, since
    // delivery is always the evening before and pickup the evening of)
    // plus the guest's chosen time window -- and deliberately nothing
    // else. This card is meant to be shareable, so no address of any
    // kind belongs on it, on either line.
    var deliveryWindow = ap.deliveryWindow || state.deliveryWindow;
    var deliveryLine = status.gearDone
      ? (formatOffsetDate(eb.date, -1) + (deliveryWindow ? ', ' + deliveryWindow : ''))
      : 'Not set yet';
    var returnWindow = ap.returnWindow || state.returnWindow;
    var hotelPath = (ap.propertyType || state.propertyType) === 'Hotel / resort';
    var pickupTimeLabel = returnWindow || (hotelPath ? 'Final sweep after 9:00pm' : 'Time TBD');
    var pickupLine = status.gearDone
      ? (formatOffsetDate(eb.date, 0) + ', ' + pickupTimeLabel)
      : 'Not set yet';

    var actionHtml = (allSet && status.trailSelected && isPastT3Cutoff())
      ? '<div class="ap-receipt-guide-cta"><span>Your trail guide is ready to download.</span><button type="button" id="ap-get-guide">Get Guide</button></div>'
      : '';

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
      '<div><div class="ap-receipt-stat-label">Group</div><div class="ap-receipt-stat-value">' + attendingRosterCount() + ' adventurers</div></div>' +
      '<div><div class="ap-receipt-stat-label">Gear Kits</div><div class="ap-receipt-stat-value">' + kitStat + '</div></div>' +
      '</div>' +
      '<div class="ap-receipt-divider"></div>' +
      '<div class="ap-receipt-line"><span>Gear delivery</span><b>' + escapeHtml(deliveryLine) + '</b></div>' +
      '<div class="ap-receipt-line"><span>Gear pickup</span><b>' + escapeHtml(pickupLine) + '</b></div>' +
      actionHtml +
      '<div class="ap-receipt-footer">palmspringsadventureclub.com</div>' +
      '</div></div>' +
      '</div></div>'
    );

    wrap.querySelector('#ap-back-to-hub').addEventListener('click', function () { state.step = 'hub'; render(); });
    var guideBtn = wrap.querySelector('#ap-get-guide');
    if (guideBtn) guideBtn.addEventListener('click', function () {
      window.open((ap.rideWithGpsExperienceAccess && ap.rideWithGpsExperienceAccess.url) || 'https://ridewithgps.com/', '_blank');
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
  //
  // UPDATED (per-row "Resend waiver invite" on the Waivers screen itself,
  // 2026-09-03): this button used to be a "resend to everyone" action
  // wearing one person's name (sendSignerLinks re-emailed the whole
  // group every time, with copy here honestly saying so) -- it now
  // passes this person's participantId and only reaches them, matching
  // the equivalent action added to renderWaiver()'s own list screen.
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

    // UPDATED (per-row "Resend waiver invite," 2026-09-03):
    // api/adventure-prep.js's sendSignerLinks now takes an optional
    // participantId that narrows the actual email send to just that one
    // signer (the DB bookkeeping in sendSignerLinksForBooking still runs
    // for the whole booking either way -- that part was always meant to
    // be unconditional, see that function's own header comment). Passing
    // it here means this button really does just remind the one person
    // named on it, instead of quietly re-emailing everyone else too.
    Array.prototype.forEach.call(wrap.querySelectorAll('.ap-waiver-remind-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var participantId = btn.getAttribute('data-participant-id');
        var person = signers.filter(function (s) { return s.participantId === participantId; })[0];
        btn.disabled = true;
        apiPost('/api/adventure-prep', {
          action: 'sendSignerLinks',
          token: TOKEN,
          participantId: participantId,
        }).then(function (res) {
          wrap.querySelector('#ap-remind-status').textContent = res.ok
            ? 'Reminder sent to ' + (person ? person.name : 'this person') + '.'
            : 'Something went wrong sending that reminder, try again.';
          btn.disabled = false;
        });
      });
    });

    return wrap;
  }

  boot();
})();
