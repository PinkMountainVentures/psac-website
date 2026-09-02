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

   WHAT THIS BUILD STILL COULD NOT DO (flagged, not silently worked
   around, and now more precisely scoped than before this rewrite):
   mockup-07 also shows a second scenario — "Taylor," an adult who is
   named as a guardian for a minor but is NOT herself attending or on the
   roster. PRD Section 6's guardian hybrid model (built earlier this
   migration — see lib/waiver-service.js's own header comment) DOES now
   support this at the data/backend level: confirmRoster's
   guardianAssignment can name a non-attending external guardian
   ({name, email}), which creates a real booking_participants row
   (role_on_booking = 'guardian_only') and sendSignerLinksForBooking does
   send that person a real signerToken. What's still missing is UI: there
   is no screen anywhere in this codebase for the booker to actually NAME
   that external guardian (see adventure-prep-form.js's own header comment
   for the same flag from the booker's side), so no real "Taylor" token
   has ever been issued in practice — every real signerToken today still
   belongs to an attending adult (the "Jordan" shape), and that's the only
   shape this file builds. If/when that assignment UI is built, this
   file's hub would need a second branch for a non-attending guardian (no
   Your Trail tile, "[Child]'s Waiver" instead of "Your Waiver") — flagged
   here rather than guessed at now.

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
    step: 'hub', // 'hub' | 'confirmDetails' | 'trail' | 'waiver' | 'summary'
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
    switch (state.step) {
      case 'confirmDetails': frag = renderConfirmDetails(); break;
      case 'trail': frag = renderTrail(); break;
      case 'waiver': frag = renderWaiver(); break;
      case 'summary': frag = renderSummary(); break;
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
  function compareCardHtml(candidate) {
    var desc = summarize(candidate.overviewCopy, 250) || ((candidate.matchedAttributes || []).length
      ? 'Matches what you told us: ' + candidate.matchedAttributes.join(', ') + '.'
      : 'A safe, solid fit for your group.');
    return '<div class="ap-compare-card">' +
      '<div class="ap-compare-photo"' + (candidate.photoUrl ? ' style="background-image:url(\'' + candidate.photoUrl + '\'); background-size:cover; background-position:center;"' : '') + '></div>' +
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
      ? (status.guardianForChildren.length ? 'Signed — includes ' + status.guardianForChildren.join(', ') : 'Signed')
      : 'Needs your signature';

    var tiles = [
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="7.6" y="2.7" width="8.8" height="18.6" rx="2.1" stroke="#2A4747" stroke-width="1.3"/><path d="M10.6 5.3h2.8" stroke="#2A4747" stroke-width="1.1" stroke-linecap="round"/><path d="M9.6 9.6h4.8M9.6 12.4h3.2" stroke="#2A4747" stroke-width="1" stroke-linecap="round"/><circle cx="12" cy="18.4" r="1.15" fill="#F58271"/></svg>', 'Confirm Your Details',
        status.detailsDone ? 'Saved' : 'Your email & phone, so we can reach you',
        status.detailsDone ? 'Done' : 'Not done',
        { onClick: function () { state.step = 'confirmDetails'; render(); } }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.3" stroke="#2A4747" stroke-width="1.4"/><path d="M12 3.3v1.6" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round"/><path d="M12 12l3-5-1 5.6z" fill="#F58271"/><path d="M12 12l-3 5 1-5.6z" fill="#2A4747"/><circle cx="12" cy="12" r="1" fill="#2A4747"/></svg>', 'Your Trail',
        status.trailAssigned ? status.trailName : 'Not yet assigned',
        null,
        { readonly: true, onClick: status.trailAssigned ? function () { state.step = 'trail'; render(); } : null }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4.3 16.6c1.7-2.6 2.6 2.6 4.3 0s2.6 2.6 4.3 0 2.6 2.6 4.3 0" stroke="#2A4747" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 6.3l4.3 4.3" stroke="#F58271" stroke-width="1.4" stroke-linecap="round"/><circle cx="18.7" cy="11" r="1.2" fill="#F58271"/></svg>', 'Your Waiver', waiverSub,
        status.waiverDone ? 'Done' : 'Not done',
        { onClick: function () { state.step = 'waiver'; render(); } }),
      tile('<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="5.2" y="4.4" width="13.6" height="16.6" rx="2" stroke="#2A4747" stroke-width="1.3"/><rect x="9" y="2.7" width="6" height="3" rx="1" stroke="#2A4747" stroke-width="1.2"/><path d="M8.3 10h6.4M8.3 13.4h4.6" stroke="#2A4747" stroke-width="1.1" stroke-linecap="round"/><path d="M8.3 17l1.9 1.9 3.7-3.9" stroke="#F58271" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>', 'Adventure Summary',
        status.summaryUnlocked ? 'See your recap' : 'Unlocks once everything above is set',
        status.summaryUnlocked ? 'Done' : 'Locked',
        { locked: !status.summaryUnlocked, onClick: status.summaryUnlocked ? function () { state.step = 'summary'; render(); } : null }),
    ];

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

    var allSet = status.detailsDone && status.waiverDone;

    // Trail card (Sept 2026 follow-up, matches Surface A's own hub
    // pattern): only shown once the booker has actually picked a trail --
    // status.trailDetail is the full candidate_trails/trails row
    // (distance/elevation/ratings/photo) getSignerContext now resolves,
    // not just a name (see this file's computeStatus() bug-fix comment).
    var trailSectionHtml = !status.trailAssigned || !status.trailDetail ? '' :
      '<div class="ap-trail-section-wide">' + compareCardHtml(status.trailDetail) + '</div>';

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-eyebrow">You’re Invited</div>' +
      '<div class="ap-greeting">Hi ' + escapeHtml(firstName) + ', you’ve been added to an adventure.</div>' +
      '<div class="ap-subline">Complete the following steps to officially join the adventure.</div>' +
      '<div class="ap-intro-banner"><div class="ap-intro-banner-text">' + escapeHtml(ownerName) + '’s heading out with Palm Springs Adventure Club on ' + escapeHtml(tripDate) + ' and added you to the adventure. Palm Springs Adventure Club is a personalized trail experience and gear rental service that unlocks experiences on the trails, canyons, and ridgelines surrounding Palm Springs. We need a few things from you before your adventure.</div></div>' +
      trailSectionHtml +
      '<div class="ap-tiles-label">Get ready</div>' +
      '<div class="ap-tiles" id="sb-hub-tiles">' + tilesHtml + '</div>' +
      '</div></div>'
    );

    Array.prototype.forEach.call(wrap.querySelectorAll('.ap-tile:not(.locked)'), function (el) {
      el.addEventListener('click', function () {
        var t = tiles[Number(el.getAttribute('data-tile'))];
        if (t && t.onClick) t.onClick();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Confirm Your Details (mockup-07 frame 2) — no longer a mandatory gate,
  // just one tile among others, reachable and re-editable any time.
  // ---------------------------------------------------------------------
  function renderConfirmDetails() {
    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      '<div class="ap-back-link" id="sb-back" style="cursor:pointer;">&larr; Back to Your Adventure</div>' +
      '<div class="ap-eyebrow">Confirm Your Details</div>' +
      '<div class="ap-q-title">Let’s make sure we can reach you.</div>' +
      '<div class="ap-q-help">We’ll keep you posted on this adventure, including trail updates, waivers you need to sign, and weather for your trail day.</div>' +
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
      '<div class="container"><div class="ap-shell">' +
      '<div class="ap-back-link" id="sb-back" style="cursor:pointer;">&larr; Back to Your Adventure</div>' +
      '<div class="ap-eyebrow">Your Trail</div>' +
      '<div class="ap-q-title">' + escapeHtml(status.trailName || 'Not yet assigned') + '</div>' +
      (status.trailDescription ? '<div class="ap-q-help">' + escapeHtml(status.trailDescription) + '</div>' : '') +
      '<div class="ap-helper" style="display:block;">Your trip organizer handles picking and adjusting the trail — this is just here so you know where you’re headed.</div>' +
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
    var wrap = h('<div class="container"><div class="ap-shell"><div id="sb-waiver-content"></div></div></div>');
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
          '<div class="sb-additive">Since a child is joining too, we build the day around who’s actually on the trail.</div>' +
          minors.map(function (m) {
            var name = m.name || 'this child';
            var age = AGE_BUCKET_LABELS[m.ageBucket] || '';
            var alreadyNote = m.alreadyVerified ? '<div class="ap-helper" style="margin:0.1rem 0 0.4rem;">A guardian has already confirmed this — checking again just adds your own confirmation too.</div>' : '';
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
      contentEl.innerHTML =
        flowTopHtml('&larr; Adventure Home') +
        '<div class="ap-eyebrow">Your Waiver</div>' +
        '<div class="ap-recap-icon">&#9997;&#65039;</div>' +
        '<div class="ap-recap-title">Waiver signed.</div>' +
        '<div class="ap-recap-body">You’re all set on this one.</div>' +
        '<button type="button" class="ap-cta-primary" id="sb-return-hub">Return to Adventure Home</button>';
      contentEl.querySelector('#sb-flow-back').addEventListener('click', goHub);
      contentEl.querySelector('#sb-return-hub').addEventListener('click', goHub);
    }

    renderSign();
    return wrap;
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
    var status = computeStatus();
    var tripDate = formatTripDate(state.ctx.tripDate);
    var signer = state.ctx.signer || {};
    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      '<div class="ap-back-link" id="sb-back" style="cursor:pointer;">&larr; Back to Your Adventure</div>' +
      '<div class="ap-eyebrow">Adventure Summary</div>' +
      '<div class="ap-q-title">You’re all set.</div>' +
      '<div class="ap-recap-line"><span>Trail Day</span><b>' + escapeHtml(tripDate) + '</b></div>' +
      (status.trailAssigned ? '<div class="ap-recap-line"><span>Trail</span><b>' + escapeHtml(status.trailName) + '</b></div>' : '') +
      '<div class="ap-recap-line"><span>Your Waiver</span><b>Signed' + (signer.signedAt ? ' ' + formatTripDate(signer.signedAt) : '') + '</b></div>' +
      (status.guardianForChildren.length ? '<div class="ap-recap-line"><span>Also covers</span><b>' + escapeHtml(status.guardianForChildren.join(', ')) + '</b></div>' : '') +
      '</div></div>'
    );
    wrap.querySelector('#sb-back').addEventListener('click', goHub);
    return wrap;
  }

  boot();
})();
