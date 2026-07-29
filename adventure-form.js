/* ============================================
   PSAC — Plan Your Day (custom intake flow)
   Replaces the JotForm modal. Vanilla JS, no deps.
   ============================================ */

(function () {

  // ── CONFIG ──────────────────────────────────────
  // TODO(payment): once Stripe is set up, replace the "Reserve" step's
  // submit handler with a redirect to the correct tier's Stripe Payment
  // Link (or a call to a serverless Checkout Session endpoint). Until
  // then we just capture the booking and tell the guest we'll follow up.
  var SUBMIT_ENDPOINT = ""; // paste the Google Apps Script Web App /exec URL here once deployed

  var TIERS = {
    trail:  { key: 'trail',  name: 'Trail Guide',        booking: 100, gear: 65 },
    p2p:    { key: 'p2p',    name: 'Peaks to Pools',     booking: 195, gear: 100 },
    custom: { key: 'custom', name: 'Custom Experience',  booking: 595, gear: 100 }
  };

  var SECTIONS = [
    { id: 'adventure', name: 'Your Adventure' },
    { id: 'move',       name: 'How You Move' },
    { id: 'after',       name: "What You're After" },
    { id: 'kit',         name: 'Your Kit' },
    { id: 'trail',       name: 'After the Trail' }
  ];

  var Q1_STARTERS = [
    "I need a day that's just mine —",
    "We're celebrating —",
    "I've been wanting to do this and I finally —",
    "I want to push myself —",
    "I'm showing someone I love this place —",
    "I just need to be outside and —"
  ];

  var Q12_STARTERS = [
    "Completely emptied out and —",
    "Like I earned something —",
    "Relaxed and —",
    "Proud that I —",
    "Ready to —"
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
      q4: '',
      q5: [],
      q6: null,
      q7: '',
      q8: [],
      q9: '',
      q10: [],
      q11_qty: null,         // gear package quantity, user-adjustable
      q12: null,
      q13: [],
      q14: null,
      q15: '',
      contact_name: '',
      contact_email: '',
      contact_phone: '',
      tier: 'p2p',
      rating: null
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
      cardTextarea('q4', 'move', "What's the most challenging thing you've done outdoors that felt great?",
        "Doesn't have to be epic. Could be a trail, a ride, a climb — anything that pushed you and paid off.", false),
      cardMultiselect('q5', 'move', 'What activity are you planning?', [
        'Hiking', 'Trail running', 'Cycling or gravel riding', 'Jeep or off-road', 'Horseback',
        'Architecture or cultural tour', "Not sure yet — help me decide"
      ], null, false),
      cardSelect('q6', 'move', 'How long do you want to be out?', [
        'A few hours (half day)', 'Full day', 'Sunrise to sunset', 'Overnight or multi-day'
      ], true),
      cardText('q7', 'move', 'Any physical considerations we should know about?',
        'Anything that affects how you move — nothing medical required, just what\'s useful for building your day.',
        'Bad knee on descents, prefer no scrambling, slower pace is fine — anything like that.', false),
      cardMultiselect('q8', 'after', 'What draws you most on a great day out?', [
        'Big views', 'Solitude and quiet', 'Physical challenge', 'Wildlife and nature', 'Interesting geology',
        'Water — streams, pools, falls', 'Photography opportunities', 'Learning about the place',
        'Moving fast', 'Moving slow and taking it all in'
      ], 3, true),
      cardText('q9', 'after', 'Is there anything specific you want to see or do on this adventure?',
        null, 'A summit, a canyon, a specific trail you\'ve heard about — anything on your list.', false),
      cardMultiselect('q10', 'kit', 'What gear are you bringing?', [
        'Hiking boots', 'Trail runners', 'Trekking poles', 'Hydration pack', 'Daypack',
        'Navigation device or GPS', 'Satellite communicator', 'First aid kit', 'Sun protection',
        'Layers for elevation change', "I'm not sure what I need yet"
      ], null, false),
      cardGearQty(),
      cardStitch('q12', 'trail', 'At the end of this day, I want to feel —', Q12_STARTERS, true, null,
        "Now let's talk about the other half of your day."),
      cardMultiselect('q13', 'trail', 'What does recovery look like for you?', [
        'A pool somewhere beautiful', 'A long cold drink', 'A proper meal', 'A spa or body treatment',
        'Back to the hotel and horizontal', 'Getting back on the road', "I'm open to whatever you recommend"
      ], null, false),
      cardSelect('q14', 'trail', 'How would you describe your taste for the recovery experience?', [
        'Simple and restorative', 'Comfortable and easy', 'Elevated and indulgent', 'Surprise me'
      ], true),
      cardTextarea('q15', 'trail', 'Anything else we should know to make this day exactly right?',
        'This is your space. Anything at all.', false),
      cardContact(),
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
      html += '<div class="paf-q">' + esc(text) + (required ? ' <span class="paf-req">*</span>' : '') + '</div>';
      if (subtext) html += '<div class="paf-sub">' + esc(subtext) + '</div>';
      html += '<div class="paf-starters" data-field="' + id + '_starters"></div>';
      html += '<div class="paf-stitch-line"><span class="paf-stitch-prefix" data-field="' + id + '_prefix">Pick a line above to begin your sentence</span>' +
        '<input type="text" class="paf-stitch-input" data-field="' + id + '_text" placeholder="keep typing…" style="display:none;"></div>';
      root.innerHTML = html;

      var starterWrap = root.querySelector('[data-field="' + id + '_starters"]');
      var prefixEl = root.querySelector('[data-field="' + id + '_prefix"]');
      var inputEl = root.querySelector('[data-field="' + id + '_text"]');
      var current = state.answers[id];

      starters.forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'paf-starter-btn';
        b.textContent = s.replace(' —', '');
        if (current && current.starter === s) b.classList.add('is-selected');
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(starterWrap.children, function (c2) { c2.classList.remove('is-selected'); });
          b.classList.add('is-selected');
          state.answers[id] = { starter: s, text: (state.answers[id] && state.answers[id].text) || '' };
          prefixEl.textContent = s + ' ';
          prefixEl.classList.add('is-active');
          inputEl.style.display = 'inline-block';
          inputEl.value = state.answers[id].text;
          inputEl.focus();
          refreshNav();
        });
        starterWrap.appendChild(b);
      });

      if (current) {
        prefixEl.textContent = current.starter + ' ';
        prefixEl.classList.add('is-active');
        inputEl.style.display = 'inline-block';
        inputEl.value = current.text || '';
      }

      inputEl.addEventListener('input', function () {
        if (!state.answers[id]) return;
        state.answers[id].text = inputEl.value;
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
      var html = '<div class="paf-q">Who\'s coming? <span class="paf-req">*</span></div>';
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
        ['Age range', '14–18', '18–25', '26–35', '36–45', '46–55', '56–65', '66+'].forEach(function (o, i) {
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

        if (prefill) {
          name.value = prefill.name || '';
          if (prefill.age) age.value = prefill.age;
          if (prefill.fitness) fit.value = prefill.fitness;
        }

        function sync() {
          var data = { name: name.value, age: age.value, fitness: fit.value };
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

      // "Just me" is exactly one person — no adding, no removing.
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
            // "Just me" is unambiguous — trim back down to a single person.
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
      var html = '<div class="paf-q">When are you going? <span class="paf-req">*</span></div>';
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

  function cardTextarea(id, section, text, placeholder, required) {
    var c = cardShell(section, required);
    c.render = function (root) {
      var html = '<div class="paf-q">' + esc(text) + (required ? ' <span class="paf-req">*</span>' : '') + '</div>';
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
      var html = '<div class="paf-q">' + esc(text) + (required ? ' <span class="paf-req">*</span>' : '') + '</div>';
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

  function cardSelect(id, section, text, options, required) {
    var c = cardShell(section, required);
    c.render = function (root) {
      var html = '<div class="paf-q">' + esc(text) + (required ? ' <span class="paf-req">*</span>' : '') + '</div>';
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
          refreshNav();
        });
        wrap.appendChild(b);
      });
    };
    c.isValid = function () { return !required || !!state.answers[id]; };
    return c;
  }

  function cardMultiselect(id, section, text, options, max, required) {
    var c = cardShell(section, required);
    c.render = function (root) {
      var subtext = max ? ('Pick up to ' + max + '.') : null;
      var html = '<div class="paf-q">' + esc(text) + (required ? ' <span class="paf-req">*</span>' : '') + '</div>';
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

  function recommendedGearQty() {
    // The roster is collected for every "who's coming" option now, and the
    // age range picker starts at 14+, so every filled-in roster row is a
    // teen/adult and gets its own recommended gear package.
    var roster = state.answers.q2_roster.filter(function (p) { return p && (p.name || p.age); });
    return Math.max(roster.length, 1);
  }

  function totalHeadcount() {
    var roster = state.answers.q2_roster.filter(function (p) { return p && (p.name || p.age); });
    return Math.max(roster.length, 1);
  }

  function cardGearQty() {
    var c = cardShell('kit', true);
    c.render = function (root) {
      if (state.answers.q11_qty === null) state.answers.q11_qty = recommendedGearQty();
      var html = '<div class="paf-q">How many gear packages would you like?</div>';
      html += '<div class="paf-sub">Every booking includes at least one. We recommend one per teen or adult in your group, so everyone has their own water, electrolytes, sunscreen, and keepsakes. Share if you\'d like — just adjust below.</div>';
      html += '<div class="paf-stepper">' +
        '<button type="button" class="paf-stepper-btn" data-field="minus">−</button>' +
        '<span class="paf-stepper-value" data-field="value">' + state.answers.q11_qty + '</span>' +
        '<button type="button" class="paf-stepper-btn" data-field="plus">+</button>' +
        '</div>';
      root.innerHTML = html;
      var valueEl = root.querySelector('[data-field="value"]');
      root.querySelector('[data-field="minus"]').addEventListener('click', function () {
        state.answers.q11_qty = Math.max(1, state.answers.q11_qty - 1);
        valueEl.textContent = state.answers.q11_qty;
      });
      root.querySelector('[data-field="plus"]').addEventListener('click', function () {
        state.answers.q11_qty = state.answers.q11_qty + 1;
        valueEl.textContent = state.answers.q11_qty;
      });
    };
    c.isValid = function () { return state.answers.q11_qty >= 1; };
    return c;
  }

  function cardContact() {
    var c = cardShell('trail', true);
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
    return tier.booking + tier.gear * state.answers.q11_qty;
  }

  function cardPricing() {
    var c = cardShell('trail', false);
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
    var html = '<div class="paf-q">Here\'s your day.</div>';
    html += '<div class="paf-price-card">';
    html += '<div class="paf-price-tier">' + esc(tier.name) + '</div>';
    html += '<div class="paf-price-line"><span>Booking fee</span><span>$' + tier.booking + '</span></div>';
    html += '<div class="paf-price-line"><span>Gear package × ' + state.answers.q11_qty + '</span><span>$' + (tier.gear * state.answers.q11_qty) + '</span></div>';
    html += '<div class="paf-price-total"><span>Total</span><span>$' + total + '</span></div>';
    html += '</div>';
    html += '<div class="paf-price-switch">Prefer something else? ' +
      '<a href="#" data-tier="trail">Trail Guide</a> · <a href="#" data-tier="p2p">Peaks to Pools</a> · <a href="#" data-tier="custom">Custom Experience</a></div>';
    html += '<button type="button" class="paf-reserve-btn" data-field="reserve">Reserve My Spot</button>';
    html += '<div class="paf-price-note">Payment is being finalized. You will not be charged yet — we\'ll follow up within one business day to confirm your date and collect payment.</div>';
    root.innerHTML = html;

    Array.prototype.forEach.call(root.querySelectorAll('[data-tier]'), function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        state.answers.tier = a.getAttribute('data-tier');
        renderPricing(root);
      });
    });

    root.querySelector('[data-field="reserve"]').addEventListener('click', function () {
      submitForm();
    });
  }

  function cardClosing() {
    var c = cardShell('trail', false);
    c.isClosing = true;
    c.render = function (root) {
      var q1 = state.answers.q1;
      var q12 = state.answers.q12;
      var q1Frag = q1 ? (q1.starter + ' ' + (q1.text || '')).trim() : '';
      var q12Frag = q12 ? (q12.starter + ' ' + (q12.text || '')).trim() : '';
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
      q4_experience: state.answers.q4,
      q5_activity: state.answers.q5,
      q6_duration: state.answers.q6,
      q7_physical: state.answers.q7,
      q8_draws: state.answers.q8,
      q9_specific: state.answers.q9,
      q10_gear_owned: state.answers.q10,
      q11_gear_packages: state.answers.q11_qty,
      q12: state.answers.q12,
      q13_recovery: state.answers.q13,
      q14_taste: state.answers.q14,
      q15_other: state.answers.q15,
      contact: {
        name: state.answers.contact_name,
        email: state.answers.contact_email,
        phone: state.answers.contact_phone
      },
      tier: state.answers.tier,
      total: computeTotal(state.answers.tier)
    };
  }

  function submitForm() {
    var payload = buildPayload();
    if (SUBMIT_ENDPOINT) {
      try {
        fetch(SUBMIT_ENDPOINT, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        });
      } catch (e) { /* fail silently, still show closing screen */ }
    }
    goToStep(cards.length - 1);
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
