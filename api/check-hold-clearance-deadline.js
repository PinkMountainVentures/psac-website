/**
 * api/check-hold-clearance-deadline.js
 *
 * MIGRATED (2026-08-31, deposit-hold engine build session): now calls
 * lib/hold-clearance-service.js (Postgres) instead of lib/apps-script-
 * client.js's callBookingsWebApp() — the last of the 4 files in the
 * deposit-hold engine's own cron chain (9am trigger -> noon clearance
 * check [this file] -> 1pm+ renewal safety net). Folded into this same
 * pass rather than left on Apps Script: this file's own noon check reads
 * the exact same trip-date candidate list and Ops Alert lookups the other
 * 3 files needed, and leaving it un-migrated would have meant the deposit-
 * hold engine's go/no-go decision — the piece that actually cancels a
 * booking if its hold never cleared — was reading live Postgres-side
 * depositStatus/depositPaymentIntentId writes (from the just-migrated
 * api/create-deposit-hold.js) through a query aimed at the OLD Apps
 * Script sheet, which would never see them. Flagged for Airey in this
 * session's own wrap-up rather than silently expanded scope.
 *
 * The one real external dependency this file has — api/cancel-and-refund-
 * booking.js, called over the network below, unchanged — is itself still
 * fully on Apps Script (confirmed via grep, 6 callBookingsWebApp calls).
 * That's a separate, large cancellation/refund subsystem, deliberately NOT
 * folded into this pass; this file's own logic (the go/no-go decision and
 * its own direct Stripe re-verify) works correctly against Postgres either
 * way, since it only ever reads booking state and calls that endpoint —
 * cancel-and-refund-booking.js's own internals are that endpoint's problem
 * to solve when it's migrated.
 *
 * Operations UX PRD Section 6 / Section 18 item 5a — the noon Pacific,
 * T-1 dispatch-day go/no-go decision on the deposit hold. Vercel Cron at a
 * fixed 12pm Pacific trigger, three hours after the 9am attempt
 * (api/trigger-deposit-holds.js — see that file's header for why it exists;
 * this endpoint's logic assumes a hold was already attempted this morning).
 *
 * For every active booking whose trip date is tomorrow (T-1 today):
 *   - `depositStatus === 'held'`: the hold cleared (either the original
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

const gearService = require('../lib/gear-service');
const holdClearanceService = require('../lib/hold-clearance-service');
const bookingService = require('../lib/booking-service');
const { pacificDateString, addDaysToDateString, pacificClockTimeReached } = require('../lib/cadence');
const { getSiteUrl } = require('../lib/site-url');

const CANCEL_ENDPOINT = `${getSiteUrl()}/api/cancel-and-refund-booking`;

// Must match api/create-deposit-hold.js's own TIERS keys — the two tiers a
// deposit hold ever applies to. Duplicated rather than shared (no shared
// constants module exists yet in this stack for it, and this file only
// needs the key set, not the dollar amounts) — see Medium #43's fix below.
const DEPOSIT_HOLD_TIER_KEYS = ['trail', 'p2p'];

function checkCronAuth(req) {
  // BUG FIX (payment-review, Aug 2026, Medium #44): fail closed if
  // CRON_SECRET is unset, instead of matching the literal string
  // 'Bearer undefined'.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + secret;
}

function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

async function stripeGetPaymentIntent(paymentIntentId) {
  const res = await fetch('https://api.stripe.com/v1/payment_intents/' + encodeURIComponent(paymentIntentId), {
    headers: { Authorization: stripeAuthHeader() },
  });
  const data = await res.json();
  return { ok: res.ok, data };
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
  // (live, pre-existing) writes 'held' to depositStatus on a successful
  // hold (see that file's updateBookingDepositStatus call right after a
  // requires_capture PaymentIntent) — 'succeeded' only ever appeared in
  // that endpoint's own HTTP response, never in the persisted value.
  // Nothing anywhere writes the literal string 'succeeded' to this column.
  // This check was comparing against a value that never occurs, so it fell
  // through to cancelBooking() below for every booking whose hold actually
  // succeeded — a guaranteed, every-day false cancel-and-refund of
  // successful deposit holds. Fixed to check the real persisted value.
  if (booking.depositStatus === 'held') {
    const alertLookup = await gearService.findOpenAlert({ bookingId: booking.bookingId, alertType: 'deposit_hold_failed' });
    if (alertLookup && alertLookup.found) {
      await holdClearanceService.resolveAlert({
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

  // BUG FIX (payment-review, Aug 2026, Medium #43): this function used to
  // treat ANY depositStatus other than the exact literals 'held'/'skipped'
  // — including a blank value that was never written at all — as a genuine
  // hold failure and fell straight through to cancelBooking() below. But
  // create-deposit-hold.js's own "no tier, no deposit hold" branch writes
  // 'skipped' as a separate best-effort updateBookingDepositStatus call
  // AFTER deciding the response — the exact same write-back-can-silently-
  // fail class as every other bug this review found. If THAT write is lost,
  // a perfectly normal Custom Experience booking (which never had a deposit
  // hold to begin with) still reads as blank/'scheduled_t1' at noon and got
  // wrongly cancelled and refunded here. Self-heal the same way the Stripe
  // re-verify branch just below already does for a lost 'held' write-back:
  // if this booking's tier has no deposit hold at all, treat it as
  // 'skipped' directly instead of falling through toward cancellation.
  // Deliberately conservative — only acts when `tier` is actually present
  // and unambiguously not a deposit-hold tier; a blank/missing tier (a
  // different, unrelated data gap) falls through to the existing logic
  // unchanged rather than being guessed at.
  if (booking.tier && DEPOSIT_HOLD_TIER_KEYS.indexOf(booking.tier) === -1) {
    try {
      await bookingService.updateDepositStatus({
        bookingId: booking.bookingId,
        depositPaymentIntentId: '',
        depositStatus: 'skipped',
      });
    } catch (writeBackErr) {
      // eslint-disable-next-line no-console
      console.error('check-hold-clearance-deadline: tier-based skip self-heal write-back failed', booking.bookingId, writeBackErr);
    }
    return { bookingId: booking.bookingId, outcome: 'skipped_via_tier_reverify', depositStatus: booking.depositStatus, tier: booking.tier };
  }

  // BUG FIX (payment-review, Aug 2026, High #24): this go/no-go decision
  // used to trust the persisted depositStatus alone. But api/create-
  // deposit-hold.js writes depositPaymentIntentId and depositStatus:'held'
  // as a SEPARATE step after the Stripe hold itself already succeeded (see
  // updateDepositStatus) — if that write-back is delayed or fails (a
  // transient DB error, same bug class as every other write-back in this
  // stack), depositStatus can still read as something other than 'held'
  // (e.g. still 'scheduled_t1' or a stale 'requires_action') even though
  // there is a genuinely live Stripe hold on the guest's card. Falling
  // through to cancelBooking() in that case would wrongly cancel a
  // reservation with a real, successfully-placed deposit hold. Re-verify
  // directly against Stripe before ever cancelling: if the PaymentIntent
  // shows 'requires_capture' (Stripe's own live-hold state), self-heal the
  // write-back and treat it the same as the 'held' branch above, instead
  // of trusting the stale persisted value.
  if (booking.depositPaymentIntentId) {
    const piCheck = await stripeGetPaymentIntent(booking.depositPaymentIntentId);
    if (piCheck.ok && piCheck.data && piCheck.data.status === 'requires_capture') {
      try {
        await bookingService.updateDepositStatus({
          bookingId: booking.bookingId,
          depositPaymentIntentId: booking.depositPaymentIntentId,
          depositStatus: 'held',
        });
      } catch (writeBackErr) {
        // eslint-disable-next-line no-console
        console.error('check-hold-clearance-deadline: Stripe re-verify found a live hold but self-heal write-back failed', booking.bookingId, writeBackErr);
      }
      const alertLookup = await gearService.findOpenAlert({ bookingId: booking.bookingId, alertType: 'deposit_hold_failed' });
      if (alertLookup && alertLookup.found) {
        await holdClearanceService.resolveAlert({
          alertId: alertLookup.alertId,
          resolvedBy: 'system (noon hold-clearance check, Stripe re-verify)',
          notes: `depositStatus read '${booking.depositStatus}' at noon, but Stripe confirms PaymentIntent ${booking.depositPaymentIntentId} is a live, successfully-placed hold (requires_capture) — the depositStatus write-back was evidently delayed or failed. Self-healed, booking NOT cancelled.`,
        });
        return { bookingId: booking.bookingId, outcome: 'cleared_via_stripe_reverify_alert_resolved', alertId: alertLookup.alertId };
      }
      return { bookingId: booking.bookingId, outcome: 'cleared_via_stripe_reverify' };
    }
  }

  // BUG FIX (payment-review, Aug 2026, High #22): this endpoint fires on a
  // single fixed noon-Pacific trigger, not a repeating cron window like
  // most of this stack (see this file's own header) — there is no "next
  // tick" to self-heal on. cancelBooking()'s fetch (or its res.json()) can
  // throw on a network blip, which used to propagate straight out of this
  // function, past the alerting logic below entirely, into the caller's
  // outer per-booking catch (which only console.errors). That meant this
  // safety net's one and only shot at a booking could fail completely
  // silently: no alert, and by tomorrow this booking's trip date is no
  // longer "tomorrow" so listBookingsForTripDate never surfaces it to this
  // endpoint again — a booking stuck 'active' with a deposit hold that
  // never cleared, permanently unflagged. Wrapping this in its own
  // try/catch funnels a thrown network error into the exact same
  // cancelResult-shaped failure the alerting logic below already handles,
  // same pattern as api/save-booking.js's own fetchThrew fix.
  let cancelResult;
  try {
    cancelResult = await cancelBooking(booking.bookingId);
  } catch (fetchErr) {
    cancelResult = { ok: false, error: 'fetch_threw', detail: fetchErr.message };
  }
  // BUG FIX (payment-review, Aug 2026, High #23): this used to report
  // 'cancelled_hold_never_cleared' regardless of whether the downstream
  // cancel-and-refund-booking.js call actually succeeded — its response was
  // captured but never checked. A genuinely failed cancellation (a Stripe
  // refund decline, an engineering error) reported as success in this
  // cron's own output, with no alert, leaving a booking that should have
  // been cancelled quietly still 'active' with a live, about-to-expire
  // deposit hold and nobody told.
  if (!cancelResult || cancelResult.ok !== true) {
    try {
      await gearService.recordOpsAlert({
        bookingId: booking.bookingId,
        alertType: 'cancellation_gate_call_failed',
        stripeErrorDetail: (cancelResult && (cancelResult.detail || cancelResult.error)) || 'no response',
        urgency: 'urgent_same_day',
        notes: 'check-hold-clearance-deadline (the noon Pacific hold-never-cleared gate) tried to cancel this booking, but cancel-and-refund-booking.js did not report success: ' + JSON.stringify(cancelResult) + '. The booking was NOT cancelled — it is still active, with a deposit hold that never cleared. Needs manual review before it expires unresolved.',
      });
    } catch (alertErr) {
      // eslint-disable-next-line no-console
      console.error('check-hold-clearance-deadline: also failed to write the cancellation_gate_call_failed Ops Alert', booking.bookingId, alertErr);
    }
    return { bookingId: booking.bookingId, outcome: 'cancel_call_failed', depositStatus: booking.depositStatus, cancelResult };
  }
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
    const listRes = await holdClearanceService.listBookingsForTripDate({ tripDate: tomorrow });
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
