/**
 * lib/trail-swap-service.js
 *
 * MIGRATED (2026-08-31, Task 8 ops-proxy migration): Postgres replacement
 * for apps-script/trail-swap-actions.gs's four actions — trailSwap_logIntake,
 * trailSwap_getRequestContext, trailSwap_getDropdownOptions,
 * trailSwap_applyOverride. Backs api/write-manual-trail-override.js.
 *
 * Every Sheets-era workaround the .gs source documents fixing (en-dash vs
 * ASCII-hyphen column names, Date-object trip dates, the Trails tab living
 * on a separate spreadsheet with a two-row header) is a Google-Sheets-
 * storage-layer artifact with no Postgres equivalent — this schema already
 * has correctly-typed columns (trails.difficulty/technical_rating are plain
 * INTEGER; trails.optimal_season/viable_season/avoid_season and
 * park_access.applicable_days are already TEXT[]; booking_participants.
 * age_bucket is a real enum, 'under_14'/'14_17'/... — no en-dash bug
 * possible). Only the underlying business logic (season-range parsing,
 * day-of-week checking, family-tier/ceiling computation) is ported.
 *
 * Roster: read directly from booking_participants (attending rows only),
 * mirroring lib/run-trail-assignment.js's own pattern — no
 * reconfirmedRosterJson/fullPayload-roster fallback needed here, since
 * booking_participants is the persistent source of truth from booking time
 * onward in this schema (the .gs version's fallback existed only because
 * Adventure Prep's own JSON snapshot could be blank before a guest reached
 * 1.2a; this schema has no such gap).
 */

'use strict';

const { sql, transaction } = require('./db');
const { genId } = require('./ids');

// ---------------------------------------------------------------------------
// Intake / context (simple reads/writes)
// ---------------------------------------------------------------------------

/** Staff-initiated intake only (the system-generated <3-candidate auto-open intake path belongs to lib/run-trail-assignment.js, not this file). */
async function logIntake({ bookingId, guestConcernSummary }) {
  const swapRequestId = genId('SWAP');
  await sql`
    INSERT INTO trail_swap_requests (swap_request_id, booking_id, guest_concern_summary, received_at, status)
    VALUES (${swapRequestId}, ${bookingId}, ${guestConcernSummary || ''}, NOW(), 'Open')
  `;
  return { ok: true, swapRequestId };
}

async function getRequestContext({ swapRequestId }) {
  const rows = await sql`SELECT * FROM trail_swap_requests WHERE swap_request_id = ${swapRequestId}`;
  if (!rows.length) return { notFound: true };
  const r = rows[0];
  return {
    swapRequestId: r.swap_request_id,
    bookingId: r.booking_id,
    guestConcernSummary: r.guest_concern_summary || '',
    receivedAt: r.received_at ? new Date(r.received_at).toISOString() : '',
    status: r.status,
    reviewedBy: r.reviewed_by || '',
    newTrailId: r.new_trail_id || '',
    staffNotes: r.staff_notes || '',
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : '',
    tierASafetyFiltersOverridden: r.tier_a_safety_filters_overridden || [],
    safetyOverrideReason: r.safety_override_reason || '',
  };
}

// ---------------------------------------------------------------------------
// Read-side: the dropdown's underlying data
// ---------------------------------------------------------------------------

const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthAbbrev(dateStr) {
  const m = String(dateStr || '').match(/^\d{4}-(\d{2})-\d{2}/);
  if (!m) return null;
  return MONTH_ABBREVS[Number(m[1]) - 1];
}

/** Park/date availability (absolute exclusion) — checks the trail's `park` against park_access's schedule for the trip date. A trail with no park value is open/unrestricted. */
function parseParkSeasonRange(seasonStr) {
  const s = String(seasonStr || '').trim();
  if (!s || /year-round/i.test(s)) return null; // no restriction
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const m = s.match(/([A-Za-z]{3})\s*(\d{1,2})\s*-\s*([A-Za-z]{3})\s*(\d{1,2})/);
  if (!m) return null; // unrecognized format -> don't falsely exclude
  return { startMonth: months[m[1]], startDay: Number(m[2]), endMonth: months[m[3]], endDay: Number(m[4]) };
}

function dateInSeasonRange(tripDate, range) {
  if (!range) return true; // year-round or unrecognized -> not restricted
  const d = String(tripDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return true;
  const month = Number(d[2]) - 1;
  const day = Number(d[3]);
  const startsBeforeEnds = range.startMonth < range.endMonth || (range.startMonth === range.endMonth && range.startDay <= range.endDay);
  const afterStart = month > range.startMonth || (month === range.startMonth && day >= range.startDay);
  const beforeEnd = month < range.endMonth || (month === range.endMonth && day <= range.endDay);
  if (startsBeforeEnds) return afterStart && beforeEnd;
  return afterStart || beforeEnd; // wraps the calendar year
}

function dayOfWeekAbbrev(tripDate) {
  const d = String(tripDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return null;
  const abbrevs = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dateObj = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
  return abbrevs[dateObj.getDay()];
}

function parkAvailable(trail, tripDate, parkAccessRows) {
  if (!trail.park) return true;
  const relevant = parkAccessRows.filter((r) => r.park === trail.park);
  if (!relevant.length) return true; // no schedule row for this park -> not restricted
  const dayAbbrev = dayOfWeekAbbrev(tripDate);
  return relevant.some((r) => {
    const range = parseParkSeasonRange(r.season);
    if (!dateInSeasonRange(tripDate, range)) return false;
    const applicableDays = r.applicable_days; // real TEXT[] or NULL — no comma-string parsing needed
    if (!applicableDays || !applicableDays.length) return true; // blank -> every day
    if (!dayAbbrev) return true; // unparseable trip date -> don't falsely exclude
    return applicableDays.indexOf(dayAbbrev) !== -1;
  });
}

/**
 * Seasonal safety (advisory, overridable). Returns 'unknown' only when the
 * trip month isn't graded in ANY of Avoid/Optimal/Viable for this trail —
 * the caller (getDropdownOptions) treats that the same as 'avoid' (fail
 * closed), per the original PRD's explicit instruction.
 */
function seasonStatus(trail, tripMonthAbbrev) {
  if (!tripMonthAbbrev) return 'unknown';
  const avoid = trail.avoid_season || [];
  const viable = trail.viable_season || [];
  const optimal = trail.optimal_season || [];
  if (avoid.indexOf(tripMonthAbbrev) !== -1) return 'avoid';
  if (optimal.indexOf(tripMonthAbbrev) !== -1) return 'optimal';
  if (viable.indexOf(tripMonthAbbrev) !== -1) return 'viable';
  return 'unknown';
}

/** Family-tier eligibility — Trail Selection Logic PRD Section 4. Minors are roster rows whose age_bucket is 'under_14' or '14_17' — real enum values, no en-dash bug possible. */
function familyTierEligible(trail, roster) {
  const minors = (roster || []).filter((p) => p.age_bucket === 'under_14' || p.age_bucket === '14_17');
  if (!minors.length) return { applies: false, eligible: true };
  const kidFriendly = trail.kid_friendly === true;
  if (!kidFriendly) return { applies: true, eligible: false };
  const minAgeRecRaw = trail.min_age_rec;
  if (minAgeRecRaw === '' || minAgeRecRaw == null || isNaN(Number(minAgeRecRaw))) return { applies: true, eligible: true };
  const minAge = Number(minAgeRecRaw);
  // A bucket only gives a lower bound, never an exact age — 'under_14' still
  // correctly fails any real minAgeRec above 0; '14_17' can't be ruled out
  // precisely (could be 14, could be 17), so it's never falsely excluded.
  const allMeetMinAge = minors.every((p) => (p.age_bucket === 'under_14' ? minAge <= 0 : true));
  return { applies: true, eligible: allMeetMinAge };
}

// ---------------------------------------------------------------------------
// Ceiling computation — Airey-confirmed mapping table (Trail Selection
// Logic PRD Section 4): Easygoing -> 2, Comfortable -> 4, Strong -> 5, same
// mapping for both the Difficulty axis (least-experienced ATTENDING roster
// member governs the group) and the Technical axis (booking's single
// technical_comfort field, no per-person summarization needed).
// ---------------------------------------------------------------------------

const FITNESS_TIER_CEILING = { easygoing: 2, comfortable: 4, strong: 5 };
const FITNESS_TIER_ORDER = ['easygoing', 'comfortable', 'strong'];

function fitnessTierKey(value) {
  const v = String(value || '').toLowerCase();
  if (v.indexOf('easygoing') !== -1 || v.indexOf('wide, easy') !== -1) return 'easygoing';
  if (v.indexOf('comfortable') !== -1 || v.indexOf('some rock') !== -1) return 'comfortable';
  if (v.indexOf('strong') !== -1 || v.indexOf('experienced') !== -1 || v.indexOf('scrambling') !== -1) return 'strong';
  return null;
}

function computeGroupCeilings(roster, technicalComfort) {
  let worstTierIdx = null;
  (roster || []).forEach((p) => {
    const key = fitnessTierKey(p.fitness_level);
    if (!key) return;
    const idx = FITNESS_TIER_ORDER.indexOf(key);
    if (worstTierIdx === null || idx < worstTierIdx) worstTierIdx = idx;
  });
  const difficultyCeiling = worstTierIdx === null ? null : FITNESS_TIER_CEILING[FITNESS_TIER_ORDER[worstTierIdx]];
  const technicalKey = fitnessTierKey(technicalComfort);
  const technicalCeiling = technicalKey ? FITNESS_TIER_CEILING[technicalKey] : null;
  return {
    difficultyCeiling,
    technicalCeiling,
    evaluatable: difficultyCeiling != null && technicalCeiling != null,
  };
}

/**
 * Returns every bookable=true trail, each annotated with whether it clears
 * this booking's Tier A filters. Bookable/park-date are absolute (excluded
 * from the list entirely); the other three (seasonal_safety, family_tier,
 * difficulty/technical ceiling) are advisory flags the Apply-button UI uses
 * to trigger the inline warning-and-reason gate.
 */
async function getDropdownOptions({ bookingId }) {
  const bookingRows = await sql`SELECT booking_id, date FROM experience_bookings WHERE booking_id = ${bookingId}`;
  if (!bookingRows.length) return { notFound: true };
  const booking = bookingRows[0];
  const tripDate = booking.date ? (booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : String(booking.date)) : '';

  const roster = await sql`
    SELECT display_name, age_bucket, fitness_level FROM booking_participants
    WHERE experience_booking_id = ${bookingId} AND is_participating = true
    ORDER BY roster_index
  `;
  const apRows = await sql`SELECT technical_comfort FROM adventure_prep WHERE booking_id = ${bookingId}`;
  const technicalComfort = apRows.length ? apRows[0].technical_comfort : null;

  const ceilings = computeGroupCeilings(roster, technicalComfort);

  const trails = await sql`SELECT * FROM trails WHERE bookable = true`;
  const parkAccessRows = await sql`SELECT * FROM park_access`;

  const options = [];
  trails.forEach((trail) => {
    if (!parkAvailable(trail, tripDate, parkAccessRows)) return; // absolute exclusion

    const season = seasonStatus(trail, monthAbbrev(tripDate));
    const family = familyTierEligible(trail, roster);
    const difficultyRating = trail.difficulty != null ? Number(trail.difficulty) : 0;
    const technicalRating = trail.technical_rating != null ? Number(trail.technical_rating) : 0;

    const failedFilters = [];
    // An ungraded month ('unknown') defaults to Avoid (fail closed), not a
    // silent pass — Trail Selection Logic PRD Section 3.
    if (season === 'avoid' || season === 'unknown') failedFilters.push('seasonal_safety');
    if (family.applies && !family.eligible) failedFilters.push('family_tier');
    if (ceilings.evaluatable !== false) {
      if (ceilings.difficultyCeiling != null && difficultyRating > ceilings.difficultyCeiling) failedFilters.push('difficulty_ceiling');
      if (ceilings.technicalCeiling != null && technicalRating > ceilings.technicalCeiling) failedFilters.push('technical_ceiling');
    }

    options.push({
      trailId: trail.trail_id,
      trailName: trail.trail_name || '',
      difficultyRating,
      technicalRating,
      failedFilters,
      ceilingsEvaluatable: ceilings.evaluatable !== false,
      seasonStatus: season,
    });
  });

  return { options, ceilingsEvaluatable: ceilings.evaluatable !== false, tripDate };
}

// ---------------------------------------------------------------------------
// Write-back: the Apply action
// ---------------------------------------------------------------------------

/**
 * The Apply action: one call does everything — writes the manual override
 * into candidate_trails, updates adventure_prep's selected_trail_id/
 * assignment_method/assigned_at, resolves the Trail Swap Requests row (if
 * any), and appends the audit_log row, all as one transaction.
 *
 * candidate_trails has CHECK(rank BETWEEN 1 AND 4) and
 * UNIQUE(experience_booking_id, rank) — unlike the .gs version's unbounded
 * JSON array, a manual override needs a real rank slot. Design: (1) drop
 * any existing manual_override row for this booking first (the .gs
 * source's own "single manual-slot cap"); (2) if a free rank (1-4) remains
 * among what's left, use it; (3) if all 4 are taken by rules_v1 entries,
 * evict the HIGHEST-ranked (least-preferred) one and reuse its slot — the
 * manual override always gets a slot, top algorithmic picks are preserved
 * as much as possible.
 *
 * difficulty_rating/technical_rating/distance/elevation are looked up
 * directly from the trails table by trail_id at write time (the DB is
 * local, so there's no reason to trust a fragile caller-supplied pass-
 * through the way the .gs version did — that version also never even wired
 * technicalRating/distance/elevation through at all, a real pre-existing
 * gap in api/write-manual-trail-override.js, closed here for free).
 * matched_attributes stays null for a manual entry — no attribute match,
 * hand-picked, matching the .gs version's own `matchedAttributes: null`.
 *
 * The read that decides which rank to use (and whether to evict) happens
 * BEFORE the transaction, since lib/db.js's transaction() takes an array of
 * already-built query promises — every value has to be known in JS before
 * any of them run, same constraint lib/run-trail-assignment.js's own
 * transaction call already works within. A concurrent second override
 * landing between that read and this write is a low-risk race for a
 * staff-only, one-at-a-time admin action — matching this project's
 * existing risk tolerance for non-financial writes.
 */
async function applyOverride({ bookingId, swapRequestId, newTrailId, staffNotes, tierASafetyFiltersOverridden, safetyOverrideReason, reviewedBy }) {
  const trailRows = await sql`
    SELECT trail_id, difficulty, technical_rating, distance_mi, elevation_gain_ft FROM trails WHERE trail_id = ${newTrailId}
  `;
  if (!trailRows.length) return { ok: false, error: 'Trail not found: ' + newTrailId };
  const trail = trailRows[0];

  const bookingRows = await sql`SELECT booking_id, contact_email, contact_name FROM experience_bookings WHERE booking_id = ${bookingId}`;
  if (!bookingRows.length) return { ok: false, error: 'Booking not found' };
  const booking = bookingRows[0];

  const apRows = await sql`SELECT selected_trail_id FROM adventure_prep WHERE booking_id = ${bookingId}`;
  const oldSelectedTrailId = apRows.length ? apRows[0].selected_trail_id : null;

  const existingCandidates = await sql`
    SELECT candidate_trail_id, rank, source FROM candidate_trails WHERE experience_booking_id = ${bookingId} ORDER BY rank
  `;
  const withoutPriorManual = existingCandidates.filter((c) => c.source !== 'manual_override');

  let targetRank;
  let evictedId = null;
  if (withoutPriorManual.length < 4) {
    const usedRanks = withoutPriorManual.map((c) => c.rank);
    targetRank = [1, 2, 3, 4].find((r) => usedRanks.indexOf(r) === -1);
  } else {
    const highest = withoutPriorManual.reduce((a, b) => (b.rank > a.rank ? b : a));
    targetRank = highest.rank;
    evictedId = highest.candidate_trail_id;
  }

  const now = new Date().toISOString();
  const overrides = tierASafetyFiltersOverridden || [];
  const oldValueJson = JSON.stringify({ selectedTrailId: oldSelectedTrailId });
  const newValueJson = JSON.stringify({
    selectedTrailId: newTrailId,
    tierASafetyFiltersOverridden: overrides,
    safetyOverrideReason: safetyOverrideReason || '',
  });

  await transaction((txSql) => {
    const queries = [
      // Ensure the adventure_prep row exists — mirrors adventurePrep_getOrCreateRow_.
      txSql`INSERT INTO adventure_prep (booking_id) VALUES (${bookingId}) ON CONFLICT (booking_id) DO NOTHING`,
      // Single manual-slot cap — drop any prior manual entry.
      txSql`DELETE FROM candidate_trails WHERE experience_booking_id = ${bookingId} AND source = 'manual_override'`,
    ];
    if (evictedId) {
      queries.push(txSql`DELETE FROM candidate_trails WHERE candidate_trail_id = ${evictedId}`);
    }
    queries.push(txSql`
      INSERT INTO candidate_trails (experience_booking_id, rank, source, trail_id, matched_attributes, difficulty_rating, technical_rating, distance, elevation)
      VALUES (${bookingId}, ${targetRank}, 'manual_override', ${newTrailId}, NULL, ${trail.difficulty}, ${trail.technical_rating}, ${trail.distance_mi}, ${trail.elevation_gain_ft})
    `);
    queries.push(txSql`
      UPDATE adventure_prep SET selected_trail_id = ${newTrailId}, assignment_method = 'manual_override', assigned_at = ${now}
      WHERE booking_id = ${bookingId}
    `);
    if (swapRequestId) {
      queries.push(txSql`
        UPDATE trail_swap_requests
        SET reviewed_by = ${reviewedBy || ''}, new_trail_id = ${newTrailId}, staff_notes = ${staffNotes || ''},
            tier_a_safety_filters_overridden = ${overrides}, safety_override_reason = ${safetyOverrideReason || ''},
            resolved_at = ${now}, status = 'Resolved'
        WHERE swap_request_id = ${swapRequestId}
      `);
    }
    queries.push(txSql`
      INSERT INTO audit_log (audit_id, booking_id, change_type, old_value_json, new_value_json, staff_notes, tier_a_safety_filters_overridden, safety_override_reason)
      VALUES (${genId('AUDIT')}, ${bookingId}, 'trail_manual_override', ${oldValueJson}, ${newValueJson}, ${staffNotes || ''}, ${overrides}, ${safetyOverrideReason || ''})
    `);
    return queries;
  });

  const finalCandidates = await sql`
    SELECT rank, source, trail_id, matched_attributes, difficulty_rating, technical_rating, distance, elevation
    FROM candidate_trails WHERE experience_booking_id = ${bookingId} ORDER BY rank
  `;
  const candidateTrails = finalCandidates.map((c) => ({
    rank: c.rank, source: c.source, trailId: c.trail_id, matchedAttributes: c.matched_attributes,
    difficultyRating: c.difficulty_rating, technicalRating: c.technical_rating, distance: c.distance, elevation: c.elevation,
  }));

  return {
    ok: true,
    bookingId,
    selectedTrailId: newTrailId,
    candidateTrails,
    contactEmail: booking.contact_email,
    contactName: booking.contact_name,
  };
}

module.exports = { logIntake, getRequestContext, getDropdownOptions, applyOverride };
