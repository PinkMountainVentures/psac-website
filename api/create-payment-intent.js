/* ============================================
   PSAC — Stripe PaymentIntent creation endpoint
   Vercel serverless function. Calls Stripe's REST API directly with
   fetch (no stripe npm package) to keep this repo dependency-free,
   matching the rest of the site.

   Reads STRIPE_SECRET_KEY from environment variables — set it in the
   Vercel project's Environment Variables settings (and in a local
   .env.local for `vercel dev`). Never hardcode it here, never commit it.
   ============================================ */

// Standard tiers only. Custom Experience is bespoke-priced and never
// charged through this endpoint — that flow stays a personal follow-up.
var TIERS = {
  trail: { name: 'Trail Guide Experience', booking: 100, gear: 65 },
  p2p:   { name: 'Peaks to Pools Experience', booking: 195, gear: 100 }
};

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
      res.status(400).json({ error: 'Invalid experience tier for payment.' });
      return;
    }

    // Recompute the total server-side from the locked tier prices rather
    // than trusting a client-sent amount — the client only tells us the
    // tier and gear count, never the dollar figure to charge.
    var gearCount = Math.max(1, Math.min(20, parseInt(body.gearCount, 10) || 1));
    var totalDollars = tier.booking + tier.gear * gearCount;
    var amountCents = Math.round(totalDollars * 100);

    if (!amountCents || amountCents < 50) {
      res.status(400).json({ error: 'Invalid amount.' });
      return;
    }

    var email = String(body.email || '').slice(0, 200);
    var date = String(body.date || '').slice(0, 40);

    var params = new URLSearchParams();
    params.append('amount', String(amountCents));
    params.append('currency', 'usd');
    // Restricted to card-rail methods only (card entry, Apple Pay, Google
    // Pay) — all settle instantly, matching the immediate "Reserved"
    // confirmation this flow shows the guest. Deliberately excludes bank
    // debit/ACH (multi-day settlement, can still fail after the fact) and
    // Amazon Pay. Apple Pay/Google Pay ride on the 'card' type and appear
    // automatically in the Payment Element when the browser/device
    // supports them — no separate type needed.
    params.append('payment_method_types[]', 'card');
    if (email) params.append('receipt_email', email);
    params.append('description', tier.name + ' — Palm Springs Adventure Club');
    params.append('metadata[tier]', tierKey);
    params.append('metadata[gearCount]', String(gearCount));
    if (date) params.append('metadata[date]', date);

    var stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    var data = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error('Stripe error creating PaymentIntent:', data);
      var message = (data && data.error && data.error.message) || 'Payment setup failed.';
      res.status(502).json({ error: message });
      return;
    }

    res.status(200).json({
      clientSecret: data.client_secret,
      amount: totalDollars
    });
  } catch (err) {
    console.error('create-payment-intent error:', err);
    res.status(500).json({ error: 'Server error setting up payment.' });
  }
};
