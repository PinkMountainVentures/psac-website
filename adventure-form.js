/* ============================================
   PSAC: Plan Your Day (custom intake flow)
   Replaces the JotForm modal. Vanilla JS, no deps.
   ============================================ */

(function () {

  // ── CONFIG ──────────────────────────────────────
  // Booking persistence goes through /api/save-booking (server-side proxy
  // to the Apps Script Web App bound to the Bookings & Operations sheet).
  // See api/save-booking.js. No client-side endpoint URL needed here.

  // Stripe publishable key: safe to expose client-side (it can only
  // create charges against the PaymentIntent our server creates, never
  // move money on its own). Get this from the Stripe Dashboard →
  // Developers → API keys. The matching *secret* key must never appear
  // in this file. It lives only in the STRIPE_SECRET_KEY environment
  // variable read by api/create-payment-intent.js.
  var STRIPE_PUBLISHABLE_KEY = "pk_test_51TybOaPXYXpja2zMN06eY38zPQz7gtuqeY2fRrGmCc0nUNS3AH6fa4sZCs0sbxBOwBQLBOTFYBRRFaJcXpompn9l00ArdCLihA";

  // Card element theming to match brand tokens in styles.css.
  var STRIPE_APPEARANCE = {
    theme: 'stripe',
    variables: {
      colorPrimary: '#2A4747',
      colorText: '#2A4747',
      colorDanger: '#E76F51',
      fontFamily: 'Montserrat, sans-serif',
      borderRadius: '8px'
    }
  };

  var stripeInstance = null;
  var stripeElementsInstance = null;

  function getStripe() {
    if (!stripeInstance && window.Stripe) {
      stripeInstance = window.Stripe(STRIPE_PUBLISHABLE_KEY);
    }
    return stripeInstance;
  }

  var TIERS = {
    trail:  { key: 'trail',  name: 'Trail Guide Experience',    booking: 100, gear: 65 },
    p2p:    { key: 'p2p',    name: 'Peaks to Pools Experience', booking: 195, gear: 100 },
    custom: { key: 'custom', name: 'Custom Experience',         booking: 595, gear: 100 }
  };

  // Multi-day trips route to a personal email inquiry instead of instant
  // checkout (see cardDuration() and showCustomContactOverlay() below).
  var CUSTOM_CONTACT_EMAIL = 'hello@palmspringsadventureclub.com';

  // Recorded per booking alongside the policy-agreement checkbox on the
  // pricing screen, so it's provable exactly which version of each policy
  // a given guest agreed to, not just "the policy" as of whenever a
  // question comes up later. Must be updated in lockstep by hand: any time
  // refund-policy.html, terms.html, or privacy.html's text changes, bump
  // its "Last updated" date in that page's <p class="legal-updated"> line
  // and the matching value here, together, in the same edit.
  var POLICY_VERSIONS = {
    refund: '2026-07-29',
    terms: '2026-07-29',
    privacy: '2026-07-29'
  };

  // Copy shown next to the SMS opt-in checkbox on the contact info step,
  // split into a label (the affirmative consent statement) and a fine
  // print line (frequency/rates/HELP-STOP disclosures), matching what
  // Twilio's A2P 10DLC web-form opt-in requirements call for: a consent
  // statement, message-frequency disclosure, rate disclaimer, HELP and
  // STOP instructions, and links to Terms of Service and Privacy Policy.
  // Revised a second time, Aug 2026, after Twilio's campaign-registration
  // review flagged the first revision's wording as not explicit enough:
  // it didn't literally say "text messages from [business]," and didn't
  // state plainly that opting in is optional and not required to book
  // (both were already true in isValid() below, which never checks this
  // field, the copy just didn't say so). This version says both
  // explicitly rather than leaving either implied. Defined once here and
  // reused for both the on-screen label/fine print and buildPayload()'s
  // contact.smsConsentText, so the stored text is guaranteed to match
  // what the guest actually saw, not a copy that can drift out of sync
  // with the UI if this ever gets reworded.
  var SMS_CONSENT_LABEL = 'Yes, send me text messages from Palm Springs Adventure Club about my reservation, delivery, and deposit.';
  var SMS_CONSENT_FINEPRINT = 'Optional, not required to book. Message frequency varies by reservation. Message and data rates may apply. Reply STOP to cancel, HELP for help.';
  var SMS_CONSENT_TEXT = SMS_CONSENT_LABEL + ' ' + SMS_CONSENT_FINEPRINT + ' See Terms of Service and Privacy Policy at palmspringsadventureclub.com.';

  // Gear delivery is evening-before-only, no morning-of delivery. Working
  // backward from that (see psac-gear-delivery-timing-for-booking-flow.md):
  // guest's delivery address is due T-3, which leaves a T-2 buffer day for
  // trail assignment and courier pre-scheduling before checkout and delivery
  // on T-1. A hike booked with less notice than this collapses that buffer,
  // so the date picker in cardDateTime() below floors selectable dates at
  // today + this many days instead of just blocking dates before today.
  var MIN_BOOKING_LEAD_DAYS = 3;

  // "What You're After" (id: 'after') and "After the Trail" (id: 'trail') are
  // both removed: their only cards (cardInterests() and the q12 cardStitch(),
  // see the comments in buildCards() below) are no longer in the active flow,
  // so these sections would never highlight and just sit dead in the progress
  // bar. Restore an entry alongside re-adding its card if either ever moves
  // back into Start My Adventure.
  var SECTIONS = [
    { id: 'adventure', name: 'Your Adventure' },
    { id: 'move',       name: 'How You Move' },
    { id: 'kit',         name: 'Your Kit' }
  ];

  var Q1_STARTERS = [
    "I need a day that's just mine",
    "We're celebrating",
    "I've been wanting to do this and I finally",
    "I want to push myself",
    "I'm showing someone I love this place",
    "I just need to be outside and"
  ];

  var Q12_STARTERS = [
    "Completely emptied out and",
    "Like I earned something",
    "Relaxed and",
    "Proud that I",
    "Ready to"
  ];

  // ── STATE ────────────────────────────────────────
  var state = {
    step: 0,
    answers: {
      q1: null,            // { starter, text }
      q2_roster: [],         // [{ name, age, fitness }], length = chosen party size
      q3_date: '',
      q3_time: null,
      q5: [],
      q6: null,
      q8: [],
      q12: null,
      q13: [],
      q14: null,
      dietary: [],
      include_after_trail: false,  // forced off for launch: Trail Guide (trail-only) is the only
                                    // experience offered, so there's nothing to opt out of. The
                                    // toggle logic (setIncludeAfterTrail / renderAfterTrailToggle,
                                    // both in cardRecap below) stays defined, unused, for when
                                    // Peaks to Pools relaunches and this becomes a real choice again.
      contact_name: '',
      contact_email: '',
      contact_phone: '',
      contact_sms_consent: false,
      policiesAgreed: false,
      tier: 'trail',
      rating: null,
      paymentIntentId: null,
      paymentStatus: null,
      depositPaymentIntentId: null,
      depositStatus: null,
      personId: null,
      bookingId: null
    }
  };

  // ── CARD DEFINITIONS ─────────────────────────────
  // Each card renders itself and validates itself. Kept data-light and
  // function-heavy on purpose so the whole flow lives in one file.
  var cards = [];

  function buildCards() {
    cards = [
      cardStitch('q1', 'adventure', "What's bringing you out?", Q1_STARTERS, true,
        "We'll use this to help pick the right trail for the occasion. Just a few quick questions, then we'll build your route and gear so you're ready to go."),
      cardWho(),
      cardDateTime(),
      cardMultiselect('q5', 'move', 'What activity are you planning?', [
        'Hiking', 'Trail running'
      ], null, true),
      cardDuration(),
      // cardTextarea('q7', 'move', 'Anything else we should know to make this day exactly right?',
      //  'Physical considerations, special requests, anything at all. Nothing medical required, just what\'s useful for building your day and matching you to the right experience.',
      //  'Bad knee on descents, prefer no scrambling, celebrating a milestone, anything like that.', false),
      // cardInterests() removed from the active flow ("What draws you most on
      // a great day out?"). Still an important signal for trail selection, but
      // it's moving to the post-booking experience instead, captured after
      // payment rather than blocking the initial reservation. The function
      // stays defined below, unused, as reference for that workstream.
      // The q12 cardStitch() below ("At the end of this day, I want to feel")
      // is removed from the active flow: it feels clunky here and doesn't add
      // much to the experience. Moving to the post-booking experience instead.
      // Original call, kept for reference:
      // cardStitch('q12', 'trail', 'At the end of this day, I want to feel', Q12_STARTERS, true, null,
      //   "Now let's talk about the other half of your day."),
      // cardRecoveryPreferences() removed from the active flow (recovery look-like,
      // recovery taste, dietary preferences). That question set is moving to the
      // post-booking experience instead. The function itself is left defined
      // below, unused, as the reference copy for whoever builds that post-booking
      // flow. Between this, cardInterests(), and q12 above, Start My Adventure is
      // down from its original 14 steps to 11.
      cardGearList(),
      cardContact(),
      cardRecap(),
      cardPricing(),
      cardClosing()
    ];
  }

  // ── CARD BUILDERS ────────────────────────────────

  function cardShell(section, required) {
    return { section: section, required: !!required };
  }

  function cardStitch(id, section, text, starters, required, subtext, transitionLine) {
    var c = cardShell(section, required);
    c.render = function (root) {
      var html = '';
      if (transitionLine) html += '<div class="paf-transition">' + esc(transitionLine) + '</div>';
      html += '<div class="paf-q">' + (required ? '<span class="paf-req">*</span> ' : '') + esc(text) + '</div>';
      if (subtext) html += '<div class="paf-sub">' + esc(subtext) + '</div>';
      html += '<div class="paf-starters" data-field="' + id + '_starters"></div>';
      html += '<div class="paf-stitch-line"><span class="paf-stitch-prefix" data-field="' + id + '_prefix">Pick a line above to begin your sentence</span>' +
        '<textarea rows="1" class="paf-stitch-input" data-field="' + id + '_text" placeholder="keep typing…" style="display:none;"></textarea></div>';
      root.innerHTML = html;

      var starterWrap = root.querySelector('[data-field="' + id + '_starters"]');
      var prefixEl = root.querySelector('[data-field="' + id + '_prefix"]');
      var inputEl = root.querySelector('[data-field="' + id + '_text"]');
      var current = state.answers[id];

      // Textarea substitutes for a plain <input> so a long continuation
      // wraps onto multiple lines instead of scrolling sideways (where it
      // used to hide the start of what someone typed). Height grows with
      // content; Enter is swallowed so it stays one flowing thought
      // instead of turning into line breaks.
      function autoGrow() {
        inputEl.style.height = 'auto';
        inputEl.style.height = inputEl.scrollHeight + 'px';
      }
      inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') e.preventDefault();
      });

      starters.forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'paf-starter-btn';
        b.textContent = s;
        if (current && current.starter === s) b.classList.add('is-selected');
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(starterWrap.children, function (c2) { c2.classList.remove('is-selected'); });
          b.classList.add('is-selected');
          state.answers[id] = { starter: s, text: (state.answers[id] && state.answers[id].text) || '' };
          prefixEl.textContent = s + ' ';
          prefixEl.classList.add('is-active');
          inputEl.style.display = 'block';
          inputEl.value = state.answers[id].text;
          autoGrow();
          inputEl.focus();
          refreshNav();
        });
        starterWrap.appendChild(b);
      });

      if (current) {
        prefixEl.textContent = current.starter + ' ';
        prefixEl.classList.add('is-active');
        inputEl.style.display = 'block';
        inputEl.value = current.text || '';
        autoGrow();
      }

      inputEl.addEventListener('input', function () {
        if (!state.answers[id]) return;
        state.answers[id].text = inputEl.value;
        autoGrow();
      });
    };
    c.isValid = function () { return !required || !!(state.answers[id] && state.answers[id].starter); };
    return c;
  }

  var MAX_PARTY_SIZE = 12;

  function cardWho() {
    var c = cardShell('adventure', true);
    c.render = function (root) {
      var html = '<div class="paf-q"><span class="paf-req">*</span> Who\'s coming?</div>';
      html += '<div class="paf-sub">How many people, including you?</div>';
      html += '<select class="paf-headcount-select" data-field="headcount"></select>';
      html += '<div class="paf-roster" data-field="roster" style="display:none;">' +
        '<div class="paf-roster-sub">Tell us a little about who\'s coming, including name, age range, and fitness level.</div>' +
        '<div class="paf-roster-rows" data-field="roster_rows"></div>' +
        '</div>';
      root.innerHTML = html;

      var headcountSelect = root.querySelector('[data-field="headcount"]');
      var rosterWrap = root.querySelector('[data-field="roster"]');
      var rowsWrap = root.querySelector('[data-field="roster_rows"]');

      var placeholderOpt = document.createElement('option');
      placeholderOpt.textContent = 'Select';
      placeholderOpt.value = '';
      headcountSelect.appendChild(placeholderOpt);
      for (var n = 1; n <= MAX_PARTY_SIZE; n++) {
        var countOpt = document.createElement('option');
        countOpt.textContent = n === 1 ? '1 person' : (n + ' people');
        countOpt.value = String(n);
        headcountSelect.appendChild(countOpt);
      }

      function addRow(prefill) {
        var row = document.createElement('div');
        row.className = 'paf-roster-row';
        var name = document.createElement('input');
        name.type = 'text'; name.placeholder = 'Name'; name.className = 'paf-roster-input paf-roster-name';
        var age = document.createElement('select');
        age.className = 'paf-roster-input paf-roster-age';
        ['Age range', 'Under 14', '14–17', '18–24', '25–34', '35–44', '45–54', '55–64', '65+'].forEach(function (o, i) {
          var opt = document.createElement('option');
          opt.textContent = o;
          opt.value = i === 0 ? '' : o;
          age.appendChild(opt);
        });
        var fit = document.createElement('select');
        fit.className = 'paf-roster-input paf-roster-fit';
        ['Fitness level', 'Easygoing pace', 'Comfortable hiker', 'Strong / experienced'].forEach(function (o, i) {
          var opt = document.createElement('option');
          opt.textContent = o;
          opt.value = i === 0 ? '' : o;
          fit.appendChild(opt);
        });

        // Gear kit inclusion is decided later, on the "Your Kit" step. It
        // lives on this same roster object, so we carry it forward via
        // closure rather than re-reading state (which gets wiped and
        // rebuilt from scratch every time this card re-renders).
        var gearKit = prefill ? prefill.gearKit : undefined;

        if (prefill) {
          name.value = prefill.name || '';
          if (prefill.age) age.value = prefill.age;
          if (prefill.fitness) fit.value = prefill.fitness;
        }

        function sync() {
          var data = { name: name.value, age: age.value, fitness: fit.value, gearKit: gearKit };
          row._data = data;
          var idx = Array.prototype.indexOf.call(rowsWrap.children, row);
          state.answers.q2_roster[idx] = data;
          refreshNav();
        }
        name.addEventListener('input', sync);
        age.addEventListener('change', sync);
        fit.addEventListener('change', sync);

        row.appendChild(name); row.appendChild(age); row.appendChild(fit);
        rowsWrap.appendChild(row);
        sync();
      }

      // Rebuilds the roster rows to match the chosen headcount, keeping
      // whatever was already typed for the people who still fit (e.g.
      // dropping from 4 to 2 keeps the first 2 rows' data rather than
      // discarding everything) and adding blank rows for the rest.
      function syncRowsToCount(count) {
        var existing = state.answers.q2_roster.slice(0, count);
        rowsWrap.innerHTML = '';
        state.answers.q2_roster = [];
        for (var i = 0; i < count; i++) {
          addRow(existing[i] || null);
        }
      }

      headcountSelect.addEventListener('change', function () {
        var count = parseInt(headcountSelect.value, 10) || 0;
        if (!count) {
          rosterWrap.style.display = 'none';
          rowsWrap.innerHTML = '';
          state.answers.q2_roster = [];
          refreshNav();
          return;
        }
        rosterWrap.style.display = 'block';
        syncRowsToCount(count);
        refreshNav();
      });

      if (state.answers.q2_roster.length) {
        headcountSelect.value = String(Math.min(state.answers.q2_roster.length, MAX_PARTY_SIZE));
        rosterWrap.style.display = 'block';
        var existing = state.answers.q2_roster.slice();
        state.answers.q2_roster = [];
        existing.forEach(function (p) { addRow(p); });
      }
    };
    c.isValid = function () {
      var roster = state.answers.q2_roster;
      if (!roster.length) return false;
      return roster.every(function (p) {
        return !!(p && p.name && p.name.trim() && p.age && p.fitness);
      });
    };
    return c;
  }

  function cardDateTime() {
    var c = cardShell('adventure', true);
    var TIMES = ['Early start (before 8am)', 'Morning (8am – 10am)', 'Mid-Morning (after 10am)', 'Flexible'];
    var outsideClickHandler = null;

    function pad2(n) { return n < 10 ? '0' + n : String(n); }
    function toISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function fromISO(iso) {
      var parts = iso.split('-');
      return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }
    function formatDisplay(iso) {
      return fromISO(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }

    c.render = function (root) {
      var html = '<div class="paf-q"><span class="paf-req">*</span> When are you going?</div>';
      html += '<div class="paf-date-picker" data-field="date-picker">';
      html += '<button type="button" class="paf-date-trigger' + (state.answers.q3_date ? '' : ' is-placeholder') + '" data-field="date-trigger">' +
        (state.answers.q3_date ? esc(formatDisplay(state.answers.q3_date)) : 'Select a date') + '</button>';
      html += '<div class="paf-calendar" data-field="calendar" style="display:none;"></div>';
      html += '</div>';
      html += '<div class="paf-time-note">Bookings need at least ' + MIN_BOOKING_LEAD_DAYS + ' days\' notice so we can arrange gear delivery.</div>';
      html += '<div class="paf-sub" style="margin-top:1.5rem;">Time preference</div>';
      html += '<div class="paf-options" data-field="time"></div>';
      html += '<div class="paf-time-note">Starting after 12pm is not recommended due to heat.</div>';
      root.innerHTML = html;

      var pickerWrap = root.querySelector('[data-field="date-picker"]');
      var trigger = root.querySelector('[data-field="date-trigger"]');
      var calendarEl = root.querySelector('[data-field="calendar"]');

      var today = new Date();
      today.setHours(0, 0, 0, 0);
      var minDate = new Date(today);
      minDate.setDate(minDate.getDate() + MIN_BOOKING_LEAD_DAYS);
      var viewDate = state.answers.q3_date ? fromISO(state.answers.q3_date) : new Date(minDate);
      viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);

      function renderCalendar() {
        var year = viewDate.getFullYear();
        var month = viewDate.getMonth();
        var monthLabel = viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        var startWeekday = new Date(year, month, 1).getDay();
        var daysInMonth = new Date(year, month + 1, 0).getDate();

        var h = '<div class="paf-cal-header">' +
          '<button type="button" class="paf-cal-nav" data-nav="prev">&#8249;</button>' +
          '<span class="paf-cal-month">' + esc(monthLabel) + '</span>' +
          '<button type="button" class="paf-cal-nav" data-nav="next">&#8250;</button>' +
          '</div>';
        h += '<div class="paf-cal-weekdays">';
        ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(function (d) { h += '<span>' + d + '</span>'; });
        h += '</div>';
        h += '<div class="paf-cal-days">';
        for (var i = 0; i < startWeekday; i++) h += '<span class="paf-cal-day is-empty"></span>';
        for (var day = 1; day <= daysInMonth; day++) {
          var thisDate = new Date(year, month, day);
          var iso = toISO(thisDate);
          // Disabled if it's in the past OR inside the gear-delivery lead
          // time (today through today + MIN_BOOKING_LEAD_DAYS - 1), not just
          // strictly before today. See MIN_BOOKING_LEAD_DAYS above.
          var isDisabled = thisDate < minDate;
          var isSelected = state.answers.q3_date === iso;
          var cls = 'paf-cal-day' + (isDisabled ? ' is-disabled' : '') + (isSelected ? ' is-selected' : '');
          h += '<button type="button" class="' + cls + '" data-date="' + iso + '"' + (isDisabled ? ' disabled' : '') + '>' + day + '</button>';
        }
        h += '</div>';
        calendarEl.innerHTML = h;

        calendarEl.querySelector('[data-nav="prev"]').addEventListener('click', function (e) {
          e.stopPropagation();
          viewDate.setMonth(viewDate.getMonth() - 1);
          renderCalendar();
        });
        calendarEl.querySelector('[data-nav="next"]').addEventListener('click', function (e) {
          e.stopPropagation();
          viewDate.setMonth(viewDate.getMonth() + 1);
          renderCalendar();
        });
        Array.prototype.forEach.call(calendarEl.querySelectorAll('.paf-cal-day[data-date]'), function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var iso = btn.getAttribute('data-date');
            state.answers.q3_date = iso;
            trigger.textContent = formatDisplay(iso);
            trigger.classList.remove('is-placeholder');
            calendarEl.style.display = 'none';
            refreshNav();
          });
        });
      }

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var willOpen = calendarEl.style.display === 'none';
        if (willOpen) {
          renderCalendar();
        }
        calendarEl.style.display = willOpen ? 'block' : 'none';
      });

      if (outsideClickHandler) document.removeEventListener('click', outsideClickHandler);
      outsideClickHandler = function (e) {
        if (!pickerWrap.contains(e.target)) calendarEl.style.display = 'none';
      };
      document.addEventListener('click', outsideClickHandler);

      var timeWrap = root.querySelector('[data-field="time"]');
      TIMES.forEach(function (t) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'paf-option-btn';
        b.textContent = t;
        if (state.answers.q3_time === t) b.classList.add('is-selected');
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(timeWrap.children, function (c2) { c2.classList.remove('is-selected'); });
          b.classList.add('is-selected');
          state.answers.q3_time = t;
          refreshNav();
        });
        timeWrap.appendChild(b);
      });
    };
    c.isValid = function () { return !!state.answers.q3_date && !!state.answers.q3_time; };
    return c;
  }

  function cardTextarea(id, section, text, subtext, placeholder, required) {
    var c = cardShell(section, required);
    c.render = function (root) {
      var html = '<div class="paf-q">' + (required ? '<span class="paf-req">*</span> ' : '') + esc(text) + '</div>';
      if (subtext) html += '<div class="paf-sub">' + esc(subtext) + '</div>';
      html += '<textarea class="paf-textarea" data-field="' + id + '" placeholder="' + esc(placeholder || '') + '">' + esc(state.answers[id] || '') + '</textarea>';
      root.innerHTML = html;
      root.querySelector('[data-field="' + id + '"]').addEventListener('input', function (e) {
        state.answers[id] = e.target.value;
        refreshNav();
      });
    };
    c.isValid = function () { return !required || !!(state.answers[id] && state.answers[id].trim()); };
    return c;
  }

  function cardText(id, section, text, subtext, placeholder, required) {
    var c = cardShell(section, required);
    c.render = function (root) {
      var html = '<div class="paf-q">' + (required ? '<span class="paf-req">*</span> ' : '') + esc(text) + '</div>';
      if (subtext) html += '<div class="paf-sub">' + esc(subtext) + '</div>';
      html += '<input type="text" class="paf-text-input" data-field="' + id + '" placeholder="' + esc(placeholder || '') + '" value="' + esc(state.answers[id] || '') + '">';
      root.innerHTML = html;
      root.querySelector('[data-field="' + id + '"]').addEventListener('input', function (e) {
        state.answers[id] = e.target.value;
        refreshNav();
      });
    };
    c.isValid = function () { return !required || !!(state.answers[id] && state.answers[id].trim()); };
    return c;
  }

  function cardSelect(id, section, text, options, required, onSelect) {
    var c = cardShell(section, required);
    c.render = function (root) {
      var html = '<div class="paf-q">' + (required ? '<span class="paf-req">*</span> ' : '') + esc(text) + '</div>';
      html += '<div class="paf-options" data-field="' + id + '"></div>';
      root.innerHTML = html;
      var wrap = root.querySelector('[data-field="' + id + '"]');
      options.forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'paf-option-btn';
        b.textContent = o;
        if (state.answers[id] === o) b.classList.add('is-selected');
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(wrap.children, function (c2) { c2.classList.remove('is-selected'); });
          b.classList.add('is-selected');
          state.answers[id] = o;
          if (onSelect) onSelect(o);
          refreshNav();
        });
        wrap.appendChild(b);
      });
    };
    c.isValid = function () { return !required || !!state.answers[id]; };
    return c;
  }

  function cardDuration() {
    var c = cardSelect('q6', 'move', 'How long do you want to be out?', [
      'A few hours (half day)', 'Full day', 'Overnight or multi-day'
    ], true, function (val) {
      // Overnight/multi-day is inherently bespoke, routes it straight
      // to the Custom Experience tier, which gets built personally
      // rather than auto-priced. Switching away reverts to whichever
      // standard tier the after-trail preference implies.
      if (val === 'Overnight or multi-day') {
        state.answers.tier = 'custom';
      } else if (state.answers.tier === 'custom') {
        state.answers.tier = state.answers.include_after_trail === false ? 'trail' : 'p2p';
      }
    });
    // Consulted in next(): picking Overnight/multi-day here doesn't continue
    // into the rest of the booking flow (Custom Experience isn't sold at
    // launch). Instead it shows a personal contact overlay in place of the
    // next card, without advancing state.step, so this stays the "current"
    // step underneath and the guest lands right back here on "Previous."
    c.branchesToCustomContact = true;
    return c;
  }

  // Not currently used in buildCards() (see the comment there). Kept as
  // reference: combines the old "what draws you most" multiselect and
  // "anything specific to see or do" free text into a single screen.
  // An important signal for trail selection, which is exactly why it moved
  // to the post-booking experience rather than being cut: it's captured
  // after payment instead of adding friction to the initial reservation.
  function cardInterests() {
    var c = cardShell('after', true);
    var OPTIONS = [
      'Big views', 'Solitude and quiet', 'Physical challenge', 'Wildlife and nature', 'Interesting geology',
      'Water (streams, pools, falls)', 'Photography opportunities', 'Learning about the place',
      'Moving fast', 'Moving slow and taking it all in'
    ];
    c.render = function (root) {
      var html = '<div class="paf-q"><span class="paf-req">*</span> What draws you most on a great day out?</div>';
      html += '<div class="paf-sub">Pick up to 3.</div>';
      html += '<div class="paf-options paf-options-wrap" data-field="q8"></div>';
      root.innerHTML = html;

      var wrap = root.querySelector('[data-field="q8"]');
      OPTIONS.forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'paf-option-btn';
        b.textContent = o;
        if (state.answers.q8.indexOf(o) !== -1) b.classList.add('is-selected');
        b.addEventListener('click', function () {
          var idx = state.answers.q8.indexOf(o);
          if (idx !== -1) {
            state.answers.q8.splice(idx, 1);
            b.classList.remove('is-selected');
          } else {
            if (state.answers.q8.length >= 3) return;
            state.answers.q8.push(o);
            b.classList.add('is-selected');
          }
          refreshNav();
        });
        wrap.appendChild(b);
      });
    };
    c.isValid = function () { return state.answers.q8.length > 0; };
    return c;
  }

  // Not currently used in buildCards() (see the comment there). Kept as
  // reference: this combines the old "what does recovery look like"
  // multiselect and "taste for the recovery experience" select into one
  // screen, plus dietary preferences (the Trail Database's After the Trail
  // tab filters restaurant options by its Dietary Notes column). All three
  // questions are about the same half of the day, so one screen covered it.
  // This is the question set moving to the post-booking experience.
  function cardRecoveryPreferences() {
    var c = cardShell('trail', true);
    var RECOVERY_OPTIONS = [
      'A pool somewhere beautiful', 'A long cold drink', 'A proper meal', 'A spa or body treatment',
      'Back to the hotel and horizontal', 'Getting back on the road', "I'm open to whatever you recommend"
    ];
    var TASTE_OPTIONS = ['Simple and restorative', 'Comfortable and easy', 'Elevated and indulgent', 'Surprise me'];
    var DIETARY_OPTIONS = ['No restrictions', 'Vegetarian', 'Vegan', 'Gluten-free', 'Dairy-free', 'Nut allergy', 'Other allergy or restriction'];

    c.render = function (root) {
      var html = '<div class="paf-q">What does recovery look like for you?</div>';
      html += '<div class="paf-options paf-options-wrap" data-field="q13"></div>';

      html += '<div class="paf-q" style="margin-top:1.75rem;"><span class="paf-req">*</span> How would you describe your taste for the recovery experience?</div>';
      html += '<div class="paf-options" data-field="q14"></div>';

      html += '<div class="paf-q" style="margin-top:1.75rem;">Any dietary preferences we should plan around?</div>';
      html += '<div class="paf-sub">Only relevant if your day includes a meal stop.</div>';
      html += '<div class="paf-options paf-options-wrap" data-field="dietary"></div>';

      root.innerHTML = html;

      var q13Wrap = root.querySelector('[data-field="q13"]');
      RECOVERY_OPTIONS.forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'paf-option-btn';
        b.textContent = o;
        if (state.answers.q13.indexOf(o) !== -1) b.classList.add('is-selected');
        b.addEventListener('click', function () {
          var idx = state.answers.q13.indexOf(o);
          if (idx !== -1) { state.answers.q13.splice(idx, 1); b.classList.remove('is-selected'); }
          else { state.answers.q13.push(o); b.classList.add('is-selected'); }
          refreshNav();
        });
        q13Wrap.appendChild(b);
      });

      var q14Wrap = root.querySelector('[data-field="q14"]');
      TASTE_OPTIONS.forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'paf-option-btn';
        b.textContent = o;
        if (state.answers.q14 === o) b.classList.add('is-selected');
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(q14Wrap.children, function (c2) { c2.classList.remove('is-selected'); });
          b.classList.add('is-selected');
          state.answers.q14 = o;
          refreshNav();
        });
        q14Wrap.appendChild(b);
      });

      var dietWrap = root.querySelector('[data-field="dietary"]');
      DIETARY_OPTIONS.forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'paf-option-btn';
        b.textContent = o;
        if (state.answers.dietary.indexOf(o) !== -1) b.classList.add('is-selected');
        b.addEventListener('click', function () {
          var idx = state.answers.dietary.indexOf(o);
          if (idx !== -1) { state.answers.dietary.splice(idx, 1); b.classList.remove('is-selected'); }
          else { state.answers.dietary.push(o); b.classList.add('is-selected'); }
          refreshNav();
        });
        dietWrap.appendChild(b);
      });
    };
    c.isValid = function () { return !!state.answers.q14; };
    return c;
  }

  function cardMultiselect(id, section, text, options, max, required) {
    var c = cardShell(section, required);
    c.render = function (root) {
      var subtext = max ? ('Pick up to ' + max + '.') : null;
      var html = '<div class="paf-q">' + (required ? '<span class="paf-req">*</span> ' : '') + esc(text) + '</div>';
      if (subtext) html += '<div class="paf-sub">' + esc(subtext) + '</div>';
      html += '<div class="paf-options paf-options-wrap" data-field="' + id + '"></div>';
      root.innerHTML = html;
      var wrap = root.querySelector('[data-field="' + id + '"]');
      options.forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'paf-option-btn';
        b.textContent = o;
        if (state.answers[id].indexOf(o) !== -1) b.classList.add('is-selected');
        b.addEventListener('click', function () {
          var idx = state.answers[id].indexOf(o);
          if (idx !== -1) {
            state.answers[id].splice(idx, 1);
            b.classList.remove('is-selected');
          } else {
            if (max && state.answers[id].length >= max) return;
            state.answers[id].push(o);
            b.classList.add('is-selected');
          }
          refreshNav();
        });
        wrap.appendChild(b);
      });
    };
    c.isValid = function () { return !required || state.answers[id].length > 0; };
    return c;
  }

  function totalHeadcount() {
    var roster = state.answers.q2_roster.filter(function (p) { return p && (p.name || p.age); });
    return Math.max(roster.length, 1);
  }

  // Gear kit quantity is now derived directly from each roster person's
  // .gearKit flag (set on the "Your Kit" step) rather than a standalone
  // stepper value.
  function selectedGearCount() {
    var n = state.answers.q2_roster.filter(function (p) { return p && p.gearKit; }).length;
    return Math.max(n, 0);
  }

  var BASE_GEAR_COPY = 'Gregory daypack, Leki trekking poles, two laser-engraved Hydro Flask bottles, LMNT electrolytes, Rancho Meladuco dates, Blue Lizard mineral sunscreen, and a first aid kit';

  function keepsakeCopy(tierKey) {
    return tierKey === 'trail'
      ? 'a Palm Springs Adventure Club bandana'
      : 'a Palm Springs Adventure Club tote, Turkish towel, and bandana';
  }

  function recoveryPreviewText() {
    var picks = (state.answers.q13 || []).filter(function (x) {
      return x && x.indexOf('open to whatever') === -1;
    });
    if (!picks.length) return 'a proper recovery: pool time, good food, somewhere to unwind';
    var lower = picks.map(function (s) { return s.charAt(0).toLowerCase() + s.slice(1); });
    if (lower.length === 1) return lower[0];
    return lower.slice(0, -1).join(', ') + ' and ' + lower[lower.length - 1];
  }

  function stitchFragment(field) {
    if (!field || !field.starter) return '';
    var joined = (field.starter + ' ' + (field.text || '')).trim();
    // Every place this fragment gets used wraps it in its own quote marks
    // and adds its own trailing punctuation (a period or comma). Strip any
    // period/exclamation/question mark the guest already typed so it
    // doesn't double up into things like "...myself.." or "...mine.,".
    return joined.replace(/[.!?]+$/, '');
  }

  // Standalone date formatter for the custom-contact email draft below.
  // Duplicates the small bit of logic living inside cardDateTime()'s own
  // closure rather than exposing that closure's internals just for this.
  function formatDateForEmail(iso) {
    if (!iso) return null;
    var parts = iso.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  // Suggested subject/body for the guest to send us once they pick Overnight
  // or multi-day (see cardDuration() and showCustomContactOverlay()). Filled
  // in from whatever they've already told us by this point in the flow, so
  // they are not stuck retyping what they just answered.
  function buildCustomInquiryEmail() {
    var subject = 'Multi-day adventure inquiry';
    var headcount = totalHeadcount();
    var lines = [];
    lines.push('Hi Palm Springs Adventure Club,');
    lines.push('');
    lines.push("I'm interested in planning an overnight or multi-day adventure. Here's what I have so far:");
    lines.push('');
    lines.push('Group size: ' + headcount + (headcount === 1 ? ' person' : ' people'));
    lines.push('Preferred dates: ' + (formatDateForEmail(state.answers.q3_date) || 'Flexible'));
    if (state.answers.q5 && state.answers.q5.length) {
      lines.push('Activity: ' + state.answers.q5.join(' and '));
    }
    var q1Frag = stitchFragment(state.answers.q1);
    if (q1Frag) {
      lines.push("What I'm looking for: " + q1Frag);
    }
    lines.push('');
    lines.push("I'd love to hear what's possible.");
    return { subject: subject, body: lines.join('\n') };
  }

  // Builds the recap paragraph on cardRecap(), re-run live whenever the
  // after-trail toggle changes so the narrative always matches the current
  // choice before price is revealed.
  function buildRecapNarrative() {
    var q1Frag = stitchFragment(state.answers.q1);
    var activity = (state.answers.q5 && state.answers.q5.length)
      ? state.answers.q5.join(' and ').toLowerCase()
      : 'your adventure';
    var duration = state.answers.q6 ? state.answers.q6.toLowerCase() : '';
    var headcount = totalHeadcount();
    var groupPhrase = headcount === 1 ? 'just you' : ('your group of ' + headcount);
    var gearCount = selectedGearCount();
    var gearPhrase = gearCount === 1 ? '1 gear kit' : (gearCount + ' gear kits');

    var opener = q1Frag
      ? 'You told us "' + q1Frag + '," so we\'re building '
      : 'We\'re building ';
    var lines = [];
    lines.push(opener + (duration ? duration + ' of ' : '') + activity + ' for ' + groupPhrase + '.');
    lines.push('That means ' + gearPhrase + ', with everything delivered and picked up, nothing for you to plan.');

    // Trail Guide (trail-only) is the only launch experience, so there's
    // nothing to add here right now: no toggle exists for the guest to
    // have "chosen" trail-only, so a line implying they made that choice
    // would be misleading. Kept as a live condition, not deleted, so the
    // after-trail line comes right back once Peaks to Pools relaunches and
    // include_after_trail can be true again.
    if (state.answers.include_after_trail !== false) {
      lines.push('Afterward, we\'ll build in ' + recoveryPreviewText() + '.');
    }
    return lines.join(' ');
  }

  // The rational counterpart to the narrative above: a plain-spoken list
  // of everything included, re-run alongside the narrative whenever the
  // after-trail toggle changes (it affects both the tier line and whether
  // the after-trail item appears at all).
  function buildValueItems() {
    var tier = TIERS[state.answers.tier];
    var gearCount = selectedGearCount();
    var gearWord = gearCount === 1 ? 'gear kit' : 'gear kits';
    var items = [
      'Nothing for you to plan, source, or figure out',
      'Trail selected for your group, built from lived experience on these trails',
      'Every logistic handled: no permits, no research, no guesswork',
      'Your route loads to your phone before you leave. Works without cell service.',
      'Printed route card with waypoints and landmarks',
      'All gear delivered the evening before and picked up after'
    ];
    if (state.answers.include_after_trail !== false) {
      items.push('An "after the trail" experience that rewards your effort and helps you recover in Palm Springs style');
    }
    return items;
  }

  function cardRecap() {
    var c = cardShell('kit', true);
    c.nextLabel = 'Reserve My Spot';
    c.render = function (root) {
      // Local to this render only: collapses back to closed every time the
      // guest (re)enters this card, doesn't need to persist in state.
      var confirmOpen = false;

      var html = '<div class="paf-closing-eyebrow">Almost there</div>';
      html += '<div class="paf-q">Here\'s the day we\'re building.</div>';
      html += '<div class="paf-closing-dynamic" data-field="narrative"></div>';
      html += '<div class="paf-value-list" data-field="value-list"></div>';
      html += '<div class="paf-after-trail" data-field="after-trail"></div>';
      root.innerHTML = html;

      var narrativeEl = root.querySelector('[data-field="narrative"]');
      var valueListEl = root.querySelector('[data-field="value-list"]');
      var afterTrailEl = root.querySelector('[data-field="after-trail"]');

      function refreshRecap() {
        narrativeEl.textContent = buildRecapNarrative();
        valueListEl.innerHTML = buildValueItems().map(function (item) {
          return '<div class="paf-value-item"><span class="paf-value-check">✓</span>' + esc(item) + '</div>';
        }).join('');
        // renderAfterTrailToggle() no longer called: Trail Guide (trail-only) is
        // the only launch experience, so there is nothing to opt in or out of.
        // The function stays defined below, unused, and the empty
        // [data-field="after-trail"] container above stays in the markup, so
        // reactivating this later is just uncommenting this one line.
      }

      function setIncludeAfterTrail(val) {
        state.answers.include_after_trail = val;
        state.answers.tier = val ? 'p2p' : 'trail';
        confirmOpen = false;
        refreshRecap();
      }

      // Assumed included by default: no toggle to answer, just a small
      // low-key way out. Removing it is a real pricing/tier change, so it
      // gets an inline confirm step rather than executing on first click.
      function renderAfterTrailToggle() {
        if (state.answers.tier === 'custom') {
          afterTrailEl.innerHTML = '<div class="paf-value-item" style="border-bottom:none; padding-top:0;">' +
            'Since this is a multi-day custom experience, we\'ll build your complete itinerary (trail days, recovery, ' +
            'everything) and reach out personally to finalize it with you.</div>';
          return;
        }
        var included = state.answers.include_after_trail !== false;
        var h;
        if (included && !confirmOpen) {
          h = '<button type="button" class="paf-link-btn" data-field="open-confirm">Prefer trail-only?</button>';
        } else if (included && confirmOpen) {
          h = '<div class="paf-inline-confirm">' +
            '<div class="paf-inline-confirm-text">Removing the after-trail experience downgrades from ' +
            esc(TIERS.p2p.name) + ' to ' + esc(TIERS.trail.name) + ', including a smaller gear kit.</div>' +
            '<div class="paf-inline-confirm-actions">' +
            '<button type="button" class="paf-link-btn paf-link-btn-confirm" data-field="confirm-remove">Yes, switch to trail-only</button>' +
            '<button type="button" class="paf-link-btn" data-field="cancel-remove">Never mind</button>' +
            '</div></div>';
        } else {
          h = '<button type="button" class="paf-link-btn" data-field="add-back">Add back an after-trail experience</button>';
        }
        afterTrailEl.innerHTML = h;

        var openBtn = afterTrailEl.querySelector('[data-field="open-confirm"]');
        if (openBtn) openBtn.addEventListener('click', function () { confirmOpen = true; renderAfterTrailToggle(); });

        var confirmBtn = afterTrailEl.querySelector('[data-field="confirm-remove"]');
        if (confirmBtn) confirmBtn.addEventListener('click', function () { setIncludeAfterTrail(false); });

        var cancelBtn = afterTrailEl.querySelector('[data-field="cancel-remove"]');
        if (cancelBtn) cancelBtn.addEventListener('click', function () { confirmOpen = false; renderAfterTrailToggle(); });

        var addBackBtn = afterTrailEl.querySelector('[data-field="add-back"]');
        if (addBackBtn) addBackBtn.addEventListener('click', function () { setIncludeAfterTrail(true); });
      }

      refreshRecap();
    };
    c.isValid = function () { return true; };
    return c;
  }

  function cardGearList() {
    var c = cardShell('kit', true);
    c.render = function (root) {
      var roster = state.answers.q2_roster.filter(function (p) { return p && (p.name || p.age); });
      roster.forEach(function (p) {
        if (p.age === 'Under 14') {
          p.gearKit = false;
        } else if (p.gearKit === undefined || p.gearKit === null) {
          p.gearKit = true;
        }
      });

      var html = '<div class="paf-q"><span class="paf-req">*</span> Who needs a gear kit?</div>';
      html += '<div class="paf-sub">Every booking includes at least one. Everyone 14 and up gets their own: ' +
        BASE_GEAR_COPY + '. Everything you need for the trail. Nothing for you to source.</div>';
      html += '<button type="button" class="paf-kit-disclosure" data-field="disclosure">What\'s inside a gear kit? <span data-field="disclosure-icon">+</span></button>';
      html += '<div class="paf-kit-details" data-field="details" style="display:none;">' +
        '<div class="paf-kit-details-row"><strong>Rental gear:</strong> ' + BASE_GEAR_COPY + '. Packed and delivered the evening before your trail day.</div>' +
        '<div class="paf-kit-details-row"><strong>Yours to keep:</strong> a few Palm Springs Adventure Club keepsakes. The exact list depends on your experience, and you\'ll see it spelled out before you reserve.</div>' +
        '</div>';
      html += '<div class="paf-gear-list" data-field="gear-list"></div>';
      root.innerHTML = html;

      var disclosureBtn = root.querySelector('[data-field="disclosure"]');
      var detailsEl = root.querySelector('[data-field="details"]');
      var iconEl = root.querySelector('[data-field="disclosure-icon"]');
      disclosureBtn.addEventListener('click', function () {
        var isOpen = detailsEl.style.display !== 'none';
        detailsEl.style.display = isOpen ? 'none' : 'block';
        iconEl.textContent = isOpen ? '+' : '–';
      });

      var listEl = root.querySelector('[data-field="gear-list"]');

      // This is a bundle: every booking needs at least one gear kit. Any
      // person who is currently the *only* remaining "yes" has their "no"
      // button locked so the total can never drop to zero. Recomputed on
      // every toggle since who counts as "the last one" changes as people
      // flip their own choice.
      function renderList() {
        listEl.innerHTML = '';
        var selectedCount = roster.filter(function (p) { return p.gearKit; }).length;

        roster.forEach(function (p, idx) {
          var row = document.createElement('div');
          row.className = 'paf-gear-row';
          var isKid = p.age === 'Under 14';
          var nameLabel = p.name && p.name.trim() ? p.name.trim() : ('Person ' + (idx + 1));

          var info = document.createElement('div');
          info.className = 'paf-gear-row-info';
          info.innerHTML = '<span class="paf-gear-row-name">' + esc(nameLabel) + '</span>' +
            (p.age ? '<span class="paf-gear-row-age">' + esc(p.age) + '</span>' : '');
          row.appendChild(info);

          if (isKid) {
            var notIncluded = document.createElement('span');
            notIncluded.className = 'paf-gear-row-excluded';
            notIncluded.textContent = 'Not included';
            row.appendChild(notIncluded);
          } else {
            var isLastOne = p.gearKit === true && selectedCount === 1;
            var toggle = document.createElement('div');
            toggle.className = 'paf-gear-toggle';
            ['Yes', 'No'].forEach(function (label) {
              var val = label === 'Yes';
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'paf-gear-toggle-btn' + (p.gearKit === val ? ' is-selected' : '');
              btn.textContent = label;
              if (!val && isLastOne) {
                btn.disabled = true;
                btn.title = 'Every booking needs at least one gear kit';
              }
              btn.addEventListener('click', function () {
                p.gearKit = val;
                refreshNav();
                renderList();
              });
              toggle.appendChild(btn);
            });
            row.appendChild(toggle);
          }

          listEl.appendChild(row);
        });
      }

      renderList();
    };
    c.isValid = function () {
      return state.answers.q2_roster.some(function (p) { return p && p.gearKit; });
    };
    return c;
  }

  function cardContact() {
    var c = cardShell('kit', true);
    c.render = function (root) {
      var html = '<div class="paf-q">Almost there. How should we reach you?</div>';
      html += '<input type="text" class="paf-text-input" data-field="contact_name" placeholder="Name" value="' + esc(state.answers.contact_name) + '" style="margin-bottom:0.9rem;">';
      html += '<input type="email" class="paf-text-input" data-field="contact_email" placeholder="Email *" value="' + esc(state.answers.contact_email) + '" style="margin-bottom:0.9rem;">';
      html += '<input type="tel" class="paf-text-input" data-field="contact_phone" placeholder="Phone *" value="' + esc(state.answers.contact_phone) + '">';
      // Separate from and unrelated to phone being required: providing a
      // number is not consent to be texted on it. Unchecked by default,
      // never wired into isValid() below, so it can never block advancing.
      html += '<label class="paf-sms-consent">' +
        '<input type="checkbox" data-field="contact_sms_consent"' + (state.answers.contact_sms_consent ? ' checked' : '') + '>' +
        '<span>' + esc(SMS_CONSENT_LABEL) +
        '<br><small class="paf-sms-fineprint">' + esc(SMS_CONSENT_FINEPRINT) +
        ' <a href="/terms" target="_blank" rel="noopener">Terms of Service</a>' +
        ' &middot; <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</small>' +
        '</span>' +
        '</label>';
      root.innerHTML = html;
      ['contact_name', 'contact_email', 'contact_phone'].forEach(function (f) {
        root.querySelector('[data-field="' + f + '"]').addEventListener('input', function (e) {
          state.answers[f] = e.target.value;
          refreshNav();
        });
      });
      root.querySelector('[data-field="contact_sms_consent"]').addEventListener('change', function (e) {
        state.answers.contact_sms_consent = e.target.checked;
      });
    };
    c.isValid = function () {
      return !!state.answers.contact_name.trim() &&
        /\S+@\S+\.\S+/.test(state.answers.contact_email) &&
        !!state.answers.contact_phone.trim();
    };
    return c;
  }

  function computeTotal(tierKey) {
    var tier = TIERS[tierKey];
    return tier.booking + tier.gear * selectedGearCount();
  }

  // Refundable per-kit gear deposit: a card hold, never an actual charge,
  // released once gear comes back complete and in working order. Priced to
  // match the tier's existing gear-kit line item exactly (a deliberate
  // choice, not a coincidence): $65/kit for Trail Guide, $100/kit for Peaks
  // to Pools and Custom.
  function depositPerKit(tierKey) {
    return TIERS[tierKey].gear;
  }

  function cardPricing() {
    var c = cardShell('kit', false);
    c.isPricing = true;
    c.render = function (root) {
      renderPricing(root);
    };
    c.isValid = function () { return true; };
    return c;
  }

  function renderPricing(root) {
    var tier = TIERS[state.answers.tier];
    var total = computeTotal(state.answers.tier);
    var gearCount = selectedGearCount();
    var isCustom = state.answers.tier === 'custom';
    var totalLabel = isCustom ? 'Starting estimate' : 'Total';
    var reserveLabel = isCustom ? 'Request My Custom Experience' : 'Continue to Payment';
    var depositEach = depositPerKit(state.answers.tier);
    var depositTotal = depositEach * gearCount;
    // Full retail replacement value per kit (backpack + poles + 2 bottles +
    // a shared delivery duffel), disclosed as the cap on what could ever be
    // charged beyond the hold. Same figure across tiers since the physical
    // rental items don't differ by tier, only the keepsakes do.
    var retailCapEach = 531;
    var retailCapTotal = retailCapEach * gearCount;
    // The hold itself no longer fires today: it moves to T-1 (the day
    // before gear delivery), placed by the Internal Operations UX. This
    // copy still discloses full terms at booking, since that's when the
    // guest is deciding and providing a card, but says plainly the hold
    // happens later, not now.
    var depositExplain = 'This is a hold on your card, not a charge. It gets placed the day before your gear is delivered, not today. It\'s released in full once your gear comes back complete and in working order. If something is missing, lost, or damaged, we deduct replacement cost from this hold first. If the damage or loss is significant, we reserve the right to charge the remaining balance directly to the card on file, up to ' +
      (gearCount === 1
        ? 'the kit\'s full retail value of $' + retailCapEach
        : 'each kit\'s full retail value of $' + retailCapEach + ' ($' + retailCapTotal + ' total across your ' + gearCount + ' kits)') +
      ', to cover it.';
    // Standard tiers pay inline via the embedded Payment Element below, so
    // no note is needed there since the payment form itself makes it obvious.
    // Custom Experience still needs the explanation since no card is
    // collected on this screen.
    var priceNote = isCustom
      ? 'This is a starting estimate for a multi-day custom experience. We\'ll personally reach out within one business day to build your complete itinerary and finalize pricing before anything is charged.'
      : null;
    // Plain-language waiver disclosure, required at the point of payment
    // even though the actual waiver-signing step happens later during Trip
    // Prep. Shown for every tier, not just standard ones.
    var waiverNote = 'Completing a Release of Liability is required before your gear is delivered or your adventure begins. We\'ll send this to you as part of getting your trip ready to go.';
    var html = '<div class="paf-q">Here\'s your day.</div>';
    // Early Guest discount: Trail Guide booking fee displays as $125 with
    // a -$25 discount applied automatically, netting to $100 charged.
    // Active through October 2026. No code required, no guest action needed.
    // In November 2026: remove the discount display lines below and update
    // TIERS.trail.booking to 125 (and update api/create-payment-intent.js
    // to match). Do not surface this discount in marketing copy or Instagram.
    var EARLY_GUEST_DISCOUNT = (!isCustom && state.answers.tier === 'trail') ? 25 : 0;
    var displayBookingFee = tier.booking + EARLY_GUEST_DISCOUNT;

    html += '<div class="paf-price-card">';
    html += '<div class="paf-price-tier">' + esc(tier.name) + '</div>';
    if (EARLY_GUEST_DISCOUNT > 0) {
      html += '<div class="paf-price-line"><span>Personalized ' + esc(tier.name) + '</span><span><s style="opacity:0.45;">$' + displayBookingFee + '</s> $' + tier.booking + '</span></div>';
      html += '<div class="paf-price-line" style="color:var(--clr-pine, #2A4747);"><span>Early Guest discount</span><span>-$' + EARLY_GUEST_DISCOUNT + '</span></div>';
    } else {
      html += '<div class="paf-price-line"><span>Personalized ' + esc(tier.name) + '</span><span>$' + tier.booking + '</span></div>';
    }
    html += '<div class="paf-price-line"><span>Gear kit × ' + gearCount + '</span><span>$' + (tier.gear * gearCount) + '</span></div>';
    html += '<div class="paf-price-total"><span>' + totalLabel + '</span><span>$' + total + '</span></div>';
    html += '</div>';
    if (!isCustom) {
      html += '<div class="paf-deposit-card">' +
        '<div class="paf-deposit-line"><span>Refundable gear deposit</span><span>$' + depositTotal + '</span></div>' +
        '<div class="paf-deposit-explain">' + depositExplain + '</div>' +
        '</div>';
    }
    html += '<div class="paf-price-note">' + waiverNote + '</div>';
    html += '<button type="button" class="paf-kit-disclosure" data-field="disclosure">What\'s included? <span data-field="disclosure-icon">+</span></button>';
    html += '<div class="paf-kit-details" data-field="details" style="display:none;">' +
      '<div class="paf-kit-details-row">Route selection tailored to your group and the day\'s conditions, built from lived experience on these trails.</div>' +
      '<div class="paf-kit-details-row">Every logistic handled: no permits, no planning, no guesswork.</div>' +
      '<div class="paf-kit-details-row">No-hassle gear delivery and pickup.</div>' +
      '<div class="paf-kit-details-row"><strong>Your gear kit:</strong> ' + BASE_GEAR_COPY + ', plus ' + keepsakeCopy(state.answers.tier) + ' to keep.</div>' +
      '</div>';
    html += '<label class="paf-policy-agree">' +
      '<input type="checkbox" data-field="policy-checkbox"' + (state.answers.policiesAgreed ? ' checked' : '') + '>' +
      '<span>I agree to the <a href="/refund-policy" target="_blank" rel="noopener">Cancellation &amp; Refund Policy</a>, <a href="/terms" target="_blank" rel="noopener">Terms of Service</a>, and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span>' +
      '</label>';
    html += '<button type="button" class="paf-reserve-btn" data-field="reserve">' + esc(reserveLabel) + '</button>';
    if (!isCustom) {
      html += '<div class="paf-payment-section" data-field="payment-section" style="display:none;">' +
        '<div class="paf-payment-element" data-field="payment-element"></div>' +
        '<div class="paf-payment-error" data-field="payment-error" style="display:none;"></div>' +
        '<button type="button" class="paf-reserve-btn" data-field="pay-btn" disabled>Pay $' + total + ' &amp; Reserve</button>' +
        '</div>';
    }
    if (priceNote) {
      html += '<div class="paf-price-note" data-field="price-note">' + esc(priceNote) + '</div>';
    }
    html += '<div class="paf-price-nav"><button type="button" class="paf-nav-btn paf-nav-prev" data-field="back">← Previous</button></div>';
    root.innerHTML = html;

    root.querySelector('[data-field="back"]').addEventListener('click', function () { prev(); });

    var disclosureBtn = root.querySelector('[data-field="disclosure"]');
    var detailsEl = root.querySelector('[data-field="details"]');
    var iconEl = root.querySelector('[data-field="disclosure-icon"]');
    disclosureBtn.addEventListener('click', function () {
      var isOpen = detailsEl.style.display !== 'none';
      detailsEl.style.display = isOpen ? 'none' : 'block';
      iconEl.textContent = isOpen ? '+' : '–';
    });

    var reserveBtn = root.querySelector('[data-field="reserve"]');
    var policyCheckbox = root.querySelector('[data-field="policy-checkbox"]');
    // Unchecked by default (state.answers.policiesAgreed starts false); the
    // guest has to actively agree before the reserve button, and with it
    // the payment step, becomes available. Persisted in state so it stays
    // checked if they navigate back and forth within the same booking
    // attempt, rather than resetting on every re-render of this card.
    reserveBtn.disabled = !state.answers.policiesAgreed;
    policyCheckbox.addEventListener('change', function () {
      state.answers.policiesAgreed = policyCheckbox.checked;
      reserveBtn.disabled = !policyCheckbox.checked;
    });

    reserveBtn.addEventListener('click', function () {
      if (!state.answers.policiesAgreed) return;
      if (isCustom) {
        submitForm();
        return;
      }
      startStripePayment(root, total, gearCount);
    });
  }

  // Kicks off the embedded payment step for standard tiers: asks our
  // serverless endpoint for a PaymentIntent (server recomputes the total
  // from locked tier prices, never trusts a client-sent dollar amount),
  // then mounts Stripe's Payment Element in place of the reserve button.
  function startStripePayment(root, total, gearCount) {
    var reserveBtn = root.querySelector('[data-field="reserve"]');
    var section = root.querySelector('[data-field="payment-section"]');
    var errorEl = root.querySelector('[data-field="payment-error"]');
    var payBtn = root.querySelector('[data-field="pay-btn"]');
    var stripe = getStripe();

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    }

    if (!stripe) {
      section.style.display = 'block';
      showError("Payment isn't available right now. Please refresh and try again, or reach out to us directly.");
      return;
    }

    reserveBtn.disabled = true;
    reserveBtn.textContent = 'Loading payment…';

    fetch('/api/create-payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tier: state.answers.tier,
        gearCount: gearCount,
        email: state.answers.contact_email,
        name: state.answers.contact_name,
        date: state.answers.q3_date
      })
    })
      .then(function (r) {
        return r.json().then(function (data) { return { ok: r.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok || !result.data || !result.data.clientSecret) {
          throw new Error((result.data && result.data.error) || 'Could not start payment.');
        }

        reserveBtn.style.display = 'none';
        section.style.display = 'block';

        stripeElementsInstance = stripe.elements({
          clientSecret: result.data.clientSecret,
          appearance: STRIPE_APPEARANCE
        });
        var paymentElement = stripeElementsInstance.create('payment');
        paymentElement.mount(root.querySelector('[data-field="payment-element"]'));

        payBtn.disabled = false;
        payBtn.addEventListener('click', function onPay() {
          payBtn.disabled = true;
          payBtn.textContent = 'Processing…';
          errorEl.style.display = 'none';

          stripe.confirmPayment({
            elements: stripeElementsInstance,
            redirect: 'if_required'
          }).then(function (confirmResult) {
            if (confirmResult.error) {
              showError(confirmResult.error.message || 'Payment failed. Please check your card details and try again.');
              payBtn.disabled = false;
              payBtn.textContent = 'Pay $' + total + ' & Reserve';
              return;
            }
            var pi = confirmResult.paymentIntent;
            if (pi && (pi.status === 'succeeded' || pi.status === 'processing')) {
              state.answers.paymentIntentId = pi.id;
              state.answers.paymentStatus = pi.status;
              payBtn.textContent = 'Finalizing your reservation…';
              // The refundable gear deposit hold no longer fires here: Stripe
              // holds expire in 5-7 days and a booking can happen weeks
              // before the trip, so the hold moved to T-1 (day before gear
              // delivery), placed by the Internal Operations UX calling
              // api/create-deposit-hold.js directly with this booking's id
              // once it exists. Go straight to submitForm(), same as Custom.
              submitForm();
            } else {
              showError('Payment did not complete. Please try again.');
              payBtn.disabled = false;
              payBtn.textContent = 'Pay $' + total + ' & Reserve';
            }
          }).catch(function () {
            showError('Something went wrong confirming your payment. Please try again.');
            payBtn.disabled = false;
            payBtn.textContent = 'Pay $' + total + ' & Reserve';
          });
        });
      })
      .catch(function (err) {
        reserveBtn.disabled = false;
        reserveBtn.textContent = 'Continue to Payment';
        section.style.display = 'block';
        showError(err.message || 'Could not start payment. Please try again.');
      });
  }

  function cardClosing() {
    var c = cardShell('kit', false);
    c.isClosing = true;
    c.render = function (root) {
      var q1Frag = stitchFragment(state.answers.q1);
      var html = '<div class="paf-closing-eyebrow">Reserved</div>';
      html += '<div class="paf-closing-headline">Your adventure is<br>already taking shape.</div>';
      html += '<div class="paf-closing-dynamic">';
      if (q1Frag) {
        html += 'You told us <em>"' + esc(q1Frag) + '."</em> We\'re building a day designed around exactly that. ';
      }
      // Fixed, non-personalized close (narrative audit recommendation 2).
      // Used to quote back state.answers.q12 ("at the end of this day, I want
      // to feel") here too, but that question moved to the post-booking
      // experience, so there is no personalized answer left to complete this
      // sentence with. If q12 ever comes back into this flow, revisit
      // whether this fixed line should go back to being personalized. Reuses
      // the "everything hits differently after" line already on the
      // homepage, so the closing screen echoes language the guest may
      // already recognize.
      html += "And when it's done, everything will hit differently. The pool. The drink. The dinner. The conversation. The bed. You'll return to exactly where you started but it will feel like somewhere new. So will you.";
      html += '</div>';
      html += '<div class="paf-closing-sub">How did that feel?</div>';
      html += '<div class="paf-rating" data-field="rating"></div>';
      root.innerHTML = html;
      var ratingWrap = root.querySelector('[data-field="rating"]');
      for (var i = 1; i <= 5; i++) {
        (function (n) {
          var star = document.createElement('button');
          star.type = 'button';
          star.className = 'paf-star';
          star.innerHTML = '★';
          if (state.answers.rating >= n) star.classList.add('is-filled');
          star.addEventListener('click', function () {
            state.answers.rating = n;
            Array.prototype.forEach.call(ratingWrap.children, function (s, idx) {
              s.classList.toggle('is-filled', idx < n);
            });
          });
          ratingWrap.appendChild(star);
        })(i);
      }
    };
    c.isValid = function () { return true; };
    return c;
  }

  // ── SUBMISSION ───────────────────────────────────
  function buildPayload() {
    return {
      submittedAt: new Date().toISOString(),
      q1: state.answers.q1,
      roster: state.answers.q2_roster,
      headcount: totalHeadcount(),
      date: state.answers.q3_date,
      timePreference: state.answers.q3_time,
      q5_activity: state.answers.q5,
      q6_duration: state.answers.q6,
      q8_draws: state.answers.q8,
      q12: state.answers.q12,
      q13_recovery: state.answers.q13,
      q14_taste: state.answers.q14,
      dietary_preferences: state.answers.dietary,
      includeAfterTrail: state.answers.include_after_trail,
      policiesAgreed: !!state.answers.policiesAgreed,
      // Which "Last updated" date was live on each policy page at the
      // moment of booking (see POLICY_VERSIONS above), independent of
      // whether the guest actually agreed, same as any other snapshot
      // field in this payload.
      policyVersionsAgreed: POLICY_VERSIONS,
      gearKitsSelected: selectedGearCount(),
      // Shared delivery duffels, not one per kit: 1 duffel covers up to 2
      // kits, 2 covers 3-4, 3 covers 5-6, and so on (Math.ceil(n/2)).
      duffelCount: Math.ceil(Math.max(selectedGearCount(), 1) / 2),
      contact: {
        name: state.answers.contact_name,
        email: state.answers.contact_email,
        phone: state.answers.contact_phone,
        // Explicit true/false, never omitted or null, so it's clear the
        // guest was shown the choice and either affirmatively opted in or
        // declined, not that consent simply wasn't asked about.
        smsConsent: !!state.answers.contact_sms_consent,
        smsConsentAt: new Date().toISOString(),
        smsConsentText: SMS_CONSENT_TEXT
      },
      tier: state.answers.tier,
      total: computeTotal(state.answers.tier),
      paymentIntentId: state.answers.paymentIntentId || null,
      paymentStatus: state.answers.paymentStatus || (state.answers.tier === 'custom' ? 'not_charged_custom_quote' : 'unpaid'),
      depositPaymentIntentId: state.answers.depositPaymentIntentId || null,
      // No hold attempt happens at booking anymore (see startStripePayment()
      // above): the deposit hold itself fires at T-1, placed by the
      // Operations UX calling api/create-deposit-hold.js. 'scheduled_t1'
      // tells the Bookings sheet and Operations UX a hold is expected
      // later, not already resolved one way or the other.
      depositStatus: state.answers.depositStatus || (state.answers.tier === 'custom' ? 'not_applicable' : 'scheduled_t1')
    };
  }

  function submitForm() {
    var payload = buildPayload();
    fetch('/api/save-booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) {
          state.answers.personId = data.personId || null;
          state.answers.bookingId = data.bookingId || null;
        }
      })
      .catch(function () { /* fail silently since booking/payment already happened, still show closing screen */ })
      .then(function () {
        goToStep(cards.length - 1);
      });
  }

  // ── NAV / RENDER SHELL ───────────────────────────
  var els = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function refreshNav() {
    var card = cards[state.step];
    els.nextBtn.disabled = !card.isValid();
  }

  function renderProgress() {
    var card = cards[state.step];
    var html = '';
    SECTIONS.forEach(function (s) {
      var isActive = card.section === s.id;
      html += '<span class="paf-progress-section' + (isActive ? ' is-active' : '') + '">' + esc(s.name) + '</span>';
    });
    els.progress.innerHTML = html;
    var pct = Math.round((state.step / (cards.length - 1)) * 100);
    els.progressFill.style.width = pct + '%';

    // Labels scroll horizontally on narrow screens instead of wrapping:
    // keep the active one in view without the guest having to swipe.
    var activeEl = els.progress.querySelector('.paf-progress-section.is-active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderStep() {
    var card = cards[state.step];
    els.cardBody.innerHTML = '';
    card.render(els.cardBody);
    renderProgress();
    els.prevBtn.style.visibility = state.step === 0 ? 'hidden' : 'visible';
    var isLast = state.step === cards.length - 1;
    var isPricing = !!card.isPricing;
    els.footer.style.display = (isLast || isPricing) ? 'none' : 'flex';
    els.nextBtn.textContent = (card.nextLabel || 'Next') + ' →';
    els.cardBody.scrollTop = 0;
    refreshNav();
  }

  function goToStep(n) {
    state.step = n;
    renderStep();
  }

  function next() {
    var card = cards[state.step];
    if (!card.isValid()) return;
    if (card.branchesToCustomContact && state.answers.tier === 'custom') {
      showCustomContactOverlay();
      return;
    }
    if (state.step < cards.length - 1) goToStep(state.step + 1);
  }

  function prev() {
    if (state.step > 0) goToStep(state.step - 1);
  }

  // ── CUSTOM CONTACT OVERLAY ───────────────────────
  // Shown in place of the next card when cardDuration() flags
  // branchesToCustomContact and the guest picked Overnight/multi-day. Does
  // not touch state.step, so this takes over els.cardBody/footer visually
  // while the flow underneath stays parked on the duration card. "Previous"
  // (rendered inline here, not the shared footer) just re-renders that same
  // step, landing the guest right back where they were.
  function renderCustomContactCard(root) {
    var email = buildCustomInquiryEmail();
    var mailtoHref = 'mailto:' + CUSTOM_CONTACT_EMAIL +
      '?subject=' + encodeURIComponent(email.subject) +
      '&body=' + encodeURIComponent(email.body);

    var html = '<div class="paf-q">Let\'s build your adventure together.</div>';
    html += '<div class="paf-sub">Overnight and multi-day adventures require collaboration to ensure your vision is realized. Send us a note and we will build a complete itinerary with you.</div>';
    html += '<div class="paf-closing-dynamic">';
    html += '<div style="margin-bottom:0.9rem;"><strong>To:</strong> ' + esc(CUSTOM_CONTACT_EMAIL) + '</div>';
    html += '<div style="margin-bottom:0.3rem;"><strong>Subject</strong></div>';
    html += '<div data-field="subject-text" style="margin-bottom:0.9rem;">' + esc(email.subject) + '</div>';
    html += '<div style="margin-bottom:0.3rem;"><strong>Message</strong></div>';
    html += '<div data-field="body-text" style="white-space:pre-wrap;">' + esc(email.body) + '</div>';
    html += '</div>';
    html += '<a href="' + esc(mailtoHref) + '" class="paf-reserve-btn" style="display:block; text-align:center; text-decoration:none; box-sizing:border-box;">Open Email to Send</a>';
    html += '<div style="display:flex; gap:1.4rem; margin-top:0.9rem;">';
    html += '<button type="button" class="paf-link-btn" data-field="copy-subject">Copy subject</button>';
    html += '<button type="button" class="paf-link-btn" data-field="copy-body">Copy message</button>';
    html += '</div>';
    html += '<div class="paf-price-nav"><button type="button" class="paf-nav-btn paf-nav-prev" data-field="back">← Previous</button></div>';
    root.innerHTML = html;

    function wireCopyButton(fieldName, text) {
      var btn = root.querySelector('[data-field="' + fieldName + '"]');
      if (!btn) return;
      var originalLabel = btn.textContent;
      btn.addEventListener('click', function () {
        var done = function () {
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = originalLabel; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(function () { /* clipboard denied, leave button as-is */ });
        }
      });
    }
    wireCopyButton('copy-subject', email.subject);
    wireCopyButton('copy-body', email.body);

    root.querySelector('[data-field="back"]').addEventListener('click', function () {
      hideCustomContactOverlay();
    });
  }

  function showCustomContactOverlay() {
    els.cardBody.innerHTML = '';
    renderCustomContactCard(els.cardBody);
    els.footer.style.display = 'none';
    els.cardBody.scrollTop = 0;
  }

  function hideCustomContactOverlay() {
    renderStep();
  }

  // ── MOUNT ────────────────────────────────────────
  function mount(root) {
    buildCards();
    root.innerHTML =
      '<div class="paf-progress-bar"><div class="paf-progress-fill" data-field="fill"></div></div>' +
      '<div class="paf-progress-labels" data-field="progress"></div>' +
      '<div class="paf-card-body" data-field="body"></div>' +
      '<div class="paf-footer" data-field="footer">' +
      '<button type="button" class="paf-nav-btn paf-nav-prev" data-field="prev">← Previous</button>' +
      '<button type="button" class="paf-nav-btn paf-nav-next" data-field="next">Next →</button>' +
      '</div>';

    els.progress = root.querySelector('[data-field="progress"]');
    els.progressFill = root.querySelector('[data-field="fill"]');
    els.cardBody = root.querySelector('[data-field="body"]');
    els.footer = root.querySelector('[data-field="footer"]');
    els.prevBtn = root.querySelector('[data-field="prev"]');
    els.nextBtn = root.querySelector('[data-field="next"]');

    els.prevBtn.addEventListener('click', prev);
    els.nextBtn.addEventListener('click', next);

    state.step = 0;
    renderStep();
  }

  window.PSACAdventureForm = { mount: mount };
})();
