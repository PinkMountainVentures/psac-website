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
