/**
 * api/refund-gear-charge.js
 *
 * Gear Inventory PRD Section 10 addendum: the refund/partial-refund gap
 * the design pass explicitly flagged as real, in-scope work — "there is no
 * staff-facing refund/partial-refund action anywhere in gear
 * reconciliation" (e.g. a Missing item recovered/mailed back after the
 * deposit was already captured, or a wrong amount charged). Follows
 * api/cancel-and-refund-booking.js's existing Stripe refund pattern
 * exactly: never trust a caller-supplied refund amount as authoritative
 * beyond what Stripe itself confirms, self-heal on a retried "already
 * refunded" error rather than erroring a second time, best-effort Ops
 * Alert if the write-back fails after Stripe already moved the money.
 *
 * Server-to-server only (api/ops-proxy.js), GEAR_OPS_SHARED_SECRET.
 *
 * `refundTarget` distinguishes which prior action is being reversed —
 * matching the two distinct pairs of columns
 * apps-script/gear-inventory-actions.gs's gearOps_recordRefund() writes:
 *   - 'deposit'   -> refunds against depositPaymentIntentId (the
 *                    reconciliation capture from Scenarios 2/3/4)
 *   - 'shortfall' -> refunds against shortfallChargeId (the Scenario 4
 *                    follow-up charge from api/charge-gear-shortfall.js)
 *
 * `amountCents` is optional — a full refund of whatever remains
 * captured/charged if omitted, a partial refund (e.g. one recovered item
 * out of several) if supplied. `staffNotes` is always required, matching
 * every other money-adjacent manual action in this stack
 * (api/apply-manual-adjustment.js's own convention).
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { sendEmail } = require('../lib/send-email');
const { renderGearRefundConfirmationEmail } = require('../lib/email-templates/gear-refund-confirmation-email');

const VALID_TARGETS = ['deposit', 'shortfall'];

function checkSecret(body) {
  // Fail closed: require both a configured secret and a non-empty
  // caller-supplied one, so an unset env var never matches an absent
  // payload.secret (undefined === undefined would otherwise pass).
  if (!process.env.GEAR_OPS_SHARED_SECRET) return false;
  return !!(body && body.secret && body.secret === process.env.GEAR_OPS_SHARED_SECRET);
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  return body || {};
}

function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

async function stripePost(path, params, idempotencyKey) {
  const headers = { Authorization: stripeAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' };
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
  const res = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: stripeAuthHeader() } });
  const data = await res.json();
  return { ok: res.ok, data };
}

function centsToDollarsStr(cents) {
  return (Math.round(cents) / 100).toFixed(2);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const body = parseBody(req);
    if (!checkSecret(body)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!body.bookingId) {
      res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
      return;
    }
    const refundTarget = body.refundTarget;
    if (VALID_TARGETS.indexOf(refundTarget) === -1) {
      res.status(400).json({ error: 'bad_request', detail: `refundTarget must be one of: ${VALID_TARGETS.join(', ')}` });
      return;
    }
    if (!body.staffNotes || !String(body.staffNotes).trim()) {
      res.status(400).json({ error: 'bad_request', detail: 'staffNotes is required for a gear refund' });
      return;
    }

    const ctx = await callBookingsWebApp('gearOps_getReconciliationContext', { bookingId: body.bookingId });
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'booking_not_found' });
      return;
    }

    let sourcePaymentIntentId;
    if (refundTarget === 'deposit') {
      const CAPTURED_STATUSES = ['partial_capture', 'full_capture', 'full_capture_pending_review', 'shortfall_charged'];
      if (CAPTURED_STATUSES.indexOf(ctx.depositStatus) === -1) {
        res.status(400).json({ error: 'nothing_to_refund', detail: `depositStatus is '${ctx.depositStatus}' — no captured deposit amount to refund.` });
        return;
      }
      sourcePaymentIntentId = ctx.depositPaymentIntentId;
    } else {
      if (!ctx.shortfallChargeId) {
        res.status(400).json({ error: 'nothing_to_refund', detail: 'No shortfall charge exists on this booking to refund.' });
        return;
      }
      sourcePaymentIntentId = ctx.shortfallChargeId;
    }

    if (!sourcePaymentIntentId) {
      res.status(500).json({ error: 'engineering_error', detail: `No PaymentIntent on file for refundTarget=${refundTarget}` });
      return;
    }

    const amountCents = body.amountCents != null ? Math.round(Number(body.amountCents)) : null;
    if (amountCents != null && (!Number.isFinite(amountCents) || amountCents <= 0)) {
      res.status(400).json({ error: 'bad_request', detail: 'amountCents, if supplied, must be a positive number' });
      return;
    }

    // BUG FIX (payment-review, Aug 2026, Critical #6): this key used to be
    // bookingId + refundTarget + PaymentIntent + amount alone. Since
    // per-itemType replacementCostCents is fixed, two separate, legitimate
    // partial refunds of the same amount against the same target (e.g. two
    // different recovered items that happen to cost the same) built the
    // identical key — Stripe's idempotency contract silently returned the
    // first refund object for the second call instead of actually
    // refunding a second time, with no error and a normal-looking
    // write-back. staffNotes is already required on every call and is the
    // one field staff naturally vary per distinct action (which item,
    // which correction) — folding it in distinguishes two real refunds
    // while staying retry-safe: a genuine retry of the exact same
    // submission (browser resend after a network hiccup) reuses the same
    // notes and still collapses to one key, so Stripe still dedupes it.
    const idempotencyKey = 'gearrefund_' + ctx.bookingId + '_' + refundTarget + '_' + sourcePaymentIntentId + '_'
      + (amountCents != null ? amountCents : 'full') + '_' + String(body.staffNotes).trim().slice(0, 200);

    const params = new URLSearchParams();
    params.append('payment_intent', sourcePaymentIntentId);
    if (amountCents != null) params.append('amount', String(amountCents));
    params.append('metadata[kind]', 'gear_refund');
    params.append('metadata[bookingId]', ctx.bookingId);
    params.append('metadata[refundTarget]', refundTarget);

    let refundRes = await stripePost('refunds', params, idempotencyKey);
    let refundId;
    let refundAmountCents;

    if (!refundRes.ok) {
      const stripeErr = refundRes.data && refundRes.data.error;
      const alreadyRefunded = stripeErr && (stripeErr.code === 'charge_already_refunded' || /already.*refunded/i.test(stripeErr.message || ''));
      if (alreadyRefunded) {
        const existing = await stripeGet('refunds?payment_intent=' + encodeURIComponent(sourcePaymentIntentId) + '&limit=1');
        if (existing.ok && existing.data && existing.data.data && existing.data.data.length) {
          refundId = existing.data.data[0].id;
          refundAmountCents = Math.round(existing.data.data[0].amount || 0);
        }
      }
      if (!refundId) {
        // eslint-disable-next-line no-console
        console.error('refund-gear-charge: Stripe refund failed', ctx.bookingId, refundTarget, refundRes.data);
        res.status(502).json({ error: 'stripe_refund_failed', detail: (stripeErr && stripeErr.message) || 'unknown' });
        return;
      }
    } else {
      refundId = refundRes.data.id;
      refundAmountCents = Math.round(refundRes.data.amount || 0);
    }

    const refundedAt = new Date().toISOString();
    let writeBackFailed = false;
    try {
      await callBookingsWebApp('gearOps_recordRefund', {
        bookingId: ctx.bookingId,
        refundTarget,
        refundId,
        refundAmountCents,
        refundedAt,
        staffNotes: body.staffNotes,
      }, { retries: 2 });
    } catch (writeBackErr) {
      writeBackFailed = true;
      // eslint-disable-next-line no-console
      console.error('refund-gear-charge: refund succeeded but the booking write-back failed', ctx.bookingId, refundId, writeBackErr);
      try {
        await callBookingsWebApp('opsAlerts_recordAlert', {
          bookingId: ctx.bookingId,
          alertType: 'gear_refund_writeback_failed',
          amount: refundAmountCents / 100,
          stripeErrorDetail: writeBackErr.message,
          urgency: 'urgent_same_day',
          notes: `Refund ${refundId} for $${centsToDollarsStr(refundAmountCents)} (${refundTarget}) succeeded on Stripe, but the booking record could not be updated. A retry with the same amount reuses the same Idempotency-Key and should self-heal; if this alert is still Open, it did not.`,
        }, { retries: 2 });
      } catch (alertErr) {
        // eslint-disable-next-line no-console
        console.error('refund-gear-charge: also failed to write the write-back-failed Ops Alert', ctx.bookingId, alertErr);
      }
    }

    if (ctx.contactEmail) {
      try {
        await sendEmail({
          to: ctx.contactEmail,
          subject: 'A refund related to your gear deposit',
          html: renderGearRefundConfirmationEmail({
            logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
            guestName: ctx.contactName || '',
            amount: centsToDollarsStr(refundAmountCents),
          }),
        });
      } catch (emailErr) {
        // eslint-disable-next-line no-console
        console.error('refund-gear-charge: failed to send refund confirmation email', ctx.bookingId, emailErr);
      }
    }

    res.status(200).json({
      ok: true, bookingId: ctx.bookingId, refundTarget, refundId, refundAmountCents, refundedAt,
      writeBackFailed: writeBackFailed || undefined,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('refund-gear-charge failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
