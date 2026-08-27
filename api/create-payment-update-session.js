/**
 * api/create-payment-update-session.js
 *
 * Closes Aug 2026 build-review item 8: the "update your payment method" link
 * in the deposit-hold-failed email (lib/email-templates/deposit-hold-failed-
 * email.js) previously pointed at a guessed URL with no page behind it.
 *
 * Checked this round whether Stripe's own Customer Portal was a faster path
 * (point the link there instead of building a page): queried this account's
 * billing_portal/configurations via the Stripe MCP and found none configured
 * (empty list) — the Portal isn't set up, so it isn't a drop-in replacement
 * today. Building a small dedicated page/endpoint pair is the more reliable
 * path either way, since it also lets this flow tie back into re-attempting
 * the specific failed hold rather than just updating a card in the abstract.
 *
 * Guest-facing, token-authed (same posture as api/validate-delivery-
 * address.js — called directly from the browser, so it can't hold a shared
 * secret). Step 1 of 2: creates a Stripe SetupIntent for the booking's
 * existing Stripe Customer (looked up via the booking's own main
 * PaymentIntent, never a caller-supplied customer ID) and returns the
 * client secret for the guest page to mount Stripe Elements against.
 *
 * FLAGGED ASSUMPTION: assumes the booking's Stripe Customer is retrievable
 * from `mainPaymentIntentId`'s own `customer` field. This project's booking
 * flow was never reviewed directly for whether every PaymentIntent is
 * created with an attached Customer — worth a quick confirmation against
 * api/save-booking.js / adventure-form.js's Stripe integration before this
 * goes live; if PaymentIntents aren't created with a Customer, this
 * endpoint's 500 `no_customer_on_payment_intent` response is exactly where
 * that would surface.
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

    const { bookingId, token } = req.body || {};
    if (!bookingId || !token) {
      res.status(400).json({ error: 'bad_request', detail: 'bookingId and token are required' });
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
    // BUG FIX (payment-review, Aug 2026, Medium #41): paymentUpdate_
    // getBookingForToken now scopes this token to only work while there's
    // a genuinely open deposit_hold_failed alert on the booking — see that
    // function's own comment. A stale/leaked/already-used link now comes
    // back here instead of silently succeeding.
    if (ctx.noOpenIssue) {
      res.status(410).json({ error: 'no_open_issue', detail: 'This payment update link is no longer active — either the card issue was already resolved, or there is no open issue on this booking.' });
      return;
    }
    if (!ctx.mainPaymentIntentId) {
      res.status(400).json({ error: 'no_payment_on_file' });
      return;
    }

    const pi = await stripeGet(`/payment_intents/${encodeURIComponent(ctx.mainPaymentIntentId)}`);
    if (!pi || pi.error) {
      res.status(500).json({ error: 'stripe_lookup_failed', detail: pi && pi.error });
      return;
    }
    const customerId = pi.customer && (typeof pi.customer === 'string' ? pi.customer : pi.customer.id);
    if (!customerId) {
      res.status(500).json({ error: 'no_customer_on_payment_intent' });
      return;
    }

    // BUG FIX (payment-review, Aug 2026, Lower-confidence #8): no
    // Idempotency-Key at all previously — a guest reloading this page, or a
    // duplicated request, minted a brand-new SetupIntent every time instead
    // of resuming the same one. Keyed on bookingId + customerId (a fixed
    // identifier for "this booking's open payment-update need," never a
    // value this call itself mutates), so repeat hits within Stripe's 24h
    // idempotency window return the SAME SetupIntent/client secret rather
    // than orphaning a fresh one on every retry; naturally expires and mints
    // a new one if the guest genuinely comes back to this flow a second time
    // on a later, unrelated occasion.
    // BUG FIX (payment-review, Aug 2026, Lower-confidence #9): this
    // SetupIntent carried no metadata at all — every other Stripe object
    // this project creates (PaymentIntents, the gear-shortfall charge, etc.)
    // tags metadata.bookingId so a support/Stripe-Dashboard investigation
    // starting from the Stripe side (a guest emails about "the card update
    // link," or a SetupIntent shows up in a Stripe Radar/dispute review)
    // can trace straight back to the booking without a separate Sheet
    // lookup. Added for the same traceability reason, no behavior change.
    const setupIntent = await stripePost('/setup_intents', {
      customer: customerId,
      'payment_method_types[]': 'card',
      usage: 'off_session',
      'metadata[bookingId]': bookingId,
      'metadata[kind]': 'payment_method_update',
    }, 'payment_update_setup_intent_' + bookingId + '_' + customerId);
    if (!setupIntent || setupIntent.error) {
      res.status(500).json({ error: 'setup_intent_failed', detail: setupIntent && setupIntent.error });
      return;
    }

    res.status(200).json({
      ok: true,
      clientSecret: setupIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
      guestName: ctx.contactName || '',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('create-payment-update-session failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
