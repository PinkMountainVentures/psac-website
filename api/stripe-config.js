/* ============================================
   PSAC — Stripe publishable key config endpoint
   NEW (Aug 2026). Serves the Stripe publishable key from the
   STRIPE_PUBLISHABLE_KEY env var so adventure-form.js (a static
   client-side file with no server templating) never hardcodes the key
   value directly.

   This is NOT a security fix — publishable keys are safe to expose
   client-side by design (they can only create a charge against a
   PaymentIntent the server already created, never move money on their
   own; the matching *secret* key is what actually has to stay private,
   and it already lives in STRIPE_SECRET_KEY, read server-side only by
   api/create-payment-intent.js). This is a single-source-of-truth fix:
   before this endpoint existed, going live meant flipping
   STRIPE_SECRET_KEY to sk_live_... in Vercel AND separately hand-editing
   a hardcoded pk_test_... string inside adventure-form.js, committing,
   and redeploying — miss that second step and Stripe rejects the
   mismatched test/live key pair outright, breaking checkout. Now both
   keys are env vars, one place, one change.
   ============================================ */

module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error('Missing STRIPE_PUBLISHABLE_KEY env var');
    res.status(200).json({ publishableKey: null, error: 'Payment is not configured yet.' });
    return;
  }

  // Publishable key, not secret — safe to cache at the edge/browser for a
  // few minutes. Vercel/browsers will respect this; worst case a key
  // rotation takes a few minutes to propagate, which is fine for a value
  // that's already public once it reaches the page.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
};
