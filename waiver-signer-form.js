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
  };

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
  // Hub top card, Climax onward -- hero-photo treatment with a dark-card
  // fallback when a trail has no photo yet
  // (hub-top-card-visual-options.html, 2026-09-03). headlineHtml/
  // sublineHtml are passed through as already-safe HTML, matching how
  // topGreetingHtml/topSublineHtml are built and inserted everywhere else
  // in this file.
  function heroCardHtml(eyebrowText, headlineHtml, sublineHtml, photoUrl, countdownDays) {
    // Trail-day countdown badge (T-3 hub refresh, 2026-09-04): only
    // rendered when a caller passes a real number -- pre-T3 callers pass
    // null/undefined and get no badge at all.
    var badgeHtml = '';
    if (countdownDays !== null && countdownDays !== undefined) {
      var badgeNum = countdownDays > 0 ? String(countdownDays) : 'Today';
      var badgeLbl = countdownDays > 0 ? (countdownDays === 1 ? 'Day to go' : 'Days to go') : 'Trail day!';
      badgeHtml = '<div class="ap-countdown-badge"><div class="ap-countdown-num">' + badgeNum + '</div><div class="ap-countdown-lbl">' + badgeLbl + '</div></div>';
    }
    return '<div class="ap-hero-card' + (photoUrl ? '' : ' no-photo') + '"' +
      (photoUrl ? ' style="background-image:url(\'' + photoUrl + '\');"' : '') + '>' +
      badgeHtml +
      '<div class="ap-hero-card-inner">' +
      '<div class="ap-hero-eyebrow">' + escapeHtml(eyebrowText) + '</div>' +
      '<div class="ap-hero-headline">' + headlineHtml + '</div>' +
      '<div class="ap-hero-subline">' + sublineHtml + '</div>' +
      '</div></div>';
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
      '<div><div class="ap-compare-stat-label">Distance</div><div class="ap-compare-stat-value">' + (candidate.distance != null ? candidate.distance + ' mi' : '—') + '</div></div>' +
      '<div><div class="ap-compare-stat-label">Elevation</div><div class="ap-compare-stat-value">' + (candidate.elevation != null ? candidate.elevation + ' ft' : '—') + '</div></div>' +
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
      ? '<div class="ap-prep-summary" id="sb-prep-toggle">' +
        '<div class="ap-prep-summary-check"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
        '<div><div class="ap-prep-summary-text">Everything’s set — Your Details, Trail, Gear, Waiver</div><div class="ap-prep-summary-sub">Tap to review the details</div></div>' +
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
    var doneCount = [status.detailsDone, status.waiverDone].filter(Boolean).length;
    // NEW (T-3 hub refresh, 2026-09-04): trail-day countdown, only
    // meaningful once past T3 -- passed into heroCardHtml below so it
    // renders pinned to the hero photo's top-right corner, same as
    // Surface A.
    var daysToGo = pastT3 ? daysUntilTrip(state.ctx.tripDate) : null;

    if (status.allSet) {
      var statLine = (status.trailAssigned ? escapeHtml(status.trailName) + ' · ' : '') + formatTripDate(state.ctx.tripDate);
      var todayStr = pacificDateString(new Date());
      var tripDateMatch = String(state.ctx.tripDate || '').match(/^\d{4}-\d{2}-\d{2}/);
      var tripDateStr = tripDateMatch ? tripDateMatch[0] : '';
      var deliveryDateStr = isoOffsetDateStr(state.ctx.tripDate, -1);

      if (todayStr === tripDateStr) {
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

    var topCardHtml = status.allSet
      ? heroCardHtml('You’re In', topGreetingHtml, topSublineHtml, status.trailDetail && status.trailDetail.photoUrl, daysToGo)
      : '<div class="ap-eyebrow">You’re In</div>' +
        '<div class="ap-greeting">' + topGreetingHtml + '</div>' +
        '<div class="ap-subline">' + topSublineHtml + '</div>';

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
      '<div class="ap-guide-body">Opens ' + escapeHtml(status.trailName) + ' inside RideWithGPS — turn-by-turn navigation and waypoints, no account needed. Download it for offline use before you head out; cell service on this trail isn’t guaranteed.</div>' +
      '<button type="button" class="ap-guide-cta" id="sb-get-guide">Get Guide</button>' +
      '<button type="button" class="ap-guide-howto" id="sb-guide-howto">How does this work? →</button>' +
      '</div>';

    var pastT3TrailCardHtml = (pastT3 && status.trailAssigned && status.trailDetail)
      ? '<div class="ap-trail-section-wide">' + compareCardHtml(status.trailDetail, true) + '</div>'
      : '';

    // T-3+ embedded Adventure Summary receipt (Airey's direct request,
    // round 3, 2026-09-04): the full renderSummary() card, not a tile
    // linking out to it, placed at the bottom of the hub once past T3.
    var receiptHtml = pastT3 ? receiptCardHtml() : '';

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      topCardHtml +
      '<div class="ap-intro-banner"><div class="ap-intro-banner-text">' + hubIntroText + '</div></div>' +
      (pastT3
        ? weatherHtml + guideCardHtml + pastT3TrailCardHtml + getReadyHtml + receiptHtml
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
    var guideBtn = wrap.querySelector('#sb-get-guide');
    if (guideBtn) guideBtn.addEventListener('click', function () {
      window.open((state.ctx.rideWithGpsExperienceAccess) || 'https://ridewithgps.com/', '_blank');
    });
    var howtoBtn = wrap.querySelector('#sb-guide-howto');
    if (howtoBtn) howtoBtn.addEventListener('click', function () { state.step = 'ridewithgpsInfo'; render(); });

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

    // T-3 hub refresh, 2026-09-04 (Airey's direct follow-up: "the
    // guardian hub needs this more than anyone -- they aren't going, but
    // their child is, and they want all of the same details so they
    // know their child is safe"). Countdown and weather are gated on
    // pastT3 alone, same as the other two hubs, independent of the
    // allCertified branching below -- a guardian who hasn't certified
    // yet still gets to see how many days out the trail day is and
    // (once wired) what the weather looks like; certifying doesn't
    // change what day it is.
    var daysToGo = pastT3 ? daysUntilTrip(state.ctx.tripDate) : null;
    var weatherHtml = pastT3 ? weatherCardHtml(state.ctx.weatherSnapshot, formatTripDate(state.ctx.tripDate)) : '';

    if (allCertified) {
      var todayStr = pacificDateString(new Date());
      var tripDateMatch = String(state.ctx.tripDate || '').match(/^\d{4}-\d{2}-\d{2}/);
      var tripDateStr = tripDateMatch ? tripDateMatch[0] : '';
      var deliveryDateStr = isoOffsetDateStr(state.ctx.tripDate, -1);

      if (todayStr === tripDateStr) {
        topGreetingHtml = 'It’s adventure day for ' + childLabel + '! ' + escapeHtml(trailDetail ? trailDetail.trailName : 'The trail') + ' is waiting.';
        topSublineHtml = theDaySub;
      } else if (todayStr === deliveryDateStr) {
        var deliveryWin = state.ctx.deliveryWindow;
        topGreetingHtml = childLabel + '’s gear arrives tonight' + (deliveryWin ? ', ' + escapeHtml(deliveryWin) : '') + ', packed and ready for tomorrow.';
        topSublineHtml = 'Inside: a Gregory daypack, Leki trekking poles, two Hydro Flask 32oz bottles, and a first aid kit. Yours to keep after: LMNT electrolytes, Rancho Meladuco Medjool dates, and Blue Lizard mineral sunscreen.';
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
          '<div class="ap-guide-body">Opens ' + escapeHtml(trailDetail ? trailDetail.trailName : 'the trail') + ' inside RideWithGPS — the exact turn-by-turn route ' + childLabel + '’s group will be following on trail day, so you know exactly where they’ll be and what the terrain looks like along the way. No account needed.</div>' +
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

    var topCardHtml = allCertified
      ? heroCardHtml('You’re In', topGreetingHtml, topSublineHtml, trailDetail && trailDetail.photoUrl, daysToGo)
      : '<div class="ap-eyebrow">You’re In</div>' +
        '<div class="ap-greeting">' + topGreetingHtml + '</div>' +
        '<div class="ap-subline">' + topSublineHtml + '</div>';

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      topCardHtml +
      weatherHtml +
      guideCardHtml +
      '<div class="ap-intro-banner"><div class="ap-intro-banner-text">Palm Springs Adventure Club plans the trail, gathers the group, and gets the gear to the door. ' + childLabel + '’s day itself is self-guided, without one of our own people along, so here’s everything about it: who’s going, where, when, and what to do if you need to reach us.</div></div>' +
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
          apiPost('/api/kit-subscribe', { email: email }).catch(function () {});
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
      '<div class="rwgps-step"><div class="rwgps-num">1</div><div><div class="rwgps-step-title">Tap Get Guide</div><div class="rwgps-step-body">Opens your trail inside RideWithGPS — a free route-navigation app. No account or sign-up needed on your end.</div></div></div>' +
      '<div class="rwgps-step"><div class="rwgps-num">2</div><div><div class="rwgps-step-title">Download the route for offline use</div><div class="rwgps-step-body">Look for the download / offline-map option inside RideWithGPS and save the route before you leave cell service. This is the one step that matters most — do it before you get to the trailhead, not after.</div></div></div>' +
      '<div class="rwgps-step"><div class="rwgps-num">3</div><div><div class="rwgps-step-title">Use it on trail day</div><div class="rwgps-step-body">Turn-by-turn navigation and waypoints, right on your phone, even with no signal — as long as you downloaded it first.</div></div></div>' +
      '</div>' +
      '<div class="rwgps-callout"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;margin-top:1px;"><circle cx="12" cy="12" r="9" stroke="#F58271" stroke-width="1.6"/><path d="M12 8v5" stroke="#F58271" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16" r="1" fill="#F58271"/></svg><div>Cell service on our trails isn’t guaranteed. The offline download in step 2 is what actually gets you navigation out there — the app alone, without downloading first, won’t help once you lose signal.</div></div>' +
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
