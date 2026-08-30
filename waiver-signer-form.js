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

   WHAT THIS BUILD COULD NOT DO (flagged, not silently worked around):
   mockup-07 also shows a second scenario — "Taylor," an adult who is
   named as a guardian for a minor but is NOT herself attending or on the
   roster. That scenario needs a real guardian-assignment data model
   (the booker naming an external, non-attending adult as a signing
   guardian for a child), which is Section 9 item 1 of the handoff and is
   still explicitly unbuilt — adventurePrep_sendSignerLinks only ever
   issues signerTokens to adults already on the roster (see that
   function's own comment in adventure-prep-actions.gs). So every real
   signerToken today belongs to an attending adult (the "Jordan" shape),
   and that's the only shape this file builds. If/when the guardian-
   assignment model is built, this file's hub will need a second branch
   for a non-attending guardian (no Your Trail tile, "[Child]'s Waiver"
   instead of "Your Waiver") — flagged here rather than guessed at now.

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
    guardianForChildren: [],
    ecName: '',
    ecPhone: '',
  };

  // Matches the live booking flow's own SMS opt-in structure exactly
  // (Twilio A2P 10DLC requirements: exact consent text stored with a
  // timestamp, opt-in never required, rate/frequency disclosure, STOP/
  // HELP instructions, link to Terms & Privacy) — see adventure-form.js's
  // SMS_CONSENT_TEXT. Only the subject of the message is adapted here,
  // per mockup-07's own note, since this is a separate consent event for
  // a different purpose than the original booker's own consent.
  var SMS_CONSENT_LABEL = 'Yes, send me text messages from Palm Springs Adventure Club about this adventure — trail updates, waivers you need to sign, and weather for your trail day.';
  var SMS_CONSENT_FINEPRINT = 'Optional, not required to continue. Message frequency varies. Message and data rates may apply. Reply STOP to cancel, HELP for help.';
  var SMS_CONSENT_TEXT = SMS_CONSENT_LABEL + ' ' + SMS_CONSENT_FINEPRINT + ' See Terms of Service and Privacy Policy at palmspringsadventureclub.com.';

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

  function parseCandidateTrails() {
    var candidateTrails = state.ctx.candidateTrails;
    try { return typeof candidateTrails === 'string' ? JSON.parse(candidateTrails || '[]') : (candidateTrails || []); } catch (e) { return []; }
  }

  function computeStatus() {
    var signer = state.ctx.signer || {};
    var detailsDone = !!signer.detailsConfirmedAt;
    var waiverDone = signer.status === 'signed';
    var candidateTrails = parseCandidateTrails();
    var selectedTrailId = state.ctx.selectedTrailId;
    var trailMatch = candidateTrails.filter(function (c) { return c.trailId === selectedTrailId; })[0];
    var guardianForChildren = [];
    try { guardianForChildren = JSON.parse(signer.guardianForChildrenJson || '[]'); } catch (e) { guardianForChildren = []; }
    return {
      detailsDone: detailsDone,
      waiverDone: waiverDone,
      guardianForChildren: guardianForChildren,
      trailAssigned: !!selectedTrailId,
      trailName: trailMatch ? trailMatch.trailName : '',
      trailDescription: trailMatch ? (trailMatch.description || (trailMatch.matchedAttributes || []).join(', ')) : '',
      // Same judgment call as adventure-prep-form.js's own hub status
      // comment: no mockup exists for Surface B's Adventure Summary
      // content, so this unlocks on the two things Surface B itself
      // gates (Confirm Your Details + signing) rather than also
      // requiring the trail to be assigned, which is out of this
      // signer's hands entirely.
      summaryUnlocked: detailsDone && waiverDone,
    };
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

    function tile(icon, title, sub, statusLabel, opts) {
      opts = opts || {};
      return { icon: icon, title: title, sub: sub, statusLabel: statusLabel, locked: !!opts.locked, readonly: !!opts.readonly, onClick: opts.onClick };
    }

    var waiverSub = status.waiverDone
      ? (status.guardianForChildren.length ? 'Signed — includes ' + status.guardianForChildren.join(', ') : 'Signed')
      : 'Needs your signature';

    var tiles = [
      tile('📱', 'Confirm Your Details',
        status.detailsDone ? 'Saved' : 'Your email & phone, so we can reach you',
        status.detailsDone ? 'Done' : 'Not done',
        { onClick: function () { state.step = 'confirmDetails'; render(); } }),
      tile('🧭', 'Your Trail',
        status.trailAssigned ? status.trailName : 'Not yet assigned',
        null,
        { readonly: true, onClick: status.trailAssigned ? function () { state.step = 'trail'; render(); } : null }),
      tile('✍️', 'Your Waiver', waiverSub,
        status.waiverDone ? 'Done' : 'Not done',
        { onClick: function () { state.step = 'waiver'; render(); } }),
      tile('📋', 'Adventure Summary',
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

    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="ap-eyebrow">You’re Invited</div>' +
      '<div class="ap-greeting">Hi ' + escapeHtml(firstName) + ', you’ve been added to an adventure.</div>' +
      '<div class="ap-subline">' + escapeHtml(tripDate) + ' &middot; ' + (allSet ? 'you’re all set' : 'one thing needs you first') + '.</div>' +
      // PLACEHOLDER COPY, not final — adapted from the same illustrative
      // Borrowed Trust copy already used for this exact banner before
      // this redesign (this file's own pre-Round-2 version), per
      // mockup-07's own flag that this is a placeholder pending the real
      // copy review landing, not a design decision to sign off on.
      '<div class="ap-intro-banner"><div class="ap-intro-banner-text">' + escapeHtml(ownerName) + '’s heading out with Palm Springs Adventure Club on ' + escapeHtml(tripDate) + ' and added you to the day. We place people on the trail that actually fits them, not a generic route. Before you’re all set, we just need a few things from you.</div></div>' +
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
      '<div class="ap-q-help">So we can keep you posted on this adventure — trail updates, any waivers you need to sign, and weather for your trail day.</div>' +
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

    function renderGuardianQuestion() {
      var minors = state.ctx.minors || [];
      var isGuardian = null;

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
            return '<div class="ap-toggle-row" data-guardian-name="' + escapeHtml(name) + '" style="cursor:pointer;">' +
              '<div class="ap-toggle-row-text" style="font-weight:500; font-size:0.78rem;">I am the parent or legal guardian of ' + escapeHtml(name) + ' (' + escapeHtml(m.age || m.ageRange || '') + '), or have their parent or guardian’s authorization, and I am signing on their behalf</div>' +
              '<div class="ap-switch' + (state.guardianForChildren.indexOf(name) !== -1 ? ' on' : '') + '"></div>' +
              '</div>';
          }).join('');
        Array.prototype.forEach.call(checklistEl.querySelectorAll('[data-guardian-name]'), function (row) {
          row.addEventListener('click', function () {
            var name = row.getAttribute('data-guardian-name');
            var idx = state.guardianForChildren.indexOf(name);
            if (idx === -1) state.guardianForChildren.push(name); else state.guardianForChildren.splice(idx, 1);
            row.querySelector('.ap-switch').classList.toggle('on', state.guardianForChildren.indexOf(name) !== -1);
          });
        });
      }

      Array.prototype.forEach.call(contentEl.querySelectorAll('.sb-guardian-btn'), function (btn) {
        btn.addEventListener('click', function () {
          isGuardian = btn.getAttribute('data-val') === 'yes';
          if (!isGuardian) state.guardianForChildren = [];
          Array.prototype.forEach.call(contentEl.querySelectorAll('.sb-guardian-btn'), function (b) {
            b.classList.toggle('is-selected', b === btn);
          });
          contentEl.querySelector('#sb-guardian-continue').style.display = '';
          renderChecklist();
        });
      });

      var guardianContinueBtn = contentEl.querySelector('#sb-guardian-continue');
      contentEl.querySelector('#sb-flow-back').addEventListener('click', goHub);
      guardianContinueBtn.addEventListener('click', function () {
        if (isGuardian && minors.length && !state.guardianForChildren.length) {
          contentEl.querySelector('#sb-guardian-error').textContent = 'Check at least one child you’re certifying for, or answer "No" above.';
          return;
        }
        guardianContinueBtn.disabled = true;
        submitSignature(state.guardianForChildren, function () {
          guardianContinueBtn.disabled = false;
          contentEl.querySelector('#sb-guardian-error').textContent = 'Something went wrong saving that, try again.';
        });
      });
    }

    function submitSignature(guardianForChildren, onError) {
      var participantsCovered = [state.waiverName].concat(guardianForChildren);
      apiPost('/api/waiver', {
        action: 'saveWaiverSignature',
        signerToken: SIGNER_TOKEN,
        signerName: state.waiverName,
        isGuardian: guardianForChildren.length > 0,
        guardianForChildren: guardianForChildren,
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
        state.ctx.signer.guardianForChildrenJson = JSON.stringify(guardianForChildren);
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
