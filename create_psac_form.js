#!/usr/bin/env node

/**
 * PSAC Consultation Intake Form — JotForm API Builder
 * ─────────────────────────────────────────────────────
 * Creates the full card form via the JotForm API.
 * Conditional logic must be added manually afterward (8 rules, ~10 min).
 *
 * USAGE:
 *   1. Paste your JotForm API key below (or set env var JOTFORM_API_KEY)
 *   2. Run:  node create_psac_form.js
 *   3. Copy the Form ID printed at the end
 *   4. Add conditional logic manually — see instructions printed at the end
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const API_KEY  = process.env.JOTFORM_API_KEY || 'YOUR_API_KEY_HERE';
const BASE_URL = 'https://api.jotform.com';

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function api(method, path, body = null) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      'APIKEY': API_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (body) {
    opts.body = Object.entries(body)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }
  const res  = await fetch(url, opts);
  const data = await res.json();
  if (data.responseCode !== 200) {
    throw new Error(`API error on ${method} ${path}: ${JSON.stringify(data)}`);
  }
  return data.content;
}

// Add a question to the form; returns the question id
async function addQuestion(formId, order, qDef) {
  const body = {};
  body['question[type]']  = qDef.type;
  body['question[text]']  = qDef.text;
  body['question[order]'] = String(order);
  if (qDef.required)      body['question[required]']    = 'Yes';
  if (qDef.options)       body['question[options]']     = qDef.options;
  if (qDef.allowOther)    body['question[allowOther]']  = 'Yes';
  if (qDef.hint)          body['question[hint]']        = qDef.hint;
  if (qDef.subLabel)      body['question[subLabel]']    = qDef.subLabel;
  if (qDef.description)   body['question[description]'] = qDef.description;
  if (qDef.columns)       body['question[columns]']     = qDef.columns; // fullname sub-labels

  const result = await api('POST', `/form/${formId}/questions`, body);
  // result is an object keyed by qid
  const qid = Object.keys(result)[0];
  return qid;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  if (API_KEY === 'YOUR_API_KEY_HERE') {
    console.error('\n❌  Please set your API key at the top of this file or via JOTFORM_API_KEY env var.\n');
    process.exit(1);
  }

  console.log('\n🏔  Palm Springs Adventure Club — JotForm Builder');
  console.log('─'.repeat(52));

  // ── Step 1: Verify API key ────────────────────────────────
  console.log('\n1/3  Verifying API key…');
  const user = await api('GET', `/user?apiKey=${API_KEY}`);
  console.log(`     ✓ Authenticated as: ${user.username || user.email}`);

  // ── Step 2: Create the form ───────────────────────────────
  console.log('\n2/3  Creating form…');
  const formBody = {
    'questions[0][type]':  'control_head',
    'questions[0][text]':  'PSAC Consultation Intake',
    'questions[0][order]': '1',
    'properties[title]':   'PSAC Consultation Intake',
    'properties[formType]': 'cardForm',
  };
  const form    = await api('POST', '/user/forms', formBody);
  const formId  = form.id;
  console.log(`     ✓ Form created. ID: ${formId}`);
  console.log(`     🔗 https://www.jotform.com/build/${formId}`);

  // ── Step 3: Add questions ─────────────────────────────────
  console.log('\n3/3  Adding questions…');

  const qids = {}; // named map so we can reference them in the logic printout

  // ── SECTION 1: THE BASICS ──────────────────────────────────

  console.log('     Adding Section 1: The Basics…');

  // Card 1 — Full Name
  qids.name = await addQuestion(formId, 1, {
    type:     'control_fullname',
    text:     "First, let's get acquainted. What's your name?",
    required: true,
  });
  await sleep(300);

  // Card 2 — Email
  qids.email = await addQuestion(formId, 2, {
    type:     'control_email',
    text:     'How should I reach you?',
    required: true,
    hint:     'Your email address',
  });
  await sleep(300);

  // Card 3 — Phone
  qids.phone = await addQuestion(formId, 3, {
    type:        'control_phone',
    text:        'Phone number?',
    required:    false,
    description: 'Totally optional — email works great too.',
    subLabel:    'Optional — for a quick follow-up call if needed',
  });
  await sleep(300);

  // Card 4 — Referral source
  qids.referral = await addQuestion(formId, 4, {
    type:     'control_dropdown',
    text:     'How did you find us?',
    required: false,
    options:  'Instagram|Google Search|Friend or referral|On the trail|Other',
  });
  await sleep(300);

  // ── SECTION 2: YOUR ADVENTURE ──────────────────────────────

  console.log('     Adding Section 2: Your Adventure…');

  // Card 5 — Consultation type (BRANCH POINT)
  qids.consultationType = await addQuestion(formId, 5, {
    type:     'control_radio',
    text:     'What kind of planning are you looking for?',
    required: true,
    options:  'Day Trip Planning — $75|Weekend Expedition — $150|Seasonal Strategy — $300|Not sure yet — help me figure it out',
    description: 'This determines which questions come next.',
  });
  await sleep(300);

  // Card 6 — Activities
  qids.activities = await addQuestion(formId, 6, {
    type:     'control_checkbox',
    text:     'What activities are you planning?',
    required: true,
    options:  'Hiking|Trail Running|Camping / Backpacking|Road Cycling / Gravel|Not sure yet',
  });
  await sleep(300);

  // Card 7 — Group size
  qids.groupSize = await addQuestion(formId, 7, {
    type:     'control_dropdown',
    text:     'How many people are adventuring?',
    required: true,
    options:  'Just me|2–4 people|5–8 people|9 or more',
  });
  await sleep(300);

  // Card 8 — Timing
  qids.timing = await addQuestion(formId, 8, {
    type:     'control_dropdown',
    text:     'When are you thinking?',
    required: true,
    options:  'Within 2 weeks|Within a month|2–3 months out|Just exploring for now',
  });
  await sleep(300);

  // ── SECTION 3A: STANDARD PATH ──────────────────────────────
  // Shown for: Day Trip / Weekend Expedition / Not sure yet

  console.log('     Adding Section 3A: Standard Path…');

  // Card 9 — Experience level
  qids.experience = await addQuestion(formId, 9, {
    type:     'control_radio',
    text:     'How would you describe your experience level?',
    required: true,
    options:  'New to this|Some experience|Pretty seasoned|I do this regularly',
  });
  await sleep(300);

  // Card 10 — Physical considerations
  qids.physical = await addQuestion(formId, 10, {
    type:        'control_textarea',
    text:        'Anything physical I should know about?',
    required:    false,
    hint:        'Injuries, limitations, or anything I should plan around',
    description: 'Completely optional — only share what\'s relevant to your adventure.',
  });
  await sleep(300);

  // Card 11 — Top priority
  qids.priority = await addQuestion(formId, 11, {
    type:     'control_radio',
    text:     "What's your #1 priority for this adventure?",
    required: true,
    options:  'Scenic beauty|Physical challenge|New terrain|Group bonding|A bit of everything',
  });
  await sleep(300);

  // Card 12 — Anything else
  qids.notes = await addQuestion(formId, 12, {
    type:        'control_textarea',
    text:        'Anything else I should know?',
    required:    false,
    hint:        'Special occasions, gear questions, logistics — anything goes',
    description: 'This is your space — no detail is too small.',
  });
  await sleep(300);

  // ── SECTION 3B: SEASONAL PATH ──────────────────────────────
  // Shown only for: Seasonal Strategy

  console.log('     Adding Section 3B: Seasonal Strategy Path…');

  // Card 9B — Seasons
  qids.seasons = await addQuestion(formId, 13, {
    type:     'control_checkbox',
    text:     "What season(s) are you planning for?",
    required: true,
    options:  'Spring|Summer|Fall|Winter',
  });
  await sleep(300);

  // Card 10B — Local or visiting
  qids.visitorStatus = await addQuestion(formId, 14, {
    type:     'control_radio',
    text:     'Are you local or visiting?',
    required: true,
    options:  "A Palm Springs local|Visiting for a trip|Planning a future trip",
  });
  await sleep(300);

  // Card 11B — Gear budget
  qids.gearBudget = await addQuestion(formId, 15, {
    type:     'control_dropdown',
    text:     "What's your rough gear rental budget for the season?",
    required: false,
    options:  'Under $200|$200–$500|$500 or more|Not sure yet',
  });
  await sleep(300);

  // Card 12B — Season vision
  qids.seasonVision = await addQuestion(formId, 16, {
    type:        'control_textarea',
    text:        'What would a successful season look like for you?',
    required:    true,
    hint:        'Tell me what a great season looks like for you',
    description: 'This is the most important question for seasonal planning — take your time.',
  });
  await sleep(300);

  // ── Done ──────────────────────────────────────────────────
  console.log('\n✅  Form created successfully!\n');
  console.log('═'.repeat(52));
  console.log(`  Form ID:  ${formId}`);
  console.log(`  Edit URL: https://www.jotform.com/build/${formId}`);
  console.log(`  View URL: https://form.jotform.com/${formId}`);
  console.log('═'.repeat(52));

  // ── Conditional logic instructions ───────────────────────
  console.log(`
┌─────────────────────────────────────────────────────┐
│  MANUAL STEP: Add Conditional Logic (8 rules)       │
│  Settings → Conditions → Add a New Condition        │
│  → Show / Hide Field                                │
└─────────────────────────────────────────────────────┘

Open your form at: https://www.jotform.com/build/${formId}

The branch question is:
  "${qids.consultationType}" — "What kind of planning are you looking for?"

──────────────────────────────────────────────────────
RULES FOR STANDARD PATH (Cards 9–12)
Apply to each of these 4 fields:
  - Experience level
  - Physical considerations
  - Top priority
  - Anything else I should know?

Rule:
  IF  [Consultation type]  Is Not Equal To  "Seasonal Strategy — $300"
  THEN  Show  [that field]

(4 rules total, one per field — same condition on each)

──────────────────────────────────────────────────────
RULES FOR SEASONAL PATH (Cards 9B–12B)
Apply to each of these 4 fields:
  - Season(s)
  - Are you local or visiting?
  - Gear rental budget
  - What would a successful season look like?

Rule:
  IF  [Consultation type]  Is Equal To  "Seasonal Strategy — $300"
  THEN  Show  [that field]

(4 rules total, one per field — same condition on each)

──────────────────────────────────────────────────────
TIP: All 8 rules use the same branch question.
     Takes ~10 minutes in the UI.

──────────────────────────────────────────────────────
ALSO CONFIGURE:
  • Settings → Thank You Page
      Heading: "You're on your way."
      Body:    "I've got your details and I'll be in touch within
                48 hours with next steps."
  • Settings → Emails
      Add notification email to yourself
      Add confirmation email to respondent
  • Customize → Brand colors
      Background:    #F8F1E9
      Button:        #7ABD91
      Button text:   #FFFFFF
      Progress bar:  #E27396
      Question text: #2A4747
  • Upload logo: images/logo.svg from your repo

──────────────────────────────────────────────────────
NEXT STEP:
  Copy Form ID: ${formId}
  Share it here to wire the modal into your website.
──────────────────────────────────────────────────────
`);
}

main().catch(err => {
  console.error('\n❌  Error:', err.message);
  process.exit(1);
});
