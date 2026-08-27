/**
 * lib/trail-selection-engine.js
 *
 * Bucket 2.2 — the trail-selection rules engine.
 * Pure logic module: no network calls, no Sheet access, no Stripe, nothing
 * async. Everything it needs comes in as plain JS objects/arrays; everything
 * it produces comes out as plain JS objects/arrays. api/assign-trail.js and
 * api/trail-safety-options.js are the only things that touch I/O — they fetch
 * data via the Apps Script webapp, call into this module, then write the
 * result back the same way.
 *
 * Built against claude/psac-trail-selection-logic-jtbd-prd-v1.md, all 13
 * Section 14 decisions, Section 10's restated algorithm, Section 11's output
 * contract. Comments below cite the PRD section they implement so a reviewer
 * can check this against the source of truth line by line.
 *
 * No Date.now()/Math.random() dependency for correctness — a `now` (Date
 * object or ISO string) is always passed in by the caller, defaulting to
 * `new Date()` only at the very top of the public entry points, so the core
 * logic stays deterministic and testable.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants (PRD Section 3, Section 4, Section 7/Ops UX Section 7)
// ---------------------------------------------------------------------------

// The four Tier A checks staff can override per booking (Trail Selection
// Logic PRD Section 2; exact string values agreed with the Operations UX PRD
// Section 7's `tierASafetyFiltersOverridden` array).
const OVERRIDABLE_CHECK_KEYS = [
  'difficulty_ceiling',
  'technical_ceiling',
  'family_tier',
  'seasonal_safety',
];

// The two Tier A checks that are absolute exclusions, never overridable
// (PRD Section 2): a trail failing either of these never even appears in the
// Trail Swap Requests dropdown.
const ABSOLUTE_CHECK_KEYS = ['bookable', 'park_date_availability'];

// Fitness level -> Difficulty range. Technical-terrain comfort uses the
// identical three numeric ranges, applied independently (PRD Section 4,
// decisions log item 5). Ceiling is always range[1] (the top of the range).
const FITNESS_TO_DIFFICULTY_RANGE = {
  Easygoing: [1, 2],
  Comfortable: [2, 4],
  Strong: [3, 5],
};

const FITNESS_ORDER = ['Easygoing', 'Comfortable', 'Strong'];

// technicalComfort is a single, non-per-person field on the Adventure Prep
// tab (PRD Section 4). These three canonical values are the plain-English
// options the PRD itself uses as illustrative option text (Adventure Prep
// PRD Section 3). Surface A's actual UI copy may differ cosmetically; if so,
// whoever wires the request payload together needs to normalize to one of
// these three keys before calling this engine — see README, "Open questions".
const TECHNICAL_COMFORT_TO_RANGE = {
  wide_easy_underfoot: [1, 2],
  some_rock_uneven_ground_fine: [2, 4],
  comfortable_scrambling_route_finding: [3, 5],
};

// heatComfort is a single field, two options (PRD Section 5). Only used as a
// ranking preference, never a hard filter.
const HEAT_COMFORT = {
  PREFERS_SHADE: 'prefers_shade_or_cooler_start',
  NO_PREFERENCE: 'heat_doesnt_slow_me_down',
};

// Roster age-bucket values, exactly as shipped in the booking flow (see
// claude/psac-booking-flow-action-items.md item 1). Mapped to the most
// conservative (youngest) possible age in the bucket for the family-tier
// Min-Age-Rec comparison, since the roster stores a bucket, not an exact age
// — see README, "Open questions", for why this is a documented assumption
// rather than a PRD-specified rule.
//
// BUG FIX (Aug 2026, independent bug pass): every bucket past "Under 14"
// used an ASCII hyphen ('14-17', '18-24', ...), but adventure-form.js's
// roster step — the only place these values actually get written —
// generates them with an EN DASH ('14–17', U+2013, not U+002D). That
// meant MINOR_AGE_BUCKETS.has(p.ageRange) never matched a real 14-17-year-
// old roster entry, so the family-tier eligibility check below (line
// ~422) always treated a booking with a 14-17-year-old as having zero
// minors — silently skipping the kid-friendly / Min Age Rec check
// entirely for the one bucket most likely to actually need it. Same bug
// class apps-script/trail-swap-actions.gs's own header comment already
// documents fixing in its local, duplicate copy of this exact check (that
// file's fix is why this one stood out as suspicious) — this is the
// matching fix for the real engine both the initial trail-assignment path
// and (indirectly) the trail-swap path both ultimately rely on.
const AGE_BUCKET_MIN_AGE = {
  'Under 14': 0,
  '14–17': 14,
  '18–24': 18,
  '25–34': 25,
  '35–44': 35,
  '45–54': 45,
  '55–64': 55,
  '65+': 65,
};
const MINOR_AGE_BUCKETS = new Set(['Under 14', '14–17']);

const MONTH_ABBREVIATIONS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const DAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------------------------------------------------------------------------
// Small parsing helpers — the live Trail Database and Park Access tabs store
// several fields as descriptive text, not clean primitives. Every parser
// below documents its own fail-safe direction (open vs. closed) explicitly.
// ---------------------------------------------------------------------------

function monthAbbrevOf(date) {
  return MONTH_ABBREVIATIONS[date.getUTCMonth()];
}

function dayAbbrevOf(date) {
  return DAY_ABBREVIATIONS[date.getUTCDay()];
}

function toDate(value) {
  if (value instanceof Date) return value;
  // Treat bare YYYY-MM-DD as a UTC calendar date, not local-time midnight,
  // so this behaves identically regardless of the server's timezone.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(value + 'T00:00:00Z');
  }
  return new Date(value);
}

/**
 * Parses a comma-separated month-abbreviation list, e.g. "Jan, Feb, Mar".
 * Returns a Set of canonical 3-letter abbreviations. Case-insensitive,
 * tolerant of extra whitespace. Unrecognized tokens are dropped silently
 * (surfaced instead via `validateTrailSeasonCoverage` below, which is the
 * right layer to catch a data-entry typo, not a per-request filter).
 */
function parseMonthList(raw) {
  if (!raw) return new Set();
  const set = new Set();
  String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((token) => {
      const canon = MONTH_ABBREVIATIONS.find(
        (m) => m.toLowerCase() === token.slice(0, 3).toLowerCase()
      );
      if (canon) set.add(canon);
    });
  return set;
}

/**
 * Every month must land in exactly one of Optimal/Viable/Avoid (PRD Section
 * 3: "if whoever grades a trail leaves a month unassigned, this engine
 * should treat that month as Avoid by default"). This computes, for a given
 * trail row, the effective Avoid set after applying that fail-closed rule —
 * any month not claimed by Optimal or Viable is folded into Avoid.
 */
function effectiveAvoidMonths(trail) {
  const optimal = parseMonthList(trail.optimalSeason);
  const viable = parseMonthList(trail.viableSeason);
  const explicitAvoid = parseMonthList(trail.avoidSeason);
  const avoid = new Set(explicitAvoid);
  MONTH_ABBREVIATIONS.forEach((m) => {
    if (!optimal.has(m) && !viable.has(m)) avoid.add(m);
  });
  return avoid;
}

/**
 * Diagnostic, not used in the per-request hot path: flags a trail whose
 * Optimal/Viable/Avoid columns don't yet cover all 12 months without gaps or
 * overlaps, so a data-entry problem surfaces as an explicit warning rather
 * than a silent "defaults to Avoid" that nobody notices. Exposed for the
 * verification script and for a future admin/QA view, not called by
 * runTrailSelection itself.
 */
function validateTrailSeasonCoverage(trail) {
  const optimal = parseMonthList(trail.optimalSeason);
  const viable = parseMonthList(trail.viableSeason);
  const avoid = parseMonthList(trail.avoidSeason);
  const problems = [];
  const seen = new Map();
  [['optimalSeason', optimal], ['viableSeason', viable], ['avoidSeason', avoid]].forEach(
    ([field, set]) => {
      set.forEach((m) => {
        if (seen.has(m)) {
          problems.push(
            `${m} appears in both ${seen.get(m)} and ${field} — overlap, PRD requires mutual exclusivity`
          );
        }
        seen.set(m, field);
      });
    }
  );
  const uncovered = MONTH_ABBREVIATIONS.filter((m) => !seen.has(m));
  if (uncovered.length) {
    problems.push(
      `${uncovered.join(', ')} not assigned to any season field — will default to Avoid (fail-closed) per PRD Section 3`
    );
  }
  return { trailId: trail.trailId, ok: problems.length === 0, problems };
}

/**
 * Parses "Est. Time" text like "2.5 to 3 hours" or "1.5 to 2 hours" into a
 * single number of hours. Takes the UPPER bound of the range: for the
 * Duration Tier-B filter this is the conservative reading ("will this
 * genuinely fit inside a Half day"), consistent with the project's general
 * safety-first-default posture. Returns null if nothing numeric is found —
 * callers treat null as "unknown, don't let this exclude the trail" (Duration
 * is a relaxable Tier B preference filter, not a safety filter, so failing
 * open on bad/missing data is the right default here, unlike the Tier A
 * fail-closed rules above).
 */
function parseEstTimeHours(raw) {
  if (!raw) return null;
  const nums = String(raw).match(/\d+(\.\d+)?/g);
  if (!nums || !nums.length) return null;
  return Math.max(...nums.map(Number));
}

/**
 * Comma-separated list -> trimmed array, e.g. "Hiking, Trail Running" ->
 * ["Hiking", "Trail Running"].
 *
 * Quote-aware: the live Trail Database's `Best For Attributes` column
 * stores at least one attribute as a double-quoted sub-string containing
 * its own internal commas — e.g. `Wildlife and nature, "Water - streams,
 * pools, falls", Learning about the place` — confirmed directly against
 * 6 of the 7 launch trails, not a hypothetical. A naive `.split(',')`
 * shatters that one attribute into three garbled fragments (`"Water -
 * streams`, `pools`, `falls"`), which would never again equal a guest's
 * clean "Water - streams, pools, falls" pick — silently zeroing out the
 * PRD's dominant ranking criterion (bestForAttributes overlap) for every
 * trail carrying that attribute. This splits on commas EXCEPT inside a
 * double-quoted segment, then strips the enclosing quotes from any token
 * that had them.
 */
function parseCommaList(raw) {
  if (!raw) return [];
  const tokens = String(raw).match(/(?:[^,"]|"[^"]*")+/g) || [];
  return tokens
    .map((s) => s.trim())
    .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s))
    .filter(Boolean);
}

/** "12+" / "12" / "" -> 12 / 12 / null. */
function parseMinAge(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parseYesNo(raw) {
  return String(raw || '').trim().toLowerCase() === 'yes';
}

/**
 * Park Access `Season` column parser. FORMAT NOT YET LIVE — the tab is
 * headers-only in production as of this build (see README, "Park Access is
 * empty"). This implements the format this engine actually needs and asks
 * Airey to populate rows in, worked out directly against the real fact
 * pattern in psac-copy-drafts.md section 12 (Indian Canyons/Tahquitz Canyon
 * both run Fri-Sun-only from Jul 6 through Oct 1, daily the rest of the
 * year):
 *
 *   "Jul 6 - Oct 1"   -> a month/day range, no year, wraps the calendar if
 *                        the end is earlier in the year than the start
 *   "Year-round" / "" -> always matches (no date restriction from this
 *                        column; Applicable Days still applies)
 *
 * Returns { alwaysMatches: true } or { startMonth, startDay, endMonth,
 * endDay } (months are 0-11, matching Date's own convention, to make the
 * wraparound arithmetic below straightforward).
 */
function parseSeasonRange(raw) {
  if (!raw || /year.?round/i.test(raw) || raw.trim().toLowerCase() === 'all') {
    return { alwaysMatches: true };
  }
  const m = String(raw).match(
    /([A-Za-z]{3,})\s*(\d{1,2})\s*[-–to]+\s*([A-Za-z]{3,})\s*(\d{1,2})/i
  );
  if (!m) return { alwaysMatches: true, unparsed: raw }; // fail open on a malformed row; flagged separately, see validateParkAccessRow
  const monthIndex = (name) =>
    MONTH_ABBREVIATIONS.findIndex((ab) => ab.toLowerCase() === name.slice(0, 3).toLowerCase());
  return {
    startMonth: monthIndex(m[1]),
    startDay: parseInt(m[2], 10),
    endMonth: monthIndex(m[3]),
    endDay: parseInt(m[4], 10),
  };
}

function dateWithinSeasonRange(date, range) {
  if (range.alwaysMatches) return true;
  const md = date.getUTCMonth() * 100 + date.getUTCDate();
  const start = range.startMonth * 100 + range.startDay;
  const end = range.endMonth * 100 + range.endDay;
  if (start <= end) return md >= start && md <= end;
  return md >= start || md <= end; // wraps across the calendar year boundary
}

/** "Fri, Sat, Sun" (or full names) -> Set of 3-letter day abbreviations. */
function parseApplicableDays(raw) {
  if (!raw) return null; // null = no restriction stated; caller decides fail-open/closed
  const set = new Set();
  String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((token) => {
      let idx = DAY_ABBREVIATIONS.findIndex((d) => d.toLowerCase() === token.slice(0, 3).toLowerCase());
      if (idx === -1) idx = DAY_FULL_NAMES.findIndex((d) => d.toLowerCase() === token.toLowerCase());
      if (idx !== -1) set.add(DAY_ABBREVIATIONS[idx]);
    });
  return set;
}

// ---------------------------------------------------------------------------
// Group-ceiling computation (PRD Section 4)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ageRange:string, fitness:string}>} roster - the ATTENDING
 *   roster only (whoever is actually going, per Adventure Prep's roster
 *   reconfirmation), not the full original booking-time roster if those
 *   differ. See README re: where this engine currently reads roster from.
 * @param {string} technicalComfort - one of TECHNICAL_COMFORT_TO_RANGE's keys
 * @returns {{difficultyCeiling:number, difficultyIdealRange:[number,number],
 *   technicalCeiling:number, technicalIdealRange:[number,number],
 *   leastFitTier:string}}
 */
function computeGroupCeilings(roster, technicalComfort) {
  if (!Array.isArray(roster) || roster.length === 0) {
    throw new Error('computeGroupCeilings: roster must be a non-empty array');
  }
  // "Governed by the least-experienced attending member's own whole tier"
  // (PRD Section 4, decisions log item 7). Ordinal minimum, not an average.
  let leastFitTier = 'Strong';
  roster.forEach((person) => {
    const tier = person.fitness;
    if (
      FITNESS_ORDER.indexOf(tier) !== -1 &&
      FITNESS_ORDER.indexOf(tier) < FITNESS_ORDER.indexOf(leastFitTier)
    ) {
      leastFitTier = tier;
    }
  });
  const difficultyRange = FITNESS_TO_DIFFICULTY_RANGE[leastFitTier] || FITNESS_TO_DIFFICULTY_RANGE.Easygoing;
  const technicalRange =
    TECHNICAL_COMFORT_TO_RANGE[technicalComfort] || TECHNICAL_COMFORT_TO_RANGE.wide_easy_underfoot;

  return {
    difficultyCeiling: difficultyRange[1],
    difficultyIdealRange: difficultyRange,
    technicalCeiling: technicalRange[1],
    technicalIdealRange: technicalRange,
    leastFitTier,
  };
}

// ---------------------------------------------------------------------------
// Tier A safety-check evaluation — the reusable per-trail function (PRD
// Section 2, Section 12; the exact function Operations UX's Trail Swap
// Requests page needs to call, per the build kickoff prompt).
// ---------------------------------------------------------------------------

/**
 * @param {object} trail - normalized trail row, see README "Trail row shape"
 * @param {object} ctx - normalized booking context, see README "Booking context shape"
 * @param {Array<object>} parkAccessRows - normalized Park Access rows
 * @param {Date} referenceDate - the booking's confirmed date
 * @returns {{
 *   checks: { bookable, park_date_availability, seasonal_safety,
 *             difficulty_ceiling, technical_ceiling, family_tier: boolean },
 *   absoluteFailures: string[],   // subset of ABSOLUTE_CHECK_KEYS that failed
 *   overridableFailures: string[], // subset of OVERRIDABLE_CHECK_KEYS that failed
 *   passesTierA: boolean,          // true only if every check passed
 *   selectableAtAll: boolean,      // false if any absolute check failed
 * }}
 */
function checkTrailSafety(trail, ctx, parkAccessRows, referenceDate) {
  const checks = {};

  // 1. Bookable — absolute.
  checks.bookable = trail.bookable === true;

  // 2. Park/date availability — absolute, fail-closed on a missing row
  //    (PRD Section 3: "no matching Park Access row exists ... treat the
  //    trail as not open, not as open by default").
  if (!trail.park) {
    checks.park_date_availability = true; // no Park value = no restriction
  } else {
    const matchingRows = (parkAccessRows || []).filter(
      (row) => row.park && row.park.trim().toLowerCase() === trail.park.trim().toLowerCase()
    );
    if (matchingRows.length === 0) {
      checks.park_date_availability = false; // fail closed — see README
    } else {
      checks.park_date_availability = matchingRows.some((row) => {
        const seasonRange = parseSeasonRange(row.season);
        if (!dateWithinSeasonRange(referenceDate, seasonRange)) return false;
        const days = parseApplicableDays(row.applicableDays);
        if (days === null) return true; // no day restriction stated on this row
        return days.has(dayAbbrevOf(referenceDate));
      });
    }
  }

  // 3. Seasonal safety — absolute (as a Tier A algorithmic filter; staff can
  //    still override it via the manual path, see Section 2). Independent
  //    of the guest's own heat-comfort preference.
  const avoidMonths = effectiveAvoidMonths(trail);
  checks.seasonal_safety = !avoidMonths.has(monthAbbrevOf(referenceDate));

  // 4. Difficulty ceiling.
  checks.difficulty_ceiling =
    trail.difficulty == null || trail.difficulty <= ctx.groupCeilings.difficultyCeiling;

  // 5. Technical ceiling.
  checks.technical_ceiling =
    trail.technicalRating == null || trail.technicalRating <= ctx.groupCeilings.technicalCeiling;

  // 6. Family-tier eligibility.
  const minors = ctx.roster.filter((p) => MINOR_AGE_BUCKETS.has(p.ageRange));
  if (minors.length === 0) {
    checks.family_tier = true;
  } else if (!trail.kidFriendly) {
    checks.family_tier = false;
  } else if (trail.minAgeRec == null) {
    checks.family_tier = true; // Kid Friendly = Yes alone is sufficient, no Min Age Rec populated
  } else {
    checks.family_tier = minors.every(
      (m) => (AGE_BUCKET_MIN_AGE[m.ageRange] ?? 0) >= trail.minAgeRec
    );
  }

  const absoluteFailures = ABSOLUTE_CHECK_KEYS.filter((k) => !checks[k]);
  const overridableFailures = OVERRIDABLE_CHECK_KEYS.filter((k) => !checks[k]);

  return {
    checks,
    absoluteFailures,
    overridableFailures,
    passesTierA: absoluteFailures.length === 0 && overridableFailures.length === 0,
    selectableAtAll: absoluteFailures.length === 0,
  };
}

/**
 * The Trail Swap Requests dropdown's data source (Operations UX PRD Section
 * 7, Section 13): every Bookable trail that doesn't fail an absolute check,
 * each annotated with whether it clears the other four Tier A checks for
 * THIS booking. Trails failing Bookable or Park/date availability are
 * omitted entirely, per PRD Section 2.
 */
function getTrailSafetyOptions(ctx, trails, parkAccessRows, referenceDate) {
  return trails
    .filter((t) => t.bookable === true)
    .map((t) => {
      const safety = checkTrailSafety(t, ctx, parkAccessRows, referenceDate);
      return {
        trailId: t.trailId,
        trailName: t.trailName,
        difficultyRating: t.difficulty,
        clearsAllTierA: safety.passesTierA,
        overridableFailures: safety.overridableFailures,
        absoluteFailures: safety.absoluteFailures,
      };
    })
    .filter((opt) => opt.absoluteFailures.length === 0); // omit absolute exclusions entirely
}

// ---------------------------------------------------------------------------
// Ranking (PRD Section 5)
// ---------------------------------------------------------------------------

function bestForOverlapCount(trail, guestPicks) {
  const trailAttrs = new Set(trail.bestForAttributes || []);
  return (guestPicks || []).filter((p) => trailAttrs.has(p)).length;
}

function matchedAttributesFor(trail, guestPicks) {
  const trailAttrs = new Set(trail.bestForAttributes || []);
  return (guestPicks || []).filter((p) => trailAttrs.has(p));
}

/**
 * Heat alignment (PRD Section 5, tier 2): boolean bonus, 1 if the trail's
 * exposure profile aligns with a guest preferring shade (i.e. the trail
 * isn't tagged fully exposed), 1 by default for a guest with no heat
 * preference. See README — "fullSunExposure" is not yet a real Trail
 * Database column; this defaults to "aligned" (no penalty) until one exists.
 */
function heatAlignmentScore(trail, heatComfort) {
  if (heatComfort !== HEAT_COMFORT.PREFERS_SHADE) return 1;
  if (trail.fullSunExposure === true) return 0;
  return 1;
}

/** Ideal-range fit (PRD Section 5, tier 3): 0, 1, or 2. */
function idealRangeFitScore(trail, groupCeilings) {
  let score = 0;
  if (
    trail.difficulty != null &&
    trail.difficulty >= groupCeilings.difficultyIdealRange[0] &&
    trail.difficulty <= groupCeilings.difficultyIdealRange[1]
  ) {
    score += 1;
  }
  if (
    trail.technicalRating != null &&
    trail.technicalRating >= groupCeilings.technicalIdealRange[0] &&
    trail.technicalRating <= groupCeilings.technicalIdealRange[1]
  ) {
    score += 1;
  }
  return score;
}

/** The main lexicographic order (PRD Section 5, Section 10 step 4). */
function compareMainOrder(a, b, ctx) {
  const overlapDiff = bestForOverlapCount(b.trail, ctx.bestForAttributes) - bestForOverlapCount(a.trail, ctx.bestForAttributes);
  if (overlapDiff !== 0) return overlapDiff;
  const heatDiff = heatAlignmentScore(b.trail, ctx.heatComfort) - heatAlignmentScore(a.trail, ctx.heatComfort);
  if (heatDiff !== 0) return heatDiff;
  const idealDiff = idealRangeFitScore(b.trail, ctx.groupCeilings) - idealRangeFitScore(a.trail, ctx.groupCeilings);
  if (idealDiff !== 0) return idealDiff;
  return a.trail.trailId < b.trail.trailId ? -1 : a.trail.trailId > b.trail.trailId ? 1 : 0;
}

/** Slot 2 / slot 3 order (PRD Section 5): overlap, heat, then raw Difficulty. */
function compareDifficultyOrder(a, b, ctx, direction) {
  const overlapDiff = bestForOverlapCount(b.trail, ctx.bestForAttributes) - bestForOverlapCount(a.trail, ctx.bestForAttributes);
  if (overlapDiff !== 0) return overlapDiff;
  const heatDiff = heatAlignmentScore(b.trail, ctx.heatComfort) - heatAlignmentScore(a.trail, ctx.heatComfort);
  if (heatDiff !== 0) return heatDiff;
  const da = a.trail.difficulty ?? 0;
  const db = b.trail.difficulty ?? 0;
  const diffDiff = direction === 'asc' ? da - db : db - da;
  if (diffDiff !== 0) return diffDiff;
  return a.trail.trailId < b.trail.trailId ? -1 : a.trail.trailId > b.trail.trailId ? 1 : 0;
}

/**
 * Fills up to 3 output slots using the spread mechanism (PRD Section 5,
 * Section 10 step 5). `survivors` must already be Tier-A(+relaxed Tier-B)
 * filtered. Returns an array of up to 3 { trail } entries in slot order
 * (slot 1 = index 0, etc.) — NOT yet decorated with matchedAttributes/
 * difficultyRating/source, that happens in runTrailSelection.
 */
function fillSlotsWithSpread(survivors, ctx) {
  if (survivors.length === 0) return [];

  const wrapped = survivors.map((trail) => ({ trail }));
  const mainSorted = [...wrapped].sort((a, b) => compareMainOrder(a, b, ctx));

  const slot1 = mainSorted[0];
  const remaining1 = mainSorted.slice(1);
  if (remaining1.length === 0) return [slot1];

  // "If the remaining safe candidates (after slot 1) all share the identical
  // Difficulty, slots 2 and 3 both fall back to the plain order" (Section 5).
  const difficulties = new Set(remaining1.map((w) => w.trail.difficulty ?? null));
  const noGenuineSpread = difficulties.size <= 1;

  let slot2;
  let remaining2;
  if (noGenuineSpread) {
    slot2 = remaining1[0]; // already sorted by main order
    remaining2 = remaining1.slice(1);
  } else {
    const sortedForSlot2 = [...remaining1].sort((a, b) => compareDifficultyOrder(a, b, ctx, 'asc'));
    slot2 = sortedForSlot2[0];
    remaining2 = remaining1.filter((w) => w !== slot2);
  }
  if (remaining2.length === 0) return [slot1, slot2];

  let slot3;
  if (noGenuineSpread) {
    slot3 = remaining2[0];
  } else {
    const sortedForSlot3 = [...remaining2].sort((a, b) => compareDifficultyOrder(a, b, ctx, 'desc'));
    slot3 = sortedForSlot3[0];
  }
  return [slot1, slot2, slot3];
}

// ---------------------------------------------------------------------------
// Tier A / Tier B candidate-pool assembly (PRD Section 3, Section 8, Section 10)
// ---------------------------------------------------------------------------

function passesTierBDuration(trail, ctx) {
  const easyOrStrong = ctx.groupCeilings.leastFitTier === 'Strong' ? 'strongPaceHours' : 'easyPaceHours';
  const hours = trail[easyOrStrong];
  if (hours == null) return true; // unparseable/missing — fail open, Duration is a soft preference filter
  if (ctx.duration === 'Half day') return hours <= 4;
  return true; // Full day: no meaningful upper or lower bound at launch scale (PRD Section 3)
}

function passesTierBActivity(trail, ctx) {
  if (!ctx.activityType) return true;
  return (trail.activityType || []).includes(ctx.activityType);
}

/**
 * Assembles the final candidate pool: Tier A (never relaxed) then Tier B
 * relaxation in fixed order (Duration, then Activity Type), stopping the
 * instant 3 is reached (PRD Section 3, Section 10 steps 1-3).
 */
function buildCandidatePool(trails, ctx, parkAccessRows, referenceDate) {
  const tierAPool = trails.filter((t) => t.bookable === true).filter((t) => {
    const safety = checkTrailSafety(t, ctx, parkAccessRows, referenceDate);
    return safety.passesTierA;
  });

  const fullTierB = tierAPool.filter((t) => passesTierBDuration(t, ctx)).filter((t) => passesTierBActivity(t, ctx));
  if (fullTierB.length >= 3) return { pool: fullTierB, relaxed: [] };

  const relaxDuration = tierAPool.filter((t) => passesTierBActivity(t, ctx)); // Duration dropped
  if (relaxDuration.length >= 3) return { pool: relaxDuration, relaxed: ['duration'] };

  // Both relaxed — Duration already dropped above; also drop Activity Type.
  return { pool: tierAPool, relaxed: ['duration', 'activity_type'] };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {object} input.booking - normalized booking context, see README
 * @param {Array<object>} input.trails - normalized Trail Database rows
 * @param {Array<object>} input.parkAccessRows - normalized Park Access rows
 * @param {'initial'|'refresh'} input.operation
 * @param {Array<object>} [input.existingCandidateTrails] - required for
 *   'refresh'; the booking's current candidateTrails array (may contain a
 *   preserved `source: 'manual_override'` entry)
 * @param {string|null} [input.existingSelectedTrailId] - required for
 *   'refresh'; read-only, this engine never writes selectedTrailId
 * @param {Date|string} [input.now]
 * @returns {object} see README "Output contract"
 */
function runTrailSelection(input) {
  const now = toDate(input.now || new Date());
  const booking = input.booking;

  if (String(booking.tier || '').trim().toLowerCase() === 'custom') {
    return {
      refused: true,
      reason: 'custom_tier',
      message:
        'Custom-tier bookings are routed manually and must never be passed to this engine (PRD kickoff, "Explicitly out of scope").',
    };
  }

  const groupCeilings = computeGroupCeilings(booking.roster, booking.technicalComfort);
  const ctx = {
    roster: booking.roster,
    groupCeilings,
    bestForAttributes: booking.bestForAttributes || [],
    heatComfort: booking.heatComfort,
    duration: booking.duration,
    activityType: booking.activityType,
  };

  const referenceDate = toDate(booking.confirmedDate);
  const { pool, relaxed } = buildCandidatePool(input.trails, ctx, input.parkAccessRows, referenceDate);
  const slots = fillSlotsWithSpread(pool, ctx);

  const algorithmicEntries = slots.map((slot) => ({
    trailId: slot.trail.trailId,
    trailName: slot.trail.trailName,
    overviewCopy: slot.trail.overviewCopy,
    photoUrl: slot.trail.photoUrl,
    rideWithGpsExperienceAccess: null, // deferred to T-3, per Adventure Prep PRD Section 4 — never set by this engine
    park: slot.trail.park,
    trailheadLocation: slot.trail.trailheadLocation,
    oneTripTip: slot.trail.oneTripTip,
    matchedAttributes: matchedAttributesFor(slot.trail, ctx.bestForAttributes), // always an array, [] if none matched
    difficultyRating: slot.trail.difficulty,
    source: 'rules_v1',
  }));

  // Preserve any existing manual_override entry across a refresh — but ONLY
  // if it still clears the new date's Tier A hard filters (Ops App Redesign,
  // Manual Adjustment's "Trail day/date change" type, reusing Trail
  // Selection Logic PRD Section 2 Amendment 2: "re-run the same Tier A hard
  // filters ... against specifically the manual_override trail, using the
  // new date. If it still passes, preserved untouched. If it fails, the
  // override is removed ... the row should read as 'trail swap needed'").
  //
  // BUG FIX (Ops App Redesign, Aug 2026): this used to blindly preserve
  // ANY existing manual_override entry across a refresh with no re-check at
  // all — correct for a preference-only edit (nothing about the trip DATE
  // changed, so nothing Tier-A-relevant could have changed either), but
  // silently wrong for a date change specifically, where the whole reason
  // a re-check is needed is that Park/date availability and seasonal
  // safety are BOTH date-dependent. A manual override picked for an April
  // trip could fail Park/date availability or seasonal safety outright for
  // a trip moved to August, and the old code would have kept recommending
  // it anyway. Only bookable/park_date_availability/seasonal_safety are
  // re-checked here (matching the Amendment 2 spec's own named subset,
  // narrower than checkTrailSafety's full Tier A set) — difficulty/
  // technical/family-tier eligibility don't change when only the date
  // moves, so re-checking those here would risk dropping a still-valid
  // override for reasons unrelated to the actual edit.
  let manualEntries = [];
  let manualOverrideDroppedOnRefresh = false;
  if (input.operation === 'refresh' && Array.isArray(input.existingCandidateTrails)) {
    const priorManualEntries = input.existingCandidateTrails.filter((e) => e.source === 'manual_override');
    manualEntries = priorManualEntries.filter((entry) => {
      const trail = (input.trails || []).find((t) => t.trailId === entry.trailId);
      if (!trail) return false; // trail no longer exists in the Trail Database at all — can't re-check, don't silently keep it
      const safety = checkTrailSafety(trail, ctx, input.parkAccessRows, referenceDate);
      return safety.checks.bookable && safety.checks.park_date_availability && safety.checks.seasonal_safety;
    });
    manualOverrideDroppedOnRefresh = priorManualEntries.length > manualEntries.length;
  }

  const candidateTrails = [...algorithmicEntries, ...manualEntries];

  // assignmentMethod: 'rules_v1' unless selectedTrailId currently points at
  // the preserved manual entry, in which case it keeps reflecting that
  // entry's own origin (PRD Section 10 step 7) — this engine never writes
  // selectedTrailId itself, only reads it to decide this one field.
  let assignmentMethod = 'rules_v1';
  if (input.existingSelectedTrailId != null) {
    const selectedIsManual = manualEntries.some((e) => e.trailId === input.existingSelectedTrailId);
    if (selectedIsManual) assignmentMethod = 'manual_override';
  }

  const qualifyingCount = algorithmicEntries.length;
  // A dropped manual override on a date-change refresh forces a swap
  // request of its own, distinct from the "too few algorithmic candidates"
  // case below — the booking had a human-chosen trail that no longer works
  // for the new date, which needs a human to look again, not a silent
  // reversion to whatever the algorithm now picks.
  const swapRequestNeeded = qualifyingCount < 3 || manualOverrideDroppedOnRefresh;

  let swapRequestGuestConcernSummary = null;
  if (manualOverrideDroppedOnRefresh) {
    swapRequestGuestConcernSummary = 'system-generated: this booking\'s manually-selected trail no longer clears Tier A safety filters after a trail-day date change and was removed — needs a new trail swap review';
  } else if (swapRequestNeeded) {
    swapRequestGuestConcernSummary = `system-generated: rules engine returned only ${qualifyingCount} qualifying trail(s) for this booking`;
  }

  return {
    refused: false,
    candidateTrails,
    assignedAt: now.toISOString(),
    assignmentMethod,
    qualifyingCandidateCount: qualifyingCount,
    tierBRelaxed: relaxed, // [] | ['duration'] | ['duration','activity_type'] — diagnostic, not part of the stored contract
    swapRequestNeeded,
    manualOverrideDroppedOnRefresh: manualOverrideDroppedOnRefresh,
    swapRequestGuestConcernSummary: swapRequestGuestConcernSummary,
  };
}

module.exports = {
  // public entry points
  runTrailSelection,
  checkTrailSafety,
  getTrailSafetyOptions,
  computeGroupCeilings,
  // exported for the verification script / tests / a future admin view
  validateTrailSeasonCoverage,
  parseSeasonRange,
  dateWithinSeasonRange,
  parseApplicableDays,
  parseMonthList,
  parseEstTimeHours,
  parseCommaList,
  parseMinAge,
  parseYesNo,
  monthAbbrevOf,
  dayAbbrevOf,
  toDate,
  // constants a caller (or test) may need to build valid input
  OVERRIDABLE_CHECK_KEYS,
  ABSOLUTE_CHECK_KEYS,
  FITNESS_TO_DIFFICULTY_RANGE,
  TECHNICAL_COMFORT_TO_RANGE,
  HEAT_COMFORT,
  AGE_BUCKET_MIN_AGE,
  MINOR_AGE_BUCKETS,
};
