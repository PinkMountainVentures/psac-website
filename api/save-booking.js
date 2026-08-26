/* ============================================
   PSAC — Save booking to the Bookings & Operations sheet
   Vercel serverless function. Thin proxy in front of the Google Apps
   Script Web App bound to the "PSAC Bookings & Operations" sheet — keeps
   the Apps Script URL and shared secret server-side only, never exposed
   to the browser.

   The Apps Script side owns the actual logic: finding-or-creating the
   Person row by email, appending the Experience Booking row, and
   generating the Gear Check Log item rows.

   Never blocks a guest on this: the payment already succeeded by the time
   this is called, so a persistence hiccup here should be logged and
   surfaced softly, not turned into a dead end for someone who already
   paid. Same posture for the confirmation email and text sent below.
   ============================================ */

var { sendBookingConfirmationEmail } = require('../lib/send-booking-confirmation');
var { sendBookingConfirmationSms } = require('../lib/send-booking-confirmation-sms');
var { callBookingsWebApp } = require('../lib/apps-script-client');

// Same constant/pattern as api/adventure-prep.js's own SITE_URL (kept
// local rather than shared, matching this repo's existing convention of
// each api/*.js file declaring what it needs rather than importing a
// shared constants module).
var SITE_URL = 'https://www.palmspringsadventureclub.com';

// BUG FIX (payment-review, Aug 2026, Critical #2): this file used to
// forward the browser-supplied body straight through to
// handleSaveBooking() with zero verification — tier, total,
// gearKitsSelected, and paymentIntentId were all trusted verbatim.
// verifyChargeAgainstStripe() below fetches the actual PaymentIntent
// api/create-payment-intent.js created (whose amount and metadata.tier/
// metadata.gearCount are themselves server-computed there, never
// client-supplied) and uses IT as the source of truth for every
// money-relevant field this file writes, rather than merely checking the
// client's copy and still trusting it. Custom Experience is exempt —
// per api/create-payment-intent.js's own header, Custom never charges
// through that endpoint at all (personal follow-up quote), so there is no
// PaymentIntent to verify against; every other Custom-tier carve-out in
// this codebase (e.g. adventure-form.js's paymentStatus default) makes
// the same exception.
function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

async function fetchPaymentIntent(paymentIntentId) {
  var res = await fetch('https://api.stripe.com/v1/payment_intents/' + encodeURIComponent(paymentIntentId), {
    headers: { Authorization: stripeAuthHeader() }
  });
  var data = await res.json();
  return { ok: res.ok, data: data };
}

async function recordVerificationAlert(alertType, notes) {
  try {
    await callBookingsWebApp('opsAlerts_recordAlert', {
      bookingId: '',
      alertType: alertType,
      urgency: 'urgent_same_day',
      notes: notes
    }, { retries: 2 });
  } catch (alertErr) {
    console.error('save-booking: failed to write a ' + alertType + ' Ops Alert', alertErr);
  }
}

// Returns { ok: true } and mutates body's money-relevant fields in place
// to the Stripe-verified values, or { ok: false, message } if the booking
// should NOT be written (either the charge doesn't check out, or it
// couldn't be verified at all). Skips entirely for tier === 'custom'.
async function verifyChargeAgainstStripe(body) {
  if (body.tier === 'custom') return { ok: true };

  var paymentIntentId = String(body.paymentIntentId || '');
  if (!paymentIntentId) {
    console.error('save-booking: rejected — non-custom tier with no paymentIntentId', body.tier, body.email);
    return { ok: false, message: 'Missing payment confirmation for this booking.' };
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('save-booking: cannot verify charge, STRIPE_SECRET_KEY is not configured');
    await recordVerificationAlert(
      'save_booking_charge_verification_unreachable',
      'A booking save for PaymentIntent ' + paymentIntentId + ' (' + (body.email || 'no email') + ') could not be verified — STRIPE_SECRET_KEY is not set on this deployment. Booking was NOT written to the Sheet.'
    );
    return { ok: false, message: 'Could not verify payment. Please contact us to complete your booking.' };
  }

  var piRes;
  try {
    piRes = await fetchPaymentIntent(paymentIntentId);
  } catch (fetchErr) {
    piRes = { ok: false, data: null };
  }
  // One retry — a genuine Stripe read hiccup moments after the guest's own
  // browser just successfully confirmed this exact PaymentIntent is rare
  // enough to be worth one retry before treating it as a real problem.
  if (!piRes.ok) {
    try {
      piRes = await fetchPaymentIntent(paymentIntentId);
    } catch (fetchErr2) {
      piRes = { ok: false, data: null };
    }
  }

  if (!piRes.ok || !piRes.data) {
    console.error('save-booking: could not retrieve PaymentIntent to verify charge', paymentIntentId, piRes.data);
    await recordVerificationAlert(
      'save_booking_charge_verification_unreachable',
      'A booking save for PaymentIntent ' + paymentIntentId + ' (' + (body.email || 'no email') + ') could not be verified against Stripe — the read call failed twice. Booking was NOT written to the Sheet. If this guest genuinely paid, find the PaymentIntent in the Stripe Dashboard and create the booking manually.'
    );
    return { ok: false, message: 'Could not verify payment. Please contact us to complete your booking.' };
  }

  var pi = piRes.data;
  var piTier = pi.metadata && pi.metadata.tier;
  var piGearCount = pi.metadata && pi.metadata.gearCount;
  // adventure-form.js's own confirmPayment handler treats BOTH 'succeeded'
  // and 'processing' as good enough to call submitForm() — match that
  // here rather than requiring only 'succeeded', or a perfectly legitimate
  // booking would get rejected.
  var statusOk = pi.status === 'succeeded' || pi.status === 'processing';
  var tierMatches = piTier === body.tier;

  if (!statusOk || !tierMatches) {
    console.error('save-booking: PaymentIntent failed verification', paymentIntentId, { status: pi.status, piTier: piTier, bodyTier: body.tier });
    await recordVerificationAlert(
      'save_booking_charge_verification_failed',
      'A booking save for PaymentIntent ' + paymentIntentId + ' (' + (body.email || 'no email') + ') failed verification — Stripe status: ' + pi.status + ', PaymentIntent tier: ' + piTier + ', claimed tier: ' + body.tier + '. Booking was NOT written to the Sheet. Check whether this is a real guest hitting an edge case or a fabricated request.'
    );
    return { ok: false, message: 'Could not verify payment for this booking.' };
  }

  // Stripe is the source of truth from here on — overwrite whatever the
  // client sent for the money-relevant fields with what the PaymentIntent
  // itself actually says, rather than merely checking and still trusting
  // the client's copy. (Also closes the paired unverified Medium finding,
  // handleSaveBooking()'s payload.total || 0 — that line is now fed an
  // already-verified figure, not the raw client value.)
  body.total = pi.amount / 100;
  body.paymentStatus = pi.status;
  if (piGearCount != null && piGearCount !== '') {
    var verifiedGearCount = parseInt(piGearCount, 10);
    if (Number.isFinite(verifiedGearCount)) {
      body.gearKitsSelected = verifiedGearCount;
      // Keep the shared-duffel packaging count consistent with whatever
      // gear count actually shipped this Sheet row, same Math.ceil(n/2)
      // rule adventure-form.js's own buildPayload() uses.
      body.duffelCount = Math.ceil(Math.max(verifiedGearCount, 1) / 2);
    }
  }
  return { ok: true };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.BOOKINGS_WEBAPP_URL || !process.env.BOOKINGS_WEBAPP_SECRET) {
    console.error('Missing BOOKINGS_WEBAPP_URL or BOOKINGS_WEBAPP_SECRET env var');
    // Soft failure — booking payment already succeeded, so we don't want
    // to block the guest on this. Caller shows the closing screen either
    // way and this just gets logged for manual follow-up.
    res.status(200).json({ ok: false, error: 'Booking record keeping is not configured yet.' });
    return;
  }

  try {
    var body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    var verification = await verifyChargeAgainstStripe(body);
    if (!verification.ok) {
      res.status(200).json({ ok: false, error: verification.message });
      return;
    }

    // BUG FIX (payment-review, Aug 2026, High #9, dedup half): handleSaveBooking()
    // itself has no dedup — every call appends a brand-new booking row. The
    // 2026-08-24 Apps Script incident already added a safe, read-only lookup
    // (getBookingByPaymentIntentId) for POST-failure recovery; reused here as
    // a PRE-check, this closes the dedup gap for every retry shape (a thrown
    // network error, a non-OK application response, or a client-side double-
    // submit), not just the narrow post-failure case recovery alone covered.
    // Custom tier has no paymentIntentId (never charges through Stripe at
    // booking time), so there's nothing to dedup against — falls straight
    // through to a normal save, same as always.
    var existingPaymentIntentId = String(body.paymentIntentId || '');
    var data = null;
    if (existingPaymentIntentId) {
      try {
        var preExisting = await callBookingsWebApp('getBookingByPaymentIntentId', {
          paymentIntentId: existingPaymentIntentId
        }, { retries: 2 });
        if (preExisting && preExisting.ok) {
          console.error('save-booking: found an existing booking for this PaymentIntent before saving — treating as a retry, not creating a duplicate', preExisting.bookingId);
          data = preExisting;
        }
      } catch (dedupErr) {
        // A failed dedup check should never block a genuinely new booking —
        // fall through to the normal save path below, same "don't block a
        // guest who already paid" posture as the rest of this file.
        console.error('save-booking: dedup pre-check threw, proceeding with a normal save', dedupErr);
      }
    }

    if (!data) {
      var payload = Object.assign({}, body, {
        action: 'saveBooking',
        secret: process.env.BOOKINGS_WEBAPP_SECRET
      });

      var sheetRes = null;
      var text = '';
      var fetchThrew = null;
      try {
        sheetRes = await fetch(process.env.BOOKINGS_WEBAPP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        text = await sheetRes.text();
        try { data = JSON.parse(text); } catch (e) { data = { ok: false, error: 'Unexpected response from booking sheet.', raw: text.slice(0, 300) }; }
      } catch (fetchErr) {
        // BUG FIX (payment-review, Aug 2026, High #9, network-error half):
        // this used to only attempt recovery inside the `!sheetRes.ok`
        // branch below — a thrown network-level error (DNS, connection
        // reset, timeout) skipped straight past it to this handler's outer
        // catch, which never tried the recovery lookup at all. Now it's
        // funneled into the exact same recovery path as a non-OK response.
        fetchThrew = fetchErr;
        data = { ok: false, error: 'Network error saving booking record.' };
        console.error('save-booking: the saveBooking fetch itself threw', fetchErr);
      }

      if (!sheetRes || !sheetRes.ok || data.ok === false) {
        console.error('Apps Script save-booking error:', data);

        // RECOVERY (added 2026-08-24, see psac-build-checklist.md's Apps
        // Script incident writeup): this failure can be the confirmed-
        // transient "Web App served a Google interstitial page instead of
        // JSON" glitch - the booking row, gear log rows, and
        // adventurePrepToken may already have been written correctly even
        // though this response is garbage. saveBooking itself is never
        // retried here (not idempotent, a retry would create a second
        // booking) - instead, a safe, read-only lookup by the one value
        // already known before the failed call (the main PaymentIntent id)
        // checks whether the row actually landed.
        var recovered = null;
        if (existingPaymentIntentId) {
          try {
            recovered = await callBookingsWebApp('getBookingByPaymentIntentId', {
              paymentIntentId: existingPaymentIntentId
            }, { retries: 2 });
          } catch (recoverErr) {
            console.error('save-booking recovery lookup threw:', recoverErr);
          }
        }

        if (recovered && recovered.ok) {
          console.error('save-booking: recovered booking record after a garbled saveBooking response', recovered.bookingId);
          data = recovered;
        } else {
          // BUG FIX (payment-review, Aug 2026, High #10): this used to be
          // console.error only — no Ops Alert, no guest or staff email, so
          // an already-charged guest could end up with no booking record
          // and nobody notified. Best-effort, never blocks the response.
          try {
            await callBookingsWebApp('opsAlerts_recordAlert', {
              bookingId: '',
              alertType: 'save_booking_failed_unrecovered',
              stripeErrorDetail: (fetchThrew && fetchThrew.message) || data.error || 'unknown',
              urgency: 'urgent_same_day',
              notes: 'A booking save failed and the recovery lookup could not find a record either, for PaymentIntent ' + (existingPaymentIntentId || '(none/custom)') + ' (' + (body.email || 'no email') + '). The guest has likely already been charged with no booking record on file. Needs manual follow-up.',
            }, { retries: 2 });
          } catch (alertErr) {
            console.error('save-booking: also failed to write the save_booking_failed_unrecovered Ops Alert', alertErr);
          }
          res.status(200).json({ ok: false, error: data.error || 'Could not save booking record.' });
          return;
        }
      }
    }

    // NEW (Aug 2026): bookings-code.gs's handleSaveBooking() now mints an
    // adventurePrepToken inline and returns it here — build the guest-
    // facing URL once and hand it to the email/SMS senders below and back
    // to the client. data.adventurePrepToken can legitimately be blank
    // (adventurePrep_ensureToken is soft-failed on the Apps Script side,
    // never blocking the booking save itself), so this degrades to `null`
    // rather than shipping a broken link.
    var adventurePrepUrl = data.adventurePrepToken
      ? SITE_URL + '/complete-adventure-prep?token=' + encodeURIComponent(data.adventurePrepToken)
      : null;

    // Booking confirmation email (see lib/send-booking-confirmation.js).
    // Never blocks or fails this response — the booking and payment have
    // already succeeded by this point, same reasoning as the sheet-save
    // error handling above. A send failure just gets logged.
    try {
      var emailResult = await sendBookingConfirmationEmail(Object.assign({}, body, { bookingId: data.bookingId, adventurePrepUrl: adventurePrepUrl }));
      if (emailResult.status !== 'sent') {
        console.error('Booking confirmation email not sent:', data.bookingId, emailResult);
      }
    } catch (emailErr) {
      console.error('Booking confirmation email threw:', emailErr);
    }

    // Booking confirmation text (see lib/send-booking-confirmation-sms.js).
    // Independent of the email above and equally non-blocking. Skips
    // itself if the guest didn't opt into texts at Step 8, that check
    // lives inside sendBookingConfirmationSms so this call site doesn't
    // need to duplicate the consent logic.
    try {
      var smsResult = await sendBookingConfirmationSms(Object.assign({}, body, { bookingId: data.bookingId, adventurePrepUrl: adventurePrepUrl }));
      if (smsResult.status !== 'sent' && smsResult.status !== 'skipped') {
        console.error('Booking confirmation SMS not sent:', data.bookingId, smsResult);
      }
    } catch (smsErr) {
      console.error('Booking confirmation SMS threw:', smsErr);
    }

    res.status(200).json({
      ok: true,
      personId: data.personId || null,
      bookingId: data.bookingId || null,
      gearLogRowsCreated: data.gearLogRowsCreated || 0,
      adventurePrepUrl: adventurePrepUrl
    });
  } catch (err) {
    console.error('save-booking error:', err);
    res.status(200).json({ ok: false, error: 'Server error saving booking record.' });
  }
};
