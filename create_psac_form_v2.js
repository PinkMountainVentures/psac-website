#!/usr/bin/env node

/**
 * PSAC Consultation Intake Form — JotForm API Builder v2
 * ───────────────────────────────────────────────────────
 * Creates the full card form via the JotForm API.
 * Three consultation tiers:
 *   - Trail Guide ($90)
 *   - Peaks to Pools Guide ($180)
 *   - Custom Experience (from $540) — branches into Group/Corporate vs Multi-day
 *
 * Conditional logic must be added manually after running (instructions printed at end).
 *
 * USAGE:
 *   JOTFORM_API_KEY=your_key_here node create_psac_form_v2.js
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const API_KEY  = process.env.JOTFORM_API_KEY || 'YOUR_API_KEY_HERE';
const BASE_URL = 'https://api.jotform.com';

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function api(method, path, body = null) {
  const url  = `${BASE_URL}${path}`;
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

async function addQuestion(formId, order, qDef) {
  const body = {};
  body['question[type]']        = qDef.type;
  body['question[text]']        = qDef.text;
  body['question[order]']       = String(order);
  if (qDef.required)     body['question[required]']    = 'Yes';
  if (qDef.options)      body['question[options]']     = qDef.options;
  if (qDef.hint)         body['question[hint]']        = qDef.hint;
  if (qDef.description)  body['question[description]'] = qDef.description;
  if (qDef.subLabel)     body['question[subLabel]']    = qDef.subLabel;

  const result = await api('POST', `/form/${formId}/questions`, body);
  const qid    = Object.keys(result)[0];
  process.stdout.write(` [Q${order}:${qid}]`);
  return qid;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── QUESTION DEFINITIONS ─────────────────────────────────────────────────────
// order values are sequential — JotForm renders cards in this order

const QUESTIONS = [

  // ── SECTION 1: THE BASICS (all paths) ──────────────────────────────────────

  {
    key: 'name', order: 1,
    type: 'control_fullname',
    text: "Let's get started. What's your name?",
    required: true,
  },
  {
    key: 'email', order: 2,
    type: 'control_email',
    text: 'How should I reach you?',
    required: true,
    hint: 'Your email address',
  },
  {
    key: 'phone', order: 3,
    type: 'control_phone',
    text: 'Phone number?',
    required: false,
    description: 'Totally optional — email works great too.',
    subLabel: 'Optional — for a quick follow-up call if needed',
  },
  {
    key: 'referral', order: 4,
    type: 'control_dropdown',
    text: 'How did you find us?',
    required: false,
    options: 'Instagram|Google Search|Friend or referral|On the trail|Other',
  },

  // ── SECTION 2: YOUR ADVENTURE (all paths) ──────────────────────────────────

  {
    key: 'guideType', order: 5,
    type: 'control_radio',
    text: 'What are you looking to plan?',
    required: true,
    options: 'Trail Guide — $90 · The right outing for an exceptional day|Peaks to Pools Guide — $180 · Your full day, from adventure to recovery|Custom Experience — from $540 · Something multi-day, group, or truly unique|Not sure yet — help me figure it out',
    description: 'Not sure? Pick the closest option and tell us more at the end.',
  },
  {
    key: 'activityType', order: 6,
    type: 'control_checkbox',
    text: "What kind of experience are you after?",
    required: true,
    options: 'Hiking|Trail Running|Camping / Backpacking|Road Cycling / Gravel|Guided tour (Jeep, horseback, etc.)|Not sure yet',
  },
  {
    key: 'groupSize', order: 7,
    type: 'control_dropdown',
    text: 'How many people are adventuring?',
    required: true,
    options: 'Just me|2–4 people|5–8 people|9 or more',
  },
  {
    key: 'timing', order: 8,
    type: 'control_dropdown',
    text: 'When are you thinking?',
    required: true,
    options: 'Within 2 weeks|Within a month|2–3 months out|Just exploring for now',
  },

  // ── SECTION 3A: TRAIL GUIDE PATH ───────────────────────────────────────────
  // Shown when: guideType = Trail Guide OR Not sure yet

  {
    key: 'tg_experience', order: 9,
    type: 'control_radio',
    text: 'How would you describe your experience level?',
    required: true,
    options: 'New to this|Some experience|Pretty seasoned|I do this regularly',
  },
  {
    key: 'tg_physical', order: 10,
    type: 'control_textarea',
    text: 'Anything physical I should know about?',
    required: false,
    hint: 'Injuries, limitations, or anything I should plan around',
    description: 'Completely optional — only share what\'s relevant.',
  },
  {
    key: 'tg_priority', order: 11,
    type: 'control_radio',
    text: "What's most important to you for this outing?",
    required: true,
    options: 'Scenic beauty|Physical challenge|New terrain|Great for a group|A bit of everything',
  },
  {
    key: 'tg_notes', order: 12,
    type: 'control_textarea',
    text: 'Anything else I should know?',
    required: false,
    hint: 'Special occasion, gear questions, logistics — anything goes',
    description: 'This is your space — no detail is too small.',
  },

  // ── SECTION 3B: PEAKS TO POOLS GUIDE PATH ──────────────────────────────────
  // Shown when: guideType = Peaks to Pools Guide

  {
    key: 'p2p_experience', order: 13,
    type: 'control_radio',
    text: 'How would you describe your experience level?',
    required: true,
    options: 'New to this|Some experience|Pretty seasoned|I do this regularly',
  },
  {
    key: 'p2p_physical', order: 14,
    type: 'control_textarea',
    text: 'Anything physical I should know about?',
    required: false,
    hint: 'Injuries, limitations, or anything I should plan around',
    description: 'Completely optional — only share what\'s relevant.',
  },
  {
    key: 'p2p_priority', order: 15,
    type: 'control_radio',
    text: "What's most important to you for the outdoor portion?",
    required: true,
    options: 'Scenic beauty|Physical challenge|New terrain|Great for a group|A bit of everything',
  },
  {
    key: 'p2p_recovery', order: 16,
    type: 'control_checkbox',
    text: 'What kind of recovery experience are you looking for after?',
    required: true,
    options: 'Poolside / resort|Dining|Spa or wellness|Active recovery (yoga, float, etc.)|Open to suggestions',
  },
  {
    key: 'p2p_budget', order: 17,
    type: 'control_dropdown',
    text: 'What\'s your rough budget for the recovery portion?',
    required: false,
    options: 'Under $50 per person|$50–$100 per person|$100–$200 per person|$200+ per person|Not sure yet',
  },
  {
    key: 'p2p_vibe', order: 18,
    type: 'control_radio',
    text: "What's the occasion or vibe?",
    required: true,
    options: 'Pure celebration|Unwinding and recharging|Impressing someone|Romantic getaway|Just a great day out',
  },
  {
    key: 'p2p_dietary', order: 19,
    type: 'control_textarea',
    text: 'Any dietary preferences or restrictions I should know about?',
    required: false,
    hint: 'Vegetarian, allergies, no gluten, etc.',
    description: 'Helps me match the right dining and recovery recommendations.',
  },
  {
    key: 'p2p_notes', order: 20,
    type: 'control_textarea',
    text: 'Anything else I should know?',
    required: false,
    hint: 'Special occasion details, specific places you love or want to avoid — anything',
  },

  // ── SECTION 3C: CUSTOM EXPERIENCE — GROUP / CORPORATE PATH ─────────────────
  // Shown when: guideType = Custom Experience AND customType = Group / Corporate

  {
    key: 'cx_type', order: 21,
    type: 'control_radio',
    text: 'What kind of custom experience are you planning?',
    required: true,
    options: 'Group or corporate event|Multi-day trip or expedition',
    description: 'Your answer determines which questions come next.',
  },
  {
    key: 'cx_corp_groupSize', order: 22,
    type: 'control_dropdown',
    text: 'How many people in the group?',
    required: true,
    options: '5–10|11–20|21–50|50+|Not sure yet',
  },
  {
    key: 'cx_corp_goals', order: 23,
    type: 'control_checkbox',
    text: 'What are the primary goals for this event?',
    required: true,
    options: 'Team bonding|Client entertainment|Company retreat|Celebration or milestone|Other',
  },
  {
    key: 'cx_corp_format', order: 24,
    type: 'control_checkbox',
    text: 'What format are you imagining?',
    required: false,
    options: 'Guided outdoor activity|Competitive challenge|Relaxed group outing|Mix of outdoor and dining/social|Fully custom — tell me below',
  },
  {
    key: 'cx_corp_budget', order: 25,
    type: 'control_dropdown',
    text: 'What\'s your approximate total budget?',
    required: false,
    options: 'Under $2,500|$2,500–$5,000|$5,000–$10,000|$10,000+|Not sure yet',
  },
  {
    key: 'cx_corp_vision', order: 26,
    type: 'control_textarea',
    text: 'Tell me what you\'re imagining.',
    required: true,
    hint: 'The more detail the better — theme, feel, must-haves, things to avoid',
  },

  // ── SECTION 3D: CUSTOM EXPERIENCE — MULTI-DAY PATH ─────────────────────────
  // Shown when: guideType = Custom Experience AND customType = Multi-day

  {
    key: 'cx_multi_days', order: 27,
    type: 'control_dropdown',
    text: 'How many days are you planning for?',
    required: true,
    options: '2 days|3 days|4–5 days|6+ days|Not sure yet',
  },
  {
    key: 'cx_multi_activities', order: 28,
    type: 'control_checkbox',
    text: 'What activities are you thinking across the trip?',
    required: true,
    options: 'Hiking|Trail Running|Backpacking / Camping|Road Cycling / Gravel|Guided tour (Jeep, horseback, etc.)|Mix — help me plan it',
  },
  {
    key: 'cx_multi_basecamp', order: 29,
    type: 'control_radio',
    text: 'Where do you want to be based?',
    required: false,
    options: 'Palm Springs / Coachella Valley|Camping / backcountry|Mix of both|Not sure yet',
  },
  {
    key: 'cx_multi_budget', order: 30,
    type: 'control_dropdown',
    text: 'What\'s your rough budget per person?',
    required: false,
    options: 'Under $500|$500–$1,000|$1,000–$2,500|$2,500+|Not sure yet',
  },
  {
    key: 'cx_multi_vision', order: 31,
    type: 'control_textarea',
    text: 'What does your ideal trip look like?',
    required: true,
    hint: 'Physical goals, must-see places, pace, recovery time — anything that matters to you',
    description: 'This is the most important question. Take your time.',
  },

];

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  if (API_KEY === 'YOUR_API_KEY_HERE') {
    console.error('\n❌  Please set your API key:\n    JOTFORM_API_KEY=your_key_here node create_psac_form_v2.js\n');
    process.exit(1);
  }

  console.log('\n🏔  Palm Springs Adventure Club — JotForm Builder v2');
  console.log('─'.repeat(54));

  // Verify API key
  console.log('\n1/3  Verifying API key…');
  const user = await api('GET', `/user?apiKey=${API_KEY}`);
  console.log(`     ✓ Authenticated as: ${user.username || user.email}`);

  // Create form
  console.log('\n2/3  Creating form…');
  const formBody = {
    'questions[0][type]':   'control_head',
    'questions[0][text]':   'PSAC Adventure Intake',
    'questions[0][order]':  '1',
    'properties[title]':    'PSAC Adventure Intake',
    'properties[formType]': 'cardForm',
  };
  const form   = await api('POST', '/user/forms', formBody);
  const formId = form.id;
  console.log(`     ✓ Form created. ID: ${formId}`);
  console.log(`     🔗 https://www.jotform.com/build/${formId}`);

  // Add all questions
  console.log('\n3/3  Adding questions…');
  const qids = {};

  const sections = [
    { label: 'Section 1: The Basics',                    keys: ['name','email','phone','referral'] },
    { label: 'Section 2: Your Adventure',                keys: ['guideType','activityType','groupSize','timing'] },
    { label: 'Section 3A: Trail Guide path',             keys: ['tg_experience','tg_physical','tg_priority','tg_notes'] },
    { label: 'Section 3B: Peaks to Pools path',          keys: ['p2p_experience','p2p_physical','p2p_priority','p2p_recovery','p2p_budget','p2p_vibe','p2p_dietary','p2p_notes'] },
    { label: 'Section 3C: Custom — Group/Corporate',     keys: ['cx_type','cx_corp_groupSize','cx_corp_goals','cx_corp_format','cx_corp_budget','cx_corp_vision'] },
    { label: 'Section 3D: Custom — Multi-day',           keys: ['cx_multi_days','cx_multi_activities','cx_multi_basecamp','cx_multi_budget','cx_multi_vision'] },
  ];

  for (const section of sections) {
    process.stdout.write(`\n     ${section.label}…`);
    for (const key of section.keys) {
      const qDef = QUESTIONS.find(q => q.key === key);
      qids[key]  = await addQuestion(formId, qDef.order, qDef);
      await sleep(350);
    }
  }

  console.log('\n\n✅  All questions added successfully!\n');
  console.log('═'.repeat(54));
  console.log(`  Form ID:  ${formId}`);
  console.log(`  Edit URL: https://www.jotform.com/build/${formId}`);
  console.log(`  View URL: https://form.jotform.com/${formId}`);
  console.log('═'.repeat(54));

  // ── Conditional logic instructions ───────────────────────────────────────
  console.log(`
┌──────────────────────────────────────────────────────────┐
│  MANUAL STEP: Add Conditional Logic                      │
│  Open form → Settings → Conditions → Add New Condition  │
│  → Show / Hide Field                                     │
└──────────────────────────────────────────────────────────┘

The two branch questions are:
  (A) "What are you looking to plan?"         — Guide type selector
  (B) "What kind of custom experience?"       — Custom sub-type selector

──────────────────────────────────────────────────────────
BLOCK 1 — TRAIL GUIDE PATH (4 rules)
Fields: experience level, physical considerations,
        top priority, anything else (tg_* fields)

IF   [What are you looking to plan?]
     Is Equal To  "Trail Guide — $90 · The right outing..."
     OR Is Equal To  "Not sure yet — help me figure it out"
THEN Show [that field]

Apply the same rule to all 4 tg_* fields.

──────────────────────────────────────────────────────────
BLOCK 2 — PEAKS TO POOLS PATH (8 rules)
Fields: experience, physical, priority, recovery type,
        budget, vibe, dietary, notes (p2p_* fields)

IF   [What are you looking to plan?]
     Is Equal To  "Peaks to Pools Guide — $180..."
THEN Show [that field]

Apply to all 8 p2p_* fields.

──────────────────────────────────────────────────────────
BLOCK 3 — CUSTOM EXPERIENCE ENTRY (1 rule)
Field: "What kind of custom experience are you planning?"

IF   [What are you looking to plan?]
     Is Equal To  "Custom Experience — from $540..."
THEN Show [cx_type field]

──────────────────────────────────────────────────────────
BLOCK 4 — CUSTOM GROUP/CORPORATE PATH (5 rules)
Fields: group size, goals, format, budget, vision
        (cx_corp_* fields)

IF   [What kind of custom experience?]
     Is Equal To  "Group or corporate event"
THEN Show [that field]

Apply to all 5 cx_corp_* fields.

──────────────────────────────────────────────────────────
BLOCK 5 — CUSTOM MULTI-DAY PATH (5 rules)
Fields: days, activities, basecamp, budget, vision
        (cx_multi_* fields)

IF   [What kind of custom experience?]
     Is Equal To  "Multi-day trip or expedition"
THEN Show [that field]

Apply to all 5 cx_multi_* fields.

──────────────────────────────────────────────────────────
TOTAL: 23 rules across 5 blocks. Budget ~20 minutes.

──────────────────────────────────────────────────────────
ALSO CONFIGURE:
  • Settings → Thank You Page
      Heading: "You're on your way."
      Body:    "I've got your details and I'll be in touch
                within 48 hours with next steps."

  • Settings → Emails
      - Notification to yourself for every submission
      - Confirmation to respondent with 48-hr follow-up note

  • Customize → Brand colors
      Background:    #F8F1E9  (Sand Beige)
      Button:        #7ABD91  (Desert Green)
      Button text:   #FFFFFF
      Progress bar:  #E27396  (Mountain Pink)
      Question text: #2A4747  (Dark Pine)

  • Upload logo: images/logo.svg from your repo

──────────────────────────────────────────────────────────
NEXT STEP AFTER FORM IS DONE:
  Share Form ID ${formId} here and we'll update
  index.html with the new tier names + wire the modal.
──────────────────────────────────────────────────────────
`);
}

main().catch(err => {
  console.error('\n❌  Error:', err.message);
  process.exit(1);
});
