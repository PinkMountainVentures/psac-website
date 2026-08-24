/**
 * api/charge-gear-shortfall.js
 *
 * Gear Inventory PRD Section 10: the manual-review follow-up charge for
 * Scenario 4 (itemized loss/damage exceeds the deposit hold). Deliberately
 * NOT automatic — a staff member reviews photos on the Reconciliation
 * Review page, optionally adjusts the computed amount, and clicks one
 * "Charge $X" action that lands here. Server-to-server only
 * (api/ops-proxy.js), GEAR_OPS_SHARED_SECRET.
 *
 * Reuses the exact `setup_future_usage: 'off_session'` saved-card charge
 * pattern already established by lib/finalize-kit-change.js and
 * api/create-deposit-hold.js — not a new charging mechanism.
 *
 * IDEMPOTENCY KEY — the correction called out explicitly in this build's
 * kickoff: derive the key from bookingId + a FIXED, STORED identifier for
 * this specific reconciliation event (`ctx.reconciledAt`, written once by
 * reconcile-gear-deposit.js and read back unchanged here), never a live/
 * regenerated timestamp — combined with the actual amount this call
 * intends to charge. Using the amount as part of the key is deliberate,
 * not an oversight: a pure retry of the identical staff decision (same
 * amount) reuses the same key, so Stripe correctly dedupes it; a genuinely
 * different staff-adjusted amount is a different decision and gets a
 * different key, which is correct — Stripe would reject reusing one key
 * with two different amounts anyway.
 *
 * Amount: defaults to the stored `gearShortfallCents` computed at
 * reconciliation time. Staff may override via `amountCents` in the
 * request, but per Section 10's "required note if adjusted from the
 * computed figure," an override with no `staffNotes` is rejected here,
 * server-side, not just gated by the client's own form validation.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { sendEmail } = require('../lib/send-email');
const { summarizeItems } = require('../lib/gear-item-summary');
const { renderDepositCaptureExceedingHoldEmail } = require('../lib/email-templates/deposit-capture-exceeding-hold-email');
const { renderGearShortfallChargeFailedEmail } = require('../lib/email-templates/gear-shortfall-charge-failed-email');

function checkSecret(body) {
  return body && body.secret === process.env.GEAR_OPS_SHARED_SECRET;
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

async function stripeGet(path) {
  const res = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: stripeAuthHeader() } });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function stripePost(path, params, idempotencyKey) {
  const headers = { Authorization: stripeAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch('https://api.stripe.com/v1/' + path, { method: 'POST', headers, body: params.toString() });
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

    const ctx = await callBookingsWebApp('gearOps_getReconciliationContext', { bookingId: body.bookingId });
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'booking_not_found' });
      return;
    }

    // Idempotent: already charged by an earlier call.
    if (ctx.depositStatus === 'shortfall_charged') {
      res.status(200).json({
        ok: true, alreadyCharged: true, bookingId: ctx.bookingId,
        shortfallChargeId: ctx.shortfallChargeId, shortfallChargedAmountCents: ctx.shortfallChargedAmountCents,
      });
      return;
    }

    if (ctx.depositStatus !== 'full_capture_pending_review') {
      res.status(400).json({ error: 'not_in_review_state', detail: `depositStatus is '${ctx.depositStatus}', expected 'full_capture_pending_review'` });
      return;
    }
    if (!ctx.reconciledAt) {
      res.status(500).json({ error: 'engineering_error', detail: 'booking is pending review but has no reconciledAt on file' });
      return;
    }
    if (ctx.gearShortfallCents == null) {
      res.status(500).json({ error: 'engineering_error', detail: 'booking is pending review but has no gearShortfallCents on file' });
      return;
    }

    const requestedAmountCents = body.amountCents != null ? Math.round(Number(body.amountCents)) : ctx.gearShortfallCents;
    if (!Number.isFinite(requestedAmountCents) || requestedAmountCents <= 0) {
      res.status(400).json({ error: 'bad_request', detail: 'amountCents must be a positive number' });
      return;
    }
    const isAdjusted = requestedAmountCents !== ctx.gearShortfallCents;
    if (isAdjusted && (!body.staffNotes || !String(body.staffNotes).trim())) {
      res.status(400).json({ error: 'bad_request', detail: 'staffNotes is required when the charge amount is adjusted from the computed shortfall' });
      return;
    }

    if (!ctx.mainPaymentIntentId) {
      res.status(500).json({ error: 'engineering_error', detail: 'booking has no main PaymentIntent on file' });
      return;
    }
    const mainRes = await stripeGet('payment_intents/' + encodeURIComponent(ctx.mainPaymentIntentId));
    if (!mainRes.ok) {
      res.status(502).json({ error: 'stripe_error', detail: 'Could not retrieve the main PaymentIntent.' });
      return;
    }
    const customerId = mainRes.data.customer;
    let paymentMethodId = mainRes.data.payment_method;

    // Same "prefer the Customer's current default payment method" fix
    // already established in api/create-deposit-hold.js — a guest who
    // updated their card after a failed hold shouldn't have that fix
    // silently ignored here.
    if (customerId) {
      try {
        const customerRes = await fetch('https://api.stripe.com/v1/customers/' + encodeURIComponent(customerId), { headers: { Authorization: stripeAuthHeader() } });
        const customerData = await customerRes.json();
        if (customerRes.ok && customerData && customerData.invoice_settings && customerData.invoice_settings.default_payment_method) {
          paymentMethodId = customerData.invoice_settings.default_payment_method;
        }
      } catch (custErr) {
        // eslint-disable-next-line no-console
        console.error('charge-gear-shortfall: Customer default-payment-method lookup failed, falling back to the main PaymentIntent\'s payment method', custErr);
      }
    }

    const chargeableItems = (ctx.items || []).filter((i) => i.condition === 'Damaged' || i.condition === 'Missing');
    const { itemsLabel, conditionNote } = summarizeItems(chargeableItems);
    const idempotencyKey = 'gearshortfall_' + ctx.bookingId + '_' + ctx.reconciledAt + '_' + requestedAmountCents;

    if (!customerId || !paymentMethodId) {
      await recordFailure(ctx, requestedAmountCents, 'No saved card on file to run an off-session charge against.');
      res.status(200).json({ ok: false, outcome: 'unavailable', bookingId: ctx.bookingId });
      return;
    }

    const params = new URLSearchParams();
    params.append('amount', String(requestedAmountCents));
    params.append('currency', 'usd');
    params.append('customer', customerId);
    params.append('payment_method', paymentMethodId);
    params.append('payment_method_types[]', 'card');
    params.append('off_session', 'true');
    params.append('confirm', 'true');
    params.append('description', 'Gear deposit shortfall — Palm Springs Adventure Club');
    params.append('metadata[kind]', 'gear_shortfall_charge');
    params.append('metadata[bookingId]', ctx.bookingId);

    const chargeRes = await stripePost('payment_intents', params, idempotencyKey);

    if (!chargeRes.ok) {
      const detail = (chargeRes.data && chargeRes.data.error && chargeRes.data.error.message) || 'Stripe API error creating the charge.';
      await recordFailure(ctx, requestedAmountCents, detail);
      res.status(200).json({ ok: false, outcome: 'failed', bookingId: ctx.bookingId, detail });
      return;
    }

    if (chargeRes.data.status === 'requires_action') {
      await recordFailure(ctx, requestedAmountCents, 'Card requires additional authentication (3D Secure) before the charge can complete.');
      res.status(200).json({ ok: false, outcome: 'requires_action', bookingId: ctx.bookingId, paymentIntentId: chargeRes.data.id });
      return;
    }

    if (chargeRes.data.status !== 'succeeded' && chargeRes.data.status !== 'processing') {
      await recordFailure(ctx, requestedAmountCents, 'Unexpected PaymentIntent status: ' + chargeRes.data.status);
      res.status(200).json({ ok: false, outcome: 'failed', bookingId: ctx.bookingId, detail: 'Unexpected PaymentIntent status: ' + chargeRes.data.status });
      return;
    }

    const chargedAt = new Date().toISOString();
    try {
      await callBookingsWebApp('gearOps_recordShortfallCharge', {
        bookingId: ctx.bookingId,
        shortfallChargeId: chargeRes.data.id,
        shortfallChargedAmountCents: requestedAmountCents,
        shortfallChargedAt: chargedAt,
        staffNotes: body.staffNotes || '',
      });
    } catch (writeBackErr) {
      // eslint-disable-next-line no-console
      console.error('charge-gear-shortfall: charge succeeded but write-back failed', ctx.bookingId, chargeRes.data.id, writeBackErr);
      try {
        await callBookingsWebApp('opsAlerts_recordAlert', {
          bookingId: ctx.bookingId,
          alertType: 'gear_shortfall_charge_writeback_failed',
          amount: requestedAmountCents / 100,
          stripeErrorDetail: writeBackErr.message,
          urgency: 'urgent_same_day',
          notes: `Shortfall charge ${chargeRes.data.id} for $${centsToDollarsStr(requestedAmountCents)} succeeded on Stripe, but the booking record could not be updated. Retrying this same call reuses the same Idempotency-Key so it should self-heal; if this alert is still Open, it did not.`,
        });
      } catch (alertErr) {
        // eslint-disable-next-line no-console
        console.error('charge-gear-shortfall: also failed to write the write-back-failed Ops Alert', ctx.bookingId, alertErr);
      }
      throw writeBackErr;
    }

    if (ctx.contactEmail) {
      try {
        await sendEmail({
          to: ctx.contactEmail,
          subject: 'An update on your gear deposit',
          html: renderDepositCaptureExceedingHoldEmail({
            logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
            item: itemsLabel,
            additionalAmount: centsToDollarsStr(requestedAmountCents),
          }),
        });
      } catch (emailErr) {
        // eslint-disable-next-line no-console
        console.error('charge-gear-shortfall: failed to send success email', ctx.bookingId, emailErr);
      }
    }

    res.status(200).json({
      ok: true, outcome: 'charged', bookingId: ctx.bookingId,
      shortfallChargeId: chargeRes.data.id, shortfallChargedAmountCents: requestedAmountCents, shortfallChargedAt: chargedAt,
    });

    async function recordFailure(ctxInner, amountCents, detail) {
      try {
        await callBookingsWebApp('gearOps_recordShortfallChargeFailure', { bookingId: ctxInner.bookingId, detail });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('charge-gear-shortfall: failed to record shortfall charge failure', ctxInner.bookingId, e);
      }
      try {
        await callBookingsWebApp('opsAlerts_recordAlert', {
          bookingId: ctxInner.bookingId,
          alertType: 'gear_shortfall_charge_failed',
          amount: amountCents / 100,
          stripeErrorDetail: detail,
          urgency: 'urgent_same_day',
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('charge-gear-shortfall: failed to record Ops Alert for shortfall charge failure', ctxInner.bookingId, e);
      }
      if (ctxInner.contactEmail) {
        try {
          const { itemsLabel: fItemsLabel, conditionNote: fConditionNote } = summarizeItems(chargeableItems);
          await sendEmail({
            to: ctxInner.contactEmail,
            subject: "We couldn't process your gear deposit charge",
            html: renderGearShortfallChargeFailedEmail({
              logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
              item: fItemsLabel, conditionNote: fConditionNote,
              holdAmount: centsToDollarsStr(ctxInner.reconciledAmountCents || 0),
              amount: centsToDollarsStr(amountCents),
            }),
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('charge-gear-shortfall: failed to send failure email', ctxInner.bookingId, e);
        }
      } else {
        // eslint-disable-next-line no-console
        console.error('charge-gear-shortfall: no contactEmail on file, guest not notified of charge failure', ctxInner.bookingId);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('charge-gear-shortfall failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
