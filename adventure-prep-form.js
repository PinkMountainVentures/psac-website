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
  var AGE_BUCKETS = ['Under 14', '14-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
  var MINOR_BUCKETS = { 'Under 14': true, '14-17': true };
  var FITNESS_OPTIONS = ['Easygoing', 'Comfortable', 'Strong'];

  var state = {
    ctx: null,
    step: 'landing',
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
    waiverName: '',
    waiverAgreed: false,
    guardianForChildren: [],
    ecName: '',
    ecPhone: '',
    trailAssignmentPhase: 'idle', // idle | loading | done
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
    return apiPost('/api/save-adventure-prep', { token: TOKEN, fields: fields });
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
    apiGet('/api/get-adventure-prep?token=' + encodeURIComponent(TOKEN)).then(function (res) {
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
  }

  // ---------------------------------------------------------------------
  // Render dispatch
  // ---------------------------------------------------------------------

  function render() {
    root.innerHTML = '';
    var frag;
    switch (state.step) {
      case 'landing': frag = renderLanding(); break;
      case 'roster': frag = renderRoster(); break;
      case 'preferences': frag = renderPreferences(); break;
      case 'trail': frag = renderTrail(); break;
      case 'planning': frag = renderPlanning(); break;
      case 'deposit': frag = renderDeposit(); break;
      case 'waiver': frag = renderWaiver(); break;
      case 'review': frag = renderReview(); break;
      case 'done': frag = renderDone(); break;
      default: frag = renderLanding();
    }
    root.appendChild(frag);
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
  // Step: Landing
  // ---------------------------------------------------------------------

  function checklistDone() {
    var ap = state.ctx.adventurePrep || {};
    return {
      roster: !!ap.reconfirmedRosterJson,
      trail: !!ap.selectedTrailId && !!ap.deliveryAddressLine1,
      waiver: (state.ctx.waiverSignatures || []).some(function (w) { return w.role === 'owner' && w.status === 'signed'; }),
      signers: !!ap.linksSentAt,
    };
  }

  function renderLanding() {
    var eb = state.ctx.experienceBooking;
    var done = checklistDone();
    var firstName = (eb.contactName || 'there').split(' ')[0];
    function item(label, isDone) {
      return '<div class="ap-checklist-item"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="' + (isDone ? 'rgba(122,189,145,0.35)' : 'rgba(42,71,71,0.08)') + '"/>' +
        (isDone ? '<path d="M8 12l3 3 5-6" stroke="#2a7a4a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' : '') +
        '</svg><span>' + label + '</span></div>';
    }
    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      progressBar(0, 4) +
      '<div class="ap-card" style="text-align:center; padding:3rem 2.5rem;">' +
      '<div class="ap-eyebrow" style="text-align:left;">Finish setting up your adventure</div>' +
      '<h1 class="ap-q" style="max-width:none; font-size:1.7rem;">You already told us who you are and what you’re after. This is just the last handful of things standing between you and the trail.</h1>' +
      '<p class="ap-sub" style="margin:1rem auto 1.8rem; max-width:520px;">Hi ' + escapeHtml(firstName) + ', your trail day is <strong>' + formatTripDate(eb.date) + '</strong>. Here’s what’s left:</p>' +
      '<div class="ap-checklist" style="text-align:left; max-width:400px; margin:0 auto 2rem;">' +
      item('Confirm who’s coming and their gear', done.roster) +
      item('See your trail pick and tell us your delivery details', done.trail) +
      item('Sign your waiver', done.waiver) +
      item('Let us know who else is coming, so we can reach them', done.signers) +
      '</div>' +
      '<p class="ap-helper" style="margin-bottom:1.6rem;">About 5 minutes. You can leave anytime and pick up right where you left off, this link is yours to keep.</p>' +
      '<button class="ap-nav-next" id="ap-start" style="padding:0.9rem 2.6rem;">Let’s Go</button>' +
      '</div></div></div>'
    );
    wrap.querySelector('#ap-start').addEventListener('click', function () {
      state.step = 'roster';
      render();
    });
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Are you joining? + roster reconfirmation + gear kit toggle
  // ---------------------------------------------------------------------

  function rosterRowHtml(person, index, isOwnerRow) {
    var age = person.age || person.ageRange || '';
    var isMinor = !!MINOR_BUCKETS[age];
    var emailField = (!isMinor && !isOwnerRow)
      ? '<input class="ap-roster-email" data-idx="' + index + '" type="email" placeholder="' + escapeHtml((person.name || 'Their') + '’s email, for their waiver link') + '" value="' + escapeHtml(person.email || '') + '" style="flex:2; min-width:180px; border:1px solid rgba(42,71,71,0.18); border-radius:6px; padding:0.6rem 0.7rem; background:var(--sand-beige); color:var(--dark-pine); font-family:inherit; font-size:0.82rem;">'
      : '';
    return '<div class="paf-roster-row">' +
      '<input class="paf-roster-input paf-roster-name" value="' + escapeHtml(person.name || '') + '" disabled>' +
      '<input class="paf-roster-input paf-roster-age" value="' + escapeHtml(age) + '" disabled>' +
      (isMinor ? '<span class="paf-roster-tag">Minor</span>' : '<input class="paf-roster-input paf-roster-fit" value="' + escapeHtml(person.fitness || '') + '" disabled>') +
      (isOwnerRow ? '<span class="paf-roster-tag is-you">You</span>' : emailField) +
      '</div>';
  }

  function renderRoster() {
    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      progressBar(0, 14) +
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
      '<div class="paf-gear-list" id="ap-gear-list"></div>' +
      '</div>' +
      '<div id="ap-roster-error" class="ap-error"></div>' +
      '</div>' +
      '<div class="ap-nav"><button class="ap-nav-prev" id="ap-back">Back</button><button class="ap-nav-next" id="ap-next">Continue</button></div>' +
      '</div></div>'
    );

    function ownerIndex() { return state.participatingRosterRef === '' ? -1 : Number(state.participatingRosterRef); }

    function renderWhoIsYou() {
      var el = wrap.querySelector('#ap-whoisyou-opts');
      el.innerHTML = state.roster.map(function (p, i) {
        var age = p.age || p.ageRange || '';
        var label = (p.name || 'Unnamed') + ' · ' + age + (p.fitness ? ' · ' + p.fitness : '');
        return '<button type="button" class="paf-option-btn' + (ownerIndex() === i ? ' is-selected' : '') + '" data-idx="' + i + '">' + escapeHtml(label) + '</button>';
      }).join('') + '<button type="button" class="paf-option-btn' + (state.participatingRosterRef === 'none' ? ' is-selected' : '') + '" data-idx="none">None of these are me</button>';
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
      Array.prototype.forEach.call(wrap.querySelectorAll('.ap-roster-email'), function (input) {
        input.addEventListener('change', function () {
          var idx = Number(input.getAttribute('data-idx'));
          state.roster[idx].email = input.value.trim();
        });
      });
      renderGearList();
    }

    function renderGearList() {
      wrap.querySelector('#ap-gear-list').innerHTML = state.roster.map(function (p, i) {
        var age = p.age || p.ageRange || '';
        var hasKit = p.gearKit !== false;
        return '<div class="paf-gear-row">' +
          '<div class="paf-gear-row-info"><span class="paf-gear-row-name">' + escapeHtml(p.name || '') + '</span>' +
          (i === ownerIndex() ? '<span class="paf-gear-row-age">You</span>' : (age ? '<span class="paf-gear-row-age">' + escapeHtml(age) + '</span>' : '')) + '</div>' +
          '<div class="paf-gear-toggle">' +
          '<button type="button" class="paf-gear-toggle-btn' + (hasKit ? ' is-selected' : '') + '" data-idx="' + i + '" data-kit="true">Own kit</button>' +
          '<button type="button" class="paf-gear-toggle-btn' + (!hasKit ? ' is-selected' : '') + '" data-idx="' + i + '" data-kit="false">Sharing</button>' +
          '</div></div>';
      }).join('');
      Array.prototype.forEach.call(wrap.querySelectorAll('.paf-gear-toggle-btn'), function (btn) {
        btn.addEventListener('click', function () {
          var idx = Number(btn.getAttribute('data-idx'));
          state.roster[idx].gearKit = btn.getAttribute('data-kit') === 'true';
          renderGearList();
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

    wrap.querySelector('#ap-back').addEventListener('click', function () { state.step = 'landing'; render(); });
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
        state.step = 'preferences';
        render();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Preferences (bestForAttributes, technical comfort, heat comfort)
  // ---------------------------------------------------------------------

  function renderPreferences() {
    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      progressBar(1, 34) +
      '<div class="ap-eyebrow">Trail &amp; Prep</div>' +
      '<h1 class="ap-q">What draws you most on a great day out?</h1>' +
      '<p class="ap-sub">Pick up to 3. This helps us place you on the right trail, not just an available one.</p>' +
      '<div class="ap-card">' +
      '<div class="paf-options paf-options-wrap" id="ap-bfa"></div>' +
      '<div class="paf-roster" style="margin-top:1.8rem;">' +
      '<div class="paf-roster-sub" style="font-weight:600; color:var(--dark-pine); font-size:0.85rem;">How do you feel about technical terrain?</div>' +
      '<div class="paf-options" id="ap-technical"></div>' +
      '</div>' +
      '<div class="paf-roster">' +
      '<div class="paf-roster-sub" style="font-weight:600; color:var(--dark-pine); font-size:0.85rem;">And the desert sun?</div>' +
      '<div class="paf-options" id="ap-heat"></div>' +
      '</div>' +
      '<div id="ap-pref-error" class="ap-error"></div>' +
      '</div>' +
      '<div class="ap-nav"><button class="ap-nav-prev" id="ap-back">Back</button><button class="ap-nav-next" id="ap-next">Continue</button></div>' +
      '</div></div>'
    );

    function renderBfa() {
      wrap.querySelector('#ap-bfa').innerHTML = BEST_FOR_ATTRIBUTES_OPTIONS.map(function (opt) {
        return '<button type="button" class="paf-option-btn' + (state.bestForAttributes.indexOf(opt) !== -1 ? ' is-selected' : '') + '" data-opt="' + escapeHtml(opt) + '">' + escapeHtml(opt) + '</button>';
      }).join('');
      Array.prototype.forEach.call(wrap.querySelectorAll('#ap-bfa button'), function (btn) {
        btn.addEventListener('click', function () {
          var opt = btn.getAttribute('data-opt');
          var idx = state.bestForAttributes.indexOf(opt);
          if (idx !== -1) { state.bestForAttributes.splice(idx, 1); }
          else if (state.bestForAttributes.length < 3) { state.bestForAttributes.push(opt); }
          renderBfa();
        });
      });
    }
    function renderSingleSelect(containerSel, options, currentVal, onPick) {
      var el = wrap.querySelector(containerSel);
      el.innerHTML = options.map(function (opt) {
        return '<button type="button" class="paf-option-btn' + (currentVal === opt.value ? ' is-selected' : '') + '" data-val="' + opt.value + '">' + escapeHtml(opt.label) + '</button>';
      }).join('');
      Array.prototype.forEach.call(el.querySelectorAll('button'), function (btn) {
        btn.addEventListener('click', function () { onPick(btn.getAttribute('data-val')); renderAll(); });
      });
    }
    function renderAll() {
      renderBfa();
      renderSingleSelect('#ap-technical', TECHNICAL_COMFORT_OPTIONS, state.technicalComfort, function (v) { state.technicalComfort = v; });
      renderSingleSelect('#ap-heat', HEAT_COMFORT_OPTIONS, state.heatComfort, function (v) { state.heatComfort = v; });
    }
    renderAll();

    wrap.querySelector('#ap-back').addEventListener('click', function () { state.step = 'roster'; render(); });
    wrap.querySelector('#ap-next').addEventListener('click', function () {
      if (!state.technicalComfort || !state.heatComfort) {
        wrap.querySelector('#ap-pref-error').textContent = 'Answer both questions below to continue.';
        return;
      }
      saveFields({
        bestForAttributes: state.bestForAttributes.join(', '),
        technicalComfort: state.technicalComfort,
        heatComfort: state.heatComfort,
      }).then(function (res) {
        if (!res.ok) { wrap.querySelector('#ap-pref-error').textContent = 'Something went wrong saving that, try again.'; return; }
        state.step = 'trail';
        state.trailAssignmentPhase = 'idle';
        render();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Trail assignment (pacing transition -> reveal grid)
  // ---------------------------------------------------------------------

  function difficultyBadges(candidates) {
    var algo = candidates.filter(function (c) { return c.source !== 'manual_override'; });
    var ratings = algo.map(function (c) { return c.difficultyRating; }).filter(function (n) { return n != null; });
    var min = Math.min.apply(null, ratings), max = Math.max.apply(null, ratings);
    var badges = {};
    algo.forEach(function (c, i) {
      if (i === 0) return; // best-overall-match slot never gets an easier/harder badge
      if (c.difficultyRating === min && min !== max) badges[c.trailId] = 'Easier';
      else if (c.difficultyRating === max && min !== max) badges[c.trailId] = 'Harder';
    });
    return badges;
  }

  function trailCardHtml(candidate, index, isSelected, badges) {
    var isManual = candidate.source === 'manual_override';
    var slotLabel = isManual ? 'Suggested by our team' : (index === 0 ? 'Best overall match' : (badges[candidate.trailId] === 'Easier' ? 'A gentler day' : (badges[candidate.trailId] === 'Harder' ? 'More of a push' : 'Another option')));
    var badge = badges[candidate.trailId];
    var tagsHtml = isManual
      ? '<span class="trail-card-tag is-team-pick">Picked based on your note</span>'
      : ((candidate.matchedAttributes || []).length
        ? candidate.matchedAttributes.map(function (a) { return '<span class="trail-card-tag">' + escapeHtml(a) + '</span>'; }).join('')
        : '<span class="trail-card-tag is-none">No specific match, still a safe fit</span>');
    return '<div class="trail-card' + (isSelected ? ' is-selected' : '') + '">' +
      '<div class="trail-card-photo" style="' + (candidate.photoUrl ? "background-image:url('" + candidate.photoUrl + "');" : '') + '">' +
      '<span class="trail-card-slotlabel">' + escapeHtml(slotLabel) + '</span>' +
      (badge ? '<span class="trail-card-diffbadge ' + (badge === 'Easier' ? 'diff-easier' : 'diff-harder') + '">' + badge + '</span>' : '') +
      '</div>' +
      '<div class="trail-card-body">' +
      '<div class="trail-card-name">' + escapeHtml(candidate.trailName || '') + '</div>' +
      (candidate.overviewCopy ? '<div class="trail-card-overview">' + escapeHtml(candidate.overviewCopy) + '</div>' : '') +
      '<div class="trail-card-tags">' + tagsHtml + '</div>' +
      (candidate.oneTripTip ? '<div class="trail-card-tip">' + escapeHtml(candidate.oneTripTip) + '</div>' : '') +
      '<div class="trail-card-fee">' + (candidate.park ? escapeHtml(candidate.park) + ' entry fee may apply, based on your group and trail day. ' : '') + 'We’ll confirm the exact amount closer to your date.</div>' +
      '<button type="button" class="trail-card-cta' + (isSelected ? ' is-current' : '') + '" data-trail-id="' + escapeHtml(candidate.trailId) + '"' + (isSelected ? ' disabled' : '') + '>' + (isSelected ? 'This is your current pick' : 'Choose this trail') + '</button>' +
      '</div></div>';
  }

  function renderTrail() {
    var ap = state.ctx.adventurePrep || {};
    var wrap = h('<div class="container"><div class="ap-shell">' + progressBar(1, 62) + '<div id="ap-trail-content"></div></div></div>');
    var contentEl = wrap.querySelector('#ap-trail-content');

    function renderPacing() {
      contentEl.innerHTML = '<div class="transition-wrap"><div class="transition-spinner"></div>' +
        '<div class="transition-line">Looking for trails that fit <em>' + escapeHtml((state.bestForAttributes[0] || 'what you’re after').toLowerCase()) + '</em>&hellip;</div></div>';
    }

    function renderReveal(candidates) {
      var selectedId = ap.selectedTrailId;
      var badges = difficultyBadges(candidates);
      var gridClass = candidates.length <= 2 ? 'trail-grid is-thin' : 'trail-grid';
      var picksEcho = state.bestForAttributes.length
        ? '<div class="reveal-picks-echo"><span class="reveal-picks-echo-label">What you told us matters most:</span>' + state.bestForAttributes.map(function (a) { return '<span class="pick-tag">' + escapeHtml(a) + '</span>'; }).join('') + '</div>'
        : '';

      var headline, sub, body;
      if (candidates.length >= 3) {
        headline = 'Here’s where we’re thinking of sending you.';
        sub = 'Trails that fit your group, your date, and what you told us you’re after. Pick the one that feels right, you can always switch before you go.';
        body = picksEcho + '<div class="' + gridClass + '">' + candidates.map(function (c, i) { return trailCardHtml(c, i, c.trailId === selectedId, badges); }).join('') + '</div>' +
          '<p class="reveal-footnote">Not loving what’s here? <a href="mailto:hello@palmspringsadventureclub.com">Tell us what’s not working</a> and we’ll take a closer look, this doesn’t remove your current pick while we do.</p>';
      } else if (candidates.length > 0) {
        headline = 'Here’s what we’ve got so far.';
        sub = 'Your group and date narrowed things down more than usual. We’ve flagged this for a closer look by our team, in the meantime, here’s a strong option already lined up.';
        body = '<div class="thin-grid">' + candidates.map(function (c, i) { return trailCardHtml(c, i, c.trailId === selectedId, badges); }).join('') +
          '<div class="placeholder-wrap" style="display:flex;flex-direction:column;justify-content:center;">' +
          '<div class="placeholder-dots"><div class="placeholder-dot"></div><div class="placeholder-dot"></div><div class="placeholder-dot"></div></div>' +
          '<div class="placeholder-title" style="font-size:1.2rem;">We’re finding you a second option.</div>' +
          '<div class="placeholder-body">Our team is taking a personal look at your group’s day to round out your choices. We’ll let you know the moment there’s more to see, no need to check back.</div>' +
          '</div></div>' +
          '<p class="reveal-footnote">Not loving what’s here either way? <a href="mailto:hello@palmspringsadventureclub.com">Tell us what’s not working</a> and we’ll take another pass.</p>';
      } else {
        headline = null;
      }

      if (!headline) {
        contentEl.innerHTML =
          '<div style="display:flex; justify-content:center;"><div class="placeholder-wrap">' +
          '<div class="placeholder-icon">🧭</div>' +
          '<div class="placeholder-title">We’re building your trail pick personally.</div>' +
          '<div class="placeholder-body">Your group and date turned out to be a genuinely specific combination, so instead of forcing a match, we’ve put this in front of a real person on our team. You’ll hear from us with a trail pick well before your trail day, no action needed from you right now.</div>' +
          '<div class="placeholder-dots"><div class="placeholder-dot"></div><div class="placeholder-dot"></div><div class="placeholder-dot"></div></div>' +
          '<div class="placeholder-sub">Everything else, your gear, your delivery details, is still ready to go in the meantime.</div>' +
          '</div></div>' +
          '<div class="ap-nav" style="justify-content:flex-end; max-width:820px;"><button class="ap-nav-next" id="ap-next">Continue anyway</button></div>';
        contentEl.querySelector('#ap-next').addEventListener('click', function () { state.step = 'planning'; render(); });
        return;
      }

      contentEl.innerHTML =
        '<div class="ap-eyebrow">Your trail</div>' +
        '<h1 class="ap-q">' + headline + '</h1>' +
        '<p class="ap-sub" style="max-width:820px;">' + sub + '</p>' +
        body +
        '<div class="ap-nav" style="justify-content:flex-end; max-width:820px;"><button class="ap-nav-next" id="ap-next"' + (!selectedId ? ' disabled' : '') + '>Continue</button></div>';

      Array.prototype.forEach.call(contentEl.querySelectorAll('.trail-card-cta:not(.is-current)'), function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          apiPost('/api/select-trail', { token: TOKEN, trailId: btn.getAttribute('data-trail-id') }).then(function (res) {
            if (res.ok) {
              ap.selectedTrailId = res.body.selectedTrailId;
              ap.assignmentMethod = res.body.assignmentMethod;
            }
            renderReveal(candidates);
          });
        });
      });
      var nextBtn = contentEl.querySelector('#ap-next');
      if (nextBtn) nextBtn.addEventListener('click', function () { state.step = 'planning'; render(); });
    }

    function loadCandidates() {
      var existing = ap.candidateTrails;
      try { existing = typeof existing === 'string' ? JSON.parse(existing || '[]') : (existing || []); } catch (e) { existing = []; }
      if (existing.length && ap.assignedAt) {
        renderReveal(existing);
        return;
      }
      renderPacing();
      apiPost('/api/run-trail-assignment', { token: TOKEN, operation: ap.assignedAt ? 'refresh' : 'initial' }).then(function (res) {
        if (!res.ok) {
          if (res.body && res.body.status === 'refused') {
            contentEl.innerHTML = '<p class="ap-sub">' + escapeHtml(res.body.message || 'We need to take a closer look at this booking before assigning a trail. Our team has been notified.') + '</p>';
            return;
          }
          contentEl.innerHTML = '<p class="ap-error">Something went wrong finding your trail. Refresh the page to try again, or reply to your confirmation email and we’ll take a look.</p>';
          return;
        }
        ap.candidateTrails = res.body.candidateTrails;
        ap.selectedTrailId = (res.body.candidateTrails.filter(function (c) { return c.source !== 'manual_override'; })[0] || {}).trailId;
        ap.assignedAt = res.body.assignedAt;
        ap.assignmentMethod = res.body.assignmentMethod;
        renderReveal(res.body.candidateTrails);
      });
    }

    loadCandidates();
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Planning details (property, address, delivery window, return pref)
  // ---------------------------------------------------------------------

  function renderPlanning() {
    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      progressBar(1, 76) +
      '<div class="ap-eyebrow">Trail &amp; Prep</div>' +
      '<h1 class="ap-q">Where should your gear go?</h1>' +
      '<p class="ap-sub">We’ll hand-deliver your kit the evening before your trail day.</p>' +
      '<div class="ap-cutoff-note">⏱ Self-service changes to your address, delivery window, and kit lock at <strong>' + formatCutoffLabel() + '</strong>.</div>' +
      '<div class="ap-card">' +
      '<div class="ap-form-row"><label>Where are you staying?</label><div class="paf-options paf-options-wrap" id="ap-property"></div></div>' +
      '<div class="ap-form-row"><label>Delivery address</label><input type="text" id="ap-address" placeholder="Property name or street address, Palm Springs, CA" value="' + escapeHtml(state.deliveryAddressLine1) + '"></div>' +
      '<div class="ap-form-grid">' +
      '<div class="ap-form-row"><label>City</label><input type="text" id="ap-city" value="' + escapeHtml(state.deliveryCity) + '" placeholder="Palm Springs"></div>' +
      '<div class="ap-form-row"><label>ZIP</label><input type="text" id="ap-zip" value="' + escapeHtml(state.deliveryZip) + '" placeholder="92262"></div>' +
      '</div>' +
      '<div class="ap-form-grid">' +
      '<div class="ap-form-row"><label>Delivery window</label><select id="ap-window">' +
      ['3:00pm – 5:00pm', '5:00pm – 7:00pm', '7:00pm – 9:00pm'].map(function (w) { return '<option' + (state.deliveryWindow === w ? ' selected' : '') + '>' + w + '</option>'; }).join('') +
      '</select><div class="ap-helper">Defaults to 7–9pm if you skip this, the quietest window for most front desks.</div></div>' +
      '<div class="ap-form-row"><label>Return preference</label><select id="ap-return">' +
      ['We’ll drop it back off ourselves', 'Please arrange pickup'].map(function (w) { return '<option' + (state.returnPreference === w ? ' selected' : '') + '>' + w + '</option>'; }).join('') +
      '</select></div>' +
      '</div>' +
      '<div id="ap-planning-error" class="ap-error"></div>' +
      '</div>' +
      '<div class="ap-nav"><button class="ap-nav-prev" id="ap-back">Back</button><button class="ap-nav-next" id="ap-next">Continue</button></div>' +
      '</div></div>'
    );

    function renderPropertyOpts() {
      var opts = ['Hotel / resort', 'Vacation rental (Airbnb/VRBO)', 'Private residence'];
      wrap.querySelector('#ap-property').innerHTML = opts.map(function (o) {
        return '<button type="button" class="paf-option-btn' + (state.propertyType === o ? ' is-selected' : '') + '" data-val="' + escapeHtml(o) + '">' + o + '</button>';
      }).join('');
      Array.prototype.forEach.call(wrap.querySelectorAll('#ap-property button'), function (btn) {
        btn.addEventListener('click', function () { state.propertyType = btn.getAttribute('data-val'); renderPropertyOpts(); });
      });
    }
    renderPropertyOpts();

    wrap.querySelector('#ap-back').addEventListener('click', function () { state.step = 'trail'; render(); });
    wrap.querySelector('#ap-next').addEventListener('click', function () {
      state.deliveryAddressLine1 = wrap.querySelector('#ap-address').value.trim();
      state.deliveryCity = wrap.querySelector('#ap-city').value.trim();
      state.deliveryZip = wrap.querySelector('#ap-zip').value.trim();
      state.deliveryWindow = wrap.querySelector('#ap-window').value;
      state.returnPreference = wrap.querySelector('#ap-return').value;
      if (!state.propertyType || !state.deliveryAddressLine1) {
        wrap.querySelector('#ap-planning-error').textContent = 'Let us know where you’re staying and your delivery address.';
        return;
      }
      // deliveryAddressValidated is always false from this build — real
      // address validation (Google Places or similar) is Operations UX's
      // own future work, not built here. This intentionally degrades into
      // that PRD's own already-designed "soft-fail, staff review" path
      // rather than inventing validation logic in this chat's scope.
      saveFields({
        propertyType: state.propertyType,
        deliveryAddressLine1: state.deliveryAddressLine1,
        deliveryCity: state.deliveryCity,
        deliveryState: 'CA',
        deliveryZip: state.deliveryZip,
        deliveryAddressRaw: [state.deliveryAddressLine1, state.deliveryCity, 'CA', state.deliveryZip].filter(Boolean).join(', '),
        deliveryAddressValidated: false,
        deliveryWindow: state.deliveryWindow,
        returnPreference: state.returnPreference,
      }).then(function (res) {
        if (!res.ok) { wrap.querySelector('#ap-planning-error').textContent = 'Something went wrong saving that, try again.'; return; }
        state.step = 'deposit';
        render();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Light deposit reminder (interstitial, no data written)
  // ---------------------------------------------------------------------

  function renderDeposit() {
    var eb = state.ctx.experienceBooking;
    var depositAmount = eb.tier === 'p2p' ? 100 : 65;
    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      progressBar(2, 84) +
      '<div class="ap-card" style="text-align:center; max-width:520px; margin:0 auto;">' +
      '<div class="paf-deposit-card" style="text-align:left; margin-bottom:1.6rem;">' +
      'One more thing: the $' + depositAmount + ' refundable gear deposit hold we mentioned at booking gets placed on your card the day before your trail day, not now. We’ll let you know right before it happens.' +
      '</div>' +
      '<button class="ap-nav-next" id="ap-continue">Got it, continue</button>' +
      '</div></div></div>'
    );
    wrap.querySelector('#ap-continue').addEventListener('click', function () { state.step = 'waiver'; render(); });
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Waiver + guardian certification + optional emergency contact
  // ---------------------------------------------------------------------

  function renderWaiver() {
    var minors = state.roster.filter(function (p) { return MINOR_BUCKETS[p.age || p.ageRange]; });
    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      progressBar(2, 92) +
      '<div class="ap-eyebrow">Your Kit</div>' +
      '<h1 class="ap-q">Last thing before your gear is booked in: your waiver</h1>' +
      '<div class="ap-cutoff-note">⏱ Waivers lock at <strong>' + formatCutoffLabel() + '</strong>. A kit without a signed waiver by then gets removed and refunded automatically.</div>' +
      '<div class="ap-card">' +
      '<div class="ap-form-row" style="background:var(--sand-beige); border-radius:8px; padding:1rem 1.2rem; max-height:120px; overflow-y:auto; font-size:0.78rem; color:rgba(42,71,71,0.7); line-height:1.7;">' +
      '<strong>Release of Liability, Assumption of Risk, and Indemnification Agreement (v1.4)</strong><br>' +
      'I understand that trekking and outdoor recreation involve inherent risks, including but not limited to uneven terrain, wildlife, weather, and remote locations with limited emergency access. I voluntarily assume all such risks on behalf of myself and anyone I am certifying for below.' +
      '</div>' +
      '<div class="ap-form-row"><label>Type your full legal name to sign</label><input type="text" id="ap-waiver-name" placeholder="Full legal name" value="' + escapeHtml(state.waiverName) + '"></div>' +
      '<label class="paf-sms-consent"><input type="checkbox" id="ap-waiver-agree"' + (state.waiverAgreed ? ' checked' : '') + '><span>I have read, understand, and agree to this Release of Liability.</span></label>' +
      (minors.length ? minors.map(function (m, i) {
        return '<div class="paf-roster" style="margin-top:1.4rem;">' +
          '<div class="paf-roster-sub" style="font-weight:600; color:var(--dark-pine); font-size:0.85rem;">You have a minor on this booking: ' + escapeHtml(m.name || '') + ' (' + escapeHtml(m.age || m.ageRange || '') + ')</div>' +
          '<label class="paf-sms-consent"><input type="checkbox" class="ap-guardian-cb" data-name="' + escapeHtml(m.name || '') + '"' + (state.guardianForChildren.indexOf(m.name) !== -1 ? ' checked' : '') + '>' +
          '<span>I am the parent or legal guardian of ' + escapeHtml(m.name || 'this child') + ', named above, or have their parent or guardian’s authorization, and I am signing on their behalf.</span></label>' +
          '</div>';
      }).join('') : '') +
      '<div class="paf-roster" style="margin-top:1.4rem;">' +
      '<div class="paf-roster-sub" style="font-weight:600; color:var(--dark-pine); font-size:0.85rem;">Optional: an emergency contact for you specifically</div>' +
      '<div class="ap-form-grid">' +
      '<div class="ap-form-row"><label>Name</label><input type="text" id="ap-ec-name" placeholder="Optional" value="' + escapeHtml(state.ecName) + '"></div>' +
      '<div class="ap-form-row"><label>Phone</label><input type="text" id="ap-ec-phone" placeholder="Optional" value="' + escapeHtml(state.ecPhone) + '"></div>' +
      '</div>' +
      '<div class="ap-helper">Just for you, not the group, each person on the trail can add their own.</div>' +
      '</div>' +
      '<div id="ap-waiver-error" class="ap-error"></div>' +
      '</div>' +
      '<div class="ap-nav"><button class="ap-nav-prev" id="ap-back">Back</button><button class="ap-nav-next" id="ap-next">Continue</button></div>' +
      '</div></div>'
    );

    Array.prototype.forEach.call(wrap.querySelectorAll('.ap-guardian-cb'), function (cb) {
      cb.addEventListener('change', function () {
        var name = cb.getAttribute('data-name');
        var idx = state.guardianForChildren.indexOf(name);
        if (cb.checked && idx === -1) state.guardianForChildren.push(name);
        else if (!cb.checked && idx !== -1) state.guardianForChildren.splice(idx, 1);
      });
    });

    wrap.querySelector('#ap-back').addEventListener('click', function () { state.step = 'deposit'; render(); });
    wrap.querySelector('#ap-next').addEventListener('click', function () {
      state.waiverName = wrap.querySelector('#ap-waiver-name').value.trim();
      state.waiverAgreed = wrap.querySelector('#ap-waiver-agree').checked;
      state.ecName = wrap.querySelector('#ap-ec-name').value.trim();
      state.ecPhone = wrap.querySelector('#ap-ec-phone').value.trim();
      if (!state.waiverName || !state.waiverAgreed) {
        wrap.querySelector('#ap-waiver-error').textContent = 'Type your full legal name and agree to the release to continue.';
        return;
      }
      var participantsCovered = [state.waiverName].concat(state.guardianForChildren);
      apiPost('/api/save-waiver-signature', {
        token: TOKEN,
        signerName: state.waiverName,
        signerEmail: state.ctx.experienceBooking.contactEmail,
        isGuardian: state.guardianForChildren.length > 0,
        guardianForChildren: state.guardianForChildren,
        participantsCovered: participantsCovered,
      }).then(function (res) {
        if (!res.ok) { wrap.querySelector('#ap-waiver-error').textContent = 'Something went wrong saving your signature, try again.'; return; }
        var ecDone = state.ecName || state.ecPhone
          ? apiPost('/api/save-emergency-contact', { token: TOKEN, contactName: state.ecName, contactPhone: state.ecPhone })
          : Promise.resolve({ ok: true });
        ecDone.then(function () {
          state.step = 'review';
          render();
        });
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Review & send
  // ---------------------------------------------------------------------

  function renderReview() {
    var eb = state.ctx.experienceBooking;
    var ap = state.ctx.adventurePrep || {};
    var ownerIdx = state.participatingRosterRef === '' ? -1 : Number(state.participatingRosterRef);
    var signers = state.roster.filter(function (p, i) {
      var age = p.age || p.ageRange || '';
      return i !== ownerIdx && !MINOR_BUCKETS[age];
    });
    var missingEmail = signers.filter(function (p) { return !p.email; });
    var kitCount = state.roster.filter(function (p) { return p.gearKit !== false; }).length;
    var candidateTrails = ap.candidateTrails;
    try { candidateTrails = typeof candidateTrails === 'string' ? JSON.parse(candidateTrails || '[]') : (candidateTrails || []); } catch (e) { candidateTrails = []; }
    var selectedTrail = candidateTrails.filter(function (c) { return c.trailId === ap.selectedTrailId; })[0];
    var trailNameDisplay = selectedTrail ? selectedTrail.trailName : 'To be confirmed';

    var wrap = h(
      '<div class="container"><div class="ap-shell">' +
      progressBar(2, 96) +
      '<div class="ap-eyebrow">Your Kit</div>' +
      '<h1 class="ap-q">Take one last look before we reach out to the rest of your group</h1>' +
      '<div class="ap-card">' +
      '<div class="paf-roster-sub" style="font-weight:600; color:var(--dark-pine); font-size:0.85rem; margin-bottom:0.7rem;">Here’s who we’re reaching out to</div>' +
      (signers.length
        ? signers.map(function (s) {
          return '<div class="review-recipient"><div><div class="review-recipient-name">' + escapeHtml(s.name || '') + '</div><div class="review-recipient-email">' + escapeHtml(s.email || 'no email on file yet') + '</div></div><span class="review-recipient-tag">Waiver link</span></div>';
        }).join('')
        : '<p class="ap-helper">No one else on this booking needs their own waiver link.</p>') +
      '<div class="ap-helper" style="margin-bottom:1.4rem;">Any minors on this booking are already covered by your guardian certification, they won’t get their own link.</div>' +
      '<div class="paf-roster-sub" style="font-weight:600; color:var(--dark-pine); font-size:0.85rem; margin-bottom:0.5rem;">Quick recap</div>' +
      '<div class="review-row"><span class="review-row-label">Trail day</span><span class="review-row-value">' + formatTripDate(eb.date) + '</span></div>' +
      '<div class="review-row"><span class="review-row-label">Trail</span><span class="review-row-value">' + escapeHtml(trailNameDisplay) + '</span></div>' +
      '<div class="review-row"><span class="review-row-label">Gear kits</span><span class="review-row-value">' + kitCount + '</span></div>' +
      '<div class="review-row"><span class="review-row-label">Delivery</span><span class="review-row-value">' + escapeHtml(state.deliveryWindow) + '</span></div>' +
      '<div class="review-row"><span class="review-row-label">Your waiver</span><span class="review-row-value">Signed</span></div>' +
      (missingEmail.length ? '<div class="ap-error" style="margin-top:1rem;">Add an email for ' + missingEmail.map(function (p) { return escapeHtml(p.name || 'this person'); }).join(', ') + ' before sending, they need it for their own waiver link. <a href="#" id="ap-back-to-roster" style="color:var(--mountain-pink);">Go back and add it</a></div>' : '') +
      '<div id="ap-review-error" class="ap-error"></div>' +
      '<button class="ap-nav-next" id="ap-confirm-send" style="width:100%; margin-top:1.6rem; padding:1rem;"' + (missingEmail.length ? ' disabled' : '') + '>Confirm &amp; Send</button>' +
      '</div>' +
      '</div></div>'
    );

    var backLink = wrap.querySelector('#ap-back-to-roster');
    if (backLink) backLink.addEventListener('click', function (e) { e.preventDefault(); state.step = 'roster'; render(); });

    wrap.querySelector('#ap-confirm-send').addEventListener('click', function (e) {
      e.target.disabled = true;
      apiPost('/api/send-signer-links', {
        token: TOKEN,
        signers: signers.map(function (s, i) { return { rosterRef: String(state.roster.indexOf(s)), name: s.name, email: s.email }; }),
      }).then(function (res) {
        if (!res.ok) {
          wrap.querySelector('#ap-review-error').textContent = 'Something went wrong sending those links, try again.';
          e.target.disabled = false;
          return;
        }
        state.lastSignerSummary = res.body.signers;
        state.step = 'done';
        render();
      });
    });

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Step: Done
  // ---------------------------------------------------------------------

  function renderDone() {
    var signers = state.lastSignerSummary || [];
    var body = signers.length
      ? signers.map(function (s) { return s.name; }).join(' and ') + '’s waiver link' + (signers.length > 1 ? 's are' : ' is') + ' on ' + (signers.length > 1 ? 'their' : 'its') + ' way.'
      : 'Everything’s in for now.';
    var wrap = h(
      '<div class="container"><div class="ap-shell" style="padding-top:0;">' +
      '<div class="done-wrap">' +
      '<div class="done-badge"><svg viewBox="0 0 24 24" fill="none" width="26" height="26"><path d="M5 12.5L9.5 17L19 7" stroke="#4a9d68" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
      '<h1 class="done-headline">You’re all set for now</h1>' +
      '<p class="done-body">' + escapeHtml(body) + ' We’ll let you know as things move along, and you’re always welcome back at this same link, nothing to remember, nothing to log in with.</p>' +
      '</div></div></div>'
    );
    return wrap;
  }

  boot();
})();
