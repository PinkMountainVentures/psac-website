/* ============================================
   PSAC — Adventure Prep, Surface B (non-owner signer waiver link)
   Vanilla JS, no deps. Drives /sign-waiver?token=<signerToken>, one link
   per required adult signer besides the booking owner. Deliberately does
   NOT reuse Surface A's task-page chrome (header, progress bar, step-card
   shell) — see psac-surface-b-non-owner-signer.html's own design-note:
   this is a short, mostly one-time task for someone with zero context on
   the brand, not a multi-session flow, so it gets a distinct, warmer,
   single continuous-scroll shell instead.

   Also deliberately never checks bookingStatus the way Surface A does —
   confirmed decision (Operations UX PRD Section 5/16), a non-owner signer
   has no reason to see a cancellation or refund status that isn't theirs.
   ============================================ */

(function () {
  'use strict';

  var qs = new URLSearchParams(window.location.search);
  var SIGNER_TOKEN = qs.get('token') || '';
  var root = document.getElementById('sb-root');

  var state = {
    ctx: null,
    step: 1,
    signerName: '',
    waiverAgreed: false,
    isGuardian: null,
    guardianForChildren: [],
    phone: '',
    smsConsent: false,
    ecName: '',
    ecPhone: '',
  };

  var SMS_CONSENT_TEXT = 'Yes, send me text messages from Palm Springs Adventure Club about my reservation, delivery, and deposit. Optional, not required. Message frequency varies. Message and data rates may apply. Reply STOP to cancel, HELP for help.';

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
      state.signerName = res.body.signer && res.body.signer.signerName || '';
      if (res.body.signer && res.body.signer.status === 'signed') {
        state.step = 'done';
      }
      render();
    });
  }

  function renderMessage(title, body) {
    root.innerHTML = '';
    root.appendChild(h('<div class="container" style="padding:4rem 0;"><div style="max-width:480px;margin:0 auto;text-align:center;"><h1 class="sb-section-title" style="font-size:1.6rem;">' + escapeHtml(title) + '</h1><p class="sb-section-sub">' + body + '</p></div></div>'));
  }

  function render() {
    root.innerHTML = '';
    if (state.step === 'done') { root.appendChild(renderDone()); return; }
    root.appendChild(renderHero());
    var container = h('<div class="container"></div>');
    if (state.step === 1) container.appendChild(renderStep1());
    else if (state.step === 2) container.appendChild(renderStep2());
    else container.appendChild(renderStep3());
    root.appendChild(container);
  }

  function renderHero() {
    var ownerName = state.ctx.ownerName || 'Your trip organizer';
    var tripDate = formatTripDate(state.ctx.tripDate);
    return h(
      '<div class="sb-hero"><div class="container">' +
      '<div class="sb-hero-brand">Palm Springs Adventure Club</div>' +
      '<p class="sb-hero-quote">' + escapeHtml(ownerName) + '&rsquo;s heading out with Palm Springs Adventure Club on ' + tripDate + ' and added you to the day. We place people on the trail that actually fits them, not a generic route. Before you&rsquo;re all set, we just need <strong>a few things from you</strong>.</p>' +
      '<p class="sb-hero-sub">Two minutes, most of it optional.</p>' +
      '</div></div>'
    );
  }

  // Step 1: confirm name + waiver text + sign
  function renderStep1() {
    var wrap = h(
      '<div class="sb-section"><div class="sb-section-label">Step 1 of 3</div>' +
      '<h2 class="sb-section-title">First, confirm it’s you</h2>' +
      '<p class="sb-section-sub">We’ll double-check your name is right.</p>' +
      '<div class="ap-form-row"><label>Your full legal name</label><input type="text" id="sb-name" value="' + escapeHtml(state.signerName) + '"></div>' +
      '</div>' +
      '<div class="sb-section">' +
      '<h2 class="sb-section-title">Your Release of Liability</h2>' +
      '<p class="sb-section-sub">Palm Springs Adventure Club needs your own agreement to this, separate from ' + escapeHtml(state.ctx.ownerName || 'the booking owner') + '. No one else can sign on your behalf.</p>' +
      '<div class="sb-waiver-text"><strong>Release of Liability, Assumption of Risk, and Indemnification Agreement (v1.4)</strong><br>' +
      'I understand that trekking and outdoor recreation involve inherent risks, including but not limited to uneven terrain, wildlife, weather, and remote locations with limited emergency access. I voluntarily assume all such risks.</div>' +
      '<label class="paf-sms-consent"><input type="checkbox" id="sb-agree"' + (state.waiverAgreed ? ' checked' : '') + '><span>I have read, understand, and agree to this Release of Liability.</span></label>' +
      '<div id="sb-error" class="ap-error"></div>' +
      '<button class="sb-cta" id="sb-next">Sign &amp; Continue</button>' +
      '</div>'
    );
    wrap.querySelector('#sb-next').addEventListener('click', function () {
      state.signerName = wrap.querySelector('#sb-name').value.trim();
      state.waiverAgreed = wrap.querySelector('#sb-agree').checked;
      if (!state.signerName || !state.waiverAgreed) {
        wrap.querySelector('#sb-error').textContent = 'Type your full legal name and agree to the release to continue.';
        return;
      }
      state.step = 2;
      render();
    });
    return wrap;
  }

  // Step 2: guardian question, branches into a per-minor checklist
  function renderStep2() {
    var minors = state.ctx.minors || [];
    var wrap = h(
      '<div class="sb-section"><div class="sb-section-label">Step 2 of 3</div>' +
      '<h2 class="sb-section-title">Is a child on this booking yours?</h2>' +
      '<p class="sb-section-sub">We ask everyone this directly, we never assume it from who’s traveling together.</p>' +
      '<div class="sb-guardian-q">' +
      '<button type="button" class="sb-guardian-btn" data-val="yes">Yes</button>' +
      '<button type="button" class="sb-guardian-btn" data-val="no">No</button>' +
      '</div>' +
      '<div id="sb-guardian-checklist"></div>' +
      '<div id="sb-error2" class="ap-error"></div>' +
      '<button class="sb-cta" id="sb-next2" style="display:none;">Continue</button>' +
      '</div>'
    );

    function renderChecklist() {
      var checklistEl = wrap.querySelector('#sb-guardian-checklist');
      if (state.isGuardian !== true || !minors.length) { checklistEl.innerHTML = ''; return; }
      checklistEl.innerHTML =
        '<div class="sb-additive">Since a child is joining too, we build the day around who’s actually on the trail.</div>' +
        minors.map(function (m) {
          var name = m.name || 'this child';
          return '<label class="paf-sms-consent" style="margin-bottom:0.5rem;"><input type="checkbox" class="sb-guardian-cb" data-name="' + escapeHtml(name) + '"' + (state.guardianForChildren.indexOf(name) !== -1 ? ' checked' : '') + '><span>I am the parent or legal guardian of ' + escapeHtml(name) + ' (' + escapeHtml(m.age || m.ageRange || '') + '), or have their parent or guardian’s authorization, and I am signing on their behalf.</span></label>';
        }).join('');
      Array.prototype.forEach.call(checklistEl.querySelectorAll('.sb-guardian-cb'), function (cb) {
        cb.addEventListener('change', function () {
          var name = cb.getAttribute('data-name');
          var idx = state.guardianForChildren.indexOf(name);
          if (cb.checked && idx === -1) state.guardianForChildren.push(name);
          else if (!cb.checked && idx !== -1) state.guardianForChildren.splice(idx, 1);
        });
      });
    }

    Array.prototype.forEach.call(wrap.querySelectorAll('.sb-guardian-btn'), function (btn) {
      btn.addEventListener('click', function () {
        state.isGuardian = btn.getAttribute('data-val') === 'yes';
        Array.prototype.forEach.call(wrap.querySelectorAll('.sb-guardian-btn'), function (b) {
          b.classList.toggle('is-selected', b === btn);
        });
        wrap.querySelector('#sb-next2').style.display = '';
        renderChecklist();
      });
    });

    wrap.querySelector('#sb-next2').addEventListener('click', function () {
      if (state.isGuardian && minors.length && !state.guardianForChildren.length) {
        wrap.querySelector('#sb-error2').textContent = 'Check at least one child you’re certifying for, or answer "No" above.';
        return;
      }
      submitWaiver(wrap.querySelector('#sb-error2'), function () {
        state.step = 3;
        render();
      });
    });

    return wrap;
  }

  function submitWaiver(errorEl, onSuccess) {
    var participantsCovered = [state.signerName].concat(state.guardianForChildren);
    apiPost('/api/waiver', {
      action: 'saveWaiverSignature',
      signerToken: SIGNER_TOKEN,
      rosterRef: state.ctx.signer && state.ctx.signer.rosterRef,
      signerName: state.signerName,
      signerEmail: state.ctx.signer && state.ctx.signer.signerEmail,
      isGuardian: !!state.isGuardian,
      guardianForChildren: state.guardianForChildren,
      participantsCovered: participantsCovered,
    }).then(function (res) {
      if (!res.ok) { if (errorEl) errorEl.textContent = 'Something went wrong saving that, try again.'; return; }
      onSuccess();
    });
  }

  // Step 3: optional phone/SMS + optional emergency contact
  function renderStep3() {
    var wrap = h(
      '<div class="sb-section"><div class="sb-section-label">Step 3 of 3 · Optional</div>' +
      '<h2 class="sb-section-title">Want trip updates by text?</h2>' +
      '<div class="ap-form-row"><label>Phone number</label><input type="text" id="sb-phone" placeholder="Optional"></div>' +
      '<label class="paf-sms-consent"><input type="checkbox" id="sb-sms"><span>' + SMS_CONSENT_TEXT + '</span></label>' +
      '</div>' +
      '<div class="sb-section">' +
      '<h2 class="sb-section-title">An emergency contact, just for you</h2>' +
      '<p class="sb-section-sub">Not the group’s, yours specifically. Totally optional.</p>' +
      '<div class="ap-form-row"><label>Name</label><input type="text" id="sb-ec-name" placeholder="Optional"></div>' +
      '<div class="ap-form-row"><label>Phone</label><input type="text" id="sb-ec-phone" placeholder="Optional"></div>' +
      '<div id="sb-error3" class="ap-error"></div>' +
      '<button class="sb-cta" id="sb-finish">Finish</button>' +
      '<button class="sb-cta-outline" id="sb-skip">Skip these, I’m done</button>' +
      '</div>'
    );

    function finish() {
      var phone = wrap.querySelector('#sb-phone').value.trim();
      var smsConsent = wrap.querySelector('#sb-sms').checked;
      var ecName = wrap.querySelector('#sb-ec-name').value.trim();
      var ecPhone = wrap.querySelector('#sb-ec-phone').value.trim();

      var tasks = [];
      if (phone || smsConsent) {
        tasks.push(apiPost('/api/waiver', {
          action: 'saveWaiverSignature',
          signerToken: SIGNER_TOKEN,
          signerName: state.signerName,
          signerPhone: phone,
          smsConsent: smsConsent,
          smsConsentText: smsConsent ? SMS_CONSENT_TEXT : '',
        }));
      }
      if (ecName || ecPhone) {
        tasks.push(apiPost('/api/waiver', { action: 'saveEmergencyContact', signerToken: SIGNER_TOKEN, contactName: ecName, contactPhone: ecPhone }));
      }
      Promise.all(tasks).then(function () {
        state.step = 'done';
        render();
      });
    }

    wrap.querySelector('#sb-finish').addEventListener('click', finish);
    wrap.querySelector('#sb-skip').addEventListener('click', function () { state.step = 'done'; render(); });
    return wrap;
  }

  function renderDone() {
    var ownerName = state.ctx.ownerName || 'the booking owner';
    var firstName = (state.signerName || '').split(' ')[0] || 'there';
    return h(
      '<div class="sb-page"><div class="container"><div class="sb-done">' +
      '<div class="sb-done-badge"><svg viewBox="0 0 24 24" fill="none" width="24" height="24"><path d="M5 12.5L9.5 17L19 7" stroke="#4a9d68" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
      '<h1 class="sb-done-title">You’re all set, ' + escapeHtml(firstName) + '</h1>' +
      '<p class="sb-done-body">Your waiver’s signed. ' + escapeHtml(ownerName) + ' will handle the rest, we’ll see you on the trail.</p>' +
      '</div></div></div>'
    );
  }

  boot();
})();
