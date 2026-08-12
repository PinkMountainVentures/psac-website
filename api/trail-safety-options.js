/**
 * api/trail-safety-options.js
 *
 * Operations UX's Trail Swap Requests page needs a per-booking dropdown of
 * every trail a staffer could swap the guest onto, each annotated with
 * whether it clears Tier A safety on its own or would require a documented
 * override (Operations UX PRD Section 7, Section 13's cross-chat contract).
 *
 * This endpoint is the ONLY place that annotation logic lives. It calls the
 * exact same checkTrailSafety() function bucket 2.2's own candidate-pool
 * filter uses (lib/trail-selection-engine.js) — never a re-implementation —
 * so a staff override and the algorithmic pool can never silently disagree
 * about what "fails Tier A" means for a given booking.
 *
 * Request:  POST /api/trail-safety-options
 *           { bookingId: string, secret: string }
 *
 * Response:
 *   200 { bookingId, options: [
 *           { trailId, trailName, park, difficultyRating, bookable,
 *             clearsAllTierA: boolean,
 *             overridableFailures: [{ key, label, detail }],
 *             // absolute failures (not bookable, no park/date match) are
 *             // omitted from `options` entirely — see checkTrailSafety's
 *             // own doc comment for why those are never override-able.
 *           }, ...
 *         ] }
 *   401 { error: 'unauthorized' }
 *   404 { error: 'booking_not_found' }
 *   400 { error: 'missing_bookingId' | 'missing_1_2a_inputs' }
 *   500 { error: 'engineering_error', detail }
 *
 * Auth: same TRAIL_SELECTION_SHARED_SECRET as api/assign-trail.js — this is
 * still bucket 2.2's surface area, just a read-only second entry point into
 * it, so it reuses that endpoint's secret rather than inventing a third one.
 */

'use strict';

const { getTrailSafetyOptions, computeGroupCeilings, toDate } = require('../lib/trail-selection-engine');
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

  const { bookingId, secret } = req.body || {};

  if (secret !== process.env.TRAIL_SELECTION_SHARED_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!bookingId) {
    res.status(400).json({ error: 'missing_bookingId' });
    return;
  }

  try {
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

    const fullPayload = parseMaybeJson(ctx.experienceBooking.fullPayloadJson, {});
    const bookingTimeRoster = fullPayload.roster || [];
    const booking = normalizeBookingContext(ctx.adventurePrep, ctx.experienceBooking, bookingTimeRoster);
    const trails = (trailDb.rows || []).map(normalizeTrailRow);
    const parkAccessRows = (parkAccess.rows || []).map(normalizeParkAccessRow);

    // getTrailSafetyOptions expects the SAME internal ctx shape
    // runTrailSelection builds for itself (roster + precomputed groupCeilings,
    // not the raw normalized booking) plus an explicit reference date — see
    // trail-selection-engine.js's own runTrailSelection for the identical
    // construction. Building it any other way here would risk silently
    // drifting from what the candidate-pool filter actually checks.
    const groupCeilings = computeGroupCeilings(booking.roster, booking.technicalComfort);
    const safetyCtx = {
      roster: booking.roster,
      groupCeilings,
      bestForAttributes: booking.bestForAttributes || [],
      heatComfort: booking.heatComfort,
      duration: booking.duration,
      activityType: booking.activityType,
    };
    const referenceDate = toDate(booking.confirmedDate);

    const options = getTrailSafetyOptions(safetyCtx, trails, parkAccessRows, referenceDate);

    res.status(200).json({ bookingId, options });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('trail-safety-options failed', bookingId, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
