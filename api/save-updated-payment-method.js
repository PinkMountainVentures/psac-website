/**
 * api/save-updated-payment-method.js
 *
 * Step 2 of 2 for the "update your payment method" flow (see api/create-
 * payment-update-session.js's header for full context). Guest-facing,
 * token-authed. Called by update-payment-method.html once Stripe Elements'
 * confirmSetup() resolves, to persist the new card as the booking's Stripe
 * Customer default so the next hold/charge attempt actually uses it.
 *
 * FLAGGED ASSUMPTION, same as the create-session endpoint's own flag:
 * this sets `invoice_settings.default_payment_method` on the Customer.
 * api/create-deposit-hold.js's own "card on file" lookup was never reviewed
 * this session (pre-existing, live code) — worth confirming it actually
 * reads the Customer's default payment method (vs. e.g. a stored
 * PaymentMethod ID column elsewhere) before relying on this to unblock a
 * failed hold. The email's "reply to this email" fallback still works
 * regardless if this assumption turns out wrong.
 *
 * This endpoint never re-attempts the hold itself — Section 6's own
 * design keeps hold placement inside api/create-deposit-hold.js /
 * api/trigger-deposit-holds.js, called again the next dispatch-day morning
 * or by staff directly; this endpoint's only job is making sure that next
 * attempt has a working card to charge.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function stripeAuthHeader() {
  return 'Bearer ' + process.env.STRIPE_SECRET_KEY;
}

async function stripeGet(path) {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    headers: { Authorization: stripeAuthHeader() },
  });
  return res.json();
}

async function stripePost(path, form, idempotencyKey) {
  const headers = {
    Authorization: stripeAuthHeader(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(form).toString(),
  });
  return res.json();
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const { bookingId, token, setupIntentId } = req.body || {};
    if (!bookingId || !token || !setupIntentId) {
      res.status(400).json({ error: 'bad_request', detail: 'bookingId, token, and setupIntentId are required' });
      return;
    }

    const ctx = await callBookingsWebApp('paymentUpdate_getBookingForToken', { bookingId, token });
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (ctx.unauthorized) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // BUG FIX (payment-review, Aug 2026, Medium #41): same scoping check as
    // create-payment-update-session.js — see paymentUpdate_getBookingForToken's
    // own comment. Checked again here too (not just at session-creation
    // time) since a guest could in principle reach this second step
    // directly with an old setupIntentId after the issue already resolved.
    if (ctx.noOpenIssue) {
      res.status(410).json({ error: 'no_open_issue', detail: 'This payment update link is no longer active — either the card issue was already resolved, or there is no open issue on this booking.' });
      return;
    }

    const setupIntent = await stripeGet(`/setup_intents/${encodeURIComponent(setupIntentId)}`);
    if (!setupIntent || setupIntent.error || setupIntent.status !== 'succeeded' || !setupIntent.payment_method) {
      res.status(400).json({
        error: 'setup_not_complete',
        detail: setupIntent && (setupIntent.error || setupIntent.status),
      });
      return;
    }

    const paymentMethodId = typeof setupIntent.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent.payment_method.id;
    const customerId = setupIntent.customer
      && (typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer.id);
    if (!customerId) {
      res.status(500).json({ error: 'no_customer_on_setup_intent' });
      return;
    }

    // BUG FIX (payment-review, Aug 2026, High #21): `token` authenticates
    // that the caller is allowed to act on `bookingId` (paymentUpdate_
    // getBookingForToken above), but nothing previously checked that the
    // client-supplied `setupIntentId` actually belongs to THIS booking's own
    // Stripe Customer before writing invoice_settings.default_payment_method
    // — a real cross-guest bug: a stale, replayed, or hand-edited
    // setupIntentId from a DIFFERENT booking's Customer would silently
    // rewrite that OTHER booking's default payment method using a token
    // that only ever proved authority over THIS booking. Cross-check against
    // the booking's own main PaymentIntent's Customer — the same
    // authoritative, never-trust-a-caller-supplied-ID anchor
    // api/charge-gear-shortfall.js already uses for its own Customer lookup
    // — and fail closed with an Ops Alert on any mismatch rather than
    // proceeding.
    if (!ctx.mainPaymentIntentId) {
      res.status(500).json({ error: 'engineering_error', detail: 'booking has no mainPaymentIntentId on file to verify the Customer against' });
      return;
    }
    const mainPi = await stripeGet(`/payment_intents/${encodeURIComponent(ctx.mainPaymentIntentId)}`);
    const expectedCustomerId = mainPi && mainPi.customer
      && (typeof mainPi.customer === 'string' ? mainPi.customer : mainPi.customer.id);
    if (!mainPi || mainPi.error || !expectedCustomerId) {
      res.status(502).json({ error: 'stripe_error', detail: 'Could not verify the booking\'s Customer against its main PaymentIntent.' });
      return;
    }
    if (String(expectedCustomerId) !== String(customerId)) {
      // eslint-disable-next-line no-console
      console.error('save-updated-payment-method: setupIntentId Customer mismatch', { bookingId, setupIntentId, expectedCustomerId, gotCustomerId: customerId });
      try {
        await callBookingsWebApp('opsAlerts_recordAlert', {
          bookingId,
          alertType: 'payment_method_update_customer_mismatch',
          stripeErrorDetail: `setupIntentId ${setupIntentId} belongs to Customer ${customerId}, but booking ${bookingId}'s main PaymentIntent (${ctx.mainPaymentIntentId}) belongs to Customer ${expectedCustomerId}. Rejected — likely a stale/replayed/edited setupIntentId, possibly from a different booking. No payment method was changed.`,
          urgency: 'urgent_same_day',
        }, { retries: 2 });
      } catch (alertErr) {
        // eslint-disable-next-line no-console
        console.error('save-updated-payment-method: also failed to write the customer-mismatch Ops Alert', bookingId, alertErr);
      }
      res.status(403).json({ error: 'customer_mismatch', detail: 'This payment method does not belong to this booking.' });
      return;
    }

    // BUG FIX (payment-review, Aug 2026, Lower-confidence #8): no
    // Idempotency-Key on this Customer update either. Keyed on customerId +
    // the target paymentMethodId (a fixed value per "set this customer's
    // default payment method to this specific card," never a field the call
    // itself mutates) — a true retry setting the same target reuses the
    // cached response, while a genuinely different paymentMethodId (a
    // second, later card update) gets its own key, exactly as intended.
    const updated = await stripePost(`/customers/${encodeURIComponent(customerId)}`, {
      'invoice_settings[default_payment_method]': paymentMethodId,
    }, 'payment_method_update_customer_' + customerId + '_' + paymentMethodId);
    if (!updated || updated.error) {
      res.status(500).json({ error: 'customer_update_failed', detail: updated && updated.error });
      return;
    }

    // BUG FIX (payment-review, Aug 2026, Medium #40): a successful card
    // update used to write nothing back to the Sheet and raise no Ops
    // Alert — staff had no way to know a previously-alerted card-failure
    // issue had just been resolved by the guest. Both writes are
    // best-effort: the Stripe-side update above already succeeded, so
    // neither should block or fail this response if the Sheet side hiccups.
    try {
      await callBookingsWebApp('paymentUpdate_recordCardUpdated', { bookingId, paymentMethodId }, { retries: 2 });
    } catch (writeBackErr) {
      // eslint-disable-next-line no-console
      console.error('save-updated-payment-method: card updated but Change Log write-back failed', bookingId, writeBackErr);
    }
    try {
      const alertLookup = await callBookingsWebApp('holdClearance_findOpenDepositAlert', { bookingId, alertType: 'deposit_hold_failed' });
      if (alertLookup && alertLookup.found) {
        await callBookingsWebApp('opsAlerts_resolveAlert', {
          alertId: alertLookup.alertId,
          resolvedBy: 'system (guest updated payment method)',
          notes: 'Guest updated their card via the self-service payment-method-update link. The next scheduled hold attempt (or a manual retry) should now have a working card to charge.',
        }, { retries: 2 });
      }
    } catch (resolveErr) {
      // eslint-disable-next-line no-console
      console.error('save-updated-payment-method: card updated but failed to check/resolve an open deposit_hold_failed alert', bookingId, resolveErr);
    }

    res.status(200).json({ ok: true, paymentMethodId });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('save-updated-payment-method failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
