/* ============================================
   PSAC — Stripe PaymentIntent creation endpoint
   Vercel serverless function. Calls Stripe's REST API directly with
   fetch (no stripe npm package) to keep this repo dependency-free,
   matching the rest of the site.

   Reads STRIPE_SECRET_KEY from environment variables — set it in the
   Vercel project's Environment Variables settings (and in a local
   .env.local for `vercel dev`). Never hardcode it here, never commit it.
   ============================================ */

const { callBookingsWebApp } = require('../lib/apps-script-client');

// Standard tiers only. Custom Experience is bespoke-priced and never
// charged through this endpoint — that flow stays a personal follow-up.
// NOTE: booking fee here is the CURRENT CHARGED amount, not the anchor
// price shown struck through in the UI. The Early Guest discount lives
// entirely in adventure-form.js's display layer ($125 shown crossed out,
// $100 net) — this file only ever needs to know the real number to
// charge. In November 2026, when the discount ends, this becomes 125 to
// match adventure-form.js's own TIERS.trail.booking flip (see that
// file's comment at the discount block).
var TIERS = {
  trail: { name: 'Trail Guide Experience', booking: 100, gear: 65 },
  p2p:   { name: 'Peaks to Pools Experience', booking: 195, gear: 100 }
};

/* ============================================================================
   CA SALES TAX (Stripe Tax) — Option A from psac-tax-and-stripe-implementation.md
   ============================================================================
   Tax the full combined transaction (booking + gear) at whatever the real
   California/Riverside County rate is for the sourcing address below — no
   attempt to split the booking fee (service) from the gear fee (rental) by
   tax code. This is the deliberately conservative launch posture: over-
   collecting isn't a legal problem, under-collecting is. Revisit after a
   CPA opinion confirms whether the booking fee is actually non-taxable
   (Option B in that doc), which would need a second, gear-only calculation
   call instead of this single combined one.

   SOURCING ADDRESS: every kit is delivered to and used inside Palm Springs
   — that's true regardless of where the guest actually lives, and most
   guests are visiting from somewhere else entirely. So the correct address
   for Stripe Tax purposes is PSAC's own Palm Springs delivery area, not the
   guest's home/billing address. This also means no guest address is needed
   just to calculate tax at checkout — a real simplification, not a corner
   cut (confirmed against Stripe's own current docs, docs.stripe.com/tax/
   payment-intent/simplified, which pass a destination address exactly this
   way via address_source: 'shipping').

   PRE-FLIGHT REQUIREMENT — READ BEFORE DEPLOYING:
   Stripe Tax returns $0 tax with a normal HTTP 200 (no error at all) for any
   jurisdiction where this Stripe account has no active tax registration.
   California MUST be added as a registration under Settings > Tax in the
   Stripe Dashboard before this goes live, or every booking will look
   completely normal while silently collecting zero tax — the exact same
   "200 OK but wrong" failure class this project has hit before (the Apps
   Script doPost gap, the TRAIL_DATABASE_SHEED_ID typo). calculateTax()
   below logs loudly if this happens on a real charge so it doesn't go
   unnoticed the way those did.
   ============================================================================ */
var TAX_CODE_CATCH_ALL = 'txcd_99999999'; // Option A: tax everything, no service/rental split
var PSAC_TAX_SOURCE_ADDRESS = {
  city: 'Palm Springs',
  state: 'CA',
  postal_code: '92262',
  country: 'US'
};

function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

// Calls Stripe's Tax Calculation API on the pre-tax amount actually being
// charged (already discount-aware — this is whatever TIERS resolves to
// today, so it needs zero changes when the Early Guest discount ends in
// November). Returns the Calculation object on success, or null if the
// call itself fails (network error, bad request, etc.) — the caller falls
// back to a manual flat-rate calculation in that case rather than blocking
// checkout on a Tax API hiccup. Returning null is NOT the same as the
// silent $0-tax case described above (that returns a normal 200 with a
// real Calculation object, just one whose tax_amount_exclusive is 0) —
// this function logs that case explicitly so it's distinguishable in
// Vercel's logs from an ordinary API failure.
async function calculateTax(amountCents, reference) {
  try {
    var params = new URLSearchParams();
    params.append('currency', 'usd');
    params.append('line_items[0][amount]', String(amountCents));
    params.append('line_items[0][reference]', reference);
    params.append('line_items[0][tax_code]', TAX_CODE_CATCH_ALL);
    params.append('customer_details[address][city]', PSAC_TAX_SOURCE_ADDRESS.city);
    params.append('customer_details[address][state]', PSAC_TAX_SOURCE_ADDRESS.state);
    params.append('customer_details[address][postal_code]', PSAC_TAX_SOURCE_ADDRESS.postal_code);
    params.append('customer_details[address][country]', PSAC_TAX_SOURCE_ADDRESS.country);
    params.append('customer_details[address_source]', 'shipping');

    var taxRes = await fetch('https://api.stripe.com/v1/tax/calculations', {
      method: 'POST',
      headers: { 'Authorization': stripeAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    var taxData = await taxRes.json();

    if (!taxRes.ok) {
      console.error('Stripe Tax calculation error:', taxData);
      return null;
    }

    if (amountCents > 0 && (!taxData.tax_amount_exclusive || taxData.tax_amount_exclusive === 0)) {
      console.error(
        'Stripe Tax returned $0 tax on a non-zero charge — this almost always means ' +
        'California is not yet registered under Settings > Tax in the Stripe Dashboard. ' +
        'Verify before assuming this booking is genuinely tax-exempt.',
        { calculationId: taxData.id, amountCents: amountCents }
      );
    }

    return taxData;
  } catch (err) {
    console.error('calculateTax error:', err);
    return null;
  }
}

// Finds an existing Stripe Customer by exact email match, or creates one.
// This is what lets the deposit-hold PaymentIntent (created separately,
// right after this one succeeds) reuse the same card without asking the
// guest to enter it twice, and keeps a stable 1:1 mapping between a real
// person and a Stripe Customer across repeat bookings rather than minting
// a fresh Customer every time. Returns null (never throws) on any failure
// so a Customer/Stripe hiccup never blocks the actual booking charge.
async function findOrCreateCustomer(email, name) {
  if (!email) return null;
  try {
    var listRes = await fetch('https://api.stripe.com/v1/customers?email=' + encodeURIComponent(email) + '&limit=1', {
      headers: { 'Authorization': stripeAuthHeader() }
    });
    var listData = await listRes.json();
    if (listRes.ok && listData.data && listData.data.length) {
      return listData.data[0].id;
    }

    var createParams = new URLSearchParams();
    createParams.append('email', email);
    if (name) createParams.append('name', name);
    var createRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: { 'Authorization': stripeAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: createParams.toString()
    });
    var createData = await createRes.json();
    if (!createRes.ok) {
      console.error('Stripe error creating Customer:', createData);
      return null;
    }
    return createData.id;
  } catch (err) {
    console.error('findOrCreateCustomer error:', err);
    return null;
  }
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

    // Tax the pre-tax amount actually being charged today (see the block
    // comment above TIERS/PSAC_TAX_SOURCE_ADDRESS for the full reasoning).
    var taxCalc = await calculateTax(amountCents, 'psac-booking-' + tierKey);
    var finalAmountCents = amountCents;
    var taxAmountCents = 0;
    var taxFallbackApplied = false;
    if (taxCalc) {
      finalAmountCents = taxCalc.amount_total;
      taxAmountCents = taxCalc.tax_amount_exclusive || 0;
    } else {
      // The Tax API call itself failed (not the silent-$0-registration
      // case above, which still returns a normal 200 — this is a genuine
      // network/API error). Don't block a guest's checkout on a Stripe Tax
      // outage: fall back to the documented flat Palm Springs rate so the
      // charge is still correct, but flag it clearly since this booking
      // won't get an automatic Stripe Tax transaction record and needs to
      // be included by hand in quarterly CDTFA reconciliation.
      taxAmountCents = Math.round(amountCents * 0.0925);
      finalAmountCents = amountCents + taxAmountCents;
      taxFallbackApplied = true;
      console.error(
        'Tax calculation API call failed — applied manual 9.25% fallback (Palm Springs\'s actual combined ' +
        'rate, confirmed against palmspringsca.gov — NOT the 8.75% this project assumed until Aug 2026, ' +
        'which expired in 2018 when Measure D took effect). ' +
        'Flag this booking for manual CDTFA reconciliation (no Stripe Tax transaction record exists for it).',
        { tier: tierKey, amountCents: amountCents, fallbackTaxAmountCents: taxAmountCents }
      );
    }

    var email = String(body.email || '').slice(0, 200);
    var name = String(body.name || '').slice(0, 200);
    var date = String(body.date || '').slice(0, 40);

    // BUG FIX (payment-review, Aug 2026, Critical #1): this call previously
    // had no Idempotency-Key at all - a retried/duplicated request for the
    // same checkout attempt (flaky network, browser back/forward, anything
    // beyond the plain double-click adventure-form.js's own button-disable
    // guard covers) could create two independent PaymentIntents for one
    // guest. Prefer the client-generated, per-attempt checkoutAttemptId
    // (adventure-form.js) so the key is stable across true retries of the
    // exact same attempt; if an older cached front-end bundle hasn't picked
    // that field up yet, fall back to a deterministic key built from the
    // request's own defining fields binned into a 2-minute window - not as
    // strong (a guest who genuinely resubmits after 2+ minutes gets a fresh
    // PaymentIntent either way), but real, immediate protection against the
    // common rapid-retry case without waiting on a full front-end rollout.
    var checkoutAttemptId = String(body.checkoutAttemptId || '').slice(0, 100);
    var idempotencyKey;
    if (checkoutAttemptId) {
      idempotencyKey = 'checkout_' + checkoutAttemptId;
    } else {
      var fallbackWindow = Math.floor(Date.now() / (2 * 60 * 1000));
      idempotencyKey = 'checkout_fallback_' + tierKey + '_' + gearCount + '_' + email + '_' + fallbackWindow;
    }

    // Find-or-create the Stripe Customer up front so we can attach it to
    // this PaymentIntent and save the payment method on confirmation — the
    // deposit-hold PaymentIntent (created right after this one succeeds)
    // reuses that same saved card via the Customer, so the guest never
    // enters their card twice for one booking.
    var customerId = await findOrCreateCustomer(email, name);

    var params = new URLSearchParams();
    params.append('amount', String(finalAmountCents));
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
    if (customerId) {
      params.append('customer', customerId);
      // off_session: the saved card gets reused later, off-session, at T-1
      // (the day before gear delivery) to place the refundable deposit
      // hold, not moments later in this same visit. off_session tells
      // Stripe to request the right authentication upfront so that later,
      // truly unattended charge behaves correctly.
      params.append('setup_future_usage', 'off_session');
    }
    if (taxCalc) {
      // Links this PaymentIntent to the Tax Calculation above so Stripe
      // automatically records the tax transaction on success and handles
      // reversals on refund — see docs.stripe.com/tax/payment-intent/simplified.
      // Only set when the real Stripe Tax call succeeded; the manual-
      // fallback path above has no calculation to link, hence taxFallbackApplied.
      params.append('hooks[inputs][tax][calculation]', taxCalc.id);
    }
    if (taxFallbackApplied) {
      params.append('metadata[tax_fallback]', 'true');
    }

    var stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': stripeAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey
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

    // BUG FIX (payment-review, Aug 2026, Medium #25): the tax-fallback path
    // above only ever reached console.error — nothing surfaced it to a
    // human, so a Stripe Tax outage (no automatic Tax Transaction record,
    // needs manual CDTFA reconciliation per the comment above) could pass
    // silently for every affected booking. Raised here, after the
    // PaymentIntent exists, so the alert has a real Stripe id to point at —
    // no bookingId exists yet at this point in the flow (the Sheet row is
    // created later by save-booking.js), so the PaymentIntent id is the
    // identifier staff reconcile against. Best-effort: never blocks or
    // fails the guest's checkout if the alert write itself has a problem.
    if (taxFallbackApplied) {
      try {
        await callBookingsWebApp('opsAlerts_recordAlert', {
          bookingId: '',
          alertType: 'tax_fallback_applied',
          amount: taxAmountCents / 100,
          stripeErrorDetail: 'Stripe Tax Calculation API call failed for PaymentIntent ' + data.id +
            ' (tier ' + tierKey + '); applied the manual 9.25% fallback rate instead. No automatic Stripe ' +
            'Tax Transaction record exists for this booking — include it by hand in quarterly CDTFA reconciliation.',
          urgency: 'standard_24hr',
          notes: 'paymentIntentId=' + data.id + ', tier=' + tierKey + ', gearCount=' + gearCount +
            ', fallbackTaxAmountCents=' + taxAmountCents,
        }, { retries: 2 });
      } catch (alertErr) {
        console.error('create-payment-intent: also failed to write the tax_fallback_applied Ops Alert', alertErr);
      }
    }

    res.status(200).json({
      clientSecret: data.client_secret,
      // Authoritative, tax-inclusive dollar figure — this is what the card
      // actually gets charged. subtotal/taxAmount are broken out so the
      // front-end can show a clear line-item breakdown instead of just a
      // bigger number appearing after the fact.
      amount: finalAmountCents / 100,
      subtotal: totalDollars,
      taxAmount: taxAmountCents / 100,
      customerId: customerId || null
    });
  } catch (err) {
    console.error('create-payment-intent error:', err);
    res.status(500).json({ error: 'Server error setting up payment.' });
  }
};
