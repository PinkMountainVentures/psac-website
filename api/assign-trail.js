/**
 * api/assign-trail.js
 *
 * Bucket 2.2's two operations in one endpoint: the initial run (called once
 * 1.2a's inputs are complete) and the refresh (called when the guest edits
 * a 1.2a input before T-3). Both run the identical sequence per Trail
 * Selection Logic PRD Section 10's closing paragraph — the only difference
 * is which candidateTrails entries get replaced, which lib/trail-selection-
 * engine.js's runTrailSelection() already handles internally.
 *
 * Request:  POST /api/assign-trail
 *           { bookingId: string, secret: string, operation: 'initial' | 'refresh' }
 *
 * Response shapes (mirrors this repo's existing convention — explicit
 * outcomes to branch on, never a bare throw):
 *   200 { status: 'assigned', bookingId, candidateTrails, assignedAt,
 *         assignmentMethod, qualifyingCandidateCount, swapRequestOpened }
 *   409 { status: 'refused', reason: 'custom_tier', message }
 *   401 { error: 'unauthorized' }                 — secret mismatch
 *   404 { error: 'booking_not_found' }             — bad bookingId
 *   400 { error: 'missing_bookingId' | 'invalid_operation' | 'missing_1_2a_inputs' }
 *   500 { error: 'engineering_error', detail }      — never guest-facing
 *
 * Auth: shared secret, `{ bookingId, secret, ... }`, matching
 * api/create-deposit-hold.js's own convention exactly. Env var name is new
 * (TRAIL_SELECTION_SHARED_SECRET) since this is a new capability, not a
 * reuse of DEPOSIT_HOLD_SHARED_SECRET or BOOKINGS_WEBAPP_SECRET — see the
 * accompanying README, "Why a separate secret."
 */

'use strict';

const { runTrailSelection } = require('../lib/trail-selection-engine');
const { normalizeTrailRow, normalizeParkAccessRow, normalizeBookingContext } = require('../lib/normalize');
const { callBookingsWebApp } = require('../lib/apps-script-client');

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { bookingId, secret, operation } = req.body || {};

  if (secret !== process.env.TRAIL_SELECTION_SHARED_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!bookingId) {
    res.status(400).json({ error: 'missing_bookingId' });
    return;
  }
  if (operation !== 'initial' && operation !== 'refresh') {
    res.status(400).json({ error: 'invalid_operation' });
    return;
  }

  try {
    // 1. Fetch everything this run needs: the booking's own 1.2a inputs and
    //    current Adventure Prep state, the full Trail Database, and Park
    //    Access. See apps-script/trail-selection-actions.gs for what these
    //    three actions actually do on the Sheet side.
    const ctx = await callBookingsWebApp('getAdventurePrepContext', { bookingId });
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'booking_not_found' });
      return;
    }
    if (!ctx.adventurePrep || !ctx.experienceBooking) {
      res.status(400).json({ error: 'missing_1_2a_inputs' });
      return;
    }

    const [trailDb, parkAccess] = await Promise.all([
      callBookingsWebApp('getTrailDatabase', {}),
      callBookingsWebApp('getParkAccess', {}),
    ]);

    // 2. Normalize. Roster currently lives on Experience Bookings'
    //    fullPayloadJson.roster, not on the Adventure Prep tab — see README
    //    "Where roster data actually lives," an open question for Airey.
    const fullPayload = parseMaybeJson(ctx.experienceBooking.fullPayloadJson, {});
    const bookingTimeRoster = fullPayload.roster || [];
    const booking = normalizeBookingContext(ctx.adventurePrep, ctx.experienceBooking, bookingTimeRoster);
    const trails = (trailDb.rows || []).map(normalizeTrailRow);
    const parkAccessRows = (parkAccess.rows || []).map(normalizeParkAccessRow);
    const existingCandidateTrails = parseMaybeJson(ctx.adventurePrep.candidateTrails, []);
    const existingSelectedTrailId = ctx.adventurePrep.selectedTrailId || null;

    // 3. Run the engine. Pure function, no I/O — see lib/trail-selection-engine.js.
    const result = runTrailSelection({
      operation,
      booking,
      trails,
      parkAccessRows,
      existingCandidateTrails,
      existingSelectedTrailId,
    });

    if (result.refused) {
      res.status(409).json({ status: 'refused', reason: result.reason, message: result.message });
      return;
    }

    // 4. Write back. Two writes, both idempotent to retry: the candidate
    //    set itself, and — only if needed — the system-generated Trail Swap
    //    Requests row (PRD Section 8). Never blocks the primary write on
    //    the swap-request write failing; that failure gets logged, not
    //    surfaced as this request's own failure, since the assignment
    //    itself already succeeded by that point.
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
        console.error('assign-trail: swap-request write failed, primary assignment already succeeded', bookingId, swapErr);
      }
    }

    res.status(200).json({
      status: 'assigned',
      bookingId,
      candidateTrails: result.candidateTrails,
      assignedAt: result.assignedAt,
      assignmentMethod: result.assignmentMethod,
      qualifyingCandidateCount: result.qualifyingCandidateCount,
      swapRequestOpened: result.swapRequestNeeded,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('assign-trail failed', bookingId, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
