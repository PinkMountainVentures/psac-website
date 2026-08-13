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

async function stripePost(path, form) {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: stripeAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
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

    const updated = await stripePost(`/customers/${encodeURIComponent(customerId)}`, {
      'invoice_settings[default_payment_method]': paymentMethodId,
    });
    if (!updated || updated.error) {
      res.status(500).json({ error: 'customer_update_failed', detail: updated && updated.error });
      return;
    }

    res.status(200).json({ ok: true, paymentMethodId });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('save-updated-payment-method failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
