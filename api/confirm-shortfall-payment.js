/**
 * api/confirm-shortfall-payment.js
 *
 * Step 2 of 2 for the guest self-service "complete your gear deposit
 * payment" flow (see api/create-shortfall-payment-session.js's header for
 * full context on Medium #33). Guest-facing, token-authed. Called by
 * complete-shortfall-payment.html once Stripe Elements' confirmPayment()
 * resolves, to record the now-completed charge and resolve the associated
 * Ops Alert — never trusts the browser's own claim of success, re-fetches
 * the PaymentIntent from Stripe and checks its actual status.
 *
 * Reuses gearOps_recordShortfallCharge (apps-script/gear-inventory-
 * actions.gs) unchanged — the exact same write-back api/charge-gear-
 * shortfall.js's own direct-success path already uses — rather than a
 * second, parallel write-back function that could drift out of sync.
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

    const { bookingId, token, paymentIntentId } = req.body || {};
    if (!bookingId || !token || !paymentIntentId) {
      res.status(400).json({ error: 'bad_request', detail: 'bookingId, token, and paymentIntentId are required' });
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
    // Re-checked here too, same defense-in-depth as save-updated-payment-
    // method.js's own re-check of noOpenIssue at its own step 2 — a guest
    // could in principle reach this second step directly with a stale
    // paymentIntentId after the issue already resolved another way.
    if (ctx.noOpenIssue || ctx.noResolvablePayment) {
      res.status(410).json({ error: 'no_open_issue', detail: 'This payment link is no longer active.' });
      return;
    }

    // Never trust the client-supplied paymentIntentId as the sole
    // authority — it must match the id this booking's own token-scoped
    // lookup just resolved, same "never trust a caller-supplied
    // money-adjacent ID" posture as Medium #21's Customer cross-check.
    if (String(paymentIntentId) !== String(ctx.pendingPaymentIntentId)) {
      // eslint-disable-next-line no-console
      console.error('confirm-shortfall-payment: paymentIntentId mismatch', bookingId, paymentIntentId, ctx.pendingPaymentIntentId);
      res.status(403).json({ error: 'payment_mismatch', detail: 'This payment does not match this booking.' });
      return;
    }

    const pi = await stripeGet(`/payment_intents/${encodeURIComponent(paymentIntentId)}`);
    if (!pi || pi.error) {
      res.status(500).json({ error: 'stripe_lookup_failed', detail: pi && pi.error });
      return;
    }
    if (String((pi.metadata && pi.metadata.bookingId) || '') !== String(bookingId)) {
      // eslint-disable-next-line no-console
      console.error('confirm-shortfall-payment: PaymentIntent metadata mismatch', bookingId, paymentIntentId);
      res.status(403).json({ error: 'payment_mismatch', detail: 'This payment does not match this booking.' });
      return;
    }

    if (pi.status !== 'succeeded' && pi.status !== 'processing') {
      // The guest bailed before finishing 3DS, or the bank declined the
      // authentication step itself — not a write-back case, just tell the
      // page so it can show the right state. The Ops Alert stays open;
      // staff will see this booking is still stuck the same as before.
      // ('processing' is treated as a success case here, matching
      // api/charge-gear-shortfall.js's own direct-charge path.)
      res.status(200).json({ ok: false, outcome: pi.status });
      return;
    }

    const chargedAt = new Date().toISOString();
    try {
      await callBookingsWebApp('gearOps_recordShortfallCharge', {
        bookingId,
        shortfallChargeId: pi.id,
        shortfallChargedAmountCents: pi.amount,
        shortfallChargedAt: chargedAt,
        staffNotes: 'Guest completed 3D Secure authentication via the self-service payment link.',
      }, { retries: 2 });
    } catch (writeBackErr) {
      // eslint-disable-next-line no-console
      console.error('confirm-shortfall-payment: charge succeeded but write-back failed', bookingId, pi.id, writeBackErr);
      try {
        await callBookingsWebApp('opsAlerts_recordAlert', {
          bookingId,
          alertType: 'gear_shortfall_charge_writeback_failed',
          amount: pi.amount / 100,
          stripeErrorDetail: writeBackErr.message,
          urgency: 'urgent_same_day',
          notes: `Shortfall charge ${pi.id} for $${(pi.amount / 100).toFixed(2)} succeeded via the guest's self-service 3DS completion link, but the booking record could not be updated.`,
        }, { retries: 2 });
      } catch (alertErr) {
        // eslint-disable-next-line no-console
        console.error('confirm-shortfall-payment: also failed to write the write-back-failed Ops Alert', bookingId, alertErr);
      }
      // Still tell the guest it worked — the Stripe-side charge genuinely
      // did succeed, same best-effort posture as save-updated-payment-
      // method.js; staff gets the alert above to reconcile the Sheet.
    }

    try {
      const alertLookup = await callBookingsWebApp('holdClearance_findOpenDepositAlert', { bookingId, alertType: 'gear_shortfall_charge_failed' });
      if (alertLookup && alertLookup.found) {
        await callBookingsWebApp('opsAlerts_resolveAlert', {
          alertId: alertLookup.alertId,
          resolvedBy: 'system (guest completed 3D Secure authentication)',
          notes: 'Guest completed the 3D Secure challenge via the self-service payment link, and the shortfall charge succeeded.',
        }, { retries: 2 });
      }
    } catch (resolveErr) {
      // eslint-disable-next-line no-console
      console.error('confirm-shortfall-payment: charge succeeded but failed to resolve the open alert', bookingId, resolveErr);
    }

    res.status(200).json({ ok: true, outcome: 'succeeded', paymentIntentId: pi.id, amount: pi.amount / 100 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('confirm-shortfall-payment failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
