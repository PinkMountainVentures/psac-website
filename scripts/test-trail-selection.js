'use strict';
/**
 * scripts/test-trail-selection.js
 *
 * Automated, repeatable version of the R1-R8 (+ date axis) combinatorial
 * test matrix from Section 4 of
 * claude/psac-trail-selection-diagnosis-and-test-plan-2026-09-12.md.
 *
 * Deliberately does NOT touch Postgres. lib/trail-selection-engine.js is
 * pure logic (no I/O, confirmed by its own header comment and unchanged by
 * the Neon migration) -- this script requires it directly and drives it
 * with fixture data in scripts/fixtures/trail-selection-fixtures.js, which
 * is itself generated from the real db/seed.sql +
 * db/2026-09-03_add_trails_039-052.sql INSERT statements (see that file's
 * own header for exactly which values were overridden from seed and why).
 *
 * Run: node scripts/test-trail-selection.js
 * Exits non-zero if any assertion fails, so it's CI/pre-commit friendly.
 *
 * WHY NOT AGAINST LIVE POSTGRES: this session has no DATABASE_URL and the
 * Vercel CLI here isn't authenticated (`vercel whoami` -> "Logged out"), so
 * there's no live credential to run this against production or a Neon
 * branch from here. That's a real gap for confirming CURRENT row-level
 * content (see the fixtures file's own caveat about ops-UI-only edits that
 * never became a migration file -- TRAIL-052's Difficulty is one
 * confirmed example). But the actual bug this test plan is chasing is a
 * LOGIC bug in the engine, not a data bug, and the engine takes plain JS
 * objects with zero knowledge of where they came from -- so this harness
 * validates the real logic paths precisely, just against a fixture
 * snapshot of the data rather than a live query. Re-run
 * scripts/build-trail-selection-fixtures.js (not checked in; ask this
 * session to regenerate it) against a fresh `pg_dump` or admin-screen
 * export if the live data drifts further from these fixtures.
 */

const path = require('path');
const {
  runTrailSelection,
  checkTrailSafety,
  computeGroupCeilings,
  AGE_BUCKET_MIN_AGE,
} = require(path.join(__dirname, '..', 'lib', 'trail-selection-engine.js'));
const { TRAILS, PARK_ACCESS } = require(path.join(__dirname, 'fixtures', 'trail-selection-fixtures.js'));

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(label, condition, detail) {
  if (condition) {
    passCount++;
    console.log(`  PASS  ${label}`);
  } else {
    failCount++;
    failures.push({ label, detail });
    console.log(`  FAIL  ${label}${detail ? ' -- ' + detail : ''}`);
  }
}

function makeBooking(overrides) {
  return Object.assign(
    {
      bookingId: 'TEST-BOOKING',
      tier: 'trail',
      confirmedDate: '2026-09-19', // a Saturday, in-season, Indian Canyons/Tahquitz open both halves of the year on Sat
      roster: [{ ageRange: '35–44', fitness: 'Strong / experienced' }],
      technicalComfort: 'comfortable_scrambling_route_finding',
      heatComfort: 'heat_doesnt_slow_me_down',
      duration: 'Full day',
      activityType: null,
      bestForAttributes: [],
    },
    overrides
  );
}

function run(bookingOverrides) {
  const booking = makeBooking(bookingOverrides);
  return runTrailSelection({
    operation: 'initial',
    booking,
    trails: TRAILS,
    parkAccessRows: PARK_ACCESS,
    now: '2026-09-14',
  });
}

console.log('=== Section 4a: roster axis ===\n');

// R1: Solo adult, baseline
{
  const r = run({ roster: [{ ageRange: '35–44', fitness: 'Strong / experienced' }] });
  console.log('R1 (solo adult, Strong):', r.candidateTrails.map((c) => c.trailId));
  assert('R1 returns non-zero candidates', r.candidateTrails.length > 0);
}

// R2: Solo adult, Easygoing
{
  const r = run({ roster: [{ ageRange: '35–44', fitness: 'Easygoing' }] });
  console.log('R2 (solo adult, Easygoing):', r.candidateTrails.map((c) => c.trailId));
  assert('R2 returns non-zero candidates', r.candidateTrails.length > 0);
}

// R3: 2 adults, mixed fitness -- least-fit-member ceiling should govern
{
  const r = run({
    roster: [
      { ageRange: '35–44', fitness: 'Easygoing' },
      { ageRange: '35–44', fitness: 'Strong / experienced' },
    ],
  });
  const ceilings = computeGroupCeilings(
    [
      { ageRange: '35–44', fitness: 'Easygoing' },
      { ageRange: '35–44', fitness: 'Strong / experienced' },
    ],
    'comfortable_scrambling_route_finding'
  );
  console.log('R3 (mixed fitness) candidates:', r.candidateTrails.map((c) => `${c.trailId}(diff${c.difficultyRating})`));
  assert('R3 leastFitTier is Easygoing (ceiling governed by least-fit member)', ceilings.leastFitTier === 'Easygoing');
  assert(
    'R3 every candidate stays within Easygoing difficulty ceiling (<=2)',
    r.candidateTrails.every((c) => c.difficultyRating == null || c.difficultyRating <= 2)
  );
}

// R4/R4a/R4b: 1 adult + 1 child Under 14 -- the reported bug
{
  const base = { roster: [{ ageRange: '35–44', fitness: 'Strong / experienced' }, { ageRange: 'Under 14', fitness: 'Comfortable' }] };
  const r4 = run(base);
  console.log('R4 (adult + Under-14 child):', r4.candidateTrails.map((c) => c.trailId), '| qualifying:', r4.qualifyingCandidateCount);
  assert('R4 returns ZERO candidates (confirms the reported bug against current trail data)', r4.candidateTrails.length === 0);

  const r4a = run(Object.assign({}, base, { confirmedDate: '2026-11-15' }));
  assert('R4a (different date) still returns zero -- not date-driven', r4a.candidateTrails.length === 0);

  const r4b = run(Object.assign({}, base, { bestForAttributes: ['Solitude and quiet', 'Interesting geology'], heatComfort: 'prefers_shade_or_cooler_start' }));
  assert('R4b (different preferences) still returns zero -- not preference-driven', r4b.candidateTrails.length === 0);
}

// R5: 1 adult + 1 child 14-17 -- CORRECTED expectation vs. the doc's original
// prediction: AGE_BUCKET_MIN_AGE['14–17'] = 14, which clears every 4+ and
// 12+ kid-friendly trail (all but none of the 9 kid-friendly trails here
// require more than 12+), so this should return REAL candidates, unlike R4.
{
  const r5 = run({ roster: [{ ageRange: '35–44', fitness: 'Strong / experienced' }, { ageRange: '14–17', fitness: 'Comfortable' }] });
  console.log('R5 (adult + 14-17 child):', r5.candidateTrails.map((c) => c.trailId), '| qualifying:', r5.qualifyingCandidateCount);
  assert(
    'R5 returns NON-ZERO candidates (differs from R4 -- this is the corrected prediction, see Section 2 rewrite)',
    r5.candidateTrails.length > 0
  );
  assert(
    'R5 candidates are all Kid Friendly trails',
    r5.candidateTrails.every((c) => TRAILS.find((t) => t.trailId === c.trailId).kidFriendly === true)
  );
}

// R6: matches BK-CB86E7D6's actual composition -- 1 adult + 2 children (Under 14 and 14-17)
{
  const r6 = run({
    roster: [
      { ageRange: '35–44', fitness: 'Strong / experienced' },
      { ageRange: 'Under 14', fitness: 'Comfortable' },
      { ageRange: '14–17', fitness: 'Comfortable' },
    ],
  });
  console.log('R6 (BK-CB86E7D6 composition, 2 kids):', r6.candidateTrails.map((c) => c.trailId));
  assert(
    'R6 returns ZERO candidates (the Under-14 minor alone is enough to zero it out, per checkTrailSafety requiring EVERY minor to clear)',
    r6.candidateTrails.length === 0
  );
}

// R7: 2 adults + 1 Under-14 child, mixed adult fitness
{
  const r7 = run({
    roster: [
      { ageRange: '35–44', fitness: 'Easygoing' },
      { ageRange: '35–44', fitness: 'Strong / experienced' },
      { ageRange: 'Under 14', fitness: 'Comfortable' },
    ],
  });
  console.log('R7 (2 adults mixed fitness + Under-14 child):', r7.candidateTrails.map((c) => c.trailId));
  assert('R7 also returns ZERO candidates (family-tier fails regardless of fitness ceiling)', r7.candidateTrails.length === 0);
}

// R8: smoking-gun check -- checkTrailSafety directly against a specific
// kid-friendly 4+ trail (Andreas Canyon, TRAIL-032) for a 15-year-old.
{
  const ctx15 = {
    roster: [{ ageRange: '14–17', fitness: 'Comfortable' }],
    groupCeilings: computeGroupCeilings([{ ageRange: '14–17', fitness: 'Comfortable' }], 'comfortable_scrambling_route_finding'),
    bestForAttributes: [],
    heatComfort: 'heat_doesnt_slow_me_down',
    duration: 'Full day',
    activityType: null,
  };
  const andreas = TRAILS.find((t) => t.trailId === 'TRAIL-032');
  const safety15 = checkTrailSafety(andreas, ctx15, PARK_ACCESS, new Date('2026-09-19T00:00:00Z'));
  console.log('R8: Andreas Canyon (4+) vs a 15-year-old ->', JSON.stringify(safety15.checks));
  assert(
    'R8: family_tier PASSES for a 14-17 roster member against a 4+ trail (AGE_BUCKET_MIN_AGE["14–17"]=14 >= 4)',
    safety15.checks.family_tier === true
  );

  const ctx3 = {
    roster: [{ ageRange: 'Under 14', fitness: 'Comfortable' }],
    groupCeilings: computeGroupCeilings([{ ageRange: 'Under 14', fitness: 'Comfortable' }], 'comfortable_scrambling_route_finding'),
    bestForAttributes: [],
    heatComfort: 'heat_doesnt_slow_me_down',
    duration: 'Full day',
    activityType: null,
  };
  const safety3 = checkTrailSafety(andreas, ctx3, PARK_ACCESS, new Date('2026-09-19T00:00:00Z'));
  console.log('R8: Andreas Canyon (4+) vs an Under-14 roster ->', JSON.stringify(safety3.checks));
  assert(
    'R8: family_tier FAILS for an Under-14 roster member even against the most permissive 4+ trail (AGE_BUCKET_MIN_AGE["Under 14"]=0 < 4)',
    safety3.checks.family_tier === false
  );
}

console.log('\n=== Section 4c: date axis (against R1) ===\n');

// Park-closed weekday (Tuesday) for the 16 Indian-Canyons-governed trails
{
  const r = run({ confirmedDate: '2026-09-15' }); // a Tuesday, in the Jul6-Oct1 Fri/Sat/Sun-only window
  const indianCanyonsIds = new Set(TRAILS.filter((t) => t.park === 'Indian Canyons' || t.park === 'Tahquitz Canyon').map((t) => t.trailId));
  const gotIndianCanyonsTrail = r.candidateTrails.some((c) => indianCanyonsIds.has(c.trailId));
  console.log('Tuesday in Jul6-Oct1 window, R1 profile:', r.candidateTrails.map((c) => c.trailId));
  assert(
    'Indian Canyons / Tahquitz Canyon trails excluded on a Tuesday inside the Fri/Sat/Sun-only window',
    !gotIndianCanyonsTrail
  );
}

// Deep avoid season (June)
{
  const r = run({ confirmedDate: '2026-06-16' });
  const juneAvoidIds = new Set(
    TRAILS.filter((t) => (t.avoidSeason || '').includes('Jun')).map((t) => t.trailId)
  );
  const gotJuneAvoidTrail = r.candidateTrails.some((c) => juneAvoidIds.has(c.trailId));
  console.log('Deep June avoid-season, R1 profile:', r.candidateTrails.map((c) => c.trailId));
  assert('No trail with June in its Avoid Season is recommended in June', !gotJuneAvoidTrail);
}

console.log('\n=== Diversity evidence (Airey\'s 2026-09-14 follow-up: "same 3 trails every time") ===\n');

// Quantify how big the *qualifying* pool is vs. how many trails ever reach
// the top main-order rank, for a realistic non-family profile -- this is
// the concrete evidence behind the "the setup qualifies for far more than
// 3" observation, and behind proposing a frequency-based distribution
// mechanism (see the doc's new Section 8) rather than just a bigger
// candidate list.
{
  const roster = [{ ageRange: '35–44', fitness: 'Strong / experienced' }];
  const groupCeilings = computeGroupCeilings(roster, 'comfortable_scrambling_route_finding');
  const ctx = {
    roster,
    groupCeilings,
    bestForAttributes: [],
    heatComfort: 'heat_doesnt_slow_me_down',
    duration: 'Full day',
    activityType: null,
  };
  const referenceDate = new Date('2026-09-19T00:00:00Z');
  const qualifying = TRAILS.filter((t) => {
    const safety = checkTrailSafety(t, ctx, PARK_ACCESS, referenceDate);
    return safety.passesTierA;
  });
  console.log(
    `For the R1 profile (Strong/experienced solo adult, no preference picks): ${qualifying.length} of ${TRAILS.length} trails clear every Tier A check.`
  );
  console.log('Qualifying pool:', qualifying.map((t) => `${t.trailId}(diff${t.difficulty})`).join(', '));
  const r1 = run({});
  console.log(
    `But only ${r1.candidateTrails.length} are ever surfaced (fillSlotsWithSpread caps output at 3 regardless of pool size), and slot 1 is always the same single trail for this exact profile: ${r1.candidateTrails[0] && r1.candidateTrails[0].trailId}.`
  );
  assert(
    'Qualifying pool is meaningfully larger than the 3 surfaced slots (evidence for Section 8\'s distribution proposal, not just Section 7\'s tie-break)',
    qualifying.length > 3
  );
}

console.log('\n=== Section 7/8 verification: hash-based tie-break (shipped 2026-09-14) ===\n');

// Same booking, re-run repeatedly -> identical result every time
// (reproducibility preserved).
{
  const results = [1, 2, 3].map(() => run({ bookingId: 'BK-REPEAT-TEST' }).candidateTrails.map((c) => c.trailId).join(','));
  console.log('Same booking (BK-REPEAT-TEST), 3 runs:', results);
  assert('Same bookingId + same inputs -> identical candidateTrails every re-run', new Set(results).size === 1);
}

// Different bookings, identical profile -> spread across the tied set
// instead of always landing on the same trail (Airey's 2026-09-14 "same 3
// trails" follow-up, Section 8a's 8-way tie group).
{
  const bookingIds = ['BK-0001', 'BK-0002', 'BK-0003', 'BK-0004', 'BK-0005', 'BK-0006', 'BK-0007', 'BK-0008'];
  const topPicks = bookingIds.map((bookingId) => run({ bookingId }).candidateTrails[0].trailId);
  const distinctTopPicks = new Set(topPicks);
  console.log('Same profile, 8 different bookingIds, top pick each:', topPicks);
  assert(
    'Different bookingIds with an identical tied profile land on more than one top-pick trail (the actual fix for "same 3 trails every time")',
    distinctTopPicks.size > 1
  );
}

console.log(`\n${passCount} passed, ${failCount} failed.\n`);
if (failCount > 0) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log(`  - ${f.label}${f.detail ? ' (' + f.detail + ')' : ''}`));
  process.exitCode = 1;
}
