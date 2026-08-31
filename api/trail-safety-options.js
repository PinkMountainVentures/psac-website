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
 *           { trailId, trailName, difficultyRating,
 *             clearsAllTierA: boolean,
 *             overridableFailures: string[],
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
 *
 * MIGRATED (Task 18, 2026-08-31): I/O rewritten against Postgres via the
 * new lib/trail-safety-options-service.js, which builds the identical
 * booking-context shape lib/run-trail-assignment.js already builds and
 * tests for the same untouched trail-selection-engine.js — reusing that
 * file's normalizeTrailRow/normalizeParkAccessRow/AGE_BUCKET_LABELS rather
 * than a second copy. Roster now comes directly from booking_participants
 * (no fullPayloadJson/reconfirmedRosterJson fallback needed — this schema's
 * booking_participants is a complete, always-current roster on its own,
 * per Finding #29 in the migration progress doc). Request/response shape
 * and auth are unchanged; the response's `park`/`bookable` fields mentioned
 * in an earlier draft of this comment were never actually part of
 * getTrailSafetyOptions's real output — corrected above to match what this
 * endpoint has always actually returned.
 */

'use strict';

const { getSafetyOptionsForBooking } = require('../lib/trail-safety-options-service');

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
    const result = await getSafetyOptionsForBooking({ bookingId });

    if (result.notFound) {
      res.status(404).json({ error: 'booking_not_found' });
      return;
    }
    if (result.missingInputs) {
      res.status(400).json({ error: 'missing_1_2a_inputs' });
      return;
    }

    res.status(200).json({ bookingId, options: result.options });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('trail-safety-options failed', bookingId, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
