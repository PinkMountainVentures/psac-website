/**
 * api/check-hold-clearance-deadline.js
 *
 * Operations UX PRD Section 6 / Section 18 item 5a — the noon Pacific,
 * T-1 dispatch-day go/no-go decision on the deposit hold. Vercel Cron at a
 * fixed 12pm Pacific trigger, three hours after the 9am attempt
 * (api/trigger-deposit-holds.js — see that file's header for why it exists;
 * this endpoint's logic assumes a hold was already attempted this morning).
 *
 * For every active booking whose trip date is tomorrow (T-1 today):
 *   - `depositStatus === 'succeeded'`: the hold cleared (either the original
 *     9am attempt succeeded outright, or staff/the guest fixed it and
 *     something re-ran api/create-deposit-hold.js in the meantime, whether
 *     before or after the guest's 11am deadline — Section 6: "whether that
 *     happened before or after 11am"). If an Open `deposit_hold_failed`
 *     alert exists for this booking, resolve it automatically — the
 *     underlying problem already fixed itself, no reason to leave it
 *     sitting Open for staff to notice and close by hand.
 *   - Anything else (`requires_action`, `unavailable`, `failed`, or still
 *     `scheduled_t1` if the 9am job somehow never ran for this booking):
 *     cancels outright via api/cancel-and-refund-booking.js with
 *     `reasons: ['hold_never_cleared']` (Section 5/6/18 item 5a — resolved:
 *     "the reservation cancels outright ... no deposit-hold action needed
 *     ... since the hold never reached succeeded, there's no live hold to
 *     release"). That endpoint itself writes `bookingStatus:
 *     'cancelled_hold_failed'`, issues the full refund, and sends the
 *     cancellation notice — this file doesn't duplicate any of that, only
 *     triggers it.
 *
 * Gear-return-uncleaned (Section 8c) is explicitly NOT this endpoint's job —
 * it's staff's own manual follow-up (api/apply-manual-adjustment.js,
 * type: 'gear_returned_uncleaned'), performed after cancellation once staff
 * physically checks what's already been pulled for that day's delivery run.
 *
 * ============================================================================
 * The self-service-lock question this session's own build-review addendum
 * flagged — now moot, not just resolved: this session's first pass gated
 * address/trail self-service edits (saveFields/selectTrail) on a new T-1
 * noon Pacific lock (lib/self-service-cutoff.js) and wondered whether this
 * cron tick was the natural place to "flip" it. A second pass reverted that
 * decision entirely — address and trail-swap edits now close at the SAME
 * T-3, 10pm cutoff as kit count (matching what psac-adventure-prep-jtbd-
 * prd-v1.md Section 10 and psac-operations-ux-jtbd-prd-v1.md Section 14
 * already locked, and avoiding a stale-RideWithGPS-credential bug the T-1
 * version would have caused). lib/self-service-cutoff.js is deleted. This
 * file's own noon-Pacific job is unaffected either way — it was always
 * about the deposit hold, a genuinely different mechanism from self-service
 * field edits, and still is.
 * ============================================================================
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { pacificDateString, addDaysToDateString, pacificClockTimeReached } = require('../lib/cadence');

const CANCEL_ENDPOINT = 'https://www.palmspringsadventureclub.com/api/cancel-and-refund-booking';

function checkCronAuth(req) {
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + process.env.CRON_SECRET;
}

async function cancelBooking(bookingId) {
  const res = await fetch(CANCEL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookingId,
      secret: process.env.CANCEL_AND_REFUND_SHARED_SECRET,
      reasons: ['hold_never_cleared'],
    }),
  });
  return res.json();
}

async function processOneBooking(booking) {
  // BUG FIX (independent bug pass, Aug 2026): api/create-deposit-hold.js
  // (live, pre-existing) writes 'held' to the Sheet's depositStatus column
  // on a successful hold (see that file's updateBookingDepositStatus call
  // right after a requires_capture PaymentIntent) — 'succeeded' only ever
  // appeared in that endpoint's own HTTP response, never in the persisted
  // Sheet value. Nothing anywhere writes the literal string 'succeeded' to
  // this column. This check was comparing against a value that never
  // occurs, so it fell through to cancelBooking() below for every booking
  // whose hold actually succeeded — a guaranteed, every-day false
  // cancel-and-refund of successful deposit holds. Fixed to check the real
  // persisted value.
  if (booking.depositStatus === 'held') {
    const alertLookup = await callBookingsWebApp('holdClearance_findOpenDepositAlert', { bookingId: booking.bookingId });
    if (alertLookup && alertLookup.found) {
      await callBookingsWebApp('opsAlerts_resolveAlert', {
        alertId: alertLookup.alertId,
        resolvedBy: 'system (noon hold-clearance check)',
        notes: 'Hold cleared before the noon Pacific deadline — resolved automatically.',
      });
      return { bookingId: booking.bookingId, outcome: 'cleared_alert_resolved', alertId: alertLookup.alertId };
    }
    return { bookingId: booking.bookingId, outcome: 'cleared_no_action' };
  }

  if (booking.depositStatus === 'skipped') {
    // Custom tier, no deposit hold applies — not a failure, nothing to do.
    return { bookingId: booking.bookingId, outcome: 'skipped_no_hold_applies' };
  }

  const cancelResult = await cancelBooking(booking.bookingId);
  return { bookingId: booking.bookingId, outcome: 'cancelled_hold_never_cleared', depositStatus: booking.depositStatus, cancelResult };
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // BUG FIX (independent bug pass, Aug 2026): gate to the actual locked
    // noon Pacific instant rather than acting on the cron window's first
    // tick (which lands as early as 11am Pacific during PDT, 10am during
    // PST — up to two hours before the guest's own 11am deadline). See
    // lib/cadence.js's pacificClockTimeReached header.
    const now = new Date();
    if (!pacificClockTimeReached(12, 0, now)) {
      res.status(200).json({ ok: true, skipped: 'before_noon_pacific' });
      return;
    }

    const tomorrow = addDaysToDateString(pacificDateString(now), 1);
    const listRes = await callBookingsWebApp('holdClearance_listBookingsForTripDate', { tripDate: tomorrow });
    const bookings = (listRes && listRes.bookings) || [];

    const results = [];
    for (const b of bookings) {
      try {
        results.push(await processOneBooking(b));
      } catch (err) {
        // One booking's failure never blocks the rest of the tick — same
        // posture as every other cron endpoint in this stack.
        // eslint-disable-next-line no-console
        console.error('check-hold-clearance-deadline: booking failed', b.bookingId, err);
        results.push({ bookingId: b.bookingId, outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({ ok: true, tripDate: tomorrow, candidateCount: bookings.length, results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('check-hold-clearance-deadline failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
