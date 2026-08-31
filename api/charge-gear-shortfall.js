/**
 * api/charge-gear-shortfall.js
 *
 * MIGRATED (2026-08-31, gear-ops build session): now calls lib/gear-
 * service.js (Postgres) instead of lib/apps-script-client.js's
 * callBookingsWebApp(). Every direct Stripe call in this file is
 * unchanged. See lib/gear-service.js's own header for the full scope of
 * this migration.
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
 * intends to charge.
 *
 * Amount: defaults to the stored `gearShortfallCents` computed at
 * reconciliation time. Staff may override via `amountCents` in the
 * request, but per Section 10's "required note if adjusted from the
 * computed figure," an override with no `staffNotes` is rejected here,
 * server-side, not just gated by the client's own form validation.
 */

'use strict';

const gearService = require('../lib/gear-service');
const { sendEmail } = require('../lib/send-email');
const { summarizeItems } = require('../lib/gear-item-summary');
const { renderDepositCaptureExceedingHoldEmail } = require('../lib/email-templates/deposit-capture-exceeding-hold-email');
const { renderGearShortfallChargeFailedEmail } = require('../lib/email-templates/gear-shortfall-charge-failed-email');

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

// NEW (payment-review, Aug 2026, Medium #33): base URL for the guest-facing
// self-service 3DS-completion page — same constant/pattern as api/
// adventure-prep.js's own SITE_URL.
const SITE_URL = 'https://www.palmspringsadventureclub.com';

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

    const ctx = await gearService.getReconciliationContext({ bookingId: body.bookingId });
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
    // BUG FIX (payment-review, Aug 2026, Medium #32): these two "should
    // never happen" branches used to fall straight through to a bare 500
    // with only a console.error — no Ops Alert, no audit trail, for a
    // genuine data-integrity anomaly (a booking marked pending review with
    // no reconciledAt/gearShortfallCents on file). Deliberately NOT routed
    // through recordFailure below: no shortfall-charge claim has been taken
    // yet at this point (beginShortfallCharge hasn't run), and no Stripe
    // charge was ever attempted, so recordFailure's "we couldn't process
    // your charge" guest email would be false — this is a data problem for
    // staff to investigate, not a failed charge to notify the guest about.
    if (!ctx.reconciledAt) {
      await recordDataIntegrityAlert(ctx, 'booking is pending review but has no reconciledAt on file');
      res.status(500).json({ error: 'engineering_error', detail: 'booking is pending review but has no reconciledAt on file' });
      return;
    }
    if (ctx.gearShortfallCents == null) {
      await recordDataIntegrityAlert(ctx, 'booking is pending review but has no gearShortfallCents on file');
      res.status(500).json({ error: 'engineering_error', detail: 'booking is pending review but has no gearShortfallCents on file' });
      return;
    }

    const requestedAmountCents = body.amountCents != null ? Math.round(Number(body.amountCents)) : ctx.gearShortfallCents;
    if (!Number.isFinite(requestedAmountCents) || requestedAmountCents <= 0) {
      res.status(400).json({ error: 'bad_request', detail: 'amountCents must be a positive number' });
      return;
    }
    // BUG FIX (payment-review, Aug 2026, Lower-confidence #6): staff-supplied
    // amountCents had no upper bound at all beyond "positive number". Cap
    // the override at whichever is larger: 3x the system's own computed
    // shortfall, or a flat $1,000 floor so a small computed shortfall
    // doesn't make an otherwise-reasonable adjustment impossible.
    const SHORTFALL_OVERRIDE_CEILING_CENTS = Math.max(ctx.gearShortfallCents * 3, 100000);
    if (requestedAmountCents > SHORTFALL_OVERRIDE_CEILING_CENTS) {
      res.status(400).json({
        error: 'bad_request',
        detail: `amountCents ($${centsToDollarsStr(requestedAmountCents)}) is too far above the computed shortfall ($${centsToDollarsStr(ctx.gearShortfallCents)}) to accept automatically. If this charge is genuinely correct, it needs a different manual process.`,
      });
      return;
    }
    const isAdjusted = requestedAmountCents !== ctx.gearShortfallCents;
    if (isAdjusted && (!body.staffNotes || !String(body.staffNotes).trim())) {
      res.status(400).json({ error: 'bad_request', detail: 'staffNotes is required when the charge amount is adjusted from the computed shortfall' });
      return;
    }

    // BUG FIX (payment-review, Aug 2026, High #17): the ctx.depositStatus
    // check above is a plain read with no lock — two overlapping requests
    // can both read 'full_capture_pending_review' and both proceed.
    // beginShortfallCharge atomically claims the booking (a guarded UPDATE)
    // before this endpoint ever calls Stripe, so a genuinely concurrent
    // second request is turned away here instead of creating a second real
    // charge. Every failure branch below (recordFailure) undoes this claim
    // via recordShortfallChargeFailure so a legitimate retry isn't blocked
    // by its own earlier failed attempt.
    const beginResult = await gearService.beginShortfallCharge({ bookingId: ctx.bookingId, nowIso: new Date().toISOString() });
    if (!beginResult || !beginResult.ok) {
      const reason = (beginResult && beginResult.reason) || 'unknown';
      if (reason === 'charge_in_progress') {
        res.status(409).json({ error: 'charge_in_progress', detail: 'Another shortfall charge attempt for this booking is already in progress. Please wait a moment and retry.' });
        return;
      }
      res.status(409).json({ error: 'not_in_review_state', detail: `depositStatus is '${(beginResult && beginResult.depositStatus) || ctx.depositStatus}', expected 'full_capture_pending_review'` });
      return;
    }

    // MOVED UP (payment-review, Aug 2026, High #18): computed early so
    // recordFailure can be called from the mainPaymentIntentId lookup
    // failure branch below (it closes over chargeableItems). Only depends
    // on ctx.items, already available — safe to compute this early.
    const chargeableItems = (ctx.items || []).filter((i) => i.condition === 'Damaged' || i.condition === 'Missing');

    if (!ctx.mainPaymentIntentId) {
      // BUG FIX (payment-review, Aug 2026, Medium #32): unlike the two
      // reconciledAt/gearShortfallCents checks above, this one runs AFTER
      // beginShortfallCharge has already claimed the booking — a bare 500
      // here used to leave that claim stuck in 'shortfall_charge_in_progress'
      // with no release and no alert. requestedAmountCents is already
      // computed above, so this is a normal recordFailure call, same as the
      // sibling Stripe-lookup-failure branch just below.
      await recordFailure(ctx, requestedAmountCents, 'Booking has no main PaymentIntent on file — cannot look up a saved card to charge.');
      res.status(500).json({ error: 'engineering_error', detail: 'booking has no main PaymentIntent on file' });
      return;
    }
    const mainRes = await stripeGet('payment_intents/' + encodeURIComponent(ctx.mainPaymentIntentId));
    if (!mainRes.ok) {
      // BUG FIX (payment-review, Aug 2026, High #18): this used to return a
      // raw 502 with no recordFailure call, unlike every other failure
      // branch in this function — no Ops Alert, no claim release, no guest
      // email, for a real failure to look up the very PaymentIntent this
      // whole charge depends on.
      await recordFailure(ctx, requestedAmountCents, 'Could not retrieve the main PaymentIntent from Stripe (' + JSON.stringify((mainRes.data && mainRes.data.error) || {}) + ').');
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

    // chargeableItems is now computed earlier (see High #18 note above);
    // itemsLabel/conditionNote still only needed from here down.
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
      // BUG FIX (payment-review, Aug 2026, Medium #33): a plain retry of
      // this endpoint just replays the same cached requires_action state
      // via the same Idempotency-Key, and an off-session PaymentIntent
      // generally can't complete 3DS without the guest back in a live
      // browser session. Passing chargeRes.data.id through lets
      // recordFailure persist it and hand the guest a self-service link
      // (complete-shortfall-payment.html) that finishes this SAME
      // PaymentIntent, never a new one.
      await recordFailure(ctx, requestedAmountCents, 'Card requires additional authentication (3D Secure) before the charge can complete.', chargeRes.data.id);
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
      await gearService.recordShortfallCharge({
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
        await gearService.recordOpsAlert({
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

    // BUG FIX (payment-review, Aug 2026, Medium #32): lightweight sibling to
    // recordFailure for the two pre-claim data-integrity checks above —
    // raises an Ops Alert for staff to investigate, no claim to release, no
    // "your charge failed" guest email (nothing was ever attempted).
    async function recordDataIntegrityAlert(ctxInner, detail) {
      try {
        await gearService.recordOpsAlert({
          bookingId: ctxInner.bookingId,
          alertType: 'gear_shortfall_data_integrity_error',
          stripeErrorDetail: detail,
          urgency: 'urgent_same_day',
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('charge-gear-shortfall: failed to record data-integrity Ops Alert', ctxInner.bookingId, e);
      }
    }

    // BUG FIX (payment-review, Aug 2026, Medium #33): new optional 4th
    // param, pendingPaymentIntentId — only ever passed by the
    // requires_action call site above. Persisted (or explicitly cleared,
    // when absent) via recordShortfallChargeFailure so a later guest visit
    // to complete-shortfall-payment.html can look it back up, and used
    // here to build that page's link for the failure email.
    async function recordFailure(ctxInner, amountCents, detail, pendingPaymentIntentId) {
      try {
        await gearService.recordShortfallChargeFailure({
          bookingId: ctxInner.bookingId, detail,
          pendingPaymentIntentId: pendingPaymentIntentId || '',
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('charge-gear-shortfall: failed to record shortfall charge failure', ctxInner.bookingId, e);
      }
      try {
        await gearService.recordOpsAlert({
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
          const actionUrl = (pendingPaymentIntentId && ctxInner.adventurePrepToken)
            ? SITE_URL + '/complete-shortfall-payment?bookingId=' + encodeURIComponent(ctxInner.bookingId) + '&token=' + encodeURIComponent(ctxInner.adventurePrepToken)
            : '';
          await sendEmail({
            to: ctxInner.contactEmail,
            subject: "We couldn't process your gear deposit charge",
            html: renderGearShortfallChargeFailedEmail({
              logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
              item: fItemsLabel, conditionNote: fConditionNote,
              holdAmount: centsToDollarsStr(ctxInner.reconciledAmountCents || 0),
              amount: centsToDollarsStr(amountCents),
              actionUrl: actionUrl || undefined,
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
