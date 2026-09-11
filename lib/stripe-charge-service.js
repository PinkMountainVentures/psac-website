/**
 * lib/stripe-charge-service.js
 *
 * Shared payment/card-capture consolidation (2026-09-11), item 6.
 * api/create-deposit-hold.js and api/charge-gear-shortfall.js each
 * independently implemented the identical "resolve which Stripe Customer
 * and payment method to charge off-session" lookup — confirmed via direct
 * read of both files during that proposal. Pulled out here as the one
 * place that logic lives.
 *
 * Deliberately NOT a wrapper around an entire charge — each caller still
 * builds and fires its own Stripe PaymentIntent (different amount,
 * metadata, idempotency-key shape, and failure handling per caller). This
 * module only owns the "which Customer, which payment method" resolution
 * shared by both, so a fix to that logic (like the one below) only ever
 * needs to happen once.
 */

'use strict';

function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

/**
 * Given a booking's main PaymentIntent id, resolves the Stripe Customer id
 * and the payment method id that should be charged off-session.
 *
 * BUG FIX (independent bug pass, Aug 2026, originally landed separately in
 * create-deposit-hold.js and charge-gear-shortfall.js): prefers the
 * Customer's CURRENT default payment method over whatever's frozen on the
 * original main PaymentIntent. Without this, a guest who fixes a failed
 * hold via the card-update flow (api/save-updated-payment-method.js, which
 * sets invoice_settings.default_payment_method on the Customer) would have
 * that fix silently ignored — a retry would keep charging the same,
 * already-declined card off the main PaymentIntent's own payment_method.
 * Falls back to the main PaymentIntent's payment method if the Customer
 * has no default set yet (the ordinary first-attempt case, where nobody's
 * had to update anything) or if the Customer lookup itself fails — never
 * throws over this, since the caller almost always has a reasonable
 * fallback to charge.
 *
 * Returns { ok: true, customerId, paymentMethodId, mainPaymentIntent } on
 * success. Returns { ok: false, status, error } only if the main
 * PaymentIntent itself couldn't be retrieved from Stripe — callers decide
 * their own response shape for that case (they always have, since each
 * responds a little differently on this failure today).
 */
async function resolveChargeableCustomer(mainPaymentIntentId) {
  const mainRes = await fetch('https://api.stripe.com/v1/payment_intents/' + encodeURIComponent(mainPaymentIntentId), {
    headers: { Authorization: stripeAuthHeader() },
  });
  const mainData = await mainRes.json();
  if (!mainRes.ok) {
    return { ok: false, status: mainRes.status, error: (mainData && mainData.error) || mainData };
  }

  const customerId = mainData.customer;
  let paymentMethodId = mainData.payment_method;

  if (customerId) {
    try {
      const customerRes = await fetch('https://api.stripe.com/v1/customers/' + encodeURIComponent(customerId), {
        headers: { Authorization: stripeAuthHeader() },
      });
      const customerData = await customerRes.json();
      if (customerRes.ok && customerData && customerData.invoice_settings && customerData.invoice_settings.default_payment_method) {
        paymentMethodId = customerData.invoice_settings.default_payment_method;
      }
    } catch (custErr) {
      // eslint-disable-next-line no-console
      console.error('resolveChargeableCustomer: Customer default-payment-method lookup failed, falling back to the main PaymentIntent\'s payment method', custErr);
    }
  }

  return {
    ok: true,
    customerId: customerId || null,
    paymentMethodId: paymentMethodId || null,
    mainPaymentIntent: mainData,
  };
}

module.exports = { stripeAuthHeader, resolveChargeableCustomer };
