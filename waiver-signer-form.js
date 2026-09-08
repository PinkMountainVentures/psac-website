/* ============================================
   PSAC — Adventure Prep, Surface B (non-owner signer waiver link)
   Vanilla JS, no deps. Drives /sign-waiver?token=<signerToken>, one link
   per required adult signer besides the booking owner.

   ROUND 2 REDESIGN (mockup-07-surface-b-confirm-details.html): this used
   to be a single linear 3-step form with its own distinct hero-style
   shell, deliberately NOT reusing Surface A's chrome. Airey asked for
   Surface B to be brought in line with the Round 2 mockups, so this is
   now a scoped Adventure Home hub — same tile-based pattern as
   adventure-prep-form.js's renderHub(), same .ap-header/.ap-shell chrome,
   same white-cards-on-sand-beige visual system — with 4 tiles instead of
   Surface A's 5: Confirm Your Details, Your Trail (view-only), Your
   Waiver, and Adventure Summary (locked until the first two are done).
   No Attendees tile, no Gear Kits tile — both stay owner-managed.

   REWRITTEN (Task 16, 2026-08-31, Postgres migration): this file was
   built against the pre-migration name-keyed guardian model
   (guardianForChildren as an array of child NAMES, submitted straight to
   adventurePrep_saveWaiverSignature). lib/waiver-service.js's real
   saveWaiverSignature only reads guardianForChildrenParticipantIds — the
   name-based key this file sent was silently ignored, so
   applyGuardianCertification never ran for anyone signing here on behalf
   of a child. Also found in the same pass: getSignerContext never
   returned signer.guardianForChildrenJson at all (a real gap, since
   saveWaiverSignature has written it since this file was built) — see
   that function's own header comment for the backend fix. This rewrite:
   state.guardianForChildren -> state.guardianForChildrenParticipantIds
   (keyed by participantId, matching state.ctx.minors' own shape), and
   the guardian checklist now pre-checks any minor getSignerContext flags
   as preAssignedToThisSigner (Section 6's assignment half — the booker
   named this signer as the guardian at roster-confirmation time) rather
   than always starting unchecked, while still requiring the affirmative
   click to actually submit (never auto-certifying).

   RESOLVED (Part 5 branch, 2026-09-03): mockup-07 also shows a second
   scenario -- "Taylor," an adult who is named as a guardian for a minor
   but is NOT herself attending or on the roster. This paragraph used to
   flag two real gaps here; both are closed now. First, the booker-side
   assignment UI (renderRosterGuardians(), adventure-prep-form.js) was
   built 2026-09-02, per that file's own header -- a real "Taylor" token
   is issued today, this was stale by the time this paragraph was next
   read. Second, this file's own hub now has that second branch:
   getSignerContext returns isGuardianOnly (role_on_booking ===
   'guardian_only'), and render() routes straight to
   renderGuardianOnlyHub()/renderGuardianOnlyCertify() for that case,
   entirely separate from renderHub() above -- no Your Trail/Gear/
   Adventure Summary tiles, "[Child]'s Trail"/"Who's Going"/"The Day"/
   "[Child]'s Waiver" instead, per
   claude/psac-adventure-prep-full-copy-pass-rewrite-proposal-2026-09-03.md
   Part 5's approved copy. See that branch's own comments for the design.

   Two screens have no mockup frame to build against (Your Trail's detail
   view, and Adventure Summary's unlocked content) — both are deliberately
   minimal, read-only recaps assembled from data Surface A already has,
   flagged in their own comments below rather than presented as "to spec."
   ============================================ */

(function () {
  'use strict';

  var qs = new URLSearchParams(window.location.search);
  var SIGNER_TOKEN = qs.get('token') || '';
  var root = document.getElementById('sb-root');

  var state = {
    ctx: null,
    step: 'hub', // attending signer: 'hub' | 'confirmDetails' | 'trail' | 'gear' | 'waiver' | 'summary'
            // guardian_only signer (Part 5): 'hub' | 'guardianCertify' -- routed independently, see render()
    // Confirm Your Details
    email: '',
    phone: '',
    smsConsent: false,
    // Your Waiver (sign sub-flow)
    waiverName: '',
    guardianForChildrenParticipantIds: [], // NEW (Task 16): array of participant_ids, replaces the old name-keyed guardianForChildren — matches lib/waiver-service.js's real saveWaiverSignature contract
    ecName: '',
    ecPhone: '',
    // Surface B trail-day arc (2026-09-08) -- same triage-flow fields
    // adventure-prep-form.js's own state object carries, see that file's
    // renderTrailCheckinTriage() for what each drives.
    checkinAffectedIds: [],
    checkinOmitRunningLonger: false,
    checkinCategory: null,
    checkinLostSeparatedWho: null,
    checkinRunningLongerConfirmed: false,
    checkinRunningLongerDisplay: '',
    hasOpenIncident: false,
    // NEW (Post-Adventure Check-in, 2026-09-08) -- see
    // claude/psac-post-adventure-phase3-final-spec-2026-09-08.md. Shared
    // across every signer variant's own Check-in card (fbGear unused by
    // guardian_only, fbCheckin unused by everyone else -- each render
    // function only reads the fields its own persona's card collects).
    fbOverall: null,
    fbGear: null,
    fbCheckin: null,
    fbNote: '',
    fbSubmitting: false,
    fbSubmitted: false,
    fbError: '',
  };

  // Surface B trail-day arc (2026-09-08) -- same six triage options as
  // Surface A's own CHECKIN_OPTIONS (adventure-prep-form.js), shared
  // engine per the approved proposal's "Multi-surface access" section.
  var CHECKIN_OPTIONS = [
    { key: 'injury', label: 'Someone’s hurt' },
    { key: 'lost_separated', label: 'Someone’s lost, or we got separated' },
    { key: 'heat_illness', label: 'Someone’s showing signs of heat illness' },
    { key: 'running_longer', label: 'Everyone’s fine, just taking longer than expected' },
    { key: 'overdue_unknown', label: 'They’re just not back yet and we don’t know why' },
    { key: 'other', label: 'Something else' },
  ];

  // Matches lib/adventure-prep-service.js's own AGE_BUCKET_MAP (reversed)
  // — getSignerContext returns each minor's raw age_bucket enum value
  // (ageBucket), not a human-readable label; this file's own copy of the
  // same small lookup table every migrated file keeps for itself (see
  // lib/finalize-kit-change.js's own header comment on that convention).
  var AGE_BUCKET_LABELS = {
    under_14: 'Under 14',
    '14_17': '14–17',
    '18_24': '18–24',
    '25_34': '25–34',
    '35_44': '35–44',
    '45_54': '45–54',
    '55_64': '55–64',
    '65_plus': '65+',
  };

  // Matches the live booking flow's own SMS opt-in structure exactly
  // (Twilio A2P 10DLC requirements: exact consent text stored with a
  // timestamp, opt-in never required, rate/frequency disclosure, STOP/
  // HELP instructions, link to Terms & Privacy) — see adventure-form.js's
  // SMS_CONSENT_TEXT. Only the subject of the message is adapted here,
  // per mockup-07's own note, since this is a separate consent event for
  // a different purpose than the original booker's own consent.
  var SMS_CONSENT_LABEL = 'Yes, send me text messages from Palm Springs Adventure Club about this adventure, including trail updates, waivers you need to sign, and weather for your trail day.';
  var SMS_CONSENT_FINEPRINT = 'Optional, not required to continue. Message frequency varies. Message and data rates may apply. Reply STOP to cancel, HELP for help.';
  var SMS_CONSENT_TEXT = SMS_CONSENT_LABEL + ' ' + SMS_CONSENT_FINEPRINT + ' See Terms of Service and Privacy Policy at palmspringsadventureclub.com.';
  // PLACEHOLDER COPY, not final -- Airey asked for an email opt-in for
  // the Kit list here (Confirm Your Details, Sept 2026 follow-up) but
  // hadn't specified marketing copy yet, so this is a reasonable first
  // draft pending the real copy review, same posture this file already
  // took with the intro banner before that round's copy landed.
  var KIT_OPTIN_LABEL = 'Yes, sign me up for occasional emails from Palm Springs Adventure Club about trail guides, gear tips, and future adventures.';

  // Same rental/keepsake split as adventure-prep-form.js's own Gear Kits
  // screen (renderKitScreen's kit-info panel) -- a non-owner signer never
  // went through the booking flow, so they've never seen this list the
  // way the booker has. Kept in sync manually since these are separate
  // client bundles, same caveat as this file's ported compareCardHtml.
  var RENTAL_GEAR_ITEMS = ['Gregory daypack', 'Leki trekking poles', 'Two Hydro Flask 32oz bottles', 'First aid kit'];
  var KEEPSAKE_ITEMS = ['LMNT electrolytes', 'Rancho Meladuco Medjool dates', 'Blue Lizard mineral sunscreen'];
  // Same icon adventure-prep-form.js's own hub uses for its pre-T3
  // trail-locked note -- ported here since this is a separate client
  // bundle (see this file's header comment), needed now that Surface B's
  // own trail section gets the same locked/unlocked treatment.
  var LOCK_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="5.5" y="10.3" width="13" height="10.2" rx="2" stroke="#2A4747" stroke-width="1.4"/><path d="M8.2 10.3V7.7a3.8 3.8 0 0 1 7.6 0v2.6" stroke="#2A4747" stroke-width="1.4" stroke-linecap="round"/><circle cx="12" cy="15.1" r="1.2" fill="#F58271"/><path d="M12 16.3v1.5" stroke="#F58271" stroke-width="1.3" stroke-linecap="round"/></svg>';

  function h(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function apiGet(path) {
    return fetch(path).then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, body: b }; }); });
  }
  function apiPost(path, payload) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, body: b }; }); });
  }
  function formatTripDate(dateStr) {
    var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return 'an upcoming trip';
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(d);
  }

  // -----------------------------------------------------------------
  // Date math for the Phase 1/2 escalating hub arc (hub-lifecycle-
  // alerts-proposal.md, 2026-09-03) -- this file never needed T-3/
  // delivery-day/today's-own-date logic before now, so none of these
  // existed here; same techniques adventure-prep-form.js's own copies
  // already use (this file is a separate client bundle, no shared
  // import path between the two -- see this file's header comment).
  // -----------------------------------------------------------------
  function pacificOffsetMinutes(utcInstant) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    var parts = dtf.formatToParts(utcInstant).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
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
  function isPastT3Cutoff(tripDateStr) {
    var cutoff = computeT3CutoffDate(tripDateStr);
    return !!cutoff && new Date() >= cutoff;
  }
  function pacificDateString(date) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    var parts = dtf.formatToParts(date).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  // Surface B trail-day arc (2026-09-08) -- ported unchanged from
  // adventure-prep-form.js.
  function formatPacificTime(isoString) {
    if (!isoString) return '';
    var d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    var formatted = d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
    return formatted.replace(' ', '').toLowerCase();
  }

  // Surface B trail-day arc (2026-09-08) -- formats the running-longer
  // branch's own <input type="time"> value (guest's local device clock),
  // ported unchanged from adventure-prep-form.js.
  function formatTimeInputLabel(hhmm) {
    var parts = String(hhmm || '').split(':');
    if (parts.length !== 2) return '';
    var hour = parseInt(parts[0], 10);
    var minute = parts[1];
    if (isNaN(hour)) return '';
    var ampm = hour >= 12 ? 'pm' : 'am';
    var hour12 = hour % 12;
    if (hour12 === 0) hour12 = 12;
    return hour12 + ':' + minute + ampm;
  }

  function isoOffsetDateStr(dateStr, dayOffset) {
    var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dayOffset));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  // Trail-day countdown badge (T-3 hub refresh, 2026-09-04) -- whole-day
  // count between Pacific "today" and the trip date, clamped to 0.
  // Separate copy from Surface A's own daysUntilTrip() -- these are two
  // separate client bundles with no shared import path.
  function daysUntilTrip(dateStr) {
    var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    var todayStr = pacificDateString(new Date());
    var tm = todayStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    var tripUTC = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var todayUTC = Date.UTC(Number(tm[1]), Number(tm[2]) - 1, Number(tm[3]));
    var diff = Math.round((tripUTC - todayUTC) / 86400000);
    return diff > 0 ? diff : 0;
  }

  // Post-Adventure Phase 3 sequencing (2026-09-08 final spec, sections
  // 3-6) -- same technique as adventure-prep-form.js's own copy of
  // these three helpers, duplicated deliberately (separate client
  // bundle, no shared import path -- see this file's own header
  // comment on why daysUntilTrip/pacificDateString are already
  // duplicated here).
  function daysSinceTrip(dateStr) {
    var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return 0;
    var todayStr = pacificDateString(new Date());
    var tm = todayStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    var tripUTC = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var todayUTC = Date.UTC(Number(tm[1]), Number(tm[2]) - 1, Number(tm[3]));
    var diff = Math.round((todayUTC - tripUTC) / 86400000);
    return diff > 0 ? diff : 0;
  }

  function computeT1SendDate(tripDateStr) {
    var m = String(tripDateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var oneForward = new Date(Date.UTC(y, mo - 1, d) + 1 * 86400000);
    var cy = oneForward.getUTCFullYear(), cm = oneForward.getUTCMonth(), cd = oneForward.getUTCDate();
    var guess = new Date(Date.UTC(cy, cm, cd, 9, 0, 0) + 8 * 3600000);
    var offset = pacificOffsetMinutes(guess);
    return new Date(Date.UTC(cy, cm, cd, 9, 0, 0) - offset * 60000);
  }

  function isPastT1SendTime(tripDateStr) {
    var sendAt = computeT1SendDate(tripDateStr);
    return !!sendAt && new Date() >= sendAt;
  }

  // Post-Adventure Phase 3 card sequencing -- same
  // computePostAdventurePhase as adventure-prep-form.js, see that
  // file's own header comment for the Closing-vs-Steady-State
  // resolution (CLOSING_MIN_DAYS/CLOSING_WINDOW_DAYS), flagged to Airey
  // there. `gearReturnDone` is always passed true from this file's own
  // callers below -- Surface B carries no gear-return state at all
  // (Airey's direct, pre-existing call: gear return is booker-only,
  // this surface has always stayed gear-free), so the Closing gate here
  // is purely the day-since-trip threshold.
  var CLOSING_MIN_DAYS = 4;
  var CLOSING_WINDOW_DAYS = 14;

  function computePostAdventurePhase(tripDateStr, feedbackSubmitted, gearReturnDone) {
    if (!isPastT1SendTime(tripDateStr)) return 'turn';
    if (!feedbackSubmitted) return 'checkin';
    var since = daysSinceTrip(tripDateStr);
    if (since >= CLOSING_WINDOW_DAYS) return 'steady';
    if (gearReturnDone && (feedbackSubmitted || since >= CLOSING_MIN_DAYS)) return 'closing';
    return 'steady';
  }
  function joinWithAnd(items) {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return items[0] + ' and ' + items[1];
    return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
  }

  function boot() {
    if (!SIGNER_TOKEN) { renderMessage('This link isn’t quite right', 'We couldn’t find a waiver to sign here. Ask whoever added you to resend the link, or reach out to us directly.'); return; }
    apiGet('/api/waiver?signerToken=' + encodeURIComponent(SIGNER_TOKEN)).then(function (res) {
      if (!res.ok) { renderMessage('This link isn’t quite right', 'We couldn’t find that link. Ask whoever added you to resend it, or reach out to us directly.'); return; }
      state.ctx = res.body;
      var signer = res.body.signer || {};
      state.waiverName = signer.signerName || '';
      state.email = signer.signerEmail || '';
      state.phone = signer.signerPhone || '';
      state.smsConsent = !!signer.smsConsent;
      render();
    });
  }

  function renderMessage(title, body) {
    root.innerHTML = '';
    root.appendChild(h(
      '<div class="container"><div class="ap-shell" style="text-align:center; padding-top:3rem;">' +
      '<h1 class="ap-q-title" style="margin:0 auto 0.6rem;">' + escapeHtml(title) + '</h1>' +
      '<p class="ap-q-help" style="margin:0 auto;">' + body + '</p>' +
      '</div></div>'
    ));
  }

  function render() {
    root.innerHTML = '';
    var frag;
    // Part 5 branch (non-attending guardian, 2026-09-03): a guardian_only
    // signer -- named as a minor's guardian but not attending themselves,
    // distinct from 3.3's attending-guardian case above -- gets an
    // entirely separate hub, never the ordinary 5-step tile set. Checked
    // first and unconditionally, since nothing below applies to this
    // persona (no gear, no personal waiver, no Adventure Summary).
    if (state.ctx && state.ctx.isGuardianOnly) {
      switch (state.step) {
        case 'guardianCertify': frag = renderGuardianOnlyCertify(); break;
        case 'ridewithgpsInfo': frag = renderRideWithGpsInfo(); break;
        case 'trailCheckinTriage': frag = renderGuardianTrailCheckinTriage(); break;
        default: frag = renderGuardianOnlyHub();
      }
      root.appendChild(frag);
      if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0);
      return;
    }
    switch (state.step) {
      case 'confirmDetails': frag = renderConfirmDetails(); break;
      case 'trail': frag = renderTrail(); break;
      case 'gear': frag = renderGear(); break;
      case 'waiver': frag = renderWaiver(); break;
      case 'summary': frag = renderSummary(); break;
      case 'ridewithgpsInfo': frag = renderRideWithGpsInfo(); break;
      // Surface B trail-day arc (2026-09-08).
      case 'headingOut': frag = renderHeadingOutSheet(); break;
      case 'emergencySosInfo': frag = renderEmergencySosInfo(); break;
      case 'trailReturnRoster': frag = renderTrailReturnRosterSheet(); break;
      case 'trailCheckinTriage': frag = renderTrailCheckinTriage(); break;
      default: frag = renderHub();
    }
    root.appendChild(frag);
    // Matches adventure-prep-form.js's own render() — mockup-07's own note
    // says the same scroll-to-top behavior documented in the other
    // mockups applies here too, to Save & Continue and to tapping any tile.
    if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0);
  }

  function computeStatus() {
    var signer = state.ctx.signer || {};
    var detailsDone = !!signer.detailsConfirmedAt;
    var waiverDone = signer.status === 'signed';
    // BUG FIX (Sept 2026, Attendees walkthrough follow-up): this used to
    // look up the selected trail by filtering state.ctx.candidateTrails --
    // a key getSignerContext never actually sent (it returns
    // selectedTrail, a single object, not a candidates array), so
    // trailMatch was always undefined and the "Your Trail" tile silently
    // rendered a blank second line even once a trail had been picked.
    // getSignerContext now returns the selected trail's full stats
    // (distance/elevation/ratings included) directly on state.ctx, so
    // read it straight from there instead of re-deriving it.
    var selectedTrailId = state.ctx.selectedTrailId;
    var trailMatch = state.ctx.selectedTrail || null;
    // NEW (Task 16): guardianForChildrenParticipantIds is a real JSONB
    // column (guardian_for_children_json) that lib/waiver-service.js's
    // getSignerContext already returns pre-parsed as a JS array — NOT a
    // JSON string to re-parse here, despite the column's own _json name
    // (the Neon driver deserializes JSONB automatically). Mapped to
    // display names via state.ctx.minors (the only roster subset Surface
    // B's context carries) for the hub tile/summary sub-labels below. A
    // minor certified in a PRIOR visit that's since aged off
    // state.ctx.minors (shouldn't happen in practice — minors aren't
    // removed from the roster) would silently drop from the label only,
    // never from the underlying certification itself.
    var guardianForChildrenParticipantIds = signer.guardianForChildrenParticipantIds || [];
    var minorsById = {};
    (state.ctx.minors || []).forEach(function (m) { minorsById[m.participantId] = m; });
    var guardianForChildrenNames = guardianForChildrenParticipantIds
      .map(function (pid) { return minorsById[pid] ? minorsById[pid].name : null; })
      .filter(Boolean);
    return {
      detailsDone: detailsDone,
      waiverDone: waiverDone,
      guardianForChildren: guardianForChildrenNames,
      trailAssigned: !!selectedTrailId,
      trailName: trailMatch ? trailMatch.trailName : '',
      trailDescription: trailMatch ? (trailMatch.overviewCopy || (trailMatch.matchedAttributes || []).join(', ')) : '',
      trailDetail: trailMatch,
      // Same judgment call as adventure-prep-form.js's own hub status
      // comment: no mockup exists for Surface B's Adventure Summary
      // content, so this unlocks on the two things Surface B itself
      // gates (Confirm Your Details + signing) rather than also
      // requiring the trail to be assigned, which is out of this
      // signer's hands entirely.
      summaryUnlocked: detailsDone && waiverDone,
      // NEW (Phase 1/2 escalating hub arc, 2026-09-03): same value as
      // summaryUnlocked above, named to match Surface A's own allSet
      // field so the two hubs' top-card logic reads the same way.
      allSet: detailsDone && waiverDone,
    };
  }

  // ---------------------------------------------------------------------
  // Trail card (mirrors adventure-prep-form.js's own compareCardHtml /
  // summarize / difficultyLabel / technicalLabel) -- read-only version
  // for Surface B's hub, Sept 2026: no badge, no CTA button, since this
  // signer never controls trail selection, just needs to see it. Kept as
  // a small local port rather than a shared require because the two
  // files are separate client bundles for separate pages, not modules
  // that can import from one another.
  // ---------------------------------------------------------------------
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
  function difficultyLabel(n) {
    if (n == null) return '-';
    if (n <= 2) return 'Easy';
    if (n === 3) return 'Moderate';
    return 'Hard';
  }
  function technicalLabel(n) {
    if (n == null) return '-';
    if (n <= 2) return 'Low';
    if (n === 3) return 'Moderate';
    return 'High';
  }
  // Hub top card, Climax onward -- hero-photo treatment with a dark-card
  // fallback when a trail has no photo yet
  // (hub-top-card-visual-options.html, 2026-09-03). headlineHtml/
  // sublineHtml are passed through as already-safe HTML, matching how
  // topGreetingHtml/topSublineHtml are built and inserted everywhere else
  // in this file.
  function heroCardHtml(eyebrowText, headlineHtml, sublineHtml, photoUrl, countdownDays, dimmed) {
    // Trail-day countdown badge (T-3 hub refresh, 2026-09-04): only
    // rendered when a caller passes a real number -- pre-T3 callers pass
    // null/undefined and get no badge at all.
    var badgeHtml = '';
    if (countdownDays !== null && countdownDays !== undefined) {
      var badgeNum = countdownDays > 0 ? String(countdownDays) : 'Today';
      var badgeLbl = countdownDays > 0 ? (countdownDays === 1 ? 'Day to go' : 'Days to go') : 'Trail day!';
      badgeHtml = '<div class="ap-countdown-badge"><div class="ap-countdown-num">' + badgeNum + '</div><div class="ap-countdown-lbl">' + badgeLbl + '</div></div>';
    }
    // `dimmed` (Surface B trail-day arc, 2026-09-08) -- same Underway
    // treatment Surface A's own heroCardHtml already carries, see
    // .ap-hero-card.dimmed in ap-styles.css (shared file, no new CSS
    // needed here).
    return '<div class="ap-hero-card' + (photoUrl ? '' : ' no-photo') + (dimmed ? ' dimmed' : '') + '"' +
      (photoUrl ? ' style="background-image:url(\'' + photoUrl + '\');"' : '') + '>' +
      badgeHtml +
      '<div class="ap-hero-card-inner">' +
      '<div class="ap-hero-eyebrow">' + escapeHtml(eyebrowText) + '</div>' +
      '<div class="ap-hero-headline">' + headlineHtml + '</div>' +
      '<div class="ap-hero-subline">' + sublineHtml + '</div>' +
      '</div></div>';
  }

  // ---------------------------------------------------------------------
  // Post-Adventure Phase 3 -- Check-in / Closing / Steady State
  // (claude/psac-post-adventure-phase3-final-spec-2026-09-08.md, sections
  // 4-6). Shared across every Surface B signer variant; which copy/CTA
  // renders is decided by the caller (hubIsGuardian for the attending-
  // signer hub, or the dedicated guardian_only variants further below).
  // ---------------------------------------------------------------------

  function fbRatingRowHtml(field, label, value, optional) {
    var btns = '';
    for (var i = 1; i <= 5; i++) {
      btns += '<button type="button" class="fb-scale-btn' + (value === i ? ' selected' : '') + '" data-fb-field="' + field + '" data-fb-value="' + i + '">' + i + '</button>';
    }
    return '<div class="fb-question">' +
      '<div class="fb-question-label">' + escapeHtml(label) + (optional ? ' <span class="fb-optional">(optional)</span>' : '') + '</div>' +
      '<div class="fb-scale">' + btns + '</div>' +
      '</div>';
  }

  // Participant/participant_guardian Check-in -- the 2-field set
  // (overall + optional gear), see spec section 4. hubIsGuardian picks
  // between the plain-participant and attending-guardian headline/sub.
  function checkinCardHtml(trailName, hubIsGuardian, hubChildLabel) {
    var headline = hubIsGuardian ? 'How did ' + hubChildLabel + ' do out there?' : 'How was ' + escapeHtml(trailName) + '?';
    var sub = hubIsGuardian
      ? 'A word from you helps us get the next trail right for the next family too.'
      : 'You weren’t the one who booked it, but the day was yours too. A quick word helps us get it right for whoever’s next.';
    return '<div class="fb-eyebrow">Peaks to Pools</div>' +
      '<div class="fb-card">' +
      '<div class="fb-headline">' + headline + '</div>' +
      '<div class="fb-sub">' + sub + '</div>' +
      '<div class="fb-rule"></div>' +
      fbRatingRowHtml('fbOverall', hubIsGuardian ? 'Overall, how’d it go?' : 'Overall, how was your day?', state.fbOverall, false) +
      fbRatingRowHtml('fbGear', 'How was your gear kit?', state.fbGear, true) +
      '<div class="fb-note-wrap"><label class="fb-note-label" for="fb-note">Anything else you want to tell us?</label>' +
      '<textarea id="fb-note" class="fb-note-field" placeholder="Optional">' + escapeHtml(state.fbNote || '') + '</textarea></div>' +
      (state.fbError ? '<div class="ap-error">' + escapeHtml(state.fbError) + '</div>' : '') +
      '<button type="button" class="ap-cta-primary" id="fb-submit-btn"' + (state.fbSubmitting ? ' disabled' : '') + '>' + (state.fbSubmitting ? 'Sending…' : 'Submit') + '</button>' +
      '</div>';
  }

  // Non-attending guardian's OWN Check-in -- genuinely new copy (spec
  // section 5), never a lighter copy of the attending set: no gear kit
  // to rate, wasn't on the trail, so the two questions this persona
  // actually has a real view of are what the day felt like from home.
  function guardianOnlyCheckinCardHtml() {
    return '<div class="fb-eyebrow">Peaks to Pools</div>' +
      '<div class="fb-card">' +
      '<div class="fb-headline">How did today feel from your end?</div>' +
      '<div class="fb-sub">You weren’t out there, but the day was yours too, in its own way. A quick word helps us make sure a guardian at home always has what they need.</div>' +
      '<div class="fb-rule"></div>' +
      fbRatingRowHtml('fbOverall', 'Overall, how did today go for you?', state.fbOverall, false) +
      fbRatingRowHtml('fbCheckin', 'How was staying in the loop while they were out there?', state.fbCheckin, true) +
      '<div class="fb-note-wrap"><label class="fb-note-label" for="fb-note">Anything else you want to tell us?</label>' +
      '<textarea id="fb-note" class="fb-note-field" placeholder="Optional">' + escapeHtml(state.fbNote || '') + '</textarea></div>' +
      (state.fbError ? '<div class="ap-error">' + escapeHtml(state.fbError) + '</div>' : '') +
      '<button type="button" class="ap-cta-primary" id="fb-submit-btn"' + (state.fbSubmitting ? ' disabled' : '') + '>' + (state.fbSubmitting ? 'Sending…' : 'Submit') + '</button>' +
      '</div>';
  }

  // Closing card -- share request (everyone) + second half that
  // differs: membership invite for a plain participant, email-list
  // invite for every guardian variant (attending or not), per spec
  // section 4/5.
  function closingCardHtml(hubIsGuardian) {
    // MEMBERSHIP INVITE HIDDEN (2026-09-08, Airey's direct call): no
    // land-use access for guided hikes yet and zero current members, so
    // membership signup has ~no value right now -- same reasoning as
    // index.html's own "THE CLUB" section, hidden the same day. The
    // guardian variant's newsletter invite is unaffected (a plain email
    // list, not membership) and stays live. Re-enable the participant
    // branch's membership invite (and its own rule/second-half markup,
    // matching the guardian branch's shape below) once guided-hike land
    // use clears, expected early 2027.
    var secondHalfHtml = hubIsGuardian
      ? '<div class="fb-rule"></div><div class="fb-headline" style="font-size:1.05rem;">A trail idea or two, sent every once in a while?</div><button type="button" class="ap-cta-secondary" id="cl-newsletter-btn">Get The Newsletter</button>'
      : '';
    return '<div class="fb-eyebrow">Peaks to Pools</div>' +
      '<div class="fb-card cl-card">' +
      '<div class="fb-headline">You earned the pool.</div>' +
      '<div class="fb-sub">If today’s worth telling someone about, that means more coming from you than anything we’d write ourselves.</div>' +
      '<button type="button" class="ap-cta-primary" id="cl-share-btn">Share The Club</button>' +
      secondHalfHtml +
      '</div>';
  }

  // Non-attending guardian's own Closing card -- same email-list invite
  // as the attending guardian's, no membership invite (spec section 5:
  // "already generic across every guardian variant... no change needed").
  function guardianOnlyClosingCardHtml() {
    return closingCardHtml(true);
  }

  // Steady State -- permanent resting state, dusk hero-photo treatment.
  function steadyStateCardHtml(trailName, hubIsGuardian, hubChildLabel, photoUrl) {
    var headline = hubIsGuardian ? hubChildLabel + '’s next peak is already waiting.' : 'Peak done. Pool earned. Your next peak’s already waiting.';
    var sub = hubIsGuardian ? 'If your own family’s ever up for a day like that, we’re here.' : escapeHtml(trailName) + ' was the first one, not the only one.';
    return heroCardHtml('Peaks to Pools', headline, sub, photoUrl, null, true) +
      '<a href="/" class="ap-cta-primary" style="text-decoration:none; display:block; max-width:960px;">Start My Adventure</a>';
  }

  // Shared DOM wiring for whichever Post-Adventure card actually
  // rendered (Check-in's rating taps/submit, or Closing's share/
  // newsletter buttons) -- called from both renderHub() and
  // renderGuardianOnlyHub() rather than duplicated per-hub, since the
  // markup/data-attributes are identical either way (only which fb-*
  // fields a given persona's Check-in card actually shows differs, and
  // that's already decided by checkinCardHtml/guardianOnlyCheckinCardHtml
  // above, not by this wiring).
  function wireFeedbackCard(wrap) {
    wrap.querySelectorAll('.fb-scale-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var field = btn.getAttribute('data-fb-field');
        var val = Number(btn.getAttribute('data-fb-value'));
        state[field] = state[field] === val ? null : val;
        render();
      });
    });
    var fbNoteField = wrap.querySelector('#fb-note');
    if (fbNoteField) {
      fbNoteField.addEventListener('input', function () { state.fbNote = fbNoteField.value; });
    }
    var fbSubmitBtn = wrap.querySelector('#fb-submit-btn');
    if (fbSubmitBtn) {
      fbSubmitBtn.addEventListener('click', function () {
        if (!state.fbOverall) {
          state.fbError = 'An overall rating is required.';
          render();
          return;
        }
        state.fbSubmitting = true;
        state.fbError = '';
        render();
        apiPost('/api/waiver', {
          action: 'submitFeedback',
          signerToken: SIGNER_TOKEN,
          overallRating: state.fbOverall,
          gearRating: state.fbGear,
          checkinRating: state.fbCheckin,
          note: state.fbNote,
        }).then(function (res) {
          state.fbSubmitting = false;
          if (res.ok && res.body && res.body.ok) {
            state.fbSubmitted = true;
            state.ctx.feedbackSubmitted = true;
          } else {
            state.fbError = 'Something went wrong sending that. Please try again.';
          }
          render();
        });
      });
    }
    var clShareBtn = wrap.querySelector('#cl-share-btn');
    if (clShareBtn) {
      clShareBtn.addEventListener('click', function () {
        var shareData = {
          title: 'Palm Springs Adventure Club',
          text: 'I just got back from an adventure with Palm Springs Adventure Club, thought you’d like it too.',
          url: 'https://www.palmspringsadventureclub.com',
        };
        if (navigator.share) {
          navigator.share(shareData).catch(function () { /* cancelled, nothing to do */ });
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(shareData.url).then(function () {
            var original = clShareBtn.textContent;
            clShareBtn.textContent = 'Link Copied';
            setTimeout(function () { clShareBtn.textContent = original; }, 1500);
          }).catch(function () { /* clipboard denied, leave button as-is */ });
        }
      });
    }
    var clNewsletterBtn = wrap.querySelector('#cl-newsletter-btn');
    if (clNewsletterBtn) {
      clNewsletterBtn.addEventListener('click', function () {
        var email = (state.ctx.signer && state.ctx.signer.signerEmail) || '';
        if (!email) return;
        clNewsletterBtn.disabled = true;
        clNewsletterBtn.textContent = 'Signing Up…';
        // role:guardian (23211386) + interest:family-adventure (23211391)
        // -- Kit tagging, Post-Adventure Check-in build, 2026-09-08. This
        // button only ever renders for a guardian variant (closingCardHtml
        // only wires it when hubIsGuardian, see that function above), so
        // no role branching is needed here the way Confirm Details' own
        // opt-in below needs it.
        apiPost('/api/kit-subscribe', { email: email, extraTagIds: [23211386, 23211391] }).then(function () {
          clNewsletterBtn.textContent = 'You’re Signed Up';
        }).catch(function () {
          clNewsletterBtn.disabled = false;
          clNewsletterBtn.textContent = 'Get The Newsletter';
        });
      });
    }
  }

  // `lean` (new, hub-trail-card-placement-options.html) renders without
  // the photo bar -- used once the hero card above already carries the
  // photo, so the page isn't showing the same photo twice.
  function compareCardHtml(candidate, lean) {
    var desc = summarize(candidate.overviewCopy, 250) || ((candidate.matchedAttributes || []).length
      ? 'What you told us you wanted: ' + candidate.matchedAttributes.join(', ') + '.'
      : 'A safe, solid fit for your group.');
    return '<div class="ap-compare-card' + (lean ? ' lean' : '') + '">' +
      (lean ? '' : '<div class="ap-compare-photo"' + (candidate.photoUrl ? ' style="background-image:url(\'' + candidate.photoUrl + '\'); background-size:cover; background-position:center;"' : '') + '></div>') +
      '<div class="ap-compare-body">' +
      '<div class="ap-compare-name">' + escapeHtml(candidate.trailName || '') + '</div>' +
      '<div class="ap-compare-stats">' +
      '<div><div class="ap-compare-stat-label">Distance</div><div class="ap-compare-stat-value">' + (candidate.distance != null ? candidate.distance + ' mi' : '-') + '</div></div>' +
      '<div><div class="ap-compare-stat-label">Elevation</div><div class="ap-compare-stat-value">' + (candidate.elevation != null ? candidate.elevation + ' ft' : '-') + '</div></div>' +
      '<div><div class="ap-compare-stat-label">Difficulty</div><div class="ap-compare-stat-value">' + difficultyLabel(candidate.difficultyRating) + '</div></div>' +
      '<div><div class="ap-compare-stat-label">Technical</div><div class="ap-compare-stat-value">' + technicalLabel(candidate.technicalRating) + '</div></div>' +
      '</div>' +
      '<div class="ap-compare-desc">' + escapeHtml(desc) + '</div>' +
      '</div></div>';
  }

  function goHub() { state.step = 'hub'; render(); }

  // ---------------------------------------------------------------------
  // Scoped Adventure Home hub (mockup-07 frame 1)
  // ---------------------------------------------------------------------
  // Weather glance (T-3 hub refresh, 2026-09-04) -- renders nothing
  // until real forecast data exists; wired against a future
  // signer weather field once the Weather API integration (tracked
  // separately on the build checklist) actually populates it.
  // Deliberately does not fabricate placeholder numbers for a real
  // guest making outdoor-safety decisions. Separate copy from Surface
  // A's own weatherCardHtml() -- these are two separate client bundles
  // with no shared import path (see this file's header comment).
  // Picks an icon that actually matches the reported condition text,
  // instead of always showing a sun regardless of what the forecast
  // says (caught by Airey reviewing a "95F, Mostly cloudy" card with a
  // sun icon on it). Matches on keywords in the condition string since
  // that's already a humanized label (weatherService's conditionLabel()
  // -- either Google's own localized description text, or a humanized
  // version of its CLEAR/PARTLY_CLOUDY/RAIN/... type enum), not the raw
  // enum itself. Falls back to sun for clear/unrecognized conditions.
  // Separate copy from Surface A's own weatherIconSvg() -- same "two
  // separate client bundles" reason weatherCardHtml() is duplicated.
  function weatherIconSvg(condition) {
    var c = String(condition || '').toLowerCase();
    var cloud = 'M6.5 19a4.5 4.5 0 0 1-.62-8.96A6 6 0 0 1 17.6 8.06 4.5 4.5 0 0 1 17 19H6.5Z';
    if (c.indexOf('thunder') !== -1) {
      return '<svg class="ap-weather-icon" viewBox="0 0 24 24" fill="none"><path d="' + cloud + '" fill="#9BB0BE"/><path d="M12.5 13l-3 5h2.5l-1 4 4-5.5h-2.5l1-3.5Z" fill="#F5A623"/></svg>';
    }
    if (c.indexOf('snow') !== -1) {
      return '<svg class="ap-weather-icon" viewBox="0 0 24 24" fill="none"><path d="' + cloud + '" fill="#9BB0BE"/><g stroke="#8FCBE0" stroke-width="1.4" stroke-linecap="round"><path d="M8 18v3M6.5 19.5h3"/><path d="M12 18v3M10.5 19.5h3"/><path d="M16 18v3M14.5 19.5h3"/></g></svg>';
    }
    if (c.indexOf('rain') !== -1 || c.indexOf('shower') !== -1) {
      return '<svg class="ap-weather-icon" viewBox="0 0 24 24" fill="none"><path d="' + cloud + '" fill="#9BB0BE"/><g stroke="#6FA8C9" stroke-width="1.6" stroke-linecap="round"><path d="M8 18.5v2"/><path d="M12 18.5v2"/><path d="M16 18.5v2"/></g></svg>';
    }
    if (c.indexOf('wind') !== -1) {
      return '<svg class="ap-weather-icon" viewBox="0 0 24 24" fill="none"><g stroke="#9BB0BE" stroke-width="1.6" stroke-linecap="round"><path d="M3 8h11a2.5 2.5 0 1 0-2.2-3.7"/><path d="M3 12h15a2.5 2.5 0 1 1-2.2 3.9"/><path d="M3 16h9a2 2 0 1 1-1.8 2.9"/></g></svg>';
    }
    if (c.indexOf('cloud') !== -1) {
      if (c.indexOf('partly') !== -1 || c.indexOf('mostly clear') !== -1) {
        return '<svg class="ap-weather-icon" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.6" fill="#F5A623"/><g stroke="#F5A623" stroke-width="1.3" stroke-linecap="round"><path d="M9 2.4v1.6"/><path d="M3.4 8H5"/><path d="M4.9 3.9l1.1 1.1"/></g><path d="M8 20a4 4 0 0 1-.5-7.97A5.3 5.3 0 0 1 18 13.5 4 4 0 0 1 17.5 20H8Z" fill="#9BB0BE"/></svg>';
      }
      return '<svg class="ap-weather-icon" viewBox="0 0 24 24" fill="none"><path d="' + cloud + '" fill="#9BB0BE"/></svg>';
    }
    return '<svg class="ap-weather-icon" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" fill="#F5A623"/><g stroke="#F5A623" stroke-width="1.6" stroke-linecap="round"><path d="M12 2v2.4"/><path d="M12 19.6V22"/><path d="M4.2 4.2l1.7 1.7"/><path d="M18.1 18.1l1.7 1.7"/><path d="M2 12h2.4"/><path d="M19.6 12H22"/><path d="M4.2 19.8l1.7-1.7"/><path d="M18.1 5.9l1.7-1.7"/></g></svg>';
  }

  function weatherCardHtml(weather, tripDateLabel) {
    if (!weather || !weather.tempF) return '';
    return '<div class="ap-weather-eyebrow">Adventure Day Weather Forecast</div>' +
      '<div class="ap-weather-card">' +
      (tripDateLabel ? '<div class="ap-weather-day">' + escapeHtml(tripDateLabel) + '</div>' : '') +
      '<div class="ap-weather-row">' +
      weatherIconSvg(weather.condition) +
      '<div class="ap-weather-mid">' +
      '<div class="ap-weather-temp">' + escapeHtml(String(weather.tempF)) + '°F' + (weather.condition ? ', ' + escapeHtml(weather.condition) : '') + '</div>' +
      (weather.detail ? '<div class="ap-weather-cond">' + escapeHtml(weather.detail) + '</div>' : '') +
      '<div class="ap-weather-note">Weather will be kept up to date as your adventure day gets closer.</div>' +
      '</div>' +
      '</div>' +
      '</div>';
  }

  // ---------------------------------------------------------------------
  // Scoped Adventure Home hub (mockup-07 frame 1)
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Surface B trail-day arc (2026-09-08, claude/psac-surface-b-trail-day-
  // design-copy-2026-09-08.md) -- attending-signer path. Ported from
  // adventure-prep-form.js's own Phase 2.5/Phase 3 build, adapted to this
  // file's own conventions (own state object, /api/waiver, signerToken)
  // and with every gear-logistics piece dropped per Airey's direct call:
  // only the booker coordinates gear return, so nothing about gear
  // condition, pickup, or return belongs on this surface.
  // ---------------------------------------------------------------------

  // Whether trail_return_roster_json (once written) says everyone
  // actually came back -- gates showPostAdventure in renderHub below,
  // same rule adventure-prep-form.js's own isReturnRosterClean() follows.
  function isReturnRosterClean(ctx) {
    var roster = ctx && ctx.trailReturnRoster;
    if (!Array.isArray(roster) || !roster.length) return false;
    return roster.every(function (r) { return r.present; });
  }

  // Roster source for the return check-in: prefers the Heading Out
  // snapshot (ctx.trailDayRoster's present:true rows), falls back to the
  // unified attendingRoster when that snapshot is empty -- same fallback
  // lib/trail-checkin-incident-service.js's own getReturnRosterSource()
  // applies server-side, matching adventure-prep-form.js's own
  // trailReturnRosterSource.
  function trailReturnRosterSource(ctx) {
    var headingOutRoster = ctx && ctx.trailDayRoster;
    if (Array.isArray(headingOutRoster) && headingOutRoster.length) {
      return headingOutRoster.filter(function (r) { return r.present !== false; })
        .map(function (r) { return { participantId: r.participantId, name: r.name }; });
    }
    return ctx.attendingRoster || [];
  }

  // "Ready to go" -- guide row only, gear row dropped (see this block's
  // own header comment). Same reveal/collapse-free single-row markup
  // gearPickupReminderHtml's own single-row usage established on Surface
  // A, since guide becomes the only (and so first) row here.
  function readyStripHtml(status) {
    var guideOpened = !!state.ctx.guideFirstOpenedAt;
    var checkIconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6" stroke="#7ABD91" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var nudgeIconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 16.2v.1" stroke="#F58271" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="#F58271" stroke-width="1.6"/></svg>';
    var guideRow = guideOpened
      ? '<div class="ap-ready-row" style="border-top:none;padding-top:0;"><div class="ap-ready-icon ok">' + checkIconSvg + '</div><div class="ap-ready-text"><div class="t1">Guide downloaded</div><div class="t2">' + escapeHtml(status.trailName || 'Your trail') + '’s route is ready for offline use.</div></div></div>'
      : '<div class="ap-ready-row" style="border-top:none;padding-top:0;"><div class="ap-ready-icon nudge">' + nudgeIconSvg + '</div><div class="ap-ready-text"><div class="t1">Don’t forget your guide</div><div class="t2">Download it for offline use before you go.</div><span class="ap-ready-link" id="sb-ready-get-guide">Get Guide →</span></div></div>';
    return '<div class="ap-ready-strip"><div class="ap-card"><div class="ap-ready-title">Ready to go</div>' + guideRow + '</div></div>';
  }

  function headingOutButtonHtml() {
    return '<button type="button" class="ap-cta-primary" id="sb-heading-out-btn">Heading Out</button>' +
      '<div class="ap-helper" style="max-width:640px;margin:0 auto 1.3rem;text-align:center;">Tapping this opens a 10-second headcount, then you’re on your way. This is the list we’ll expect to hear from later today, so it’s worth getting right.</div>';
  }

  // Underway: same hero-photo card as the morning, dimmed to read as
  // "later in the day," stating the check-in's real stakes plainly --
  // verbatim copy from adventure-prep-form.js's own underwayHeroHtml.
  function underwayHeroHtml(status) {
    var effectiveReturn = state.ctx.guestRevisedReturnAt || state.ctx.expectedReturnAt;
    var expectedReturnLabel = formatPacificTime(effectiveReturn) || 'later today';
    var subline = 'Expect you back around <b>' + escapeHtml(expectedReturnLabel) + '</b>. We’ll text you then, and we need a reply, that’s how we know your group made it back safe. ' +
      'Miss it and we start trying to reach you right away, if that doesn’t work, it becomes a real search and rescue response, an expensive step we take seriously and hope never to need. ' +
      '<a class="ap-hero-link" id="sb-signal-link" style="color:var(--sand-beige);text-decoration:underline;text-underline-offset:2px;cursor:pointer;">If you can’t get signal →</a>' +
      ' · <a class="ap-hero-link" id="sb-need-help-link" style="color:var(--sand-beige);text-decoration:underline;text-underline-offset:2px;cursor:pointer;">Need help, or running behind? →</a>';
    return heroCardHtml('On The Trail', 'You’re on the trail.', subline, status.trailDetail && status.trailDetail.photoUrl, null, true);
  }

  function underwaySupportingNoteHtml() {
    return '<div class="ap-subline" style="max-width:960px;margin:0.9rem auto 0;">If you don’t check in before your expected return time, two more nudges follow, one right at the expected return time and a more direct one three hours after your expected return time. ' +
      'If we still haven’t heard from your group after that, we call in an actual search and rescue effort, a costly, serious undertaking. ' +
      'This isn’t a scare tactic. It’s a safety net and a real expectation.</div>';
  }

  // "Everyone Back?" entry point -- opens the roster-confirm sheet
  // (renderTrailReturnRosterSheet) instead of firing one action directly,
  // same reasoning as Surface A's own trailReturnEntryHtml.
  function trailReturnEntryHtml() {
    return '<button type="button" class="ap-cta-primary" id="sb-trail-return-btn">Everyone Back?</button>' +
      '<div class="ap-helper" style="max-width:640px;margin:0 auto 1.3rem;text-align:center;">A quick headcount lets us know your whole group made it back safe.</div>';
  }

  // Session-local "we heard you" status line for the Underway hero once a
  // report's gone in this visit -- not authoritative, just enough so a
  // guest bounced back to the hub isn't left wondering whether anything
  // happened. Verbatim from adventure-prep-form.js's own version.
  function openIncidentNoticeHtml() {
    if (!state.hasOpenIncident) return '';
    return '<div class="ap-checkin-callout">We’ve got your report, Palm Springs Adventure Club is on it. Situation changed, or need to add something? <span class="ap-checkin-back" id="sb-checkin-notice-link" style="margin:0;display:inline;">Tap here →</span></div>';
  }

  // "If you can't get signal" info page -- verbatim port of
  // adventure-prep-form.js's own renderEmergencySosInfo, purely static
  // content with no signerToken/apiPost dependency, so no adaptation
  // needed beyond the back-link's own step target.
  function renderEmergencySosInfo() {
    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-back-link" id="sb-sos-back" style="cursor:pointer;">&larr; Back to your Adventure Hub</div>' +
      '<div class="ap-eyebrow">If You Can’t Get Signal</div>' +
      '<h2 style="font-family:\'Cormorant Garamond\',serif;font-weight:600;font-size:1.5rem;margin:0 0 1.4rem;color:var(--dark-pine);">What your phone can already do out there</h2>' +
      '<div class="ap-card">' +
      '<div class="rwgps-step"><div class="rwgps-num">1</div><div><div class="rwgps-step-title">Always try 911 first</div><div class="rwgps-step-body">If you have any signal at all, a regular call is faster than anything below. These are for when a call won’t go through.</div></div></div>' +
      '<div class="rwgps-step"><div class="rwgps-num">2</div><div><div class="rwgps-step-title"><span class="rwgps-model-tag">iPhone 14+</span>Emergency SOS via satellite</div><div class="rwgps-step-body">No signal, no wifi: your phone offers “Emergency Text via Satellite.” Step outside with a clear view of the sky, answer a few tap-through questions, and it connects you to help, sharing your location automatically.</div></div></div>' +
      '<div class="rwgps-step"><div class="rwgps-num">3</div><div><div class="rwgps-step-title"><span class="rwgps-model-tag">Some Android</span>Satellite emergency texting</div><div class="rwgps-step-body">Newer phones from some Android makers offer a similar feature. Coverage varies a lot by brand and model, worth checking your own phone’s settings before trail day, not on it.</div></div></div>' +
      '</div>' +
      '<div class="rwgps-callout"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;margin-top:1px;"><circle cx="12" cy="12" r="9" stroke="#F58271" stroke-width="1.6"/><path d="M12 8v5" stroke="#F58271" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16" r="1" fill="#F58271"/></svg><div>Worth two minutes before you leave: open your phone’s own settings and confirm this feature is there and how it works. That’s not something to learn for the first time out on the trail.</div></div>' +
      '<a class="rwgps-back" id="sb-sos-back-2">&larr; Back to your Adventure Hub</a>' +
      '</div></div>'
    );
    wrap.querySelector('#sb-sos-back').addEventListener('click', goHub);
    wrap.querySelector('#sb-sos-back-2').addEventListener('click', goHub);
    return wrap;
  }

  // Heading Out roster-confirm sheet -- verbatim port of
  // adventure-prep-form.js's own renderHeadingOutSheet, adapted to this
  // surface's own roster source (state.ctx.attendingRoster, the unified
  // list getSignerContext() now returns) and /api/waiver + signerToken.
  function renderHeadingOutSheet() {
    var attendingRoster = state.ctx.attendingRoster || [];
    var absentIds = {}; // participantId -> true once unchecked

    var rowsHtml = attendingRoster.map(function (p) {
      return '<div class="ap-roster-row" data-participant-id="' + escapeHtml(p.participantId) + '">' +
        '<span class="ap-roster-name">' + escapeHtml(p.name) + '</span>' +
        '<div class="ap-check" data-check-for="' + escapeHtml(p.participantId) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
        '</div>';
    }).join('');

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-back-link" id="sb-heading-out-back" style="cursor:pointer;">&larr; Adventure Home</div>' +
      '<div class="ap-eyebrow">Before You Go</div>' +
      '<h1 class="ap-q">Everyone heading out?</h1>' +
      '<div class="ap-card">' +
      '<div class="ap-sub" style="margin:0 0 1rem;">Everyone’s checked by default, uncheck anyone not coming along today.</div>' +
      rowsHtml +
      '<div class="ap-roster-hint" id="sb-roster-hint" style="display:none;"></div>' +
      '</div>' +
      '<button type="button" class="ap-cta-primary" id="sb-heading-out-confirm">Confirm, Heading Out</button>' +
      '<div class="ap-helper" style="text-align:center;">Writes your real start time and today’s headcount.</div>' +
      '<div class="ap-helper" style="text-align:center;margin-top:0.8rem;padding-top:0.8rem;border-top:1px solid rgba(42,71,71,0.08);">Timing note: the check-in clock always uses the trail’s full-group, easy-pace estimate from here, the most conservative read, regardless of who’s checked above or how fast your group moves.</div>' +
      '</div></div>'
    );

    function updateHint() {
      var hintEl = wrap.querySelector('#sb-roster-hint');
      var absentNames = attendingRoster.filter(function (p) { return absentIds[p.participantId]; }).map(function (p) { return p.name; });
      if (!hintEl) return;
      if (!absentNames.length) { hintEl.style.display = 'none'; return; }
      hintEl.style.display = 'block';
      hintEl.textContent = joinWithAnd(absentNames) + ' unchecked, not hiking today.';
    }

    Array.prototype.forEach.call(wrap.querySelectorAll('[data-check-for]'), function (el) {
      el.addEventListener('click', function () {
        var pid = el.getAttribute('data-check-for');
        var nowOff = !el.classList.contains('off');
        el.classList.toggle('off', nowOff);
        el.innerHTML = nowOff ? '' : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        if (nowOff) { absentIds[pid] = true; } else { delete absentIds[pid]; }
        updateHint();
      });
    });

    wrap.querySelector('#sb-heading-out-back').addEventListener('click', goHub);

    var confirmBtn = wrap.querySelector('#sb-heading-out-confirm');
    confirmBtn.addEventListener('click', function () {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Confirming\u2026';
      apiPost('/api/waiver', {
        action: 'confirmHeadingOut',
        signerToken: SIGNER_TOKEN,
        absentParticipantIds: Object.keys(absentIds),
      }).then(function (res) {
        if (res.ok && res.body && res.body.ok) {
          state.ctx.headingOutAt = res.body.headingOutAt;
          state.ctx.expectedReturnAt = res.body.expectedReturnAt;
          goHub();
        } else {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Confirm, Heading Out';
        }
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Everyone Back? roster-confirm sheet + six-option triage, attending-
  // signer path -- verbatim port of adventure-prep-form.js's own
  // renderTrailReturnRosterSheet/renderTrailCheckinTriage, per the
  // approved proposal's "Multi-surface access" section: same engine,
  // same six options, same copy for an attending signer (including one
  // who's also a participant-guardian for a minor -- no special-cased
  // copy needed, the affected-roster step already covers flagging a
  // specific minor). Only the plumbing differs: signerToken instead of
  // token, /api/waiver instead of /api/adventure-prep -- both actions
  // (confirmTrailReturnRoster, reportTrailCheckinIncident) were already
  // dispatched from api/waiver.js as of this week's build.
  // ---------------------------------------------------------------------

  function renderTrailReturnRosterSheet() {
    var status = computeStatus();
    var rosterSource = trailReturnRosterSource(state.ctx);
    var absentIds = {}; // participantId -> true once unchecked (not back)

    var rowsHtml = rosterSource.map(function (p) {
      return '<div class="ap-roster-row" data-participant-id="' + escapeHtml(p.participantId) + '">' +
        '<span class="ap-roster-name">' + escapeHtml(p.name) + '</span>' +
        '<div class="ap-check" data-check-for="' + escapeHtml(p.participantId) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
        '</div>';
    }).join('');

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-back-link" id="sb-return-back" style="cursor:pointer;">&larr; Adventure Home</div>' +
      '<div class="ap-eyebrow">Welcome Back</div>' +
      '<h1 class="ap-q">Everyone back from ' + escapeHtml(status.trailName || 'the trail') + '?</h1>' +
      '<div class="ap-card">' +
      '<div class="ap-sub" style="margin:0 0 1rem;">Everyone’s checked by default, uncheck anyone who isn’t back with you yet.</div>' +
      rowsHtml +
      '</div>' +
      '<button type="button" class="ap-cta-primary" id="sb-return-confirm">Confirm, Everyone’s Back</button>' +
      '<div class="ap-checkin-back" id="sb-return-need-help" style="text-align:center;">Need help, or running behind? &rarr;</div>' +
      '</div></div>'
    );

    Array.prototype.forEach.call(wrap.querySelectorAll('[data-check-for]'), function (el) {
      el.addEventListener('click', function () {
        var pid = el.getAttribute('data-check-for');
        var nowOff = !el.classList.contains('off');
        el.classList.toggle('off', nowOff);
        el.innerHTML = nowOff ? '' : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        if (nowOff) { absentIds[pid] = true; } else { delete absentIds[pid]; }
      });
    });

    wrap.querySelector('#sb-return-back').addEventListener('click', goHub);
    wrap.querySelector('#sb-return-need-help').addEventListener('click', function () {
      state.checkinAffectedIds = [];
      state.checkinOmitRunningLonger = false;
      state.checkinCategory = null;
      state.checkinLostSeparatedWho = null;
      state.step = 'trailCheckinTriage';
      render();
    });

    var confirmBtn = wrap.querySelector('#sb-return-confirm');
    confirmBtn.addEventListener('click', function () {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Checking In\u2026';
      apiPost('/api/waiver', {
        action: 'confirmTrailReturnRoster',
        signerToken: SIGNER_TOKEN,
        presentParticipantIds: rosterSource.filter(function (p) { return !absentIds[p.participantId]; }).map(function (p) { return p.participantId; }),
      }).then(function (res) {
        if (res.ok && res.body && res.body.ok) {
          state.ctx.trailCheckinAt = res.body.trailCheckinAt;
          state.ctx.trailReturnRoster = res.body.roster;
          if (res.body.clean) {
            goHub();
          } else {
            // Not everyone's back -- log it, surface it to ops, and guide
            // the group through what happens next, rather than silently
            // flipping to the Post-Adventure state (showPostAdventure in
            // renderHub is gated on a CLEAN roster too). Straight into
            // the same triage a guest reaches from "Need help, or
            // running behind?", pre-scoped to whoever's still missing.
            state.checkinAffectedIds = (res.body.roster || []).filter(function (r) { return !r.present; }).map(function (r) { return r.participantId; });
            state.checkinOmitRunningLonger = false;
            state.checkinCategory = null;
            state.checkinLostSeparatedWho = null;
            state.step = 'trailCheckinTriage';
            render();
          }
        } else {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Confirm, Everyone’s Back';
        }
      });
    });

    return wrap;
  }

  function renderTrailCheckinTriage() {
    var status = computeStatus();
    var trailName = status.trailName || 'the trail';

    function submitReport(payload) {
      var body = { action: 'reportTrailCheckinIncident', signerToken: SIGNER_TOKEN, affectedParticipantIds: state.checkinAffectedIds || [] };
      for (var k in payload) { if (payload.hasOwnProperty(k)) body[k] = payload[k]; }
      return apiPost('/api/waiver', body).then(function (res) {
        if (res.ok && res.body && res.body.ok) state.hasOpenIncident = true;
        return res;
      });
    }

    function call911ButtonHtml() {
      return '<a class="ap-cta-critical" href="tel:911">Call 911 Now</a>';
    }
    function psacLineBlockHtml(note) {
      return '<a class="ap-cta-primary" href="tel:8582329391" style="margin-top:0.9rem;">Call Palm Springs Adventure Club’s Emergency Line: 858-232-9391</a>' +
        '<div class="ap-helper" style="text-align:center;">' + note + '</div>';
    }
    function intakeFormHtml() {
      return '<div class="ap-field-label" style="margin-top:1.3rem;">What they were wearing (optional)</div>' +
        '<textarea class="ap-field-textarea" id="sb-checkin-personal"></textarea>' +
        '<div class="ap-field-label">Any medical conditions (optional)</div>' +
        '<textarea class="ap-field-textarea" id="sb-checkin-medical"></textarea>' +
        '<div class="ap-field-label">Vehicle / where you parked (optional)</div>' +
        '<textarea class="ap-field-textarea" id="sb-checkin-vehicle"></textarea>' +
        '<div class="ap-field-label">Anything else Palm Springs Adventure Club should know (optional)</div>' +
        '<textarea class="ap-field-textarea" id="sb-checkin-other"></textarea>';
    }
    function wireIntakeForm(wrapEl) {
      var fieldMap = { 'sb-checkin-personal': 'personalDescription', 'sb-checkin-medical': 'medicalNote', 'sb-checkin-vehicle': 'vehicleDescription', 'sb-checkin-other': 'otherNotes' };
      var lastSaved = {};
      var _loop = function (elId, payloadKey) {
        var el = wrapEl.querySelector('#' + elId);
        if (!el) return;
        lastSaved[elId] = '';
        el.addEventListener('blur', function () {
          var val = el.value.trim();
          if (val === lastSaved[elId]) return;
          lastSaved[elId] = val;
          var payload = { category: state.checkinCategory };
          payload[payloadKey] = val;
          submitReport(payload);
        });
      };
      for (var elId in fieldMap) { _loop(elId, fieldMap[elId]); }
    }

    function pickCategory(key) {
      state.checkinCategory = key;
      state.checkinLostSeparatedWho = null;
      submitReport({ category: key });
      render();
    }

    // ---- Screen: "What's going on?" ----
    if (!state.checkinCategory) {
      var options = CHECKIN_OPTIONS.filter(function (o) {
        return !(state.checkinOmitRunningLonger && o.key === 'running_longer');
      });
      var wrapList = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-back-link" id="sb-triage-back" style="cursor:pointer;">&larr; Adventure Home</div>' +
        '<div class="ap-eyebrow">Need Help, Or Running Behind?</div>' +
        '<h1 class="ap-q">What’s going on?</h1>' +
        '<div class="ap-sub">Pick whichever’s closest, you’ll get the right next step either way.</div>' +
        options.map(function (o) { return '<div class="ap-checkin-opt" data-key="' + o.key + '">' + escapeHtml(o.label) + '</div>'; }).join('') +
        '</div></div>'
      );
      wrapList.querySelector('#sb-triage-back').addEventListener('click', goHub);
      Array.prototype.forEach.call(wrapList.querySelectorAll('[data-key]'), function (el) {
        el.addEventListener('click', function () { pickCategory(el.getAttribute('data-key')); });
      });
      return wrapList;
    }

    // ---- Lost/separated: pronoun sub-question ----
    if (state.checkinCategory === 'lost_separated' && !state.checkinLostSeparatedWho) {
      var wrapWho = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Lost Or Separated</div>' +
        '<h1 class="ap-q">Is it you who’s separated from the group, or someone else?</h1>' +
        '<div class="ap-choice-pills" style="margin-top:1rem;">' +
        '<div class="ap-pill" data-who="self">It’s me</div>' +
        '<div class="ap-pill" data-who="other">Someone else</div>' +
        '</div>' +
        '</div></div>'
      );
      wrapWho.querySelector('#sb-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      Array.prototype.forEach.call(wrapWho.querySelectorAll('[data-who]'), function (el) {
        el.addEventListener('click', function () {
          var who = el.getAttribute('data-who');
          state.checkinLostSeparatedWho = who;
          submitReport({ category: 'lost_separated', categoryDetail: who === 'self' ? 'Reporter themselves is separated from the group' : 'Someone else in the group is separated' });
          render();
        });
      });
      return wrapWho;
    }

    // ---- Injury ----
    if (state.checkinCategory === 'injury') {
      var wrapInjury = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Someone’s Hurt</div>' +
        '<h1 class="ap-q">Call 911 now.</h1>' +
        '<div class="ap-card">' +
        call911ButtonHtml() +
        '<div class="ap-checkin-note">Tell them what happened, your location (' + escapeHtml(trailName) + ', last known point), and any medical conditions.</div>' +
        psacLineBlockHtml('So we can loop in 911 or the land manager immediately, share your booking details, and stay with you until help arrives.') +
        '<div class="ap-checkin-callout">While you wait: control bleeding with steady, direct pressure. Keep them warm and in shade. Minimize movement.</div>' +
        intakeFormHtml() +
        '</div>' +
        '</div></div>'
      );
      wrapInjury.querySelector('#sb-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      wireIntakeForm(wrapInjury);
      return wrapInjury;
    }

    // ---- Lost/separated: real guidance, now that who's known ----
    if (state.checkinCategory === 'lost_separated') {
      var isSelf = state.checkinLostSeparatedWho === 'self';
      var guidanceBody = isSelf
        ? 'Stop moving. Retrace your steps only if it’s safe to do so. Tell them the trail name, your last known location, what you’re wearing, and any medical conditions.'
        : 'Give them your GPS coordinates if your phone shows them, the trail name, the last place you were together, what they were wearing, and any medical conditions they have.';
      var wrapLost = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">' + (isSelf ? 'You’re Separated' : 'Someone’s Separated') + '</div>' +
        '<h1 class="ap-q">Call 911 now.</h1>' +
        '<div class="ap-card">' +
        call911ButtonHtml() +
        '<div class="ap-checkin-note">' + guidanceBody + '</div>' +
        psacLineBlockHtml('So we can loop in 911 or the land manager immediately, share your booking details, and stay with you until help arrives.') +
        intakeFormHtml() +
        '</div>' +
        '</div></div>'
      );
      wrapLost.querySelector('#sb-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; state.checkinLostSeparatedWho = null; render(); });
      wireIntakeForm(wrapLost);
      return wrapLost;
    }

    // ---- Heat illness: unconditional "call 911 now" ----
    if (state.checkinCategory === 'heat_illness') {
      var HEAT_SYMPTOMS = ['Confusion', 'Hot or dry skin', 'Loss of consciousness', 'Mainly heavy sweating and weakness'];
      var wrapHeat = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Heat Illness</div>' +
        '<h1 class="ap-q">Call 911 now.</h1>' +
        '<div class="ap-card">' +
        call911ButtonHtml() +
        '<div class="ap-checkin-callout">While you wait: move them to shade. Help them hydrate if they’re conscious and able to. Begin active cooling, wet cloth, fanning.</div>' +
        '<div class="ap-field-label" style="margin-top:0.9rem;">What are you seeing? (optional, for 911 and Palm Springs Adventure Club, doesn’t change what to do above)</div>' +
        '<div class="ap-choice-pills" id="sb-heat-symptoms">' +
        HEAT_SYMPTOMS.map(function (s) { return '<div class="ap-pill" data-val="' + escapeHtml(s) + '">' + escapeHtml(s) + '</div>'; }).join('') +
        '</div>' +
        psacLineBlockHtml('So we can loop in 911 or the land manager immediately, share your booking details, and stay with you until help arrives.') +
        intakeFormHtml() +
        '</div>' +
        '</div></div>'
      );
      wrapHeat.querySelector('#sb-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      Array.prototype.forEach.call(wrapHeat.querySelectorAll('#sb-heat-symptoms .ap-pill'), function (el) {
        el.addEventListener('click', function () {
          Array.prototype.forEach.call(wrapHeat.querySelectorAll('#sb-heat-symptoms .ap-pill'), function (p) { p.classList.remove('selected'); });
          el.classList.add('selected');
          submitReport({ category: 'heat_illness', categoryDetail: el.getAttribute('data-val') });
        });
      });
      wireIntakeForm(wrapHeat);
      return wrapHeat;
    }

    // ---- Running longer, everyone's fine ----
    if (state.checkinCategory === 'running_longer') {
      if (state.checkinRunningLongerConfirmed) {
        var wrapRLConfirm = h(
          '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
          '<div class="ap-eyebrow">Running Longer</div>' +
          '<h1 class="ap-q">Got it, we’ve updated your expected return.</h1>' +
          '<div class="ap-card">' +
          '<div class="ap-sub" style="margin:0;">New target: <b>' + escapeHtml(state.checkinRunningLongerDisplay || 'later today') + '</b>. We’ll watch for your real check-in around then.</div>' +
          '</div>' +
          '<button type="button" class="ap-cta-critical" id="sb-checkin-escalate">Things Change? Get Help Now</button>' +
          '<div class="ap-back-link" id="sb-triage-tohub" style="cursor:pointer;text-align:center;">&larr; Back to your Adventure Hub</div>' +
          '</div></div>'
        );
        wrapRLConfirm.querySelector('#sb-triage-tohub').addEventListener('click', goHub);
        wrapRLConfirm.querySelector('#sb-checkin-escalate').addEventListener('click', function () {
          state.checkinOmitRunningLonger = true;
          state.checkinCategory = null;
          render();
        });
        return wrapRLConfirm;
      }

      var wrapRL = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Running Longer, Everyone’s Fine</div>' +
        '<h1 class="ap-q">Good to know you’re okay. Let’s get your expected return updated.</h1>' +
        '<div class="ap-card">' +
        '<div class="ap-checkin-note" id="sb-checkin-rwgps-link" style="cursor:pointer;text-decoration:underline;">Check RideWithGPS, it shows exactly where you are on the route and how much you have left &rarr;</div>' +
        '<div class="ap-field-label" style="margin-top:0.9rem;">About when do you now expect to finish?</div>' +
        '<input class="ap-field-input" type="time" id="sb-checkin-finish-time">' +
        '<div class="ap-field-label">About how much further do you have left?</div>' +
        '<div class="ap-window-list" id="sb-checkin-remaining">' +
        ['Almost done', 'A few miles', 'More than half left', 'Not sure'].map(function (d) {
          return '<div class="ap-window-opt" data-val="' + d + '">' + d + '</div>';
        }).join('') +
        '</div>' +
        '<div id="sb-checkin-running-error" class="ap-error"></div>' +
        '</div>' +
        '<button type="button" class="ap-cta-primary" id="sb-checkin-running-submit">Update My Status</button>' +
        '<div class="ap-back-link" id="sb-triage-tohub2" style="cursor:pointer;text-align:center;">&larr; Back to your Adventure Hub</div>' +
        '</div></div>'
      );

      var chosenRemaining = null;
      wrapRL.querySelector('#sb-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      wrapRL.querySelector('#sb-triage-tohub2').addEventListener('click', goHub);
      wrapRL.querySelector('#sb-checkin-rwgps-link').addEventListener('click', function () {
        window.open((state.ctx.rideWithGpsExperienceAccess) || 'https://ridewithgps.com/', '_blank');
      });
      Array.prototype.forEach.call(wrapRL.querySelectorAll('#sb-checkin-remaining .ap-window-opt'), function (el) {
        el.addEventListener('click', function () {
          Array.prototype.forEach.call(wrapRL.querySelectorAll('#sb-checkin-remaining .ap-window-opt'), function (o) { o.classList.remove('selected'); });
          el.classList.add('selected');
          chosenRemaining = el.getAttribute('data-val');
        });
      });

      wrapRL.querySelector('#sb-checkin-running-submit').addEventListener('click', function () {
        var timeVal = wrapRL.querySelector('#sb-checkin-finish-time').value;
        var errorEl = wrapRL.querySelector('#sb-checkin-running-error');
        if (!timeVal && !chosenRemaining) {
          errorEl.textContent = 'Give us at least one, a new time or how much you have left.';
          return;
        }
        var payload = { category: 'running_longer' };
        var displayLabel = '';
        if (timeVal) {
          var parts = timeVal.split(':');
          var now = new Date();
          var target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
          if (target.getTime() < now.getTime()) target.setDate(target.getDate() + 1);
          payload.reportedNewFinishEstimate = target.toISOString();
          displayLabel = formatTimeInputLabel(timeVal);
        }
        if (chosenRemaining) payload.reportedRemainingDistance = chosenRemaining;
        submitReport(payload).then(function (res) {
          if (res.ok && res.body && res.body.ok) {
            if (res.body.guestRevisedReturnAt) {
              state.ctx.guestRevisedReturnAt = res.body.guestRevisedReturnAt;
            }
            state.checkinRunningLongerConfirmed = true;
            state.checkinRunningLongerDisplay = displayLabel || (chosenRemaining || 'later today');
            render();
          } else {
            errorEl.textContent = 'Something went wrong saving that, try again.';
          }
        });
      });

      return wrapRL;
    }

    // ---- Not back yet, no idea why ----
    if (state.checkinCategory === 'overdue_unknown') {
      var wrapOverdue = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Not Back Yet</div>' +
        '<h1 class="ap-q">Let’s get Palm Springs Adventure Club on the line.</h1>' +
        '<div class="ap-card">' +
        '<div class="ap-checkin-note">We don’t have to know why yet.</div>' +
        psacLineBlockHtml('So we can help figure out what’s going on and coordinate next steps.') +
        intakeFormHtml() +
        '</div>' +
        '</div></div>'
      );
      wrapOverdue.querySelector('#sb-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      wireIntakeForm(wrapOverdue);
      return wrapOverdue;
    }

    // ---- Something else ----
    if (state.checkinCategory === 'other') {
      var wrapOther = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Something Else</div>' +
        '<h1 class="ap-q">Tell us what’s going on.</h1>' +
        '<div class="ap-card">' +
        '<textarea class="ap-field-textarea" id="sb-checkin-detail" placeholder="What’s happening?" style="height:90px;"></textarea>' +
        psacLineBlockHtml('If anything feels urgent, this is the fastest way to reach a real person.') +
        intakeFormHtml() +
        '</div>' +
        '</div></div>'
      );
      wrapOther.querySelector('#sb-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      var detailEl = wrapOther.querySelector('#sb-checkin-detail');
      var lastDetail = '';
      detailEl.addEventListener('blur', function () {
        var val = detailEl.value.trim();
        if (val === lastDetail) return;
        lastDetail = val;
        submitReport({ category: 'other', categoryDetail: val });
      });
      wireIntakeForm(wrapOther);
      return wrapOther;
    }

    // Defensive fallback.
    state.checkinCategory = null;
    return renderTrailCheckinTriage();
  }

  // Surface B trail-day arc (2026-09-08), guardian-only reframe of the
  // check-in triage (design doc Part 2d): "Worried about [child]?"
  // replaces "What's going on?", same six CHECKIN_OPTIONS and the same
  // reportTrailCheckinIncident engine as the attending path's own
  // renderTrailCheckinTriage(), only the copy changes -- third-person-
  // about-the-child throughout, no location-dependent language (this
  // reader isn't on the trail and has no coordinates or map to give),
  // affected-roster defaults to the guardian's own ward(s) with no
  // toggle (seeded once in openGuardianCheckinTriage(), above), and one
  // added line allowing the reader's own judgment to call 911 directly.
  // Same real information depth as the attending-signer version
  // throughout, per Airey's resolved framing principle -- never softened.
  function renderGuardianTrailCheckinTriage() {
    var status = computeStatus();
    var trailName = status.trailName || 'the trail';
    var myMinors = (state.ctx.minors || []).filter(function (m) { return m.preAssignedToThisSigner; });
    var childNames = myMinors.map(function (m) { return m.name; }).filter(Boolean);
    var childLabel = childNames.length ? escapeHtml(childNames.join(' and ')) : 'them';

    function submitReport(payload) {
      var body = { action: 'reportTrailCheckinIncident', signerToken: SIGNER_TOKEN, affectedParticipantIds: state.checkinAffectedIds || [] };
      for (var k in payload) { if (payload.hasOwnProperty(k)) body[k] = payload[k]; }
      return apiPost('/api/waiver', body).then(function (res) {
        if (res.ok && res.body && res.body.ok) state.hasOpenIncident = true;
        return res;
      });
    }

    function call911ButtonHtml() {
      return '<a class="ap-cta-critical" href="tel:911">Call 911 Now</a>';
    }
    // Reframed emergency-line block (design doc Part 2d): same number,
    // note reworded around what this reader can actually supply -- no
    // personal location, since they aren't on the trail. A custom note
    // still overrides the default, for the two branches that keep the
    // attending path's own framing (overdue_unknown, other).
    function psacLineBlockHtml(note) {
      var noteText = note || ('You’re not on the trail, so this is the fastest way to get help: ' + escapeHtml(trailName) + ', ' + childLabel + '’s start time, and expected return, and we can loop in 911 or the land manager immediately.');
      return '<a class="ap-cta-primary" href="tel:8582329391" style="margin-top:0.9rem;">Call Palm Springs Adventure Club’s Emergency Line: 858-232-9391</a>' +
        '<div class="ap-helper" style="text-align:center;">' + noteText + '</div>';
    }
    // Added per the proposal's own "allows the reader's own judgment"
    // clause -- the attending version doesn't need this line, since that
    // reader is already the one calling from the scene.
    function lifeThreateningLineHtml() {
      return '<div class="ap-helper" style="text-align:center;">If you believe this is life-threatening, you can also call 911 directly and give them the trail name, we can share the rest once you’re connected.</div>';
    }
    function reframedNoteHtml() {
      return '<div class="ap-checkin-note">Give them ' + escapeHtml(trailName) + ', and any medical conditions ' + childLabel + ' has. If you don’t have exact details, that’s okay, tell them what you do know.</div>';
    }
    function intakeFormHtml() {
      return '<div class="ap-field-label" style="margin-top:1.3rem;">What ' + childLabel + ' was wearing (optional)</div>' +
        '<textarea class="ap-field-textarea" id="sb-guardian-checkin-personal"></textarea>' +
        '<div class="ap-field-label">Any medical conditions (optional)</div>' +
        '<textarea class="ap-field-textarea" id="sb-guardian-checkin-medical"></textarea>' +
        '<div class="ap-field-label">Anything else Palm Springs Adventure Club should know (optional)</div>' +
        '<textarea class="ap-field-textarea" id="sb-guardian-checkin-other"></textarea>';
    }
    function wireIntakeForm(wrapEl) {
      var fieldMap = { 'sb-guardian-checkin-personal': 'personalDescription', 'sb-guardian-checkin-medical': 'medicalNote', 'sb-guardian-checkin-other': 'otherNotes' };
      var lastSaved = {};
      var _loop = function (elId, payloadKey) {
        var el = wrapEl.querySelector('#' + elId);
        if (!el) return;
        lastSaved[elId] = '';
        el.addEventListener('blur', function () {
          var val = el.value.trim();
          if (val === lastSaved[elId]) return;
          lastSaved[elId] = val;
          var payload = { category: state.checkinCategory };
          payload[payloadKey] = val;
          submitReport(payload);
        });
      };
      for (var elId in fieldMap) { _loop(elId, fieldMap[elId]); }
    }

    function pickCategory(key) {
      state.checkinCategory = key;
      submitReport({ category: key });
      render();
    }

    // ---- Screen: "Worried about [child]?" ----
    if (!state.checkinCategory) {
      var options = CHECKIN_OPTIONS.filter(function (o) {
        return !(state.checkinOmitRunningLonger && o.key === 'running_longer');
      });
      var wrapList = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-back-link" id="sb-guardian-triage-back" style="cursor:pointer;">&larr; Adventure Home</div>' +
        '<div class="ap-eyebrow">Worried About ' + childLabel + '</div>' +
        '<h1 class="ap-q">Worried about ' + childLabel + '?</h1>' +
        '<div class="ap-sub">Pick whichever’s closest, you’ll get the right next step either way.</div>' +
        options.map(function (o) { return '<div class="ap-checkin-opt" data-key="' + o.key + '">' + escapeHtml(o.label) + '</div>'; }).join('') +
        '</div></div>'
      );
      wrapList.querySelector('#sb-guardian-triage-back').addEventListener('click', goHub);
      Array.prototype.forEach.call(wrapList.querySelectorAll('[data-key]'), function (el) {
        el.addEventListener('click', function () { pickCategory(el.getAttribute('data-key')); });
      });
      return wrapList;
    }

    // ---- Injury ----
    if (state.checkinCategory === 'injury') {
      var wrapInjury = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-guardian-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Someone’s Hurt</div>' +
        '<h1 class="ap-q">Call 911 now.</h1>' +
        '<div class="ap-card">' +
        call911ButtonHtml() +
        reframedNoteHtml() +
        psacLineBlockHtml() +
        lifeThreateningLineHtml() +
        '<div class="ap-checkin-callout">While you wait: control bleeding with steady, direct pressure. Keep them warm and in shade. Minimize movement.</div>' +
        intakeFormHtml() +
        '</div>' +
        '</div></div>'
      );
      wrapInjury.querySelector('#sb-guardian-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      wireIntakeForm(wrapInjury);
      return wrapInjury;
    }

    // ---- Lost/separated ----
    if (state.checkinCategory === 'lost_separated') {
      var wrapLost = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-guardian-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Someone’s Separated</div>' +
        '<h1 class="ap-q">Call 911 now.</h1>' +
        '<div class="ap-card">' +
        call911ButtonHtml() +
        reframedNoteHtml() +
        psacLineBlockHtml() +
        lifeThreateningLineHtml() +
        intakeFormHtml() +
        '</div>' +
        '</div></div>'
      );
      wrapLost.querySelector('#sb-guardian-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      wireIntakeForm(wrapLost);
      return wrapLost;
    }

    // ---- Heat illness ----
    if (state.checkinCategory === 'heat_illness') {
      var HEAT_SYMPTOMS = ['Confusion', 'Hot or dry skin', 'Loss of consciousness', 'Mainly heavy sweating and weakness'];
      var wrapHeat = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-guardian-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Heat Illness</div>' +
        '<h1 class="ap-q">Call 911 now.</h1>' +
        '<div class="ap-card">' +
        call911ButtonHtml() +
        reframedNoteHtml() +
        '<div class="ap-checkin-callout">While you wait: move them to shade. Help them hydrate if they’re conscious and able to. Begin active cooling, wet cloth, fanning.</div>' +
        '<div class="ap-field-label" style="margin-top:0.9rem;">What are you seeing? (optional, for 911 and Palm Springs Adventure Club, doesn’t change what to do above)</div>' +
        '<div class="ap-choice-pills" id="sb-guardian-heat-symptoms">' +
        HEAT_SYMPTOMS.map(function (s) { return '<div class="ap-pill" data-val="' + escapeHtml(s) + '">' + escapeHtml(s) + '</div>'; }).join('') +
        '</div>' +
        psacLineBlockHtml() +
        lifeThreateningLineHtml() +
        intakeFormHtml() +
        '</div>' +
        '</div></div>'
      );
      wrapHeat.querySelector('#sb-guardian-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      Array.prototype.forEach.call(wrapHeat.querySelectorAll('#sb-guardian-heat-symptoms .ap-pill'), function (el) {
        el.addEventListener('click', function () {
          Array.prototype.forEach.call(wrapHeat.querySelectorAll('#sb-guardian-heat-symptoms .ap-pill'), function (p) { p.classList.remove('selected'); });
          el.classList.add('selected');
          submitReport({ category: 'heat_illness', categoryDetail: el.getAttribute('data-val') });
        });
      });
      wireIntakeForm(wrapHeat);
      return wrapHeat;
    }

    // ---- Running longer, everyone's fine ----
    if (state.checkinCategory === 'running_longer') {
      if (state.checkinRunningLongerConfirmed) {
        var wrapRLConfirm = h(
          '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
          '<div class="ap-eyebrow">Running Longer</div>' +
          '<h1 class="ap-q">Got it, we’ve updated ' + childLabel + '’s expected return.</h1>' +
          '<div class="ap-card">' +
          '<div class="ap-sub" style="margin:0;">New target: <b>' + escapeHtml(state.checkinRunningLongerDisplay || 'later today') + '</b>. We’ll watch for the group’s real check-in around then.</div>' +
          '</div>' +
          '<button type="button" class="ap-cta-critical" id="sb-guardian-checkin-escalate">Things Change? Get Help Now</button>' +
          '<div class="ap-back-link" id="sb-guardian-triage-tohub" style="cursor:pointer;text-align:center;">&larr; Back to your Adventure Hub</div>' +
          '</div></div>'
        );
        wrapRLConfirm.querySelector('#sb-guardian-triage-tohub').addEventListener('click', goHub);
        wrapRLConfirm.querySelector('#sb-guardian-checkin-escalate').addEventListener('click', function () {
          state.checkinOmitRunningLonger = true;
          state.checkinCategory = null;
          render();
        });
        return wrapRLConfirm;
      }

      var wrapRL = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-guardian-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Running Longer, Everyone’s Fine</div>' +
        '<h1 class="ap-q">Good to know ' + childLabel + '’s group is okay.</h1>' +
        '<div class="ap-sub" style="margin-top:0.4rem;">If you’re in touch with them directly, here’s what’s useful to ask for.</div>' +
        '<div class="ap-card">' +
        '<div class="ap-field-label">About when do they now expect to finish?</div>' +
        '<input class="ap-field-input" type="time" id="sb-guardian-checkin-finish-time">' +
        '<div class="ap-field-label">About how much further do they have left?</div>' +
        '<div class="ap-window-list" id="sb-guardian-checkin-remaining">' +
        ['Almost done', 'A few miles', 'More than half left', 'Not sure'].map(function (d) {
          return '<div class="ap-window-opt" data-val="' + d + '">' + d + '</div>';
        }).join('') +
        '</div>' +
        '<div id="sb-guardian-checkin-running-error" class="ap-error"></div>' +
        '</div>' +
        '<button type="button" class="ap-cta-primary" id="sb-guardian-checkin-running-submit">Update Their Status</button>' +
        '<div class="ap-back-link" id="sb-guardian-triage-tohub2" style="cursor:pointer;text-align:center;">&larr; Back to your Adventure Hub</div>' +
        '</div></div>'
      );

      var chosenRemaining = null;
      wrapRL.querySelector('#sb-guardian-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      wrapRL.querySelector('#sb-guardian-triage-tohub2').addEventListener('click', goHub);
      Array.prototype.forEach.call(wrapRL.querySelectorAll('#sb-guardian-checkin-remaining .ap-window-opt'), function (el) {
        el.addEventListener('click', function () {
          Array.prototype.forEach.call(wrapRL.querySelectorAll('#sb-guardian-checkin-remaining .ap-window-opt'), function (o) { o.classList.remove('selected'); });
          el.classList.add('selected');
          chosenRemaining = el.getAttribute('data-val');
        });
      });

      wrapRL.querySelector('#sb-guardian-checkin-running-submit').addEventListener('click', function () {
        var timeVal = wrapRL.querySelector('#sb-guardian-checkin-finish-time').value;
        var errorEl = wrapRL.querySelector('#sb-guardian-checkin-running-error');
        if (!timeVal && !chosenRemaining) {
          errorEl.textContent = 'Give us at least one, a new time or how much they have left.';
          return;
        }
        var payload = { category: 'running_longer' };
        var displayLabel = '';
        if (timeVal) {
          var parts = timeVal.split(':');
          var now = new Date();
          var target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
          if (target.getTime() < now.getTime()) target.setDate(target.getDate() + 1);
          payload.reportedNewFinishEstimate = target.toISOString();
          displayLabel = formatTimeInputLabel(timeVal);
        }
        if (chosenRemaining) payload.reportedRemainingDistance = chosenRemaining;
        submitReport(payload).then(function (res) {
          if (res.ok && res.body && res.body.ok) {
            if (res.body.guestRevisedReturnAt) {
              state.ctx.guestRevisedReturnAt = res.body.guestRevisedReturnAt;
            }
            state.checkinRunningLongerConfirmed = true;
            state.checkinRunningLongerDisplay = displayLabel || (chosenRemaining || 'later today');
            render();
          } else {
            errorEl.textContent = 'Something went wrong saving that, try again.';
          }
        });
      });

      return wrapRL;
    }

    // ---- Not back yet, no idea why ----
    if (state.checkinCategory === 'overdue_unknown') {
      var wrapOverdue = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-guardian-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Not Back Yet</div>' +
        '<h1 class="ap-q">Let’s get Palm Springs Adventure Club on the line about ' + childLabel + '’s group.</h1>' +
        '<div class="ap-card">' +
        '<div class="ap-checkin-note">We don’t have to know why yet.</div>' +
        psacLineBlockHtml('So we can help figure out what’s going on and coordinate next steps.') +
        intakeFormHtml() +
        '</div>' +
        '</div></div>'
      );
      wrapOverdue.querySelector('#sb-guardian-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      wireIntakeForm(wrapOverdue);
      return wrapOverdue;
    }

    // ---- Something else ----
    if (state.checkinCategory === 'other') {
      var wrapOther = h(
        '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
        '<div class="ap-checkin-back" id="sb-guardian-triage-reselect">&larr; Change what’s going on</div>' +
        '<div class="ap-eyebrow">Something Else</div>' +
        '<h1 class="ap-q">Tell us what’s going on with ' + childLabel + '’s group.</h1>' +
        '<div class="ap-card">' +
        '<textarea class="ap-field-textarea" id="sb-guardian-checkin-detail" placeholder="What’s happening?" style="height:90px;"></textarea>' +
        psacLineBlockHtml('If anything feels urgent, this is the fastest way to reach a real person.') +
        intakeFormHtml() +
        '</div>' +
        '</div></div>'
      );
      wrapOther.querySelector('#sb-guardian-triage-reselect').addEventListener('click', function () { state.checkinCategory = null; render(); });
      var detailEl = wrapOther.querySelector('#sb-guardian-checkin-detail');
      var lastDetail = '';
      detailEl.addEventListener('blur', function () {
        var val = detailEl.value.trim();
        if (val === lastDetail) return;
        lastDetail = val;
        submitReport({ category: 'other', categoryDetail: val });
      });
      wireIntakeForm(wrapOther);
      return wrapOther;
    }

    // Defensive fallback.
    state.checkinCategory = null;
    return renderGuardianTrailCheckinTriage();
  }

  function renderHub() {
    var signer = state.ctx.signer || {};
    var ownerName = state.ctx.ownerName || 'Your trip organizer';
    var tripDate = formatTripDate(state.ctx.tripDate);
    var firstName = (signer.signerName || '').split(' ')[0] || 'there';
    var status = computeStatus();

    // Icons: Style B ("Line, salmon accent"), matching
    // adventure-prep-form.js's hub tiles for the 3 shared concepts
    // (Your Trail / Your Waiver / Adventure Summary), 2026-09-02.
    // Confirm Your Details' phone icon (2026-09-02 follow-up) is new --
    // no equivalent existed in the hub's 5-tile set -- drawn to match
    // the same geometry/weight/accent convention as the rest.
    function tile(icon, title, sub, statusLabel, opts) {
      opts = opts || {};
      return { icon: icon, title: title, sub: sub, statusLabel: statusLabel, locked: !!opts.locked, readonly: !!opts.readonly, onClick: opts.onClick };
    }

    var waiverSub = status.waiverDone
      ? (status.guardianForChildren.length ? 'Signed, includes ' + status.guardianForChildren.join(', ') : 'Signed')
      : 'Needs your signature';

    var prepTiles = [
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="7.6" y="2.7" width="8.8" height="18.6" rx="2.1" stroke="#2A4747" stroke-width="1.3"/><path d="M10.6 5.3h2.8" stroke="#2A4747" stroke-width="1.1" stroke-linecap="round"/><path d="M9.6 9.6h4.8M9.6 12.4h3.2" stroke="#2A4747" stroke-width="1" stroke-linecap="round"/><circle cx="12" cy="18.4" r="1.15" fill="#F58271"/></svg>', 'Confirm Your Details',
        status.detailsDone ? 'Saved' : 'Your email & phone, so we can reach you',
        status.detailsDone ? 'Done' : 'Not done',
        { onClick: function () { state.step = 'confirmDetails'; render(); } }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.3" stroke="#2A4747" stroke-width="1.4"/><path d="M12 3.3v1.6" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round"/><path d="M12 12l3-5-1 5.6z" fill="#F58271"/><path d="M12 12l-3 5 1-5.6z" fill="#2A4747"/><circle cx="12" cy="12" r="1" fill="#2A4747"/></svg>', 'Your Trail',
        status.trailAssigned ? status.trailName : 'Not yet assigned',
        null,
        { readonly: true, onClick: status.trailAssigned ? function () { state.step = 'trail'; render(); } : null }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M8.3 8.2c0-2.4 1.7-4.3 3.7-4.3s3.7 1.9 3.7 4.3" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round"/><rect x="5.8" y="8.2" width="12.4" height="12" rx="3" stroke="#2A4747" stroke-width="1.4"/><path d="M9 8.2v2.6" stroke="#2A4747" stroke-width="1.2" stroke-linecap="round"/><path d="M15 8.2v2.6" stroke="#2A4747" stroke-width="1.2" stroke-linecap="round"/><rect x="9" y="13.4" width="6" height="4.4" rx="1.2" stroke="#F58271" stroke-width="1.2"/></svg>', 'Your Gear',
        'See what’s in your kit',
        null,
        { readonly: true, onClick: function () { state.step = 'gear'; render(); } }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4.3 16.6c1.7-2.6 2.6 2.6 4.3 0s2.6 2.6 4.3 0 2.6 2.6 4.3 0" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 6.3l4.3 4.3" stroke="#F58271" stroke-width="1.4" stroke-linecap="round"/><circle cx="18.7" cy="11" r="1.2" fill="#F58271"/></svg>', 'Your Waiver', waiverSub,
        status.waiverDone ? 'Done' : 'Not done',
        { onClick: function () { state.step = 'waiver'; render(); } }),
    ];

    var pastT3 = status.trailAssigned && isPastT3Cutoff(state.ctx.tripDate);
    // Adventure Summary is no longer its own 5th tile once past T3 -- the
    // full receipt card is embedded directly at the bottom of the hub
    // instead, matching Surface A's own T-3 hub refresh treatment
    // (2026-09-04). Pre-T3, it stays exactly as it always has: its own
    // locked/unlocked tile.
    var tiles = pastT3 ? prepTiles : prepTiles.concat([
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="5.2" y="4.4" width="13.6" height="16.6" rx="2" stroke="#2A4747" stroke-width="1.3"/><rect x="9" y="2.7" width="6" height="3" rx="1" stroke="#2A4747" stroke-width="1.2"/><path d="M8.3 10h6.4M8.3 13.4h4.6" stroke="#2A4747" stroke-width="1.1" stroke-linecap="round"/><path d="M8.3 17l1.9 1.9 3.7-3.9" stroke="#F58271" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>', 'Adventure Summary',
        status.summaryUnlocked ? 'See your recap' : 'Unlocks once everything above is set',
        status.summaryUnlocked ? 'Done' : 'Locked',
        { locked: !status.summaryUnlocked, onClick: status.summaryUnlocked ? function () { state.step = 'summary'; render(); } : null }),
    ]);

    var tilesHtml = tiles.map(function (t, i) {
      var rightHtml = t.readonly
        ? '<div class="ap-tile-readonly-tag">View only</div>'
        : '<div class="ap-tile-status ' + (t.statusLabel === 'Done' ? 'status-done' : t.statusLabel === 'Locked' ? 'status-locked' : 'status-notdone') + '">' + t.statusLabel + '</div>';
      return '<div class="ap-tile' + (t.locked ? ' locked' : '') + '" data-tile="' + i + '">' +
        '<div class="ap-tile-icon">' + t.icon + '</div>' +
        '<div class="ap-tile-mid"><div class="ap-tile-title">' + escapeHtml(t.title) + '</div><div class="ap-tile-sub">' + escapeHtml(t.sub) + '</div></div>' +
        rightHtml +
        '</div>';
    }).join('');

    // Collapsible "Get ready" accordion (T-3 hub refresh, 2026-09-04):
    // once the two real prep steps (details + waiver) are both Done,
    // they collapse into one summary row, loaded collapsed by default --
    // tap to expand, nothing hidden permanently. Trail/Gear stay
    // informational either way, so the gate matches status.allSet.
    // Only applies past T3, same reasoning as Surface A.
    var allPrepDone = pastT3 && status.detailsDone && status.waiverDone;
    var getReadyHtml = allPrepDone
      ? '<div class="ap-tiles-label" style="margin-top:1.1rem;">Get ready</div><div class="ap-prep-summary" id="sb-prep-toggle">' +
        '<div class="ap-prep-summary-check"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
        '<div><div class="ap-prep-summary-text">Everything’s set: Your Details, Trail, Gear, Waiver</div><div class="ap-prep-summary-sub">Tap to review the details</div></div>' +
        '<div class="ap-prep-chevron">&#9662;</div>' +
        '</div>' +
        '<div class="ap-prep-details" id="sb-prep-details"><div class="ap-tiles" id="sb-hub-tiles" style="margin-top:0.7rem;">' + tilesHtml + '</div></div>'
      : '<div class="ap-tiles-label">Get ready</div><div class="ap-tiles" id="sb-hub-tiles">' + tilesHtml + '</div>';

    // Trail card (Sept 2026 follow-up, matches Surface A's own hub
    // pattern): only shown once the booker has actually picked a trail --
    // status.trailDetail is the full candidate_trails/trails row
    // (distance/elevation/ratings/photo) getSignerContext now resolves,
    // not just a name (see this file's computeStatus() bug-fix comment).
    // Pre-T3 this stays exactly as it always has: the compare card plus
    // the locked note. Past T3, the trail card moves underneath the new
    // guide card instead (T-3 hub refresh, 2026-09-04).
    var trailSectionHtml = (!status.trailAssigned || !status.trailDetail || pastT3) ? '' :
      '<div class="ap-trail-section-wide">' + compareCardHtml(status.trailDetail, status.allSet) +
      '<div class="ap-trail-locked-note"><span class="lock-icon">' + LOCK_ICON_SVG + '</span> Your trail guide and turn-by-turn navigation unlock 3 days before your adventure day.</div>' +
      '</div>';

    var hubGuardianMinors = (state.ctx.minors || []).filter(function (m) { return m.preAssignedToThisSigner; });
    var hubIsGuardian = hubGuardianMinors.length > 0;
    var hubChildNames = hubGuardianMinors.map(function (m) { return m.name; }).filter(Boolean);
    var hubChildLabel = hubChildNames.length ? escapeHtml(hubChildNames.join(', ')) : 'them';
    var hubGreeting = hubIsGuardian
      ? 'Hi ' + escapeHtml(firstName) + ', ' + escapeHtml(ownerName) + ' invited you and ' + hubChildLabel + ' along on their adventure day.'
      : 'Hi ' + escapeHtml(firstName) + ', ' + escapeHtml(ownerName) + ' invited you along on their adventure day.';
    var hubSubline = hubIsGuardian
      ? 'A few things need your attention before the trail day arrives, most of them take a minute, plus confirming you’re ' + hubChildLabel + '’s guardian for the day.'
      : 'A few things need your attention before the trail day arrives, and most of them take a minute.';
    var hubIntroText = (hubIsGuardian ? 'You both get placed' : 'You get placed') +
      ' on a trail that fits the group, not a generic route, with gear at your door the night before you go. ' + escapeHtml(ownerName) + ' picked Palm Springs Adventure Club because it’s the easiest way to have a great adventure on the trails around Palm Springs.';
    // -----------------------------------------------------------------
    // Phase 1/2 escalating top card (hub-lifecycle-alerts-proposal.md,
    // 2026-09-03). Same "pure function of current state" rule and the
    // same climax/2A merge Surface A's own renderHub() follows -- see
    // that file's own comment for the reasoning.
    // -----------------------------------------------------------------
    var topGreetingHtml = hubGreeting;
    var topSublineHtml = hubSubline;
    var postAdventureCardHtml = null;
    var doneCount = [status.detailsDone, status.waiverDone].filter(Boolean).length;
    // Surface B trail-day arc (2026-09-08): hoisted out of the branches
    // below, same "pure function of today's date" pattern Surface A's
    // own renderHub() already established -- computed unconditionally
    // since these depend only on the trip date and booking-level
    // check-in state, not on whether this signer's own prep steps are
    // done.
    var isTrailDayToday = false;
    var todayStrForTripCheck = pacificDateString(new Date());
    var tripDateMatchForTripCheck = String(state.ctx.tripDate || '').match(/^\d{4}-\d{2}-\d{2}/);
    var tripDateStrForTripCheck = tripDateMatchForTripCheck ? tripDateMatchForTripCheck[0] : '';
    var pastTripDay = !!(tripDateStrForTripCheck && todayStrForTripCheck > tripDateStrForTripCheck);
    var showPostAdventure = pastTripDay || (!!state.ctx.trailCheckinAt && isReturnRosterClean(state.ctx));
    // NEW (T-3 hub refresh, 2026-09-04): trail-day countdown, only
    // meaningful once past T3 -- passed into heroCardHtml below so it
    // renders pinned to the hero photo's top-right corner, same as
    // Surface A.
    // Post-adventure hero-copy fix (2026-09-08): suppressed once
    // showPostAdventure is true, same fix as Surface A -- daysUntilTrip()
    // clamps a past trip date to 0, which used to read as "Today / Trail
    // day!" on a booking that's actually long over.
    var daysToGo = (pastT3 && !showPostAdventure) ? daysUntilTrip(state.ctx.tripDate) : null;

    if (status.allSet) {
      var statLine = (status.trailAssigned ? escapeHtml(status.trailName) + ' · ' : '') + formatTripDate(state.ctx.tripDate);
      var todayStr = pacificDateString(new Date());
      var tripDateMatch = String(state.ctx.tripDate || '').match(/^\d{4}-\d{2}-\d{2}/);
      var tripDateStr = tripDateMatch ? tripDateMatch[0] : '';
      var deliveryDateStr = isoOffsetDateStr(state.ctx.tripDate, -1);

      if (todayStr === tripDateStr && !showPostAdventure) {
        isTrailDayToday = true;
        var tripTip = (status.trailDetail && status.trailDetail.oneTripTip) ||
          'Most trails are sun-exposed open-desert trails. We recommend an early start when temperatures are coolest.';
        topGreetingHtml = 'It’s adventure day! ' + escapeHtml(status.trailAssigned ? status.trailName : 'Your trail') + ' is waiting.';
        topSublineHtml = escapeHtml(tripTip);
      } else if (todayStr === deliveryDateStr) {
        // Framed around what's arriving for THIS signer, per the doc's
        // own direction -- same "to the address [owner] provided," never
        // a full address, framing renderGear() already established.
        var deliveryWin = state.ctx.deliveryWindow;
        topGreetingHtml = 'Your gear arrives tonight' + (deliveryWin ? ', ' + escapeHtml(deliveryWin) : '') + ', to the address ' + escapeHtml(ownerName) + ' provided.';
        topSublineHtml = 'Inside: a Gregory daypack, Leki trekking poles, two Hydro Flask 32oz bottles, and a first aid kit. Yours to keep after: LMNT electrolytes, Rancho Meladuco Medjool dates, and Blue Lizard mineral sunscreen.';
      } else if (showPostAdventure) {
        // Post-Adventure Phase 3 (final spec, 2026-09-08:
        // claude/psac-post-adventure-phase3-final-spec-2026-09-08.md,
        // sections 3-6) -- The Turn -> Check-in -> Closing -> Steady
        // State, replacing the old static two-line headline. Gear-free
        // throughout, same as before -- see computePostAdventurePhase's
        // own header comment for why gearReturnDone is always true here.
        var postAdventurePhase = computePostAdventurePhase(state.ctx.tripDate, !!state.ctx.feedbackSubmitted, true);
        if (postAdventurePhase === 'turn') {
          var turnHeadline = hubIsGuardian ? hubChildLabel + ' did the peak. Now, the pool.' : 'The pool hits differently after adventure.';
          var turnSubline = hubIsGuardian ? 'A real one out there today, the easy part’s still ahead.' : (escapeHtml(ownerName) + ' brought you along for the peak. The pool’s next, for both of you.');
          topGreetingHtml = turnHeadline;
          topSublineHtml = turnSubline;
          postAdventureCardHtml = heroCardHtml('Peaks to Pools', turnHeadline, turnSubline, status.trailDetail && status.trailDetail.photoUrl, null) +
            (hubIsGuardian ? '' : '<div class="ap-turn-note">Tomorrow morning we’ll ask how your day went, takes less than a minute, right here.</div>');
        } else if (postAdventurePhase === 'checkin') {
          postAdventureCardHtml = checkinCardHtml(status.trailName, hubIsGuardian, hubChildLabel);
        } else if (postAdventurePhase === 'closing') {
          postAdventureCardHtml = closingCardHtml(hubIsGuardian);
        } else {
          postAdventureCardHtml = steadyStateCardHtml(status.trailName, hubIsGuardian, hubChildLabel, status.trailDetail && status.trailDetail.photoUrl);
        }
      } else if (pastT3) {
        topGreetingHtml = 'Your guide’s ready. Turn-by-turn navigation, waypoints, everything for ' + escapeHtml(status.trailName) + ' is yours now.';
        topSublineHtml = statLine;
      } else {
        // Climax through 2A Countdown, merged (same call as Surface A).
        topGreetingHtml = hubIsGuardian
          ? hubChildLabel + '’s ready, and so are you. The trail is ready and the adventure will be fun!'
          : 'You’re in. ' + escapeHtml(ownerName) + '’s adventure is set. The trail is ready for you.';
        topSublineHtml = statLine;
      }
    } else if (doneCount === 1) {
      topGreetingHtml = status.detailsDone
        ? 'One thing left: your waiver, then you’re fully in.'
        : 'One thing left: confirm your details, then you’re fully in.';
      topSublineHtml = '';
    }
    // else doneCount === 0: topGreetingHtml/topSublineHtml stay the
    // Borrowed Trust opener already built above.

    var topCardHtml = postAdventureCardHtml !== null
      ? postAdventureCardHtml
      : (status.allSet
        ? heroCardHtml('You’re In', topGreetingHtml, topSublineHtml, status.trailDetail && status.trailDetail.photoUrl, daysToGo)
        : '<div class="ap-eyebrow">You’re In</div>' +
          '<div class="ap-greeting">' + topGreetingHtml + '</div>' +
          '<div class="ap-subline">' + topSublineHtml + '</div>');

    // T-3+ weather glance (T-3 hub refresh, 2026-09-04): renders nothing
    // until real forecast data exists -- see weatherCardHtml() above.
    var weatherHtml = pastT3 ? weatherCardHtml(state.ctx.weatherSnapshot, tripDate) : '';

    // T-3+ guide emphasis card (Airey's direct request, 2026-09-04):
    // replaces the old single-line .ap-trail-unlocked treatment with a
    // full card once the guide is actually unlocked, plus a real
    // RideWithGPS "how does this work" page behind its secondary link.
    var guideCardHtml = !pastT3 ? '' :
      '<div class="ap-guide-card">' +
      '<div class="ap-guide-eyebrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2 4 6v6c0 5 3.4 8.7 8 10 4.6-1.3 8-5 8-10V6l-8-4Z" stroke="#7ABD91" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 12.2l2 2 4-4.4" stroke="#7ABD91" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Your digital guide is unlocked</div>' +
      '<div class="ap-guide-headline">Get the route on your phone, before you’re out of signal.</div>' +
      '<div class="ap-guide-body">Opens ' + escapeHtml(status.trailName) + ' inside RideWithGPS, with turn-by-turn navigation and waypoints, no account needed. Download it for offline use before you head out; cell service on this trail isn’t guaranteed.</div>' +
      '<button type="button" class="ap-guide-cta" id="sb-get-guide">Get Guide</button>' +
      '<button type="button" class="ap-guide-howto" id="sb-guide-howto">How does this work? →</button>' +
      '</div>';

    var pastT3TrailCardHtml = (pastT3 && status.trailAssigned && status.trailDetail)
      ? '<div class="ap-trail-eyebrow">Your Trail</div><div class="ap-trail-section-wide">' + compareCardHtml(status.trailDetail, true) + '</div>'
      : '';

    // T-3+ embedded Adventure Summary receipt (Airey's direct request,
    // round 3, 2026-09-04): the full renderSummary() card, not a tile
    // linking out to it, placed at the bottom of the hub once past T3.
    var receiptHtml = pastT3 ? '<div class="ap-eyebrow" style="margin-top:1.1rem;">Adventure Summary</div>' + receiptCardHtml() : '';

    // Surface B trail-day arc (2026-09-08): the ready-strip/Heading Out/
    // Underway body, built only for the trail-day-today state -- same
    // isTrailDayToday-gated construction as Surface A's own
    // trailDayBodyHtml, gear excluded throughout.
    var trailDayBodyHtml = '';
    if (isTrailDayToday) {
      trailDayBodyHtml = !state.ctx.headingOutAt
        ? (topCardHtml + readyStripHtml(status) + headingOutButtonHtml() + weatherHtml + getReadyHtml + receiptHtml)
        : (underwayHeroHtml(status) + underwaySupportingNoteHtml() + openIncidentNoticeHtml() + trailReturnEntryHtml() + weatherHtml + getReadyHtml + receiptHtml);
    }

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      (isTrailDayToday ? '' : topCardHtml) +
      (isTrailDayToday || showPostAdventure ? '' : '<div class="ap-intro-banner"><div class="ap-intro-banner-text">' + hubIntroText + '</div></div>') +
      (showPostAdventure
        // Post-Adventure, gear-free (Surface B trail-day arc, 2026-09-08):
        // deliberately minimal, same as Surface A's own version minus
        // the gear-return card -- the collapsible prep strip (still a
        // useful record) and the summary receipt.
        ? getReadyHtml + receiptHtml
        : isTrailDayToday
          ? trailDayBodyHtml
          : pastT3
            // Reordered per Airey's direct request, 2026-09-05 (same
            // sequence as Surface A's own renderHub()): trail card, then
            // the guide, then weather, then the "everything's set" prep
            // strip, then the full summary receipt at the very bottom. No
            // deposit/refund-hold note on this surface -- that card is
            // Surface A-only (it's the booking owner's card on file, not
            // this signer's). Same goes for the gear delivery/status card
            // discussed 2026-09-05 -- Airey confirmed it's booker-only (it
            // shows the real delivery address), so it does NOT land on this
            // surface; no slot reserved here.
            ? pastT3TrailCardHtml + guideCardHtml + weatherHtml + getReadyHtml + receiptHtml
            : trailSectionHtml + getReadyHtml) +
      '</div></div>'
    );

    Array.prototype.forEach.call(wrap.querySelectorAll('.ap-tile:not(.locked)'), function (el) {
      el.addEventListener('click', function () {
        var t = tiles[Number(el.getAttribute('data-tile'))];
        if (t && t.onClick) t.onClick();
      });
    });
    var prepToggle = wrap.querySelector('#sb-prep-toggle');
    if (prepToggle) prepToggle.addEventListener('click', function () {
      prepToggle.classList.toggle('is-open');
      var details = wrap.querySelector('#sb-prep-details');
      if (details) details.classList.toggle('is-open');
    });

    // openGuide: shared by every "Get Guide" entry point on this screen
    // (the guide card and, new on this surface, the trail-day Ready-to-go
    // strip's own nudge link) -- opens the real link, and now also
    // best-effort records the first-tap signal server-side
    // (markGuideOpened, Surface B trail-day arc, 2026-09-08 -- this
    // action didn't exist on Surface B before this build, so the guide
    // card's own tap was never recorded here until now) plus an
    // optimistic local update so the Ready-to-go strip flips to "Guide
    // downloaded" without a full reload. Fire-and-forget: a failed
    // markGuideOpened call shouldn't block or error out opening the
    // actual guide.
    function openGuide() {
      window.open((state.ctx.rideWithGpsExperienceAccess) || 'https://ridewithgps.com/', '_blank');
      if (!state.ctx.guideFirstOpenedAt) {
        state.ctx.guideFirstOpenedAt = new Date().toISOString();
        apiPost('/api/waiver', { action: 'markGuideOpened', signerToken: SIGNER_TOKEN }).catch(function () {});
      }
    }
    var guideBtn = wrap.querySelector('#sb-get-guide');
    if (guideBtn) guideBtn.addEventListener('click', openGuide);
    var guideBtnReady = wrap.querySelector('#sb-ready-get-guide');
    if (guideBtnReady) guideBtnReady.addEventListener('click', openGuide);
    var howtoBtn = wrap.querySelector('#sb-guide-howto');
    if (howtoBtn) howtoBtn.addEventListener('click', function () { state.step = 'ridewithgpsInfo'; render(); });

    // Surface B trail-day arc wiring (2026-09-08).
    var headingOutBtn = wrap.querySelector('#sb-heading-out-btn');
    if (headingOutBtn) headingOutBtn.addEventListener('click', function () { state.step = 'headingOut'; render(); });

    var signalLink = wrap.querySelector('#sb-signal-link');
    if (signalLink) signalLink.addEventListener('click', function () { state.step = 'emergencySosInfo'; render(); });

    var trailReturnBtn = wrap.querySelector('#sb-trail-return-btn');
    if (trailReturnBtn) trailReturnBtn.addEventListener('click', function () { state.step = 'trailReturnRoster'; render(); });

    function openCheckinTriage() {
      state.checkinAffectedIds = [];
      state.checkinOmitRunningLonger = false;
      state.checkinCategory = null;
      state.checkinLostSeparatedWho = null;
      state.step = 'trailCheckinTriage';
      render();
    }
    var needHelpLink = wrap.querySelector('#sb-need-help-link');
    if (needHelpLink) needHelpLink.addEventListener('click', openCheckinTriage);
    var checkinNoticeLink = wrap.querySelector('#sb-checkin-notice-link');
    if (checkinNoticeLink) checkinNoticeLink.addEventListener('click', openCheckinTriage);

    wireFeedbackCard(wrap);

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Part 5: non-attending guardian's own hub (guardian_only, 2026-09-03).
  // Entirely separate from renderHub() above -- this person has no trail
  // day of their own, so this doesn't reuse renderHub()'s tile set at
  // all, it's a smaller, fully informational 3-tile read-only set plus
  // one real action (certifying as guardian). Per
  // claude/psac-adventure-prep-full-copy-pass-rewrite-proposal-2026-09-03.md
  // Part 5's own approved copy.
  // ---------------------------------------------------------------------

  // Rough starting hour from the booking's own time_preference bucket
  // (adventure-form.js's q3 -- the only pre-trip start-time signal that
  // exists anywhere in this schema). Deliberately approximate: this is a
  // stated preference, not a confirmed start time, same reasoning as the
  // return check-in design in the companion lifecycle-alerts proposal --
  // so the estimate below is framed as one throughout, never a promise.
  function guardianDayStartHour(timePreference) {
    var t = (timePreference || '').toLowerCase();
    if (t.indexOf('before 8am') !== -1) return 7;
    if (t.indexOf('8am') !== -1) return 9;
    if (t.indexOf('after 10am') !== -1) return 11;
    return null; // "Flexible," missing, or unrecognized -- no estimate offered
  }
  function formatHourOfDay(hourFloat) {
    var totalMinutes = Math.round((hourFloat * 60) / 30) * 30;
    var h = Math.floor(totalMinutes / 60) % 24;
    var m = totalMinutes % 60;
    var period = h >= 12 ? 'PM' : 'AM';
    var displayHour = h % 12 === 0 ? 12 : h % 12;
    return displayHour + (m === 0 ? ':00' : ':' + m) + ' ' + period;
  }

  function renderGuardianOnlyHub() {
    var signer = state.ctx.signer || {};
    var ownerName = state.ctx.ownerName || 'Your trip organizer';
    var firstName = (signer.signerName || '').split(' ')[0] || 'there';
    var myMinors = (state.ctx.minors || []).filter(function (m) { return m.preAssignedToThisSigner; });
    var childNames = myMinors.map(function (m) { return m.name; }).filter(Boolean);
    // Two forms deliberately: childLabel is pre-escaped, for use directly
    // in HTML strings below (never re-escaped downstream). childLabelRaw
    // is unescaped, for the two places (tile titles) that go through
    // tilesHtml's own escapeHtml(t.title) call below -- passing the
    // pre-escaped form there would double-escape any child name with an
    // apostrophe or similar (e.g. "O'Brien" rendering as "O&#39;Brien").
    var childLabel = childNames.length ? escapeHtml(childNames.join(' and ')) : 'them';
    var childLabelRaw = childNames.length ? childNames.join(' and ') : 'them';
    var allCertified = myMinors.length > 0 && myMinors.every(function (m) { return m.alreadyVerified; });

    function tile(icon, title, sub, statusLabel, opts) {
      opts = opts || {};
      return { icon: icon, title: title, sub: sub, statusLabel: statusLabel, locked: !!opts.locked, readonly: !!opts.readonly, onClick: opts.onClick };
    }

    var trailDetail = state.ctx.selectedTrail || null;
    var trailSub = trailDetail
      ? 'Placed for ' + childLabel + '’s age and the group’s own experience, the same trail-matching every recommendation in this system runs on, not a generic route.' +
        (trailDetail.distance ? ' ' + trailDetail.distance + ' miles.' : '')
      : 'Not yet assigned';

    var adultNames = (state.ctx.attendingAdults || []).map(function (a) { return a.name; }).filter(Boolean);
    var whosGoingSub = 'The adults ' + childLabel + ' is headed out with today.' +
      (adultNames.length ? ' ' + escapeHtml(adultNames.join(', ')) + '.' : '');

    var dayStartText = state.ctx.timePreference || '';
    var dayLine = formatTripDate(state.ctx.tripDate) + (dayStartText ? ', ' + escapeHtml(dayStartText) + '.' : '.');
    var startHour = guardianDayStartHour(state.ctx.timePreference);
    var durationHours = trailDetail && trailDetail.estTimeEasyPaceHours;
    var backLine = (startHour != null && durationHours)
      ? ' Expected back by around ' + formatHourOfDay(startHour + durationHours) + '.'
      : '';
    var trailheadLine = trailDetail && trailDetail.trailheadLocation ? ' Meeting at ' + escapeHtml(trailDetail.trailheadLocation) + '.' : '';
    var theDaySub = dayLine + backLine + trailheadLine + ' If anything comes up out there, you’re our first call.';

    var tiles = [
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.3" stroke="#2A4747" stroke-width="1.4"/><path d="M12 3.3v1.6" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round"/><path d="M12 12l3-5-1 5.6z" fill="#F58271"/><path d="M12 12l-3 5 1-5.6z" fill="#2A4747"/><circle cx="12" cy="12" r="1" fill="#2A4747"/></svg>',
        (trailDetail ? trailDetail.trailName : childLabelRaw + '’s Trail'), trailSub, null,
        { readonly: true }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8.2" r="2.6" stroke="#2A4747" stroke-width="1.3"/><path d="M4.2 18.4c0-3 2.1-5.1 4.8-5.1s4.8 2.1 4.8 5.1" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round"/><circle cx="16.6" cy="9" r="2" stroke="#F58271" stroke-width="1.2"/><path d="M14.3 18.4c0-2.4 1-4.3 3.4-4.7" stroke="#F58271" stroke-width="1.2" stroke-linecap="round"/></svg>',
        'Who’s Going', whosGoingSub, null,
        { readonly: true }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="4.3" y="5.4" width="15.4" height="14" rx="2" stroke="#2A4747" stroke-width="1.3"/><path d="M4.3 9.6h15.4" stroke="#2A4747" stroke-width="1.3"/><path d="M8 3.8v3M16 3.8v3" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round"/><circle cx="9.4" cy="13.4" r="1.1" fill="#F58271"/></svg>',
        'The Day', theDaySub, null,
        { readonly: true }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4.3 16.6c1.7-2.6 2.6 2.6 4.3 0s2.6 2.6 4.3 0 2.6 2.6 4.3 0" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 6.3l4.3 4.3" stroke="#F58271" stroke-width="1.4" stroke-linecap="round"/><circle cx="18.7" cy="11" r="1.2" fill="#F58271"/></svg>',
        childLabelRaw + '’s Waiver', allCertified ? 'Confirmed' : 'Confirm you’re their guardian',
        allCertified ? 'Done' : 'Not done',
        { onClick: function () { state.step = 'guardianCertify'; render(); } }),
    ];

    var tilesHtml = tiles.map(function (t, i) {
      var rightHtml = t.readonly
        ? '<div class="ap-tile-readonly-tag">View only</div>'
        : '<div class="ap-tile-status ' + (t.statusLabel === 'Done' ? 'status-done' : t.statusLabel === 'Locked' ? 'status-locked' : 'status-notdone') + '">' + t.statusLabel + '</div>';
      return '<div class="ap-tile' + (t.locked ? ' locked' : '') + '" data-tile="' + i + '">' +
        '<div class="ap-tile-icon">' + t.icon + '</div>' +
        '<div class="ap-tile-mid"><div class="ap-tile-title">' + escapeHtml(t.title) + '</div><div class="ap-tile-sub">' + t.sub + '</div></div>' +
        rightHtml +
        '</div>';
    }).join('');

    // -----------------------------------------------------------------
    // Phase 1/2 escalating top card, non-attending guardian branch
    // (hub-lifecycle-alerts-proposal.md, 2026-09-03). Only two Phase 1
    // states for this persona (not certified / certified) -- one real
    // task only, no roster/gear/trail of their own to track -- then the
    // same Phase 2 arc the other two hubs get, framed around [child]'s
    // day throughout per Airey's own correction (low task count here
    // doesn't mean low informational need).
    // -----------------------------------------------------------------
    var topGreetingHtml = 'Hi ' + escapeHtml(firstName) + ', ' + escapeHtml(ownerName) + ' named you as ' + childLabel + '’s guardian for their adventure day.';
    var topSublineHtml = '';
    var pastT3 = isPastT3Cutoff(state.ctx.tripDate);
    var guideCardHtml = '';
    var postAdventureCardHtml = null;

    // T-3 hub refresh, 2026-09-04 (Airey's direct follow-up: "the
    // guardian hub needs this more than anyone -- they aren't going, but
    // their child is, and they want all of the same details so they
    // know their child is safe"). Countdown and weather are gated on
    // pastT3 alone, same as the other two hubs, independent of the
    // allCertified branching below -- a guardian who hasn't certified
    // yet still gets to see how many days out the trail day is and
    // (once wired) what the weather looks like; certifying doesn't
    // change what day it is.
    // Surface B trail-day arc (2026-09-08), guardian-only reframe:
    // Airey's resolved call -- no roster-confirm buttons for this
    // persona at either transition (a guardian at home can't take a
    // physical headcount of people they aren't standing next to), so
    // isUnderway/showPostAdventure here are purely reflective, read off
    // the same booking-level fields an attending signer's own confirm
    // writes. See the design doc's Part 2a for the full reasoning.
    // Post-adventure hero-copy fix (2026-09-08): hoisted above daysToGo
    // (computed unconditionally, not just inside allCertified) so the
    // countdown badge can be suppressed once the trip is actually over --
    // same fix as Surface A/attending-signer renderHub(), and the same
    // "certifying doesn't change what day it is" reasoning applies to
    // showPostAdventure too: a guardian who never certified but whose
    // child's trip has long since passed still shouldn't see "Today /
    // Trail day!".
    var todayStr = pacificDateString(new Date());
    var tripDateMatch = String(state.ctx.tripDate || '').match(/^\d{4}-\d{2}-\d{2}/);
    var tripDateStr = tripDateMatch ? tripDateMatch[0] : '';
    var deliveryDateStr = isoOffsetDateStr(state.ctx.tripDate, -1);
    var pastTripDay = !!(tripDateStr && todayStr > tripDateStr);
    var showPostAdventure = pastTripDay || (!!state.ctx.trailCheckinAt && isReturnRosterClean(state.ctx));
    var daysToGo = (pastT3 && !showPostAdventure) ? daysUntilTrip(state.ctx.tripDate) : null;
    var weatherHtml = pastT3 ? weatherCardHtml(state.ctx.weatherSnapshot, formatTripDate(state.ctx.tripDate)) : '';

    var isUnderway = false;
    if (allCertified) {
      isUnderway = todayStr === tripDateStr && !showPostAdventure && !!state.ctx.headingOutAt;

      if (todayStr === tripDateStr && !showPostAdventure && !isUnderway) {
        topGreetingHtml = 'It’s adventure day for ' + childLabel + '! ' + escapeHtml(trailDetail ? trailDetail.trailName : 'The trail') + ' is waiting.';
        topSublineHtml = theDaySub;
      } else if (todayStr === deliveryDateStr) {
        var deliveryWin = state.ctx.deliveryWindow;
        topGreetingHtml = childLabel + '’s gear arrives tonight' + (deliveryWin ? ', ' + escapeHtml(deliveryWin) : '') + ', packed and ready for tomorrow.';
        topSublineHtml = 'Inside: a Gregory daypack, Leki trekking poles, two Hydro Flask 32oz bottles, and a first aid kit. Yours to keep after: LMNT electrolytes, Rancho Meladuco Medjool dates, and Blue Lizard mineral sunscreen.';
      } else if (showPostAdventure) {
        // Post-Adventure Phase 3 (final spec, 2026-09-08, section 5 --
        // the non-attending guardian's own Phase 3, drafted for the
        // first time in that spec). The Turn reuses the attending
        // guardian's own copy as-is (nothing in it claims the guardian
        // was on the trail); Check-in is genuinely new (see
        // guardianOnlyCheckinCardHtml's own header comment); Closing/
        // Steady State reuse the generic guardian variant unchanged.
        var postAdventurePhase = computePostAdventurePhase(state.ctx.tripDate, !!state.ctx.feedbackSubmitted, true);
        if (postAdventurePhase === 'turn') {
          topGreetingHtml = childLabel + ' did the peak. Now, the pool.';
          topSublineHtml = 'A real one out there today, the easy part’s still ahead.';
          postAdventureCardHtml = heroCardHtml('Peaks to Pools', topGreetingHtml, topSublineHtml, trailDetail && trailDetail.photoUrl, null);
        } else if (postAdventurePhase === 'checkin') {
          postAdventureCardHtml = guardianOnlyCheckinCardHtml();
        } else if (postAdventurePhase === 'closing') {
          postAdventureCardHtml = guardianOnlyClosingCardHtml();
        } else {
          postAdventureCardHtml = steadyStateCardHtml(null, true, childLabel, trailDetail && trailDetail.photoUrl);
        }
      } else if (pastT3) {
        topGreetingHtml = childLabel + '’s trail guide is ready. Turn-by-turn navigation, waypoints, everything for ' + escapeHtml(trailDetail ? trailDetail.trailName : 'the trail') + ', so you both know exactly what the day looks like.';
        topSublineHtml = '';
        // Redesigned guide emphasis card (T-3 hub refresh, 2026-09-04) --
        // replaces the old single-line .ap-trail-unlocked treatment,
        // same upgrade the attending hubs got, framed around knowing
        // what [child]'s day looks like rather than "your" own route.
        guideCardHtml =
          '<div class="ap-guide-card">' +
          '<div class="ap-guide-eyebrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2 4 6v6c0 5 3.4 8.7 8 10 4.6-1.3 8-5 8-10V6l-8-4Z" stroke="#7ABD91" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 12.2l2 2 4-4.4" stroke="#7ABD91" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' + childLabel + '’s digital guide is unlocked</div>' +
          '<div class="ap-guide-headline">See exactly where ' + childLabel + '’ll be, turn by turn.</div>' +
          '<div class="ap-guide-body">Opens ' + escapeHtml(trailDetail ? trailDetail.trailName : 'the trail') + ' inside RideWithGPS, the exact turn-by-turn route ' + childLabel + '’s group will be following on trail day, so you know exactly where they’ll be and what the terrain looks like along the way. No account needed.</div>' +
          '<button type="button" class="ap-guide-cta" id="sb-guardian-get-guide">Get Guide</button>' +
          '<button type="button" class="ap-guide-howto" id="sb-guardian-guide-howto">How does this work? →</button>' +
          '</div>';
      } else {
        // Climax through 2A Countdown, merged into one state (same call
        // as the other two hubs' own identical reasoning -- no "seen it
        // before" tracking exists to tell a first visit from a later one).
        topGreetingHtml = childLabel + ' is going to have a great adventure!';
        topSublineHtml = 'This confirms your authorization and emergency contact are on file.';
      }
    }

    var topCardHtml = postAdventureCardHtml !== null
      ? postAdventureCardHtml
      : (allCertified
        ? heroCardHtml('You’re In', topGreetingHtml, topSublineHtml, trailDetail && trailDetail.photoUrl, daysToGo)
        : '<div class="ap-eyebrow">You’re In</div>' +
          '<div class="ap-greeting">' + topGreetingHtml + '</div>' +
          '<div class="ap-subline">' + topSublineHtml + '</div>');

    // Underway, reframed (Surface B trail-day arc, 2026-09-08): own hero
    // card entirely, same "On The Trail" eyebrow + dimmed treatment the
    // attending path's own underwayHeroHtml uses -- replaces topCardHtml
    // for this one state, per the resolved framing principle (third-
    // person-about-the-child, same real stakes and numbers, no location-
    // dependent language since this reader isn't the one on the trail).
    var underwayHtml = '';
    if (isUnderway) {
      var effectiveReturn = state.ctx.guestRevisedReturnAt || state.ctx.expectedReturnAt;
      var expectedReturnLabel = formatPacificTime(effectiveReturn) || 'later today';
      var underwaySubline = childLabel + '’s group is expected back around <b>' + escapeHtml(expectedReturnLabel) + '</b>. We’ll text them then, and we need a reply, that’s how we know ' + childLabel + ' made it back safe. ' +
        'Miss it and we start trying to reach the group right away, if that doesn’t work, it becomes a real search and rescue response, an expensive step we take seriously and hope never to need. ' +
        '<a class="ap-hero-link" id="sb-guardian-worried-link" style="color:var(--sand-beige);text-decoration:underline;text-underline-offset:2px;cursor:pointer;">Worried about ' + childLabel + '? →</a>';
      underwayHtml = heroCardHtml('On The Trail', childLabel + ' is on the trail.', underwaySubline, trailDetail && trailDetail.photoUrl, null, true) +
        '<div class="ap-subline" style="max-width:960px;margin:0.9rem auto 0;">If ' + childLabel + '’s group doesn’t check in before their expected return time, two more nudges follow, one right at the expected return time and a more direct one three hours after their expected return time. ' +
        'If we still haven’t heard from ' + childLabel + '’s group after that, we call in an actual search and rescue effort, a costly, serious undertaking. ' +
        'This isn’t a scare tactic. It’s a safety net and a real expectation.</div>' +
        openIncidentNoticeHtml();
    }

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      (isUnderway ? underwayHtml : topCardHtml) +
      // Guide before weather, matching the reordered sequence on the
      // other two hubs (2026-09-05).
      guideCardHtml +
      weatherHtml +
      (isUnderway ? '' : '<div class="ap-intro-banner"><div class="ap-intro-banner-text">Palm Springs Adventure Club plans the trail, gathers the group, and gets the gear to the door. ' + childLabel + '’s day itself is self-guided, without one of our own people along, so here’s everything about it: who’s going, where, when, and what to do if you need to reach us.</div></div>') +
      '<div class="ap-tiles-label">The day</div>' +
      '<div class="ap-tiles" id="sb-guardian-hub-tiles">' + tilesHtml + '</div>' +
      '</div></div>'
    );

    Array.prototype.forEach.call(wrap.querySelectorAll('.ap-tile:not(.locked)'), function (el) {
      el.addEventListener('click', function () {
        var t = tiles[Number(el.getAttribute('data-tile'))];
        if (t && t.onClick) t.onClick();
      });
    });
    var guardianGuideBtn = wrap.querySelector('#sb-guardian-get-guide');
    if (guardianGuideBtn) guardianGuideBtn.addEventListener('click', function () {
      window.open((state.ctx.rideWithGpsExperienceAccess) || 'https://ridewithgps.com/', '_blank');
    });
    var guardianHowtoBtn = wrap.querySelector('#sb-guardian-guide-howto');
    if (guardianHowtoBtn) guardianHowtoBtn.addEventListener('click', function () { state.step = 'ridewithgpsInfo'; render(); });

    // "Worried about [child]?" / session-local incident-notice link --
    // both drop straight into the guardian-only reframed triage, same
    // reset-then-navigate pattern the attending path's own
    // openCheckinTriage() follows.
    function openGuardianCheckinTriage() {
      state.checkinAffectedIds = myMinors.map(function (m) { return m.participantId; });
      state.checkinOmitRunningLonger = false;
      state.checkinCategory = null;
      state.checkinLostSeparatedWho = null;
      state.step = 'trailCheckinTriage';
      render();
    }
    var worriedLink = wrap.querySelector('#sb-guardian-worried-link');
    if (worriedLink) worriedLink.addEventListener('click', openGuardianCheckinTriage);
    var checkinNoticeLink = wrap.querySelector('#sb-checkin-notice-link');
    if (checkinNoticeLink) checkinNoticeLink.addEventListener('click', openGuardianCheckinTriage);

    wireFeedbackCard(wrap);

    return wrap;
  }

  // Certify screen (Part 5) -- replaces a personal liability waiver
  // entirely for this persona, per the approved copy doc: no scroll-
  // gated agreement (there's no liability to accept, this person isn't
  // attending), no emergency contact (not relevant to someone who isn't
  // on the trail). Just the one real certification action, reusing
  // saveWaiverSignature exactly as the attending-guardian self-declare
  // path does (isGuardian + guardianForChildrenParticipantIds), since the
  // backend already treats that as a complete, valid certification on
  // its own -- no waiver-specific fields are required server-side.
  function renderGuardianOnlyCertify() {
    var myMinors = (state.ctx.minors || []).filter(function (m) { return m.preAssignedToThisSigner; });
    var childNames = myMinors.map(function (m) { return m.name; }).filter(Boolean);
    var childLabel = childNames.length ? escapeHtml(childNames.join(' and ')) : 'them';
    var ownerName = state.ctx.ownerName || 'Your trip organizer';
    var alreadyCertified = myMinors.length > 0 && myMinors.every(function (m) { return m.alreadyVerified; });

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-back-link" id="sb-guardian-back" style="cursor:pointer;">&larr; Back to Adventure Home</div>' +
      '<div class="ap-eyebrow">' + childLabel + '\u2019s Waiver</div>' +
      '<div class="ap-q-title">Confirm you\u2019re ' + childLabel + '\u2019s parent or guardian.</div>' +
      '<div class="ap-q-help">' + escapeHtml(ownerName) + ' named you as the person responsible for ' + childLabel + ' on this adventure. This confirms it on our end, so ' + childLabel + '\u2019s on record with a real adult accountable for them, not just a name on someone else\u2019s roster.</div>' +
      '<div class="ap-card">' +
      '<div class="ap-field-label">Type your full legal name to confirm</div>' +
      '<input class="ap-field-input" type="text" id="sb-guardian-name" placeholder="Full legal name" value="' + escapeHtml(state.waiverName) + '">' +
      '<div id="sb-guardian-certify-error" class="ap-error"></div>' +
      '</div>' +
      '<button type="button" class="ap-cta-primary" id="sb-guardian-certify-cta"' + (alreadyCertified ? ' disabled' : '') + '>' + (alreadyCertified ? 'Confirmed' : 'Confirm') + '</button>' +
      '<div class="ap-cta-secondary" id="sb-guardian-save-return" style="cursor:pointer;">Back to Adventure Home</div>' +
      '</div></div>'
    );

    wrap.querySelector('#sb-guardian-back').addEventListener('click', goHub);
    wrap.querySelector('#sb-guardian-save-return').addEventListener('click', goHub);

    var nameInput = wrap.querySelector('#sb-guardian-name');
    var cta = wrap.querySelector('#sb-guardian-certify-cta');
    if (!alreadyCertified) {
      cta.addEventListener('click', function () {
        var name = (nameInput.value || '').trim();
        if (!name) {
          wrap.querySelector('#sb-guardian-certify-error').textContent = 'Enter your full legal name to confirm.';
          return;
        }
        state.waiverName = name;
        cta.disabled = true;
        var minorIds = myMinors.map(function (m) { return m.participantId; });
        var participantsCovered = [name].concat(childNames);
        apiPost('/api/waiver', {
          action: 'saveWaiverSignature',
          signerToken: SIGNER_TOKEN,
          signerName: name,
          isGuardian: true,
          guardianForChildrenParticipantIds: minorIds,
          participantsCovered: participantsCovered,
        }).then(function (res) {
          if (!res.ok) {
            cta.disabled = false;
            wrap.querySelector('#sb-guardian-certify-error').textContent = 'Something went wrong saving your confirmation, try again.';
            return;
          }
          state.ctx.minors = (state.ctx.minors || []).map(function (m) {
            return minorIds.indexOf(m.participantId) !== -1 ? Object.assign({}, m, { alreadyVerified: true }) : m;
          });
          state.ctx.signer = Object.assign({}, state.ctx.signer, { status: 'signed', guardianForChildrenParticipantIds: minorIds });
          goHub();
        });
      });
    }

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Confirm Your Details (mockup-07 frame 2) — no longer a mandatory gate,
  // just one tile among others, reachable and re-editable any time.
  // ---------------------------------------------------------------------
  function renderConfirmDetails() {
    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-back-link" id="sb-back" style="cursor:pointer;">&larr; Back to Your Adventure</div>' +
      '<div class="ap-eyebrow">Confirm Your Details</div>' +
      '<div class="ap-q-title">Let’s make sure we can reach you.</div>' +
      '<div class="ap-q-help">We’ll keep you posted on this adventure, including trail updates, waivers you need to sign, and weather for your trail day.</div>' +
      '<div class="ap-card">' +
      '<div class="ap-field-label">Your Email</div>' +
      '<input class="ap-field-input" type="email" id="sb-email" value="' + escapeHtml(state.email) + '">' +
      '<div class="ap-helper" style="margin-top:-0.6rem; display:block;">We’ll send waiver links and updates here. Change it if this isn’t the best one.</div>' +
      '<div class="ap-field-label">Phone Number (optional)</div>' +
      '<input class="ap-field-input" type="tel" id="sb-phone" placeholder="For text updates" value="' + escapeHtml(state.phone) + '">' +
      '<label class="ap-sms-consent">' +
      '<input type="checkbox" id="sb-sms"' + (state.smsConsent ? ' checked' : '') + '>' +
      '<span class="ap-sms-consent-label">' + escapeHtml(SMS_CONSENT_LABEL) +
      '<span class="ap-sms-fineprint">' + escapeHtml(SMS_CONSENT_FINEPRINT) + ' See Terms of Service and Privacy Policy at palmspringsadventureclub.com.</span>' +
      '</span></label>' +
      '<label class="ap-sms-consent">' +
      '<input type="checkbox" id="sb-kit-optin">' +
      '<span class="ap-sms-consent-label">' + escapeHtml(KIT_OPTIN_LABEL) +
      '<span class="ap-sms-fineprint">Optional, not required to continue. Unsubscribe anytime.</span>' +
      '</span></label>' +
      '<div id="sb-details-error" class="ap-error"></div>' +
      '</div>' +
      '<button type="button" class="ap-cta-primary" id="sb-save-details">Save &amp; Continue</button>' +
      '</div></div>'
    );

    wrap.querySelector('#sb-back').addEventListener('click', goHub);
    var cta = wrap.querySelector('#sb-save-details');
    cta.addEventListener('click', function () {
      var email = wrap.querySelector('#sb-email').value.trim();
      var phone = wrap.querySelector('#sb-phone').value.trim();
      var smsConsent = wrap.querySelector('#sb-sms').checked;
      var kitOptIn = wrap.querySelector('#sb-kit-optin').checked;
      if (!email) {
        wrap.querySelector('#sb-details-error').textContent = 'Enter an email so we can reach you.';
        return;
      }
      cta.disabled = true;
      cta.textContent = 'Saving…';
      apiPost('/api/waiver', {
        action: 'saveSignerDetails',
        signerToken: SIGNER_TOKEN,
        signerEmail: email,
        signerPhone: phone,
        smsConsent: smsConsent,
        smsConsentText: smsConsent ? SMS_CONSENT_TEXT : '',
      }).then(function (res) {
        if (!res.ok) {
          cta.disabled = false;
          cta.textContent = 'Save & Continue';
          wrap.querySelector('#sb-details-error').textContent = 'Something went wrong saving that, try again.';
          return;
        }
        state.email = email;
        state.phone = phone;
        state.smsConsent = smsConsent;
        state.ctx.signer.signerEmail = email;
        state.ctx.signer.signerPhone = phone;
        state.ctx.signer.smsConsent = smsConsent;
        state.ctx.signer.detailsConfirmedAt = res.body.detailsConfirmedAt || new Date().toISOString();
        // Kit is the system of record for list membership (see
        // lib/kit-sync-service.js's own header comment) -- this never
        // writes to Postgres directly, same as the homepage waitlist
        // form's own call to this exact endpoint. Fire-and-forget: a
        // failed subscribe shouldn't block confirming contact details,
        // so errors are swallowed here rather than surfaced in
        // sb-details-error. Not persisted locally, so a returning guest
        // sees this box unchecked again even if already subscribed --
        // re-subscribing is harmless (Kit dedupes by email).
        if (kitOptIn) {
          // Kit role-tagging (Post-Adventure Check-in build, 2026-09-08):
          // role:participant (23211384) for a plain attending signer,
          // role:guardian (23211386) for either guardian variant --
          // isGuardianOnly/signer.isGuardian is the same pair
          // lib/waiver-service.js's own resolveSignerForCheckin() reads
          // server-side to derive reportedByRole, mirrored here since
          // this call happens before this signer's own submitFeedback,
          // so there's no server round trip to piggyback the role off of.
          var kitRoleTag = (state.ctx.isGuardianOnly || (state.ctx.signer && state.ctx.signer.isGuardian)) ? 23211386 : 23211384;
          apiPost('/api/kit-subscribe', { email: email, extraTagIds: [kitRoleTag] }).catch(function () {});
        }
        goHub();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Your Trail (mockup-07's hub tile is view-only; there's no dedicated
  // detail frame in that mockup, so this is a judgment call, not a spec —
  // a minimal, read-only recap using the same candidateTrails data
  // Surface A's own hub already resolves a trail name from, with no CTAs
  // since this signer never controls trail selection.
  // ---------------------------------------------------------------------
  function renderTrail() {
    var status = computeStatus();
    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-back-link" id="sb-back" style="cursor:pointer;">&larr; Back to Your Adventure</div>' +
      '<div class="ap-eyebrow">Your Trail</div>' +
      '<div class="ap-q-title">' + escapeHtml(status.trailName || 'Not yet assigned') + '</div>' +
      (status.trailDescription ? '<div class="ap-q-help">' + escapeHtml(status.trailDescription) + '</div>' : '') +
      (status.trailDetail ? '<div style="margin:1.2rem 0;">' + compareCardHtml(status.trailDetail) + '</div>' : '') +
      '<div class="ap-helper" style="display:block;">Your trip organizer selected this trail for the group.</div>' +
      '</div></div>'
    );
    wrap.querySelector('#sb-back').addEventListener('click', goHub);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Your Gear (Sept 2026 follow-up): a Surface-B-only reference screen --
  // a non-owner signer never went through the booking flow, so unlike the
  // booker, they've never seen what's actually in a gear kit. Purely
  // static content, same rental/keepsake split as adventure-prep-form.js's
  // own Gear Kits screen. Read-only, like Your Trail above -- this signer
  // never manages kit counts or delivery details, that stays owner-side.
  // ---------------------------------------------------------------------
  function renderGear() {
    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-back-link" id="sb-back" style="cursor:pointer;">&larr; Back to Your Adventure</div>' +
      '<div class="ap-eyebrow">Your Gear</div>' +
      '<div class="ap-q-title">Your kit’s on its way.</div>' +
      '<div class="ap-q-help">It’ll be delivered the night before your adventure, to the address ' + escapeHtml(state.ctx.ownerName || 'your trip organizer') + ' provided. It’s yours for the day, packed and ready when you are.</div>' +
      '<div class="ap-card">' +
      '<div class="ap-section-label" style="margin-top:0;">Rental Gear</div>' +
      RENTAL_GEAR_ITEMS.map(function (item) { return '<div class="sb-gear-item">' + escapeHtml(item) + '</div>'; }).join('') +
      '<div class="ap-section-label">Yours to Keep</div>' +
      KEEPSAKE_ITEMS.map(function (item) { return '<div class="sb-gear-item">' + escapeHtml(item) + '</div>'; }).join('') +
      '</div>' +
      '</div></div>'
    );
    wrap.querySelector('#sb-back').addEventListener('click', goHub);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Your Waiver — sign (scroll-gated, same mechanics as Surface A's own
  // renderSign) -> guardian question (only if minors are on the roster,
  // carried over unchanged from the pre-Round-2 flow, since there's still
  // no data model that would let this be pre-known — see this file's own
  // top-of-file note) -> confirmation.
  // ---------------------------------------------------------------------
  function renderWaiver() {
    var wrap = h('<div class="container"><div class="ap-shell" style="padding-top:0;"><div id="sb-waiver-content"></div></div></div>');
    var contentEl = wrap.querySelector('#sb-waiver-content');

    function flowTopHtml(backLabel) {
      return '<div class="ap-flow-top"><div class="ap-back-link" id="sb-flow-back" style="cursor:pointer; margin-bottom:0;">' + backLabel + '</div><div></div></div>';
    }

    function renderSign() {
      var wc = state.ctx.waiverContent || {};
      var version = wc.version || 'v1.5';
      // BUG FIX (coordinating-session review, Aug 2026): these two fallback
      // strings are new guest-facing copy from this build and used an em
      // dash, against this project's locked brand-voice rule (no em dashes
      // in guest copy). Rephrased, matching the same fix applied to
      // adventure-prep-form.js's identical Surface A fallback strings.
      var statusTag = wc.statusTag == null ? 'Draft: Pending Final Attorney Review' : wc.statusTag;
      var bodyHtml = wc.bodyHtml || '<p>Waiver text is not available right now. Reply to whoever invited you and we’ll help you finish this.</p>';
      var minors = state.ctx.minors || [];
      var scrolledToEnd = false;
      var checked = false;

      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Your Waiver</div>' +
        '<div class="ap-q-title">Sign your waiver.</div>' +
        '<div class="ap-q-help">Scroll through the full agreement below, then confirm at the bottom.</div>' +
        '<div class="ap-card">' +
        '<div class="ap-waiver-scroll" id="sb-waiver-scroll">' +
        '<div class="doc-title"><div class="doc-name">PALM SPRINGS ADVENTURE CLUB</div>' +
        '<div class="doc-sub">Participant Agreement and Acknowledgment of Risk</div>' +
        '<div class="doc-version">Version ' + escapeHtml(version.replace(/^v/i, '')) + '</div></div>' +
        (statusTag ? '<div class="ap-draft-tag">' + escapeHtml(statusTag) + '</div>' : '') +
        bodyHtml +
        '<p style="font-style:italic; color:var(--ap-muted); font-size:0.68rem;">[Signed electronically as the name you type below, with a timestamped record kept on file, upon tapping “Sign &amp; Continue.”]</p>' +
        '</div>' +
        '<div class="ap-scroll-hint" id="sb-scroll-hint">&#8595; Scroll to review the full agreement</div>' +
        '<div class="ap-agree-row disabled" id="sb-agree-row">' +
        '<div class="ap-agree-box" id="sb-agree-box"></div>' +
        '<div class="ap-agree-text">I have read and agree to the Palm Springs Adventure Club waiver and release of liability.</div>' +
        '</div>' +
        '<div class="ap-field-label">Type your full legal name to sign</div>' +
        '<input class="ap-field-input" type="text" id="sb-waiver-name" placeholder="Full legal name" value="' + escapeHtml(state.waiverName) + '">' +
        '<div class="ap-section-label">Emergency Contact (optional)</div>' +
        '<div class="ap-field-label">Name</div>' +
        '<input class="ap-field-input" type="text" id="sb-ec-name" placeholder="Full name" value="' + escapeHtml(state.ecName) + '">' +
        '<div class="ap-field-label">Phone</div>' +
        '<input class="ap-field-input" type="tel" id="sb-ec-phone" placeholder="Phone number" value="' + escapeHtml(state.ecPhone) + '">' +
        '<div id="sb-waiver-error" class="ap-error"></div>' +
        '</div>' +
        '<button type="button" class="ap-cta-primary" id="sb-sign-cta" disabled>Sign &amp; Continue</button>' +
        '<div class="ap-cta-secondary" id="sb-save-and-return" style="cursor:pointer;">Save &amp; return to Adventure Home</div>';

      var scrollBox = contentEl.querySelector('#sb-waiver-scroll');
      var hint = contentEl.querySelector('#sb-scroll-hint');
      var agreeRow = contentEl.querySelector('#sb-agree-row');
      var agreeBox = contentEl.querySelector('#sb-agree-box');
      var signCta = contentEl.querySelector('#sb-sign-cta');

      // Same scroll-gated pattern as Surface A's renderSign, including the
      // same zero-height-viewport fallback so a short/zoomed-in screen
      // never traps the guest.
      scrollBox.addEventListener('scroll', function () {
        if (scrolledToEnd) return;
        if (scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 6) {
          scrolledToEnd = true;
          agreeRow.classList.remove('disabled');
          hint.textContent = 'You’ve reviewed the full agreement. Tap the checkbox to confirm.';
          hint.classList.add('done');
        }
      });
      // BUG FIX (coordinating-session review, Aug 2026): renderSign() runs
      // synchronously from renderWaiver(), before render()'s own
      // root.appendChild(frag) attaches this content to the live document
      // (see render(), above). A detached node has no layout box, so
      // scrollBox.scrollHeight/clientHeight both read 0 here — meaning the
      // "already fully visible, no scroll needed" check below used to
      // ALWAYS pass, on every viewport, unlocking "I agree" before the
      // guest had scrolled at all. Deferring this one check with
      // setTimeout(0) lets it run on the next tick, after render() has
      // finished appending and the browser has laid out real content, so
      // it now only fires when the agreement genuinely already fits
      // on-screen without scrolling. The scroll listener above is
      // unaffected — it only ever fires on a real user scroll event, which
      // can't happen before the element is attached anyway.
      setTimeout(function () {
        if (scrolledToEnd) return;
        if (scrollBox.scrollHeight <= scrollBox.clientHeight + 6) {
          scrolledToEnd = true;
          agreeRow.classList.remove('disabled');
          hint.textContent = 'You’ve reviewed the full agreement. Tap the checkbox to confirm.';
          hint.classList.add('done');
        }
      }, 0);
      agreeRow.addEventListener('click', function () {
        if (!scrolledToEnd) return;
        checked = !checked;
        agreeBox.classList.toggle('checked', checked);
        agreeBox.innerHTML = checked ? '&check;' : '';
        signCta.disabled = !checked;
      });

      function collectFields() {
        state.waiverName = contentEl.querySelector('#sb-waiver-name').value.trim();
        state.ecName = contentEl.querySelector('#sb-ec-name').value.trim();
        state.ecPhone = contentEl.querySelector('#sb-ec-phone').value.trim();
      }

      contentEl.querySelector('#sb-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#sb-save-and-return').addEventListener('click', function () {
        collectFields();
        goHub();
      });
      signCta.addEventListener('click', function () {
        collectFields();
        if (!state.waiverName) {
          contentEl.querySelector('#sb-waiver-error').textContent = 'Type your full legal name to sign.';
          return;
        }
        signCta.disabled = true;
        if (minors.length) {
          renderGuardianQuestion();
        } else {
          submitSignature([], function () {
            signCta.disabled = false;
            contentEl.querySelector('#sb-waiver-error').textContent = 'Something went wrong saving that, try again.';
          });
        }
      });
    }

    // REWRITTEN (Task 16): keyed on participantId now, not the child's
    // display name (see this file's header comment). Also pre-checks any
    // minor getSignerContext flags as preAssignedToThisSigner — the
    // booker already named THIS signer as that child's guardian at
    // roster-confirmation time (confirmRoster's guardianAssignment,
    // Section 6) — while still requiring the "Yes" tap above and leaving
    // every box independently toggleable; nothing here auto-submits
    // without the signer's own affirmative action.
    function renderGuardianQuestion() {
      wrap.classList.remove('ap-wide');
      var minors = state.ctx.minors || [];
      var isGuardian = null;
      // Pre-seed with any pre-assigned minors so the checklist starts
      // correctly checked the first time it renders (before the signer
      // has touched anything) — matches getSignerContext's own stated
      // purpose for this flag.
      state.guardianForChildrenParticipantIds = minors
        .filter(function (m) { return m.preAssignedToThisSigner; })
        .map(function (m) { return m.participantId; });

      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Your Waiver</div>' +
        '<div class="ap-q-title">Is a child on this booking yours?</div>' +
        '<div class="ap-q-help">We ask everyone this directly, we never assume it from who’s traveling together.</div>' +
        '<div class="sb-guardian-q">' +
        '<button type="button" class="sb-guardian-btn" data-val="yes">Yes</button>' +
        '<button type="button" class="sb-guardian-btn" data-val="no">No</button>' +
        '</div>' +
        '<div id="sb-guardian-checklist"></div>' +
        '<div id="sb-guardian-error" class="ap-error"></div>' +
        '<button type="button" class="ap-cta-primary" id="sb-guardian-continue" style="display:none;">Continue</button>';

      function renderChecklist() {
        var checklistEl = contentEl.querySelector('#sb-guardian-checklist');
        if (isGuardian !== true || !minors.length) { checklistEl.innerHTML = ''; return; }
        checklistEl.innerHTML =
          '<div class="sb-additive">Since a child is joining too, we build the day around who’s actually on the trail, pace and supervision included, not a one-size adventure.</div>' +
          minors.map(function (m) {
            var name = m.name || 'this child';
            var age = AGE_BUCKET_LABELS[m.ageBucket] || '';
            var alreadyNote = m.alreadyVerified ? '<div class="ap-helper" style="margin:0.1rem 0 0.4rem;">A guardian has already confirmed this. Checking again just adds your own confirmation too.</div>' : '';
            return '<div class="ap-toggle-row" data-guardian-participant-id="' + escapeHtml(m.participantId) + '" style="cursor:pointer;">' +
              '<div class="ap-toggle-row-text" style="font-weight:500; font-size:0.78rem;">I am the parent or legal guardian of ' + escapeHtml(name) + ' (' + escapeHtml(age) + '), or have their parent or guardian’s authorization, and I am signing on their behalf' + alreadyNote + '</div>' +
              '<div class="ap-switch' + (state.guardianForChildrenParticipantIds.indexOf(m.participantId) !== -1 ? ' on' : '') + '"></div>' +
              '</div>';
          }).join('');
        Array.prototype.forEach.call(checklistEl.querySelectorAll('[data-guardian-participant-id]'), function (row) {
          row.addEventListener('click', function () {
            var participantId = row.getAttribute('data-guardian-participant-id');
            var idx = state.guardianForChildrenParticipantIds.indexOf(participantId);
            if (idx === -1) state.guardianForChildrenParticipantIds.push(participantId); else state.guardianForChildrenParticipantIds.splice(idx, 1);
            row.querySelector('.ap-switch').classList.toggle('on', state.guardianForChildrenParticipantIds.indexOf(participantId) !== -1);
          });
        });
      }

      Array.prototype.forEach.call(contentEl.querySelectorAll('.sb-guardian-btn'), function (btn) {
        btn.addEventListener('click', function () {
          isGuardian = btn.getAttribute('data-val') === 'yes';
          if (!isGuardian) state.guardianForChildrenParticipantIds = [];
          Array.prototype.forEach.call(contentEl.querySelectorAll('.sb-guardian-btn'), function (b) {
            b.classList.toggle('is-selected', b === btn);
          });
          contentEl.querySelector('#sb-guardian-continue').style.display = '';
          renderChecklist();
        });
      });
      // If a pre-assignment already pre-checked at least one box, jump
      // straight to "Yes" and render the checklist — a signer who was
      // named as a guardian shouldn't have to re-answer a question the
      // booker already answered on their behalf, though they can still
      // switch to "No" and clear it themselves.
      if (state.guardianForChildrenParticipantIds.length) {
        var yesBtn = contentEl.querySelector('.sb-guardian-btn[data-val="yes"]');
        if (yesBtn) yesBtn.click();
      }

      var guardianContinueBtn = contentEl.querySelector('#sb-guardian-continue');
      contentEl.querySelector('#sb-flow-back').addEventListener('click', goHub);
      guardianContinueBtn.addEventListener('click', function () {
        if (isGuardian && minors.length && !state.guardianForChildrenParticipantIds.length) {
          contentEl.querySelector('#sb-guardian-error').textContent = 'Check at least one child you’re certifying for, or answer "No" above.';
          return;
        }
        guardianContinueBtn.disabled = true;
        submitSignature(state.guardianForChildrenParticipantIds, function () {
          guardianContinueBtn.disabled = false;
          contentEl.querySelector('#sb-guardian-error').textContent = 'Something went wrong saving that, try again.';
        });
      });
    }

    // BUG FIX (Task 16): this used to send `guardianForChildren` (child
    // names). lib/waiver-service.js's saveWaiverSignature only ever reads
    // `guardianForChildrenParticipantIds` — the old key was silently
    // ignored, so applyGuardianCertification never ran for anyone signing
    // here on behalf of a child. participantsCovered stays name-based
    // (still stored for the record on the signature row, same as
    // adventure-prep-form.js's own renderSign), resolved from
    // state.ctx.minors since that's this call's only source of names for
    // these participantIds.
    function submitSignature(guardianForChildrenParticipantIds, onError) {
      var minorsById = {};
      (state.ctx.minors || []).forEach(function (m) { minorsById[m.participantId] = m; });
      var childNames = guardianForChildrenParticipantIds.map(function (pid) { return minorsById[pid] ? minorsById[pid].name : pid; });
      var participantsCovered = [state.waiverName].concat(childNames);
      apiPost('/api/waiver', {
        action: 'saveWaiverSignature',
        signerToken: SIGNER_TOKEN,
        signerName: state.waiverName,
        isGuardian: guardianForChildrenParticipantIds.length > 0,
        guardianForChildrenParticipantIds: guardianForChildrenParticipantIds,
        participantsCovered: participantsCovered,
      }).then(function (res) {
        if (!res.ok) {
          if (onError) onError();
          return;
        }
        var ecDone = state.ecName || state.ecPhone
          ? apiPost('/api/waiver', { action: 'saveEmergencyContact', signerToken: SIGNER_TOKEN, contactName: state.ecName, contactPhone: state.ecPhone })
          : Promise.resolve({ ok: true });
        state.ctx.signer.status = 'signed';
        // NOT JSON.stringify()'d — see this function's own comment on
        // guardianForChildrenParticipantIds above; it's a real array both
        // in the server's response and in this local mirror.
        state.ctx.signer.guardianForChildrenParticipantIds = guardianForChildrenParticipantIds;
        ecDone.then(renderConfirmation);
      });
    }

    function renderConfirmation() {
      wrap.classList.remove('ap-wide');
      var ecLine = state.ecName || state.ecPhone
        ? escapeHtml([state.ecName, state.ecPhone].filter(Boolean).join(' \u00b7 '))
        : 'Not provided';
      var guardianForChildrenParticipantIds = (state.ctx.signer && state.ctx.signer.guardianForChildrenParticipantIds) || [];
      var confirmMinorsById = {};
      (state.ctx.minors || []).forEach(function (m) { confirmMinorsById[m.participantId] = m; });
      var confirmChildNames = guardianForChildrenParticipantIds
        .map(function (pid) { return confirmMinorsById[pid] ? confirmMinorsById[pid].name : null; })
        .filter(Boolean);
      var isGuardianConfirmation = confirmChildNames.length > 0;
      var confirmTitle = isGuardianConfirmation
        ? escapeHtml(confirmChildNames.join(', ')) + ' is going to have a great adventure!'
        : 'You\u2019re in. ' + escapeHtml(state.ctx.ownerName || 'Your trip organizer') + '\u2019s going to be glad to have you out there.';
      var confirmBody = isGuardianConfirmation
        ? 'This confirms your authorization and emergency contact are on file.'
        : 'This confirms your waiver and emergency contact are on file. Nothing else needed from you here.';
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Your Waiver</div>' +
        '<div class="ap-recap-title">' + confirmTitle + '</div>' +
        '<div class="ap-recap-body">' + confirmBody + '</div>' +
        '<div class="ap-recap-card">' +
        '<div class="ap-recap-line"><span>Waiver Signed By</span><b>' + escapeHtml(state.waiverName || '') + '</b></div>' +
        '<div class="ap-recap-line"><span>Emergency Contact</span><b>' + ecLine + '</b></div>' +
        '</div>' +
        '<button type="button" class="ap-cta-primary" id="sb-return-hub">Return to Adventure Home</button>';
      contentEl.querySelector('#sb-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#sb-return-hub').addEventListener('click', goHub);
    }

    renderSign();
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Adventure Summary receipt -- shared builder (T-3 hub refresh,
  // 2026-09-04). Extracted out of renderSummary() below so the exact
  // same card can also be embedded directly at the bottom of renderHub()
  // once past T3 (Airey's direct request, round 3), instead of just
  // linking out to this standalone screen. No guide-CTA button on this
  // surface's receipt (unlike Surface A's) -- the guide card above
  // already carries that action, and gear/deposit/payment detail still
  // doesn't belong to a non-owner signer, same as always.
  // ---------------------------------------------------------------------
  function receiptCardHtml() {
    var status = computeStatus();
    var tripDate = formatTripDate(state.ctx.tripDate);
    var signer = state.ctx.signer || {};
    return '<div class="ap-receipt"><div class="ap-receipt-inner">' +
      '<div class="ap-receipt-mark"><img src="/images/logo.svg" alt="Palm Springs Adventure Club"></div>' +
      '<div class="ap-receipt-eyebrow">Adventure Summary</div>' +
      '<div class="ap-receipt-headline">You’re all set.</div>' +
      '<div class="ap-receipt-grid">' +
      '<div><div class="ap-receipt-stat-label">Trail Day</div><div class="ap-receipt-stat-value">' + escapeHtml(tripDate) + '</div></div>' +
      '<div><div class="ap-receipt-stat-label">Trail</div><div class="ap-receipt-stat-value">' + escapeHtml(status.trailAssigned ? status.trailName : 'To be confirmed') + '</div></div>' +
      '</div>' +
      '<div class="ap-receipt-divider"></div>' +
      '<div class="ap-receipt-line"><span>Your Waiver</span><b>Signed' + (signer.signedAt ? ' ' + formatTripDate(signer.signedAt) : '') + '</b></div>' +
      (status.guardianForChildren.length ? '<div class="ap-receipt-line"><span>Also covers</span><b>' + escapeHtml(status.guardianForChildren.join(', ')) + '</b></div>' : '') +
      '<div class="ap-receipt-footer">palmspringsadventureclub.com</div>' +
      '</div></div>';
  }

  // ---------------------------------------------------------------------
  // Adventure Summary — same judgment call as Your Trail above: no
  // mockup-07 frame shows this screen's unlocked content, so this is a
  // deliberately minimal, read-only recap (trail day, trail name, this
  // signer's own waiver status) rather than Surface A's full receipt —
  // none of Surface A's gear/deposit/payment detail belongs to a
  // non-owner signer.
  // ---------------------------------------------------------------------
  function renderSummary() {
    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-back-link" id="sb-back" style="cursor:pointer;">&larr; Back to Your Adventure</div>' +
      receiptCardHtml() +
      '</div></div>'
    );
    wrap.querySelector('#sb-back').addEventListener('click', goHub);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // RideWithGPS "how does this work" page (T-3 hub refresh, 2026-09-04)
  // -- sits behind the new guide card's secondary link on the hub. Static
  // content, no API dependency -- deliberately plain numbered steps
  // rather than mocked RideWithGPS screenshots, since the actual in-app
  // UI isn't something to fabricate inaccurately here. Same content as
  // Surface A's own copy, adapted to this file's own goHub()/state.ctx
  // shape (see this file's header comment on why the two files don't
  // share a single implementation).
  // ---------------------------------------------------------------------
  function renderRideWithGpsInfo() {
    var status = computeStatus();
    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-back-link" id="sb-rwgps-back" style="cursor:pointer;">&larr; Back to Your Adventure</div>' +
      '<div class="ap-eyebrow">Your Digital Guide</div>' +
      '<h2 style="font-family:\'Cormorant Garamond\',serif;font-weight:600;font-size:1.5rem;margin:0 0 1.4rem;color:var(--dark-pine);">Getting ' + escapeHtml(status.trailName || 'your trail') + ' onto your phone</h2>' +
      '<div class="ap-card">' +
      '<div class="rwgps-step"><div class="rwgps-num">1</div><div><div class="rwgps-step-title">Tap Get Guide</div><div class="rwgps-step-body">Opens your trail inside RideWithGPS, a free route-navigation app. No account or sign-up needed on your end.</div></div></div>' +
      '<div class="rwgps-step"><div class="rwgps-num">2</div><div><div class="rwgps-step-title">Download the route for offline use</div><div class="rwgps-step-body">Look for the download / offline-map option inside RideWithGPS and save the route before you leave cell service. This is the one step that matters most: do it before you get to the trailhead, not after.</div></div></div>' +
      '<div class="rwgps-step"><div class="rwgps-num">3</div><div><div class="rwgps-step-title">Use it on trail day</div><div class="rwgps-step-body">Turn-by-turn navigation and waypoints, right on your phone, even with no signal, as long as you downloaded it first.</div></div></div>' +
      '</div>' +
      '<div class="rwgps-callout"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;margin-top:1px;"><circle cx="12" cy="12" r="9" stroke="#F58271" stroke-width="1.6"/><path d="M12 8v5" stroke="#F58271" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16" r="1" fill="#F58271"/></svg><div>Cell service on our trails isn’t guaranteed. The offline download in step 2 is what actually gets you navigation out there. The app alone, without downloading first, won’t help once you lose signal.</div></div>' +
      '<button type="button" class="ap-cta-primary" id="sb-rwgps-open" style="margin-top:1.4rem;">Open in RideWithGPS</button>' +
      '<a class="rwgps-back" id="sb-rwgps-back-2">&larr; Back to your Adventure Hub</a>' +
      '</div></div>'
    );
    wrap.querySelector('#sb-rwgps-back').addEventListener('click', goHub);
    wrap.querySelector('#sb-rwgps-back-2').addEventListener('click', goHub);
    wrap.querySelector('#sb-rwgps-open').addEventListener('click', function () {
      window.open((state.ctx.rideWithGpsExperienceAccess) || 'https://ridewithgps.com/', '_blank');
    });
    return wrap;
  }

  boot();
})();
