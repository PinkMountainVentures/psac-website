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
      q2_who: null,         // solo | partner | friends | friends_kids | family_kids
      q2_roster: [],         // [{ name, age, fitness }]
      q3_date: '',
      q3_time: null,
      q5: [],
      q6: null,
      q7: '',
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
        "We'll use this to help pick the right trail for the occasion."),
      cardWho(),
      cardDateTime(),
      cardMultiselect('q5', 'move', 'What activity are you planning?', [
        'Hiking', 'Trail running'
      ], null, true),
      cardSelect('q6', 'move', 'How long do you want to be out?', [
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
      }),
      cardTextarea('q7', 'move', 'Anything else we should know to make this day exactly right?',
        'Physical considerations, special requests, anything at all. Nothing medical required, just what\'s useful for building your day and matching you to the right experience.',
        'Bad knee on descents, prefer no scrambling, celebrating a milestone, anything like that.', false),
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

  function cardWho() {
    var c = cardShell('adventure', true);
    var WHO = [
      { v: 'solo', label: 'Just me' },
      { v: 'partner', label: 'Me and my partner' },
      { v: 'friends', label: 'A group of friends' },
      { v: 'friends_kids', label: 'A group of friends, including kids' },
      { v: 'family_kids', label: 'Family, including kids' }
    ];
    c.render = function (root) {
      var html = '<div class="paf-q"><span class="paf-req">*</span> Who\'s coming?</div>';
      html += '<div class="paf-options" data-field="who"></div>';
      html += '<div class="paf-roster" data-field="roster" style="display:none;">' +
        '<div class="paf-roster-sub">Tell us a little about who\'s coming, including name, age range, and fitness level.</div>' +
        '<div class="paf-roster-rows" data-field="roster_rows"></div>' +
        '<button type="button" class="paf-add-person" data-field="add_person">+ Add person</button>' +
        '</div>';
      root.innerHTML = html;

      var optWrap = root.querySelector('[data-field="who"]');
      var rosterWrap = root.querySelector('[data-field="roster"]');
      var rowsWrap = root.querySelector('[data-field="roster_rows"]');
      var addBtn = root.querySelector('[data-field="add_person"]');

      function addRow(prefill) {
        var row = document.createElement('div');
        row.className = 'paf-roster-row';
        var name = document.createElement('input');
        name.type = 'text'; name.placeholder = 'Name'; name.className = 'paf-roster-input paf-roster-name';
        var age = document.createElement('select');
        age.className = 'paf-roster-input paf-roster-age';
        ['Age range', 'Under 14', '14–18', '18–25', '26–35', '36–45', '46–55', '56–65', '66+'].forEach(function (o, i) {
          var opt = document.createElement('option');
          opt.textContent = o;
          opt.value = i === 0 ? '' : o;
          age.appendChild(opt);
        });
        var fit = document.createElement('select');
        fit.className = 'paf-roster-input paf-roster-fit';
        ['Fitness level', 'Easygoing pace', 'Comfortable hiker', 'Strong / experienced', 'Athlete'].forEach(function (o, i) {
          var opt = document.createElement('option');
          opt.textContent = o;
          opt.value = i === 0 ? '' : o;
          fit.appendChild(opt);
        });
        var del = document.createElement('button');
        del.type = 'button'; del.className = 'paf-roster-del'; del.textContent = '×'; del.title = 'Remove';

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
        del.addEventListener('click', function () {
          var idx = Array.prototype.indexOf.call(rowsWrap.children, row);
          state.answers.q2_roster.splice(idx, 1);
          row.remove();
          refreshNav();
        });

        row.appendChild(name); row.appendChild(age); row.appendChild(fit); row.appendChild(del);
        rowsWrap.appendChild(row);
        sync();
      }

      // "Just me" is exactly one person: no adding, no removing.
      function refreshRosterControls() {
        var isSolo = state.answers.q2_who === 'solo';
        addBtn.style.display = isSolo ? 'none' : '';
        Array.prototype.forEach.call(rowsWrap.querySelectorAll('.paf-roster-del'), function (btn) {
          btn.style.display = isSolo ? 'none' : '';
        });
      }

      addBtn.addEventListener('click', function () { addRow(); });

      WHO.forEach(function (w) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'paf-option-btn';
        b.textContent = w.label;
        if (state.answers.q2_who === w.v) b.classList.add('is-selected');
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(optWrap.children, function (c2) { c2.classList.remove('is-selected'); });
          b.classList.add('is-selected');
          state.answers.q2_who = w.v;
          rosterWrap.style.display = 'block';
          var defaultRows = (w.v === 'solo') ? 1 : 2;
          if (state.answers.q2_roster.length === 0) {
            rowsWrap.innerHTML = '';
            for (var i = 0; i < defaultRows; i++) addRow();
          } else if (w.v === 'solo' && state.answers.q2_roster.length > 1) {
            // "Just me" is unambiguous: trim back down to a single person.
            while (rowsWrap.children.length > 1) {
              rowsWrap.removeChild(rowsWrap.lastChild);
            }
            state.answers.q2_roster = state.answers.q2_roster.slice(0, 1);
          }
          refreshRosterControls();
          refreshNav();
        });
        optWrap.appendChild(b);
      });

      if (state.answers.q2_who) {
        rosterWrap.style.display = 'block';
        rowsWrap.innerHTML = '';
        var defaultRows = (state.answers.q2_who === 'solo') ? 1 : 2;
        var existing = state.answers.q2_roster.length
          ? state.answers.q2_roster.slice()
          : new Array(defaultRows).fill(null);
        state.answers.q2_roster = [];
        existing.forEach(function (p) { addRow(p); });
      }
      refreshRosterControls();
    };
    c.isValid = function () {
      if (!state.answers.q2_who) return false;
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
      html += '<div class="paf-sub" style="margin-top:1.5rem;">Time preference</div>';
      html += '<div class="paf-options" data-field="time"></div>';
      html += '<div class="paf-time-note">Starting after 12pm is not recommended due to heat.</div>';
      root.innerHTML = html;

      var pickerWrap = root.querySelector('[data-field="date-picker"]');
      var trigger = root.querySelector('[data-field="date-trigger"]');
      var calendarEl = root.querySelector('[data-field="calendar"]');

      var today = new Date();
      today.setHours(0, 0, 0, 0);
      var viewDate = state.answers.q3_date ? fromISO(state.answers.q3_date) : new Date(today);
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
          var isPast = thisDate < today;
          var isSelected = state.answers.q3_date === iso;
          var cls = 'paf-cal-day' + (isPast ? ' is-disabled' : '') + (isSelected ? ' is-selected' : '');
          h += '<button type="button" class="' + cls + '" data-date="' + iso + '"' + (isPast ? ' disabled' : '') + '>' + day + '</button>';
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

  var BASE_GEAR_COPY = 'a daypack, trekking poles, 2 Hydro Flask water bottles, electrolytes, trail snacks, sunscreen, and a first aid kit';

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

    if (state.answers.include_after_trail === false) {
      lines.push('You\'ve chosen to keep it trail-only, just the adventure, nothing after.');
    } else {
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
      'Personalized ' + tier.name + ' based on your preferences',
      'Digital route guide with detailed information about your route',
      'Printed route cards with waypoints and landmarks',
      gearCount + ' ' + gearWord + ', including essential gear, snacks, sunscreen, and more for a successful experience',
      'All rental gear delivered and picked up'
    ];
    if (state.answers.include_after_trail !== false) {
      items.push('An "after the trail" experience that rewards your effort and helps you recover in Palm Springs style');
    }
    items.push('Nothing more for you to plan');
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
      html += '<div class="paf-sub">Every booking includes at least one. We default everyone 14 and up to their own kit: ' +
        BASE_GEAR_COPY + ', plus keepsakes to keep.</div>';
      html += '<button type="button" class="paf-kit-disclosure" data-field="disclosure">What\'s inside a gear kit? <span data-field="disclosure-icon">+</span></button>';
      html += '<div class="paf-kit-details" data-field="details" style="display:none;">' +
        '<div class="paf-kit-details-row"><strong>Rental gear:</strong> ' + BASE_GEAR_COPY + '.</div>' +
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
      html += '<input type="tel" class="paf-text-input" data-field="contact_phone" placeholder="Phone" value="' + esc(state.answers.contact_phone) + '">';
      root.innerHTML = html;
      ['contact_name', 'contact_email', 'contact_phone'].forEach(function (f) {
        root.querySelector('[data-field="' + f + '"]').addEventListener('input', function (e) {
          state.answers[f] = e.target.value;
          refreshNav();
        });
      });
    };
    c.isValid = function () {
      return !!state.answers.contact_name.trim() && /\S+@\S+\.\S+/.test(state.answers.contact_email);
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
    // Standard tiers pay inline via the embedded Payment Element below, so
    // no note is needed there since the payment form itself makes it obvious.
    // Custom Experience still needs the explanation since no card is
    // collected on this screen.
    var priceNote = isCustom
      ? 'This is a starting estimate for a multi-day custom experience. We\'ll personally reach out within one business day to build your complete itinerary and finalize pricing before anything is charged.'
      : null;
    var html = '<div class="paf-q">Here\'s your day.</div>';
    html += '<div class="paf-price-card">';
    html += '<div class="paf-price-tier">' + esc(tier.name) + '</div>';
    html += '<div class="paf-price-line"><span>Personalized ' + esc(tier.name) + '</span><span>$' + tier.booking + '</span></div>';
    html += '<div class="paf-price-line"><span>Gear kit × ' + gearCount + '</span><span>$' + (tier.gear * gearCount) + '</span></div>';
    html += '<div class="paf-price-total"><span>' + totalLabel + '</span><span>$' + total + '</span></div>';
    html += '</div>';
    if (!isCustom) {
      html += '<div class="paf-deposit-card">' +
        '<div class="paf-deposit-line"><span>Refundable gear deposit</span><span>$' + depositTotal + '</span></div>' +
        '<div class="paf-deposit-explain">This is a hold on your card, not a charge. It\'s released in full once your gear comes back complete and in working order. If something is missing, lost, or damaged, we deduct replacement cost from this hold first. If the damage or loss is significant, we reserve the right to charge the remaining balance directly to the card on file, up to the kit\'s full retail value of $550, to cover it.</div>' +
        '</div>';
    }
    html += '<button type="button" class="paf-kit-disclosure" data-field="disclosure">What\'s included? <span data-field="disclosure-icon">+</span></button>';
    html += '<div class="paf-kit-details" data-field="details" style="display:none;">' +
      '<div class="paf-kit-details-row">Route selection tailored to your group and the day\'s conditions, built from lived experience on these trails.</div>' +
      '<div class="paf-kit-details-row">Every logistic handled: no permits, no planning, no guesswork.</div>' +
      '<div class="paf-kit-details-row">No-hassle gear delivery and pickup.</div>' +
      '<div class="paf-kit-details-row"><strong>Your gear kit:</strong> ' + BASE_GEAR_COPY + ', plus ' + keepsakeCopy(state.answers.tier) + ' to keep.</div>' +
      '</div>';
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

    root.querySelector('[data-field="reserve"]').addEventListener('click', function () {
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
              placeDepositHoldThenFinish(state.answers.tier, gearCount, pi.id);
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

  // Runs right after the main booking charge succeeds. Places the
  // refundable gear deposit hold on the same card (no second card entry;
  // the server reuses the saved payment method via the Stripe Customer
  // attached to the main PaymentIntent). The outcome here never blocks the
  // booking itself: the guest already paid, so whatever happens with the
  // deposit hold just gets recorded and, if it didn't succeed, needs a
  // manual look before the trip rather than stranding the guest mid-flow.
  function placeDepositHoldThenFinish(tierKey, gearCount, mainPaymentIntentId) {
    var stripe = getStripe();

    fetch('/api/create-deposit-hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: tierKey, gearCount: gearCount, mainPaymentIntentId: mainPaymentIntentId })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.status === 'requires_action' && data.clientSecret && stripe) {
          return stripe.handleNextAction({ clientSecret: data.clientSecret }).then(function (actionResult) {
            var pi = actionResult && actionResult.paymentIntent;
            if (!actionResult.error && pi && pi.status === 'requires_capture') {
              state.answers.depositPaymentIntentId = pi.id;
              state.answers.depositStatus = 'held';
            } else {
              state.answers.depositStatus = 'failed';
            }
          });
        }
        if (data.status === 'succeeded') {
          state.answers.depositPaymentIntentId = data.paymentIntentId;
          state.answers.depositStatus = 'held';
        } else {
          // 'unavailable' (no saved payment method) or 'failed', logged
          // server-side already; just record the outcome here.
          state.answers.depositStatus = data.status || 'failed';
        }
      })
      .catch(function () {
        state.answers.depositStatus = 'error';
      })
      .then(function () {
        submitForm();
      });
  }

  function cardClosing() {
    var c = cardShell('kit', false);
    c.isClosing = true;
    c.render = function (root) {
      var q1Frag = stitchFragment(state.answers.q1);
      var q12Frag = stitchFragment(state.answers.q12);
      var html = '<div class="paf-closing-eyebrow">Reserved</div>';
      html += '<div class="paf-closing-headline">Your adventure is<br>already taking shape.</div>';
      if (q1Frag || q12Frag) {
        html += '<div class="paf-closing-dynamic">';
        if (q1Frag) html += 'You told us <em>"' + esc(q1Frag) + '."</em> ';
        html += "We're building a day designed around exactly that. ";
        if (q12Frag) html += 'And when it\'s done, you\'ll walk away <em>"' + esc(q12Frag) + '."</em>';
        html += '</div>';
      }
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
      who: state.answers.q2_who,
      roster: state.answers.q2_roster,
      headcount: totalHeadcount(),
      date: state.answers.q3_date,
      timePreference: state.answers.q3_time,
      q5_activity: state.answers.q5,
      q6_duration: state.answers.q6,
      q7_notes: state.answers.q7,
      q8_draws: state.answers.q8,
      q12: state.answers.q12,
      q13_recovery: state.answers.q13,
      q14_taste: state.answers.q14,
      dietary_preferences: state.answers.dietary,
      includeAfterTrail: state.answers.include_after_trail,
      gearKitsSelected: selectedGearCount(),
      // Shared delivery duffels, not one per kit: 1 duffel covers up to 2
      // kits, 2 covers 3-4, 3 covers 5-6, and so on (Math.ceil(n/2)).
      duffelCount: Math.ceil(Math.max(selectedGearCount(), 1) / 2),
      contact: {
        name: state.answers.contact_name,
        email: state.answers.contact_email,
        phone: state.answers.contact_phone
      },
      tier: state.answers.tier,
      total: computeTotal(state.answers.tier),
      paymentIntentId: state.answers.paymentIntentId || null,
      paymentStatus: state.answers.paymentStatus || (state.answers.tier === 'custom' ? 'not_charged_custom_quote' : 'unpaid'),
      depositPaymentIntentId: state.answers.depositPaymentIntentId || null,
      depositStatus: state.answers.depositStatus || (state.answers.tier === 'custom' ? 'not_applicable' : null)
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
    if (state.step < cards.length - 1) goToStep(state.step + 1);
  }

  function prev() {
    if (state.step > 0) goToStep(state.step - 1);
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
