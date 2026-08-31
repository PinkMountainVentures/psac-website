/**
 * lib/run-trail-assignment.js
 *
 * Postgres rewrite. lib/trail-selection-engine.js is UNCHANGED — it's a
 * pure function (no I/O, no Sheet/Postgres awareness at all, per its own
 * header comment) and this migration has no reason to touch already-
 * reviewed rules logic. Only the I/O around it — fetching trails/park
 * access/booking context, and writing the result back — is rewritten here
 * against the new schema instead of lib/apps-script-client.js's
 * callBookingsWebApp().
 *
 * ============================================================================
 * WHAT CHANGED, AND WHY
 * ============================================================================
 *
 * 1. ROSTER COMES FROM booking_participants (attending rows only), NOT
 *    fullPayloadJson/reconfirmedRosterJson. The engine's own
 *    computeGroupCeilings() and the minor/family-tier check
 *    (MINOR_AGE_BUCKETS) both read booking.roster[].fitness and .ageRange
 *    already — this is NOT new logic this migration has to add, it's
 *    existing logic that already depends on per-person age+fitness data
 *    (confirming Airey's 2026-08-31 point: that data has to keep flowing
 *    here, "even if it doesn't use it right now" undersold how much this
 *    already leans on it). age_bucket is stored as a snake_case enum in
 *    Postgres (schema.sql) but the engine's AGE_BUCKET_MIN_AGE/
 *    MINOR_AGE_BUCKETS constants key off the exact raw labels ("Under 14",
 *    "14–17", etc.) — AGE_BUCKET_LABELS below reverses the mapping back to
 *    those exact strings before calling the engine. fitness_level is
 *    passed straight through unchanged; the engine's fitnessTierKey_()
 *    already does fuzzy substring matching designed for exactly this kind
 *    of free text.
 * 2. candidate_trails IS A TABLE, NOT A JSON COLUMN. The engine's rich
 *    candidateTrails output (trailName/overviewCopy/photoUrl/park/
 *    trailheadLocation/oneTripTip alongside the stored fields) only has
 *    columns here for the numeric/analytic subset (difficulty_rating/
 *    technical_rating/distance/elevation/matched_attributes) — the
 *    display copy fields are deliberately NOT duplicated, since they're
 *    already sitting on `trails` and can be joined back by trail_id.
 *    Whatever reads this table for display (bookingDetail_get's rewrite,
 *    a future "choose your trail" endpoint) needs `candidate_trails JOIN
 *    trails ON trail_id`, not just a `SELECT * FROM candidate_trails`.
 * 3. "missing_1_2a_inputs" is now a real content check, not a row-
 *    existence check. adventure_prep.booking_id is auto-created (mostly
 *    NULL) the moment a guest first opens Surface A (see
 *    lib/adventure-prep-service.js's getContextByToken), so "does a row
 *    exist" is no longer a meaningful signal that roster reconfirmation
 *    (1.2a) has actually happened. This checks for the two things trail
 *    assignment actually needs: technical_comfort set, and at least one
 *    attending (is_participating = true) booking_participants row.
 * 4. Same "fail loudly, don't silently misreport" posture as the Apps
 *    Script version's own documented bug fix (a missing/empty trails or
 *    park_access result throws rather than being silently treated as
 *    "zero trails on record") — kept here even though the failure mode
 *    that originally caused it (an Apps Script webapp's own error-
 *    swallowing behavior) doesn't apply to a direct Postgres query, since
 *    an empty `trails`/`park_access` table is still exactly as wrong here
 *    as it was there.
 */

'use strict';

const { sql, transaction } = require('./db');
const { runTrailSelection, parseCommaList } = require('./trail-selection-engine');
const { genId } = require('./ids');

// Reverse of lib/booking-service.js's / lib/adventure-prep-service.js's
// AGE_BUCKET_MAP — see this file's header comment, point 1.
const AGE_BUCKET_LABELS = {
  under_14: 'Under 14',
  '14_17': '14–17',
  '18_24': '18–24',
  '25_34': '25–34',
  '35_44': '35–44',
  '45_54': '45–54',
  '55_64': '55–64',
  '65_plus': '65+',
};

/** trails row (already mostly typed in Postgres) -> the shape the engine expects. */
function normalizeTrailRow(row) {
  return {
    trailId: row.trail_id,
    trailName: row.trail_name,
    bookable: !!row.bookable,
    park: (row.park || '').trim(),
    trailheadLocation: row.trailhead_name,
    // est_time_easy_pace/strong_pace are still free text ("2.5 to 3 hours")
    // in the new schema, same as the live Sheet — parseEstTimeHours (from
    // the untouched engine module) still does the real parsing; it isn't
    // exported from trail-selection-engine.js's public API (only used
    // internally there), so this passes the raw strings straight through
    // exactly like the old normalizeTrailRow did, and the engine parses
    // them itself wherever it actually needs numeric hours.
    easyPaceHours: row.est_time_easy_pace,
    strongPaceHours: row.est_time_strong_pace,
    difficulty: row.difficulty,
    technicalRating: row.technical_rating,
    distance: row.distance_mi != null ? Number(row.distance_mi) : null,
    elevation: row.elevation_gain_ft,
    // activity_type is still a comma-string column (schema.sql), not
    // TEXT[] — parseCommaList (exported from the engine) does the same
    // parsing the old normalize.js used.
    activityType: parseCommaList(row.activity_type),
    optimalSeason: row.optimal_season,
    viableSeason: row.viable_season,
    avoidSeason: row.avoid_season,
    kidFriendly: !!row.kid_friendly,
    // min_age_rec stays raw text ("12+") — same reasoning as
    // easyPaceHours/strongPaceHours above.
    minAgeRec: row.min_age_rec,
    // best_for_attributes and TEXT[] season columns are already real
    // arrays in Postgres (parsed at seed time) — no parseCommaList needed.
    bestForAttributes: row.best_for_attributes || [],
    oneTripTip: row.trail_day_tip || null,
    overviewCopy: row.opening_description || '',
    photoUrl: row.photo_references ? String(row.photo_references).split(/[\n,;]/)[0].trim() : null,
    fullSunExposure: undefined, // not a real column yet — matches normalize.js's own note
  };
}

/** park_access row -> the shape the engine expects. */
function normalizeParkAccessRow(row) {
  return {
    park: (row.park || '').trim(),
    season: row.season,
    // applicable_days is TEXT[] here; the engine's parseApplicableDays does
    // `String(raw).split(',')`, and JS's Array->String coercion joins with
    // commas, so passing the array straight through parses identically to
    // passing the old Sheet's raw comma-string — no join() needed here.
    applicableDays: row.applicable_days,
    openingTime: row.opening_time,
    closingTime: row.closing_time,
    adultFee: row.adult_fee,
    childFee: row.child_fee,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.bookingId
 * @param {'initial'|'refresh'} opts.operation
 */
async function runTrailAssignmentForBooking({ bookingId, operation }) {
  const bookingRows = await sql`SELECT booking_id, tier, date, intake_json FROM experience_bookings WHERE booking_id = ${bookingId}`;
  if (!bookingRows.length) return { outcome: 'not_found' };
  const booking = bookingRows[0];

  const apRows = await sql`SELECT * FROM adventure_prep WHERE booking_id = ${bookingId}`;
  const ap = apRows[0];

  const participantRows = await sql`
    SELECT display_name, age_bucket, fitness_level
    FROM booking_participants
    WHERE experience_booking_id = ${bookingId} AND is_participating = true
    ORDER BY roster_index
  `;

  // See this file's header comment, point 3.
  if (!ap || ap.technical_comfort == null || participantRows.length === 0) {
    return { outcome: 'missing_1_2a_inputs' };
  }

  const [trailRows, parkAccessRows, existingCandidateRows] = await Promise.all([
    sql`SELECT * FROM trails`,
    sql`SELECT * FROM park_access`,
    sql`SELECT trail_id, source FROM candidate_trails WHERE experience_booking_id = ${bookingId}`,
  ]);

  // See this file's header comment, point 4 — an empty result here is
  // always wrong (this migration's seed data guarantees 38 trails/7 park
  // access rows exist), so fail loudly rather than let the engine treat
  // it as "zero trails happen to qualify."
  if (!trailRows.length) {
    throw new Error('runTrailAssignmentForBooking: trails table returned zero rows — seed data missing or DATABASE_URL points at the wrong database');
  }
  if (!parkAccessRows.length) {
    throw new Error('runTrailAssignmentForBooking: park_access table returned zero rows — seed data missing or DATABASE_URL points at the wrong database');
  }

  const trails = trailRows.map(normalizeTrailRow);
  const parkAccess = parkAccessRows.map(normalizeParkAccessRow);

  const roster = participantRows.map((p) => ({
    name: p.display_name,
    ageRange: AGE_BUCKET_LABELS[p.age_bucket] || null,
    fitness: p.fitness_level,
  }));

  const intake = booking.intake_json || {};
  const bookingCtx = {
    bookingId: booking.booking_id,
    tier: booking.tier,
    confirmedDate: booking.date,
    activityType: intake.q5_activity || null,
    duration: intake.q6_duration || null,
    roster,
    technicalComfort: ap.technical_comfort,
    heatComfort: ap.heat_comfort,
    bestForAttributes: ap.best_for_attributes || [],
  };

  const existingCandidateTrails = existingCandidateRows.map((r) => ({ trailId: r.trail_id, source: r.source }));
  const existingSelectedTrailId = ap.selected_trail_id || null;

  const result = runTrailSelection({
    operation,
    booking: bookingCtx,
    trails,
    parkAccessRows: parkAccess,
    existingCandidateTrails,
    existingSelectedTrailId,
  });

  if (result.refused) {
    return { outcome: 'refused', reason: result.reason, message: result.message };
  }

  await transaction((txSql) => {
    const queries = [
      txSql`DELETE FROM candidate_trails WHERE experience_booking_id = ${bookingId}`,
    ];
    result.candidateTrails.forEach((c, i) => {
      queries.push(txSql`
        INSERT INTO candidate_trails (
          experience_booking_id, rank, source, trail_id, matched_attributes,
          difficulty_rating, technical_rating, distance, elevation
        ) VALUES (
          ${bookingId}, ${i + 1}, ${c.source}, ${c.trailId}, ${c.matchedAttributes},
          ${c.difficultyRating}, ${c.technicalRating}, ${c.distance}, ${c.elevation}
        )
      `);
    });
    queries.push(txSql`
      UPDATE adventure_prep SET assigned_at = ${result.assignedAt}, assignment_method = ${result.assignmentMethod}
      WHERE booking_id = ${bookingId}
    `);
    return queries;
  });

  let swapRequestOpened = false;
  if (result.swapRequestNeeded) {
    try {
      await sql`
        INSERT INTO trail_swap_requests (swap_request_id, booking_id, guest_concern_summary, received_at, status)
        VALUES (${genId('SWAP')}, ${bookingId}, ${result.swapRequestGuestConcernSummary}, ${result.assignedAt}, 'Open')
      `;
      swapRequestOpened = true;
    } catch (swapErr) {
      // eslint-disable-next-line no-console
      console.error('runTrailAssignmentForBooking: swap-request write failed, primary assignment already succeeded', bookingId, swapErr);
    }
  }

  return {
    outcome: 'assigned',
    bookingId,
    candidateTrails: result.candidateTrails,
    assignedAt: result.assignedAt,
    assignmentMethod: result.assignmentMethod,
    qualifyingCandidateCount: result.qualifyingCandidateCount,
    swapRequestOpened,
  };
}

module.exports = {
  runTrailAssignmentForBooking,
  // Exported for lib/trail-safety-options-service.js, which needs the
  // identical trails/park_access normalization and age-bucket label
  // reversal this file already built and tested — reused rather than a
  // second copy that could silently drift from this one.
  normalizeTrailRow,
  normalizeParkAccessRow,
  AGE_BUCKET_LABELS,
};
