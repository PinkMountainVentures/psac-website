/* ============================================
   PSAC — Refundable gear deposit hold endpoint
   Vercel serverless function. Shared endpoint called by the Internal
   Operations UX at T-1 (the morning before gear delivery), not by
   adventure-form.js at booking time. Stripe authorization holds expire in
   roughly 5-7 days and a booking can happen weeks before the trip, so the
   hold itself has to wait until it's actually close to being needed.

   Request shape: { bookingId, secret }. No amount, tier, or kit count is
   ever accepted from the caller — this endpoint looks all of that up
   itself from the Bookings & Operations sheet (via the same Apps Script
   Web App save-booking.js already talks to), the same "never trust a
   caller-supplied money-adjacent value" posture used in
   create-payment-intent.js.

   Auth: a shared secret in the request body, same pattern as
   BOOKINGS_WEBAPP_SECRET's check inside bookings-code.gs's doPost(), just
   a separate secret (DEPOSIT_HOLD_SHARED_SECRET) since this is a distinct
   caller (the Operations UX, not this site's own /api/save-booking).

   Places a manual-capture authorization hold for the refundable gear
   deposit ($65/kit Trail Guide, $100/kit Peaks to Pools) on the card saved
   against the booking's main PaymentIntent, no second card entry. Once
   placed, writes the result back to the booking's row in the Bookings
   sheet so both the sheet and the Operations UX know the outcome.

   This hold is released (canceled) or captured — in full or partially —
   later, once gear is checked back in. That resolution is a separate,
   staff-triggered step; this endpoint only ever places the hold.
   ============================================ */

// Deposit-per-kit deliberately matches the existing gear line-item price
// per tier (see TIERS.gear in create-payment-intent.js) — not a
// coincidence, a decision made explicitly for this feature.
var { callBookingsWebApp } = require('../lib/apps-script-client');

var TIERS = {
  trail: { name: 'Trail Guide Experience', gear: 65 },
  p2p:   { name: 'Peaks to Pools Experience', gear: 100 }
};

function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

// Looks up a booking's tier, gear kit count, and main PaymentIntent id from
// the Bookings & Operations sheet via the same Apps Script Web App
// api/save-booking.js already calls. Returns null on any failure so the
// caller gets a clean error rather than a half-parsed result.
async function getBookingRecord(bookingId) {
  var res = await fetch(process.env.BOOKINGS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'getBooking',
      bookingId: bookingId,
      secret: process.env.BOOKINGS_WEBAPP_SECRET
    })
  });
  var text = await res.text();
  var data;
  try { data = JSON.parse(text); } catch (e) { return null; }
  if (!res.ok || !data || data.ok === false) return null;
  return data;
}

// Writes the hold outcome back to the booking's row so the Bookings sheet
// (and anyone reading it, including the Operations UX) reflects the actual
// result instead of staying on the "scheduled_t1" placeholder written at
// booking time. Best-effort: a failure here never unwinds the hold that
// was already placed on Stripe's side, just gets logged for a manual look.
async function updateBookingDepositStatus(bookingId, depositPaymentIntentId, depositStatus) {
  try {
    var data = await callBookingsWebApp('updateDepositStatus', {
      bookingId: bookingId,
      depositPaymentIntentId: depositPaymentIntentId || '',
      depositStatus: depositStatus
    }, { retries: 2 });
    if (data.ok === false) {
      console.error('Failed to write back deposit status for', bookingId, data);
    }
  } catch (err) {
    console.error('updateBookingDepositStatus error:', err);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.BOOKINGS_WEBAPP_URL || !process.env.BOOKINGS_WEBAPP_SECRET || !process.env.DEPOSIT_HOLD_SHARED_SECRET) {
    console.error('Missing one or more required env vars for create-deposit-hold (STRIPE_SECRET_KEY, BOOKINGS_WEBAPP_URL, BOOKINGS_WEBAPP_SECRET, DEPOSIT_HOLD_SHARED_SECRET)');
    res.status(500).json({ error: 'Deposit hold endpoint is not configured yet.' });
    return;
  }

  try {
    var body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    if (body.secret !== process.env.DEPOSIT_HOLD_SHARED_SECRET) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    var bookingId = String(body.bookingId || '').trim();
    if (!bookingId) {
      res.status(400).json({ error: 'Missing bookingId.' });
      return;
    }

    // 'renewal' is passed only by api/renew-deposit-hold.js's in-process
    // call - every other caller (the T-1 cron, a manual staff re-trigger)
    // is an 'initial' placement. Distinguishing the two is what lets the
    // idempotency guard below, and the Stripe Idempotency-Key further
    // down, treat "retry of the same placement" and "deliberate new hold"
    // safely differently.
    var purpose = body.purpose === 'renewal' ? 'renewal' : 'initial';

    var booking = await getBookingRecord(bookingId);
    if (!booking) {
      res.status(404).json({ error: 'Booking not found.' });
      return;
    }

    var tierKey = String(booking.tier || '');
    var tier = TIERS[tierKey];
    if (!tier) {
      // Custom Experience (and anything else) has no deposit hold — nothing
      // to do, not an error.
      // BUG FIX (independent bug pass, Aug 2026): this used to return
      // without ever calling updateBookingDepositStatus, so the Sheet's
      // depositStatus stayed at its booking-time default ('scheduled_t1')
      // forever for every Custom-tier booking. api/check-hold-clearance-
      // deadline.js's noon check only special-cases the literal string
      // 'skipped', not 'scheduled_t1' — so every Custom Experience booking
      // fell through to that check's cancel-and-refund branch the day
      // before the trip, despite never having had a deposit hold to begin
      // with. Writing 'skipped' here is what that downstream check was
      // always assuming would happen.
      await updateBookingDepositStatus(bookingId, null, 'skipped');
      res.status(200).json({ status: 'skipped', reason: 'No deposit hold for this tier.' });
      return;
    }

    var gearCount = Math.max(1, Math.min(20, parseInt(booking.gearKitCount, 10) || 1));
    var depositAmountCents = Math.round(tier.gear * gearCount * 100);

    // IDEMPOTENCY GUARD (added 2026-08-24, see psac-build-checklist.md's
    // Apps Script incident writeup): a plain retry of an INITIAL placement
    // whose Stripe call already succeeded (staff re-triggering it because
    // the write-back silently failed, or a stale retry) must never place a
    // second hold on top of a live one. A genuine renewal
    // (purpose === 'renewal', the only caller being
    // api/renew-deposit-hold.js) is explicitly exempt - it means to
    // replace the existing hold with a fresh one. This is a fast-path
    // optimization, not the only safety net: the Idempotency-Key on the
    // actual Stripe call below is what protects the case where the
    // Sheet's own depositStatus never made it past 'scheduled_t1' because
    // the write-back itself failed.
    if (purpose !== 'renewal' && booking.depositStatus === 'held') {
      res.status(200).json({
        status: 'succeeded',
        paymentIntentId: booking.depositPaymentIntentId || null,
        amount: tier.gear * gearCount,
        alreadyHeld: true
      });
      return;
    }

    var mainPaymentIntentId = String(booking.mainPaymentIntentId || '');
    if (!mainPaymentIntentId) {
      res.status(400).json({ error: 'Booking has no main PaymentIntent on file.' });
      return;
    }

    // Look up the main PaymentIntent on Stripe's side rather than trust a
    // stored customer/payment method id directly — same "never trust a
    // stale or client-adjacent value" posture used for the dollar amount
    // above.
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

    // BUG FIX (independent bug pass, Aug 2026): prefer the Stripe Customer's
    // CURRENT default payment method over the one frozen on the original
    // main PaymentIntent. Without this, a guest who fixes a failed hold via
    // the "update payment method" page (api/save-updated-payment-method.js,
    // which sets invoice_settings.default_payment_method on the Customer)
    // had that fix silently ignored: a retry of this endpoint kept charging
    // the same, already-declined card off mainData.payment_method, and the
    // booking got auto-cancelled at noon anyway despite the guest doing
    // everything asked. Falls back to the original PaymentIntent's payment
    // method if the Customer has no default set yet (the normal
    // first-attempt case, where nobody's had to update anything) or if this
    // lookup itself fails — never hard-fails the hold attempt over it.
    if (customerId) {
      try {
        var customerRes = await fetch('https://api.stripe.com/v1/customers/' + encodeURIComponent(customerId), {
          headers: { 'Authorization': stripeAuthHeader() }
        });
        var customerData = await customerRes.json();
        if (customerRes.ok && customerData && customerData.invoice_settings && customerData.invoice_settings.default_payment_method) {
          paymentMethodId = customerData.invoice_settings.default_payment_method;
        }
      } catch (custErr) {
        console.error('create-deposit-hold: Customer default-payment-method lookup failed, falling back to the main PaymentIntent\'s payment method', custErr);
      }
    }

    if (!customerId || !paymentMethodId) {
      // No saved customer/payment method (e.g. Customer creation failed
      // silently earlier) — can't place a silent hold. Not a hard failure,
      // just means the deposit needs manual follow-up.
      await updateBookingDepositStatus(bookingId, null, 'unavailable');
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
    // off_session: this fires at T-1, unattended, days after the guest's
    // browser session ended, using the payment method saved via
    // setup_future_usage: 'off_session' on the main PaymentIntent.
    params.append('off_session', 'true');
    params.append('confirm', 'true');
    params.append('description', 'Refundable gear deposit — ' + tier.name + ' — Palm Springs Adventure Club');
    params.append('metadata[kind]', 'gear_deposit');
    params.append('metadata[bookingId]', bookingId);
    params.append('metadata[tier]', tierKey);
    params.append('metadata[gearCount]', String(gearCount));
    params.append('metadata[mainPaymentIntentId]', mainPaymentIntentId);

    // Idempotency-Key (added 2026-08-24): stable across a raw retry of
    // the SAME logical placement, so a retry after a write-back failure
    // (the Sheet's depositStatus never left 'scheduled_t1', so the guard
    // above couldn't catch it) still can't create a second live hold -
    // Stripe itself returns the original PaymentIntent instead of
    // creating a new one. Keyed differently for a renewal (which
    // deliberately places a real second hold) vs. an initial placement,
    // and for a renewal specifically includes the old PaymentIntent id
    // being replaced, so a later, separate renewal of the SAME booking
    // still gets its own key.
    var idempotencyKey = purpose === 'renewal'
      ? 'deposit_hold_renewal_' + bookingId + '_' + (booking.depositPaymentIntentId || 'none')
      : 'deposit_hold_initial_' + bookingId;

    var depositRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': stripeAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey
      },
      body: params.toString()
    });
    var depositData = await depositRes.json();

    if (!depositRes.ok) {
      console.error('Stripe error creating deposit PaymentIntent:', depositData);
      var message = (depositData && depositData.error && depositData.error.message) || 'Could not place the deposit hold.';
      await updateBookingDepositStatus(bookingId, null, 'failed');
      res.status(200).json({ status: 'failed', error: message });
      return;
    }

    if (depositData.status === 'requires_action') {
      // The card requires an extra authentication step before the hold can
      // be placed. Off-session confirmations that hit this can't be
      // completed silently server-side; record it as needing manual
      // follow-up rather than leaving it ambiguous.
      await updateBookingDepositStatus(bookingId, depositData.id, 'requires_action');
      res.status(200).json({
        status: 'requires_action',
        paymentIntentId: depositData.id
      });
      return;
    }

    if (depositData.status === 'requires_capture') {
      // Success — the hold is placed, nothing captured yet.
      await updateBookingDepositStatus(bookingId, depositData.id, 'held');
      res.status(200).json({
        status: 'succeeded',
        paymentIntentId: depositData.id,
        amount: tier.gear * gearCount
      });
      return;
    }

    // Any other terminal status (e.g. the card was declined for the hold).
    await updateBookingDepositStatus(bookingId, depositData.id || null, 'failed');
    res.status(200).json({ status: 'failed', error: 'Deposit hold could not be placed (status: ' + depositData.status + ').' });
  } catch (err) {
    console.error('create-deposit-hold error:', err);
    res.status(500).json({ error: 'Server error placing the deposit hold.' });
  }
};
