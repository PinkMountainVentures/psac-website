/**
 * lib/run-trail-assignment.js
 *
 * Extracted from api/assign-trail.js so the exact same I/O + engine-call
 * sequence can be triggered two ways without duplicating it:
 *   1. api/assign-trail.js — the external, shared-secret-authenticated
 *      contract (TRAIL_SELECTION_SHARED_SECRET), already live in
 *      production, verified end-to-end at the routing/auth level. Its
 *      request/response shape is UNCHANGED by this refactor — this file
 *      only moves its internal body, it doesn't alter behavior.
 *   2. api/run-trail-assignment.js — the new guest-facing wrapper Surface A
 *      calls (via adventurePrepToken, resolved to a bookingId server-side),
 *      since the browser never holds TRAIL_SELECTION_SHARED_SECRET or a raw
 *      bookingId. Same engine, same write-back, different front door.
 *
 * Both callers get back a plain result object (never an HTTP response) and
 * decide their own status codes / JSON shape on top of it.
 */

'use strict';

const { runTrailSelection } = require('./trail-selection-engine');
const { normalizeTrailRow, normalizeParkAccessRow, normalizeBookingContext } = require('./normalize');
const { callBookingsWebApp } = require('./apps-script-client');

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.bookingId
 * @param {'initial'|'refresh'} opts.operation
 * @returns {Promise<
 *   {outcome: 'assigned', bookingId, candidateTrails, assignedAt, assignmentMethod, qualifyingCandidateCount, swapRequestOpened} |
 *   {outcome: 'refused', reason, message} |
 *   {outcome: 'not_found'} |
 *   {outcome: 'missing_1_2a_inputs'}
 * >}
 */
async function runTrailAssignmentForBooking({ bookingId, operation }) {
  // 1. Fetch everything this run needs — identical to assign-trail.js's
  //    original step 1.
  const ctx = await callBookingsWebApp('getAdventurePrepContext', { bookingId });
  if (!ctx || ctx.notFound) {
    return { outcome: 'not_found' };
  }
  if (!ctx.adventurePrep || !ctx.experienceBooking) {
    return { outcome: 'missing_1_2a_inputs' };
  }

  const [trailDb, parkAccess] = await Promise.all([
    callBookingsWebApp('getTrailDatabase', {}),
    callBookingsWebApp('getParkAccess', {}),
  ]);

  // BUG FIX (Aug 2026, trail-selection live-testing investigation): Apps
  // Script Web Apps always answer HTTP 200 (ContentService's own behavior),
  // even when the dispatched action threw — bookings-code.gs's doPost
  // wraps every action in one try/catch and, on a throw, responds with
  // `{ ok: false, error: String(err) }` instead. callBookingsWebApp() only
  // throws on a non-200 status or an unparseable body, so a caught-and-
  // wrapped Apps Script error like this arrives here as a normal, successful
  // promise resolution — just one with no `.rows` property. The two lines
  // below used to be `(trailDb.rows || [])` / `(parkAccess.rows || [])`,
  // which silently turned ANY such failure (a missing/mistyped
  // TRAIL_DATABASE_SHEET_ID script property, trail-selection-actions.gs not
  // actually being pasted into the live Apps Script project, a renamed
  // tab, anything) into "there happen to be zero trails on record" — a
  // value the rules engine below treats as entirely legitimate, quietly
  // producing a false 0-candidate result and opening a
  // "system-generated: rules engine returned only 0 qualifying trail(s)"
  // swap request, with no error, log line, or alert anywhere pointing at
  // the real cause. This is the confirmed root cause of every test booking
  // coming back with no recommended trail. Failing loudly here instead
  // turns that silent mis-report into a visible engineering_error carrying
  // the real Apps Script error message, so the actual live cause (whatever
  // it turns out to be) is diagnosable from the very next test booking.
  if (!trailDb || trailDb.ok === false || !Array.isArray(trailDb.rows)) {
    throw new Error(
      'runTrailAssignmentForBooking: getTrailDatabase did not return rows — ' +
        ((trailDb && trailDb.error) || 'Apps Script webapp response missing rows array')
    );
  }
  if (!parkAccess || parkAccess.ok === false || !Array.isArray(parkAccess.rows)) {
    throw new Error(
      'runTrailAssignmentForBooking: getParkAccess did not return rows — ' +
        ((parkAccess && parkAccess.error) || 'Apps Script webapp response missing rows array')
    );
  }

  // 2. Normalize.
  const fullPayload = parseMaybeJson(ctx.experienceBooking.fullPayloadJson, {});
  // Prefer Adventure Prep's own reconfirmed roster (Section 1: routing has
  // to reflect the RECONFIRMED roster, not the stale booking-time one) —
  // falls back to the booking-time roster only if 1.2a's reconfirmation
  // step hasn't written one yet (shouldn't happen by the time this runs,
  // since trail assignment is step 5, after roster reconfirmation at step
  // 2/3, but fails open rather than crashing if it ever does).
  const reconfirmedRoster = parseMaybeJson(ctx.adventurePrep.reconfirmedRosterJson, null);
  // reconfirmedRosterJson, when present, already IS the attending roster —
  // Surface A's roster-editing step (1.2a) only ever writes rows for people
  // still coming, so no separate attending/not-attending flag is needed
  // here. Falls back to the original booking-time roster only if 1.2a's
  // reconfirmation hasn't run yet (shouldn't happen by trail-assignment
  // time, since that's step 5, after roster reconfirmation at step 2/3).
  const attendingRoster = reconfirmedRoster || fullPayload.roster || [];
  const booking = normalizeBookingContext(ctx.adventurePrep, ctx.experienceBooking, attendingRoster);

  const trails = (trailDb.rows || []).map(normalizeTrailRow);
  const parkAccessRows = (parkAccess.rows || []).map(normalizeParkAccessRow);
  const existingCandidateTrails = parseMaybeJson(ctx.adventurePrep.candidateTrails, []);
  const existingSelectedTrailId = ctx.adventurePrep.selectedTrailId || null;

  // TEMPORARY DIAGNOSTIC (Aug 2026, trail-selection live-testing
  // investigation) — remove once the 0-qualifying-trails discrepancy is
  // resolved. A faithful offline reproduction using the same real Trail
  // Database/Park Access/booking data predicts 3 qualifying trails for
  // recent test bookings, but the live system keeps writing back
  // candidateTrails: []. This logs exactly what this specific live run saw
  // — raw trail count, raw park access count, and the normalized booking
  // object actually fed to the engine — so the discrepancy can be
  // diagnosed from real captured data instead of another guess.
  // eslint-disable-next-line no-console
  console.log(
    '[trail-selection-diag]',
    JSON.stringify({
      bookingId,
      operation,
      trailsCount: trails.length,
      trailIds: trails.map((t) => t.trailId),
      parkAccessCount: parkAccessRows.length,
      parkAccessParks: parkAccessRows.map((r) => r.park),
      booking,
      rawExperienceBookingDate: ctx.experienceBooking.date,
      rawExperienceBookingDateType: typeof ctx.experienceBooking.date,
    })
  );

  // 3. Run the engine. Pure function, no I/O.
  const result = runTrailSelection({
    operation,
    booking,
    trails,
    parkAccessRows,
    existingCandidateTrails,
    existingSelectedTrailId,
  });

  if (result.refused) {
    return { outcome: 'refused', reason: result.reason, message: result.message };
  }

  // 4. Write back — identical to assign-trail.js's original step 4.
  await callBookingsWebApp('writeCandidateTrails', {
    bookingId,
    candidateTrails: result.candidateTrails,
    assignedAt: result.assignedAt,
    assignmentMethod: result.assignmentMethod,
  });

  if (result.swapRequestNeeded) {
    try {
      await callBookingsWebApp('openTrailSwapRequest', {
        bookingId,
        guestConcernSummary: result.swapRequestGuestConcernSummary,
        receivedAt: result.assignedAt,
        status: 'Open',
      });
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
    swapRequestOpened: result.swapRequestNeeded,
  };
}

module.exports = { runTrailAssignmentForBooking };
