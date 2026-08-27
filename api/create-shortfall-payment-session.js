/**
 * api/create-shortfall-payment-session.js
 *
 * Closes Medium #33 from the Aug 2026 payment-flow code review: a gear
 * deposit shortfall charge (api/charge-gear-shortfall.js) that comes back
 * `requires_action` (the card needs 3D Secure) previously had no real
 * resolution path — staff got an Ops Alert and the guest got an email, but
 * an off-session PaymentIntent generally can't complete 3DS without
 * bringing the guest back into a live browser session, and a plain retry
 * just replays the same cached requires_action state via the same
 * Idempotency-Key.
 *
 * This is Step 1 of 2 (mirrors api/create-payment-update-session.js /
 * api/save-updated-payment-method.js's own two-step shape): guest-facing,
 * token-authed (the booking's existing adventurePrepToken — same low-stakes
 * guest-auth pattern as every other guest flow in this project). Given a
 * bookingId + token, looks up whether there's a genuinely open
 * gear_shortfall_charge_failed Ops Alert AND a still-pending 3DS
 * PaymentIntent on file for this booking (shortfallPayment_
 * getBookingForToken, apps-script/gear-inventory-actions.gs), then returns
 * that SAME PaymentIntent's client secret so the guest page can mount
 * Stripe Elements and complete the existing charge — never creates a new
 * PaymentIntent, so there's no risk of a duplicate charge.
 *
 * Deliberately re-fetches the PaymentIntent fresh from Stripe rather than
 * trusting the Sheet's stored reference blindly: the stored id could be
 * stale if it was resolved through some other path (staff canceled it
 * manually, a later attempt superseded it) between being written and this
 * call.
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

    const ctx = await callBookingsWebApp('shortfallPayment_getBookingForToken', { bookingId, token });
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (ctx.unauthorized) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (ctx.noOpenIssue) {
      res.status(410).json({ error: 'no_open_issue', detail: 'This payment link is no longer active — either the issue was already resolved, or there is nothing pending on this booking.' });
      return;
    }
    if (ctx.noResolvablePayment) {
      // An open gear_shortfall_charge_failed alert exists, but not one this
      // flow can complete (e.g. a flat decline, not a 3DS challenge) — see
      // shortfallPayment_getBookingForToken's own comment.
      res.status(410).json({ error: 'no_resolvable_payment', detail: 'This link doesn’t have an active payment to complete. Please reply to the email you received so we can help directly.' });
      return;
    }

    const pi = await stripeGet(`/payment_intents/${encodeURIComponent(ctx.pendingPaymentIntentId)}`);
    if (!pi || pi.error) {
      res.status(500).json({ error: 'stripe_lookup_failed', detail: pi && pi.error });
      return;
    }

    if (pi.status === 'succeeded') {
      res.status(410).json({ error: 'already_completed', detail: 'This charge has already gone through — there’s nothing more to do here.' });
      return;
    }
    if (pi.status !== 'requires_action' && pi.status !== 'requires_confirmation' && pi.status !== 'requires_payment_method') {
      res.status(410).json({ error: 'no_open_issue', detail: 'This payment link is no longer active.' });
      return;
    }

    // Defense in depth, same "never trust a stored/caller-supplied ID as
    // the sole authority" posture as Medium #21's Customer cross-check:
    // this PaymentIntent id came from our own stored column (not the
    // caller), but confirm its own metadata still points at this exact
    // booking before ever handing its client secret to the browser.
    if (String((pi.metadata && pi.metadata.bookingId) || '') !== String(ctx.bookingId)) {
      // eslint-disable-next-line no-console
      console.error('create-shortfall-payment-session: stored pendingPaymentIntentId metadata mismatch', ctx.bookingId, ctx.pendingPaymentIntentId);
      res.status(500).json({ error: 'engineering_error', detail: 'Payment record mismatch — please reply to the email you received.' });
      return;
    }

    res.status(200).json({
      ok: true,
      clientSecret: pi.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
      amount: pi.amount != null ? pi.amount / 100 : null,
      guestName: ctx.contactName || '',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('create-shortfall-payment-session failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
