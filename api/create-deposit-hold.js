/* ============================================
   PSAC — Refundable gear deposit hold endpoint
   Vercel serverless function. Runs immediately after the main booking
   PaymentIntent succeeds. Places a manual-capture authorization hold for
   the refundable gear deposit ($65/kit Trail Guide, $100/kit Peaks to
   Pools) on the same card the guest just used — no second card entry.

   Trusts nothing dollar-related from the client: re-derives the deposit
   amount from the locked per-tier gear price and gearCount, and re-derives
   the Stripe Customer + payment method by looking up the already-confirmed
   main PaymentIntent on Stripe's side, rather than accepting a client-sent
   customer/payment method id directly.

   This hold is released (canceled) or captured — in full or partially —
   later, once gear is checked back in. That resolution is a separate,
   staff-triggered step; this endpoint only ever places the hold.
   ============================================ */

// Deposit-per-kit deliberately matches the existing gear line-item price
// per tier (see TIERS.gear in create-payment-intent.js) — not a
// coincidence, a decision made explicitly for this feature.
var TIERS = {
  trail: { name: 'Trail Guide Experience', gear: 65 },
  p2p:   { name: 'Peaks to Pools Experience', gear: 100 }
};

function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Missing STRIPE_SECRET_KEY env var');
    res.status(500).json({ error: 'Payment is not configured yet.' });
    return;
  }

  try {
    var body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    var tierKey = String(body.tier || '');
    var tier = TIERS[tierKey];
    if (!tier) {
      // Custom Experience (and anything else) has no deposit hold — nothing
      // to do, not an error.
      res.status(200).json({ status: 'skipped', reason: 'No deposit hold for this tier.' });
      return;
    }

    var mainPaymentIntentId = String(body.mainPaymentIntentId || '');
    if (!mainPaymentIntentId) {
      res.status(400).json({ error: 'Missing mainPaymentIntentId.' });
      return;
    }

    var gearCount = Math.max(1, Math.min(20, parseInt(body.gearCount, 10) || 1));
    var depositAmountCents = Math.round(tier.gear * gearCount * 100);

    // Look up the main PaymentIntent on Stripe's side rather than trust a
    // client-sent customer/payment method id — this is the same "never
    // trust client-supplied money-adjacent values" posture already used
    // for the dollar amount in create-payment-intent.js.
    var mainRes = await fetch('https://api.stripe.com/v1/payment_intents/' + encodeURIComponent(mainPaymentIntentId), {
      headers: { 'Authorization': stripeAuthHeader() }
    });
    var mainData = await mainRes.json();
    if (!mainRes.ok) {
      console.error('Stripe error retrieving main PaymentIntent:', mainData);
      res.status(502).json({ error: 'Could not verify the original payment.' });
      return;
    }
    if (mainData.status !== 'succeeded' && mainData.status !== 'processing') {
      res.status(400).json({ error: 'Original payment has not completed.' });
      return;
    }

    var customerId = mainData.customer;
    var paymentMethodId = mainData.payment_method;
    if (!customerId || !paymentMethodId) {
      // No saved customer/payment method (e.g. Customer creation failed
      // silently earlier) — can't place a silent hold. Not a hard failure
      // of the booking itself, just means the deposit needs manual
      // follow-up. Caller decides how to surface this.
      res.status(200).json({ status: 'unavailable', reason: 'No saved payment method to hold a deposit against.' });
      return;
    }

    var params = new URLSearchParams();
    params.append('amount', String(depositAmountCents));
    params.append('currency', 'usd');
    params.append('customer', customerId);
    params.append('payment_method', paymentMethodId);
    params.append('payment_method_types[]', 'card');
    params.append('capture_method', 'manual');
    params.append('confirm', 'true');
    params.append('description', 'Refundable gear deposit — ' + tier.name + ' — Palm Springs Adventure Club');
    params.append('metadata[kind]', 'gear_deposit');
    params.append('metadata[tier]', tierKey);
    params.append('metadata[gearCount]', String(gearCount));
    params.append('metadata[mainPaymentIntentId]', mainPaymentIntentId);

    var depositRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': stripeAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    var depositData = await depositRes.json();

    if (!depositRes.ok) {
      console.error('Stripe error creating deposit PaymentIntent:', depositData);
      var message = (depositData && depositData.error && depositData.error.message) || 'Could not place the deposit hold.';
      res.status(200).json({ status: 'failed', error: message });
      return;
    }

    if (depositData.status === 'requires_action') {
      // Rare — the issuer wants an extra authentication step (e.g. 3DS)
      // before the hold can be placed. Hand the client secret back so the
      // browser can complete it silently in the background.
      res.status(200).json({
        status: 'requires_action',
        clientSecret: depositData.client_secret,
        paymentIntentId: depositData.id
      });
      return;
    }

    if (depositData.status === 'requires_capture') {
      // Success — the hold is placed, nothing captured yet.
      res.status(200).json({
        status: 'succeeded',
        paymentIntentId: depositData.id,
        amount: tier.gear * gearCount
      });
      return;
    }

    // Any other terminal status (e.g. the card was declined for the hold).
    res.status(200).json({ status: 'failed', error: 'Deposit hold could not be placed (status: ' + depositData.status + ').' });
  } catch (err) {
    console.error('create-deposit-hold error:', err);
    res.status(500).json({ error: 'Server error placing the deposit hold.' });
  }
};
