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
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
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

    const ctx = await callBookingsWebApp('cancelRefund_getBookingContext', { bookingId: body.bookingId });
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
        // rather than silently marked cancelled anyway. Not yet wired to its
        // own Ops Alert type; flagged as a gap worth a follow-up round
        // rather than expanded here without a decision from Airey.
        // eslint-disable-next-line no-console
        console.error('cancel-and-refund-booking: Stripe refund failed', body.bookingId, refundRes.data);
        res.status(502).json({ error: 'stripe_refund_failed', detail: (stripeErr && stripeErr.message) || 'unknown' });
        return;
      }
    } else {
      refundId = refundRes.data.id;
      refundAmount = Math.round((refundRes.data.amount || 0)) / 100;
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
      await callBookingsWebApp('cancelRefund_writeCancellation', {
        bookingId: body.bookingId,
        bookingStatus,
        cancelledAt,
        refundId,
        refundAmount,
        cancellationReasons: reasons.join(','),
        beforeT3Cutoff: reasons.indexOf('hold_never_cleared') === -1,
        staffNotes: '',
      }, { retries: 2 });
    } catch (writeBackErr) {
      writeBackFailed = true;
      // eslint-disable-next-line no-console
      console.error('cancel-and-refund-booking: refund succeeded but the booking write-back failed', body.bookingId, refundId, writeBackErr);
      try {
        await callBookingsWebApp('opsAlerts_recordAlert', {
          bookingId: body.bookingId,
          alertType: 'cancel_refund_writeback_failed',
          amount: refundAmount,
          stripeErrorDetail: writeBackErr.message,
          urgency: 'urgent_same_day',
          notes: 'Refund ' + refundId + ' for $' + refundAmount + ' succeeded on Stripe, but the booking record could not be updated (bookingStatus/refundId/cancelledAt). A retry of this same cancellation should self-heal it automatically; if this alert is still Open, it did not.',
        }, { retries: 2 });
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
            logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
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
