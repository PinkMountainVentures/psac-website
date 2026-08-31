/**
 * api/trigger-deposit-holds.js
 *
 * MIGRATED (2026-08-31, deposit-hold engine build session): now calls
 * lib/gear-service.js and lib/hold-clearance-service.js (Postgres) instead
 * of lib/apps-script-client.js's callBookingsWebApp(). The HTTP call to
 * api/create-deposit-hold.js itself is UNCHANGED — this file always called
 * that endpoint over the network (not in-process) even before this
 * migration, and that's preserved exactly; only the two ops-alert lookups
 * and the trip-date candidate list moved off Apps Script.
 *
 * ============================================================================
 * FLAGGED ADDITION — not one of Section 13's five named endpoints, built to
 * close a real gap found while implementing check-hold-clearance-deadline.js
 * ============================================================================
 *
 * Operations UX PRD Section 6 states the T-1 deposit hold "runs at a fixed
 * time, 9am Pacific," and the build checklist explicitly assigns "Add
 * hold-creation at T-1 morning (gear checkout)" to the Operations UX build
 * ("New responsibility for this tool... fired at a fixed 9am Pacific").
 * `api/create-deposit-hold.js` itself is already live (per the build
 * checklist and `psac-internal-ops-ux-brief.md`) — it does the actual
 * Stripe hold-placement and writes the result back via `updateDepositStatus`
 * — but nothing in the reviewed docs or Section 13's own endpoint list
 * actually calls it at 9am. Without this file, `api/check-hold-clearance-
 * deadline.js` would find every T-1 booking still sitting at its booking-
 * time default (`depositStatus: 'scheduled_t1'`, per the Stripe-integration
 * chat's own confirmed fix) and cancel ALL of them at noon, every day —
 * not a hypothetical, a guaranteed bug the moment that cron went live
 * without this piece. Built here rather than left as a silent gap.
 *
 * Vercel Cron, 9am Pacific, T-1 dispatch day. For every active booking
 * whose trip date is tomorrow:
 *   1. Calls the existing `api/create-deposit-hold.js` ({bookingId, secret},
 *      DEPOSIT_HOLD_SHARED_SECRET) — never reimplements the Stripe call
 *      itself, that endpoint already owns it and already writes
 *      `depositStatus` back on every outcome.
 *   2. On anything other than `succeeded` (`requires_action`, `unavailable`,
 *      `failed`): writes a `deposit_hold_failed` Ops Alert
 *      (`urgency: 'same_day_2hr'`) and emails the guest the 2-hour-deadline
 *      notice (Section 15) — Section 6's own "the moment that 9am attempt
 *      returns anything other than succeeded" sequence, steps 1-4.
 *   3. `skipped` (Custom tier, no deposit hold applies) and `succeeded` both
 *      need no further action from this job.
 */

'use strict';

const gearService = require('../lib/gear-service');
const holdClearanceService = require('../lib/hold-clearance-service');
const { sendEmail } = require('../lib/send-email');
const { renderDepositHoldFailedEmail } = require('../lib/email-templates/deposit-hold-failed-email');
const { pacificDateString, addDaysToDateString, pacificClockTimeReached } = require('../lib/cadence');

const CREATE_DEPOSIT_HOLD_ENDPOINT = 'https://www.palmspringsadventureclub.com/api/create-deposit-hold';

function checkCronAuth(req) {
  // BUG FIX (payment-review, Aug 2026, Medium #44): fail closed if
  // CRON_SECRET is unset, instead of matching the literal string
  // 'Bearer undefined'.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + secret;
}

function formatTripDate(isoDateStr) {
  if (!isoDateStr) return 'today';
  const d = new Date(isoDateStr);
  if (isNaN(d.getTime())) return 'today';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
}

// BUG FIX (payment-review, Aug 2026, Lower-confidence #2): deposit-hold-
// failed-email.js used to hardcode "11:00am Pacific" as the guest-facing
// deadline, assuming this cron's alert always fires at exactly 9:00am
// Pacific. pacificClockTimeReached(9, 0, now) only gates the FIRST tick
// allowed to act — a delayed tick, a retry, or ordinary processing lag
// between the failed hold attempt and the send means the real send time
// can drift past 9:00am, and "11:00am" would then overstate how much time
// is actually left. Computes the real deadline from `now` (this run's
// actual clock time) instead.
function formatDeadlineTime(now) {
  const deadline = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return deadline.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) + ' Pacific';
}

async function placeHold(bookingId) {
  const res = await fetch(CREATE_DEPOSIT_HOLD_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId, secret: process.env.DEPOSIT_HOLD_SHARED_SECRET }),
  });
  return res.json();
}

async function processOneBooking(booking, now) {
  const holdResult = await placeHold(booking.bookingId);

  if (!holdResult || holdResult.status === 'succeeded' || holdResult.status === 'skipped') {
    return { bookingId: booking.bookingId, outcome: holdResult ? holdResult.status : 'no_response' };
  }

  // BUG FIX (payment-review, Aug 2026, High #12): this cron fires every 15
  // minutes across the whole 9am-noon Pacific window (vercel.json:
  // */15 15,16,17,18 * * *), and every tick re-processes every booking still
  // sitting at 'scheduled_t1'/blank — so an unresolved hold failure used to
  // re-raise this alert and re-send the guest's "act within 2 hours" email
  // on every single tick, a dozen+ duplicates for one underlying problem.
  // findOpenAlert (holdClearance_findOpenDepositAlert's Postgres
  // equivalent, generalized past hold-clearance's own original use — see
  // lib/gear-service.js's own header) already exists for exactly this
  // (used by api/check-hold-clearance-deadline.js to auto-resolve); reused
  // here as a dedup check before alerting/emailing again.
  const existingAlert = await gearService.findOpenAlert({
    bookingId: booking.bookingId,
    alertType: 'deposit_hold_failed',
  });
  if (existingAlert && existingAlert.found) {
    return { bookingId: booking.bookingId, outcome: holdResult.status, alertId: existingAlert.alertId, alreadyAlerted: true };
  }

  // requires_action / unavailable / failed — Section 6's immediate-alert path.
  const alert = await gearService.recordOpsAlert({
    bookingId: booking.bookingId,
    alertType: 'deposit_hold_failed',
    amount: holdResult.amount != null ? holdResult.amount : null,
    stripeErrorDetail: holdResult.error || holdResult.reason || holdResult.status,
    urgency: 'same_day_2hr',
  });

  if (booking.contactEmail) {
    // RESOLVED, Aug 2026 build-review follow-up: this used to be a guessed
    // URL with no page behind it. api/update-payment-method.js (the guest
    // page) + api/create-payment-update-session.js + api/save-updated-
    // payment-method.js now implement this for real — see those files'
    // headers for the Stripe Customer Portal check (not configured on this
    // account) and the flagged assumption about how api/create-deposit-
    // hold.js reads "the card on file." Reuses the booking's own
    // adventurePrepToken (same low-stakes guest-auth pattern as Surface A)
    // rather than minting a new token type.
    const html = renderDepositHoldFailedEmail({
      logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
      guestName: booking.contactName,
      tripDateFormatted: formatTripDate(booking.tripDate),
      deadlineTimeFormatted: formatDeadlineTime(now),
      updatePaymentLink: 'https://www.palmspringsadventureclub.com/update-payment-method?bookingId='
        + encodeURIComponent(booking.bookingId) + '&token=' + encodeURIComponent(booking.adventurePrepToken || ''),
    });
    await sendEmail({ to: booking.contactEmail, subject: 'Action needed within 2 hours, your gear hold didn’t go through', html });
  }

  return { bookingId: booking.bookingId, outcome: holdResult.status, alertId: alert && alert.alertId };
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // BUG FIX (independent bug pass, Aug 2026): don't act on the cron
    // window's first tick — gate to the actual locked 9am Pacific instant.
    // See lib/cadence.js's pacificClockTimeReached header for why this was
    // missing and what it was letting happen (firing as early as 7am
    // Pacific during PST).
    const now = new Date();
    if (!pacificClockTimeReached(9, 0, now)) {
      res.status(200).json({ ok: true, skipped: 'before_9am_pacific' });
      return;
    }

    const tomorrow = addDaysToDateString(pacificDateString(now), 1);
    const listRes = await holdClearanceService.listBookingsForTripDate({ tripDate: tomorrow });
    const bookings = (listRes && listRes.bookings) || [];
    // Only bookings that haven't already had a hold attempted today —
    // depositStatus starting from booking-time's 'scheduled_t1' default is
    // the expected state to act on; anything else means either this job
    // already ran today (idempotent skip) or a booking that's already
    // resolved some other way.
    const due = bookings.filter((b) => !b.depositStatus || b.depositStatus === 'scheduled_t1');

    const results = [];
    for (const b of due) {
      try {
        results.push({ ...(await processOneBooking(b, now)), tripDate: tomorrow });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('trigger-deposit-holds: booking failed', b.bookingId, err);
        // BUG FIX (payment-review, Aug 2026, High #11): a non-Stripe
        // exception here (e.g. a network failure reaching create-deposit-
        // hold.js, or reaching the DB itself) used to be console.error
        // only, no alert of any kind — and since this cron re-processes
        // every still-due booking on every 15-minute tick across the whole
        // window, the same underlying problem could recur a dozen+ times
        // before the noon auto-cancel fires, with nobody ever told. Deduped
        // the same way as the deposit_hold_failed alert above, via the same
        // generalized findOpenAlert lookup, so a persistent problem alerts
        // once, not every tick.
        let alertId = null;
        try {
          const existingErrorAlert = await gearService.findOpenAlert({
            bookingId: b.bookingId,
            alertType: 'deposit_hold_trigger_error',
          });
          if (!existingErrorAlert || !existingErrorAlert.found) {
            const errorAlert = await gearService.recordOpsAlert({
              bookingId: b.bookingId,
              alertType: 'deposit_hold_trigger_error',
              stripeErrorDetail: err.message,
              urgency: 'same_day_2hr',
              notes: 'trigger-deposit-holds hit a non-Stripe error trying to place this booking\'s T-1 deposit hold: ' + err.message + '. This cron retries every 15 minutes until noon Pacific; if this alert is still Open close to noon, the hold may never get placed and the booking could be wrongly auto-cancelled.',
            });
            alertId = errorAlert && errorAlert.alertId;
          } else {
            alertId = existingErrorAlert.alertId;
          }
        } catch (alertErr) {
          // eslint-disable-next-line no-console
          console.error('trigger-deposit-holds: also failed to write/check the deposit_hold_trigger_error Ops Alert', b.bookingId, alertErr);
        }
        results.push({ bookingId: b.bookingId, outcome: 'error', detail: err.message, alertId });
      }
    }

    res.status(200).json({ ok: true, tripDate: tomorrow, candidateCount: bookings.length, dueCount: due.length, results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('trigger-deposit-holds failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
