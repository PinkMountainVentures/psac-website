/**
 * api/cancel-and-refund-booking.js
 *
 * Operations UX PRD Section 5: the single dedicated cancellation mechanism
 * for all four cancellation gates —
 *   no_1.2a, zero_waivers, no_address   (evaluated by api/process-t3-cutoff.js
 *                                         at the T-3, 10pm cutoff)
 *   hold_never_cleared                  (evaluated by
 *                                         api/check-hold-clearance-deadline.js
 *                                         at the T-1 noon Pacific cutoff)
 *
 * Server-to-server only, matching api/create-deposit-hold.js's own
 * convention ({ bookingId, secret }) — never called from a guest browser,
 * no adventurePrepToken/signerToken involved. A new, dedicated shared
 * secret (CANCEL_AND_REFUND_SHARED_SECRET) rather than reusing another
 * endpoint's, same one-secret-per-endpoint pattern already established by
 * DEPOSIT_HOLD_SHARED_SECRET / TRAIL_SELECTION_SHARED_SECRET /
 * BOOKINGS_WEBAPP_SECRET.
 *
 * Looks up the main PaymentIntent from the Bookings sheet itself and reads
 * back whatever Stripe actually refunded — never trusts a caller-supplied
 * amount, same posture as lib/finalize-kit-change.js and
 * create-deposit-hold.js.
 *
 * Idempotent per booking: if the booking's bookingStatus is already
 * anything other than 'active', this returns success without attempting a
 * second refund, since api/process-t3-cutoff.js and
 * api/check-hold-clearance-deadline.js may both legitimately call this more
 * than once for the same booking across retries.
 *
 * Deliberately does NOT touch gear. For hold_never_cleared specifically,
 * PRD Section 6/8c: gear already pulled or assembled gets checked back into
 * inventory uncleaned via a SEPARATE manual staff action through the
 * internal ops app's Manual Adjustment page (api/apply-manual-adjustment.js,
 * type: 'gear_returned_uncleaned') — a Stripe-and-sheet endpoint has no way
 * to know what's physically sitting on a packing table, so that step is
 * never automated here.
 *
 * MIGRATED (2026-08-31, cancel-and-refund-booking build session): the two
 * callBookingsWebApp calls that had no Postgres equivalent yet
 * (cancelRefund_getBookingContext / cancelRefund_writeCancellation) now go
 * through the new lib/cancel-refund-service.js. The three opsAlerts_
 * recordAlert calls now go through lib/gear-service.js's already-exported
 * recordOpsAlert (built in the gear-ops migration, already returns
 * {ok, alertId}) instead — no new alert primitive needed here. The
 * {retries: 2} option on every callBookingsWebApp call is dropped: that
 * existed to paper over Apps Script Web App flakiness over HTTP, and has
 * no equivalent need against a direct Postgres query (matches the same
 * simplification already made in the deposit-hold engine's api/*.js
 * files). Every Stripe call, idempotency key, and business-logic branch
 * below — including releaseDepositHoldIfLive's three-way self-heal and the
 * two independent-bug-pass fixes in the main refund path — is completely
 * unchanged.
 */

'use strict';

const cancelRefundService = require('../lib/cancel-refund-service');
const gearService = require('../lib/gear-service');
const { sendEmail } = require('../lib/send-email');
const { renderCancellationEmail } = require('../lib/email-templates/cancellation-email');

const VALID_REASONS = ['no_1.2a', 'zero_waivers', 'no_address', 'hold_never_cleared'];

function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

async function stripePost(path, params, idempotencyKey) {
  const headers = {
    Authorization: stripeAuthHeader(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function stripeGet(path) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: stripeAuthHeader() },
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

// ADDED (2026-08-25, gear-ops live verification pass): a booking can be
// cancelled after its T-1 deposit hold already succeeded (depositStatus
// 'held') — none of today's four automated gates actually reach that state
// (the three T-3 gates fire before T-1; hold_never_cleared only fires when
// the hold itself failed), but this endpoint has no way to know a FUTURE
// caller (a same-day ad-hoc staff cancellation, say) won't. Without this,
// a live hold on a cancelled booking would just sit there until Stripe's
// own ~5-7 day expiry — fine for the guest (never charged), but a real gap
// if reconciliation happens to run first and captures against a booking
// that's already been told it's cancelled and refunded. Mirrors
// api/renew-deposit-hold.js's cancelOldHold() self-heal posture: never
// trust the Sheet's own depositStatus, always read the PaymentIntent's
// real status back from Stripe first.
async function releaseDepositHoldIfLive(ctx, bookingId) {
  if (!ctx.depositPaymentIntentId || ctx.depositStatus !== 'held') {
    return { attempted: false };
  }
  const piRes = await stripeGet('payment_intents/' + encodeURIComponent(ctx.depositPaymentIntentId));
  if (!piRes.ok) {
    return { attempted: true, ok: false, detail: 'Could not retrieve the deposit PaymentIntent to release it.' };
  }
  const pi = piRes.data;
  if (pi.status === 'canceled') {
    // Already released — a previous call, or the reconciliation cron beat
    // this one to it (Scenario 1, itemized === 0 also cancels the hold).
    return { attempted: true, ok: true, alreadyResolved: true };
  }
  if (pi.status === 'succeeded') {
    // Already captured (reconciliation ran and found something owed) —
    // nothing to release, and NOT ours to overwrite; leave depositStatus
    // as reconciliation already set it.
    return { attempted: true, ok: true, alreadyCaptured: true };
  }
  if (pi.status !== 'requires_capture') {
    return { attempted: true, ok: false, detail: 'Deposit PaymentIntent is in an unexpected state: ' + pi.status };
  }
  const cancelRes = await stripePost(
    'payment_intents/' + encodeURIComponent(pi.id) + '/cancel',
    new URLSearchParams(),
    'cancelrefund_holdcancel_' + bookingId + '_' + pi.id
  );
  if (!cancelRes.ok) {
    const err = cancelRes.data && cancelRes.data.error;
    const alreadyDone = err && (err.code === 'payment_intent_unexpected_state' || /already|cannot be canceled/i.test(err.message || ''));
    if (alreadyDone) {
      // BUG FIX (payment-review, Aug 2026, Critical #5): a
      // payment_intent_unexpected_state error here doesn't ONLY mean
      // "someone already canceled this hold" — it's the exact same error
      // Stripe returns when the 15-minute gear-reconciliation cron just
      // captured this same PaymentIntent for a real shortfall in the gap
      // between the requires_capture read above and this /cancel call.
      // Blindly returning alreadyResolved: true here made the caller write
      // depositStatus='released', reconciledAmountCents=0 straight over a
      // real capture reconciliation had just recorded — the guest saw
      // "cancelled and refunded" while actually still charged, with no
      // alert anywhere. Re-fetch the PaymentIntent and branch on its
      // ACTUAL resulting status, exactly like the two sibling branches
      // above, instead of inferring "already canceled" from the error
      // shape alone.
      const recheckRes = await stripeGet('payment_intents/' + encodeURIComponent(pi.id));
      if (!recheckRes.ok) {
        // eslint-disable-next-line no-console
        console.error('cancel-and-refund-booking: cancel failed as "already done" but re-checking the PaymentIntent also failed', bookingId, pi.id, err);
        return { attempted: true, ok: false, detail: 'Deposit PaymentIntent cancel failed, and re-checking its actual status also failed — refusing to guess.' };
      }
      const recheckedPi = recheckRes.data;
      if (recheckedPi.status === 'canceled') {
        return { attempted: true, ok: true, alreadyResolved: true };
      }
      if (recheckedPi.status === 'succeeded') {
        // Real capture, same as the sibling branch above — not ours to
        // overwrite. This is the case the old code got wrong.
        return { attempted: true, ok: true, alreadyCaptured: true };
      }
      // Neither canceled nor succeeded — a genuinely unexpected state.
      // Don't guess; surface it as a failure so it raises the existing
      // deposit_hold_release_failed_on_cancellation Ops Alert instead of
      // silently writing either branch's outcome.
      return { attempted: true, ok: false, detail: 'Deposit PaymentIntent cancel failed and re-check found an unexpected state: ' + recheckedPi.status };
    }
    // eslint-disable-next-line no-console
    console.error('cancel-and-refund-booking: failed to release the deposit hold', bookingId, pi.id, err);
    return { attempted: true, ok: false, detail: (err && err.message) || 'Stripe error releasing the deposit hold.' };
  }
  return { attempted: true, ok: true, paymentIntentId: pi.id };
}

function parseBody(req) {
  var body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  return body || {};
}

// Section 5: bookingStatus, set to cancelled_no_adventure_prep for any of
// the three T-3 gates, or cancelled_hold_failed for the new hold-clearance
// gate — so a cancellation's cause stays legible later on Surface A's
// cancelled-status screen and in any audit view.
function bookingStatusForReasons(reasons) {
  if (reasons.indexOf('hold_never_cleared') !== -1) return 'cancelled_hold_failed';
  return 'cancelled_no_adventure_prep';
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const body = parseBody(req);
    if (!body.secret || body.secret !== process.env.CANCEL_AND_REFUND_SHARED_SECRET) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!body.bookingId) {
      res.status(400).json({ error: 'missing_booking_id' });
      return;
    }
    const reasons = Array.isArray(body.reasons)
      ? body.reasons.filter((r) => VALID_REASONS.indexOf(r) !== -1)
      : [];
    if (!reasons.length) {
      res.status(400).json({ error: 'missing_or_invalid_reasons' });
      return;
    }

    const ctx = await cancelRefundService.getBookingContext(body.bookingId);
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'booking_not_found' });
      return;
    }

    // Idempotent no-op: this booking was already cancelled by an earlier
    // call (this endpoint, or a retry of the same cron tick). Don't attempt
    // a second Stripe refund against an already-refunded PaymentIntent.
    if (ctx.bookingStatus && ctx.bookingStatus !== 'active') {
      res.status(200).json({
        ok: true,
        alreadyCancelled: true,
        bookingId: body.bookingId,
        bookingStatus: ctx.bookingStatus,
      });
      return;
    }

    if (!ctx.mainPaymentIntentId) {
      res.status(500).json({ error: 'engineering_error', detail: 'booking has no main PaymentIntent on file' });
      return;
    }

    // Full refund — amount deliberately omitted so Stripe refunds whatever
    // was actually captured, rather than trusting a value threaded through
    // from the caller.
    const params = new URLSearchParams();
    params.append('payment_intent', ctx.mainPaymentIntentId);
    params.append('metadata[kind]', 'booking_cancellation_refund');
    params.append('metadata[bookingId]', body.bookingId);
    params.append('metadata[reasons]', reasons.join(','));

    // Idempotency key added 2026-08-24 alongside the same fix in
    // api/refund-gear-charge.js. This cancellation refund is always a full
    // refund of one specific PaymentIntent, so a key on bookingId + that
    // PaymentIntent is enough for a genuine retry to reuse safely; the
    // existing "already refunded" self-heal below remains the backstop.
    const idempotencyKey = 'cancelrefund_' + body.bookingId + '_' + ctx.mainPaymentIntentId;
    const refundRes = await stripePost('refunds', params, idempotencyKey);
    let refundId, refundAmount;

    if (!refundRes.ok) {
      // BUG FIX (independent bug pass, Aug 2026): if the write-back below
      // fails after a PREVIOUS call already got the refund through,
      // bookingStatus never left 'active' (that's what the write-back was
      // supposed to change), so a retry lands right back here and re-issues
      // the refund — which Stripe now correctly refuses since the
      // PaymentIntent is already fully refunded. Recognize that specific
      // case and recover the existing refund's details instead of erroring
      // out a second time, so a retry can self-heal the write-back rather
      // than staying permanently stuck.
      const stripeErr = refundRes.data && refundRes.data.error;
      const alreadyRefunded = stripeErr && (stripeErr.code === 'charge_already_refunded' || /already.*refunded/i.test(stripeErr.message || ''));
      if (alreadyRefunded) {
        const existing = await stripeGet('refunds?payment_intent=' + encodeURIComponent(ctx.mainPaymentIntentId) + '&limit=1');
        if (existing.ok && existing.data && existing.data.data && existing.data.data.length) {
          refundId = existing.data.data[0].id;
          refundAmount = Math.round(existing.data.data[0].amount || 0) / 100;
        }
      }
      if (!refundId) {
        // A cancellation gate firing but Stripe refusing the refund for a
        // real reason (not the self-heal case above) is a real operational
        // problem (the booking is about to be marked cancelled with no
        // successful refund behind it) — surfaced as an engineering error
        // rather than silently marked cancelled anyway.
        // eslint-disable-next-line no-console
        console.error('cancel-and-refund-booking: Stripe refund failed', body.bookingId, refundRes.data);
        // BUG FIX (payment-review, Aug 2026, High #19): this used to be
        // console.error only — the comment above even said so explicitly
        // ("not yet wired to its own Ops Alert type"). An unattended,
        // cron-triggered cancellation (the T-3/T-1 gates, not a staff
        // click) hitting a genuine refund decline used to get permanently
        // stuck 'active' with nobody told. Best-effort, never blocks the
        // 502 response below.
        try {
          await gearService.recordOpsAlert({
            bookingId: body.bookingId,
            alertType: 'cancel_refund_declined',
            stripeErrorDetail: (stripeErr && stripeErr.message) || 'unknown',
            urgency: 'urgent_same_day',
            notes: 'This booking should be cancelled (reasons: ' + reasons.join(',') + '), but Stripe declined the refund on PaymentIntent ' + ctx.mainPaymentIntentId + ': ' + ((stripeErr && stripeErr.message) || 'unknown') + '. The booking was NOT marked cancelled — it is still active. Needs manual review.',
          });
        } catch (alertErr) {
          // eslint-disable-next-line no-console
          console.error('cancel-and-refund-booking: also failed to write the cancel_refund_declined Ops Alert', body.bookingId, alertErr);
        }
        res.status(502).json({ error: 'stripe_refund_failed', detail: (stripeErr && stripeErr.message) || 'unknown' });
        return;
      }
    } else {
      refundId = refundRes.data.id;
      refundAmount = Math.round((refundRes.data.amount || 0)) / 100;
    }

    // ADDED (2026-08-25): release a live deposit hold, if one exists, as
    // part of this same cancellation. Best-effort and never blocks the
    // booking cancellation itself — a failure here still lets the (more
    // urgent) main-charge refund and cancellation stand, just raises an
    // Ops Alert so staff know a hold needs manual attention.
    const depositRelease = await releaseDepositHoldIfLive(ctx, body.bookingId);
    if (depositRelease.attempted && !depositRelease.ok) {
      try {
        await gearService.recordOpsAlert({
          bookingId: body.bookingId,
          alertType: 'deposit_hold_release_failed_on_cancellation',
          stripeErrorDetail: depositRelease.detail,
          urgency: 'urgent_same_day',
          notes: 'This booking was cancelled and its main charge refunded, but its live gear deposit hold (' + ctx.depositPaymentIntentId + ') could not be released: ' + depositRelease.detail + '. Left untouched — Stripe will release it on its own after ~5-7 days if nothing else acts on it first, but reconciliation could otherwise still capture against a cancelled booking.',
        });
      } catch (alertErr) {
        // eslint-disable-next-line no-console
        console.error('cancel-and-refund-booking: also failed to write the deposit-hold-release-failed Ops Alert', body.bookingId, alertErr);
      }
    }

    const bookingStatus = bookingStatusForReasons(reasons);
    const cancelledAt = new Date().toISOString();

    // BUG FIX (independent bug pass, Aug 2026): the refund above has
    // already happened on Stripe's side by this point — if this write-back
    // throws (a Sheet lock timeout, a transient Apps Script error), the old
    // code let that exception propagate straight to the outer catch, which
    // returned a bare 500 with bookingStatus never flipped off 'active',
    // no refundId/cancelledAt written, and no cancellation email sent. That
    // left a booking permanently stuck showing active — refunded on
    // Stripe's side, invisible as cancelled everywhere else, with no
    // automated path to reconcile it (and, before the self-heal above, a
    // guaranteed second failed refund attempt on every retry). Now: catch
    // it, raise a best-effort Ops Alert so staff can see the mismatch, and
    // still report success below (the refund is real and already
    // happened, regardless of whether the Sheet reflects it yet).
    let writeBackFailed = false;
    try {
      const depositWasReleased = depositRelease.attempted && depositRelease.ok && !depositRelease.alreadyCaptured;
      await cancelRefundService.writeCancellation({
        bookingId: body.bookingId,
        bookingStatus,
        cancelledAt,
        refundId,
        refundAmount,
        cancellationReasons: reasons.join(','),
        beforeT3Cutoff: reasons.indexOf('hold_never_cleared') === -1,
        staffNotes: '',
        depositStatus: depositWasReleased ? 'released' : undefined,
        depositReconciledAt: depositWasReleased ? cancelledAt : undefined,
        depositReconciledAmountCents: depositWasReleased ? 0 : undefined,
        depositHoldPaymentIntentId: depositWasReleased ? ctx.depositPaymentIntentId : undefined,
      });
    } catch (writeBackErr) {
      writeBackFailed = true;
      // eslint-disable-next-line no-console
      console.error('cancel-and-refund-booking: refund succeeded but the booking write-back failed', body.bookingId, refundId, writeBackErr);
      try {
        await gearService.recordOpsAlert({
          bookingId: body.bookingId,
          alertType: 'cancel_refund_writeback_failed',
          amount: refundAmount,
          stripeErrorDetail: writeBackErr.message,
          urgency: 'urgent_same_day',
          notes: 'Refund ' + refundId + ' for $' + refundAmount + ' succeeded on Stripe, but the booking record could not be updated (bookingStatus/refundId/cancelledAt). A retry of this same cancellation should self-heal it automatically; if this alert is still Open, it did not.',
        });
      } catch (alertErr) {
        // eslint-disable-next-line no-console
        console.error('cancel-and-refund-booking: also failed to write the orphaned-refund Ops Alert', body.bookingId, alertErr);
      }
    }

    if (ctx.contactEmail) {
      try {
        await sendEmail({
          to: ctx.contactEmail,
          subject: 'Your Palm Springs Adventure Club reservation has been cancelled',
          html: renderCancellationEmail({
            logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || 'https://palmspringsadventureclub.com/images/psac-logo-email-header.png',
            guestName: ctx.contactName || '',
            reasons,
            refundAmount,
          }),
        });
      } catch (emailErr) {
        // eslint-disable-next-line no-console
        console.error('cancel-and-refund-booking: failed to send cancellation email', body.bookingId, emailErr);
      }
    } else {
      // eslint-disable-next-line no-console
      console.error('cancel-and-refund-booking: no contactEmail on file, guest not notified of cancellation', body.bookingId);
    }

    res.status(200).json({
      ok: true,
      bookingId: body.bookingId,
      bookingStatus,
      cancelledAt,
      refundId,
      refundAmount,
      cancellationReasons: reasons,
      writeBackFailed: writeBackFailed || undefined,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('cancel-and-refund-booking action failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
