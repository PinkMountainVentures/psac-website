/**
 * api/booking-open-days.js
 *
 * NEW (2026-09-03). Public, read-only, unauthenticated GET endpoint —
 * adventure-form.js (a static client-side file, no bookingId or session
 * yet, since this runs during the pre-booking flow) needs to know which
 * days in a given month it can let the guest pick on the date-picker
 * screen, closing the long-open build-checklist P0 item: "Date picker:
 * restrict to open days only ... defined generically by whichever trail's
 * hours/days apply, not hardcoded to Agua Caliente."
 *
 * No secret, no bookingId — same posture as api/stripe-config.js: this is
 * non-sensitive, already-public data (park operating days), not a
 * booking- or guest-specific lookup. The real decision logic (does at
 * least one bookable trail's park actually open on a given date) lives in
 * lib/trail-selection-engine.js's isAnyBookableTrailOpen, the exact same
 * function checkTrailSafety/getTrailSafetyOptions use for the equivalent
 * Tier A "park_date_availability" check at trail-assignment time — this
 * endpoint never re-implements that rule, only calls it per candidate day
 * via lib/booking-open-days-service.js.
 *
 * Request:  GET /api/booking-open-days?year=2026&month=9
 * Response: 200 { year, month, openDates: ['2026-09-04', '2026-09-05', ...] }
 *           (a date NOT in openDates is closed — no day restriction stated
 *           anywhere reads as "open", per the underlying engine function's
 *           own fail-open default when a park has no day restriction on
 *           the matching Park Access row.)
 *           400 { error: 'invalid_year_month' }
 *           500 { error: 'engineering_error', detail }
 */

'use strict';

const { getOpenDaysForMonth } = require('../lib/booking-open-days-service');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);

  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    res.status(400).json({ error: 'invalid_year_month' });
    return;
  }

  try {
    const { openDates } = await getOpenDaysForMonth({ year, month });
    // Small, non-sensitive, slowly-changing dataset (park hours/seasons
    // don't change minute to minute) — safe to cache briefly at the
    // edge/browser, same reasoning as api/stripe-config.js.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json({ year, month, openDates });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('booking-open-days failed', year, month, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
