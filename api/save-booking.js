/* ============================================
   PSAC — Save booking to Postgres
   Vercel serverless function. Used to be a thin proxy in front of the
   Google Apps Script Web App bound to the "PSAC Bookings & Operations"
   sheet; now calls lib/booking-service.js directly, which talks to Neon
   Postgres via lib/db.js (PRD Section 8/9's chokepoint).

   verifyChargeAgainstStripe() below is UNCHANGED by this migration — it
   was already calling Stripe directly, never Apps Script, so nothing
   about the Postgres switch touches it.

   The dedup pre-check + post-failure recovery-lookup dance this file used
   to do around callBookingsWebApp('saveBooking', ...) is GONE, not just
   moved: it existed only to work around two Apps Script facts that don't
   exist anymore once writes go straight to Postgres — the "Web App served
   a Google interstitial page instead of JSON even though the write
   secretly succeeded" glitch, and appendRow() having no unique-constraint
   concept to refuse a duplicate with. lib/booking-service.js's
   saveBooking() now does that dedup atomically, in the same single
   INSERT, against a real UNIQUE index on main_payment_intent_id — see its
   own header comment for the full reasoning. This was anticipated
   directly by PRD Section 7 ("becomes moot once calling Postgres
   directly").

   Still never blocks a guest on a persistence hiccup: the payment already
   succeeded by the time this is called, so a save failure should be
   logged and surfaced softly, not turned into a dead end for someone who
   already paid. Same posture for the confirmation email and text sent
   below (unchanged from before).
   ============================================ */

var { sendBookingConfirmationEmail } = require('../lib/send-booking-confirmation');
var { sendBookingConfirmationSms } = require('../lib/send-booking-confirmation-sms');
var { saveBooking } = require('../lib/booking-service');
var { query } = require('../lib/db');

// Same constant/pattern as api/adventure-prep.js's own SITE_URL (kept
// local rather than shared, matching this repo's existing convention of
// each api/*.js file declaring what it needs rather than importing a
// shared constants module).
var SITE_URL = 'https://www.palmspringsadventureclub.com';

// UNCHANGED from the pre-migration version of this file (still calling
// Stripe directly, not Apps Script) — see this file's header comment.
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

// Records a verification-failure Ops Alert straight into Postgres instead
// of round-tripping through the Apps Script webapp's opsAlerts_recordAlert
// action. ops_alerts (schema.sql) is a fresh-start table (Section 7), so
// this is a plain INSERT, no dedup/CAS concern here.
async function recordVerificationAlert(alertType, notes) {
  try {
    await query(
      `INSERT INTO ops_alerts (alert_id, booking_id, alert_type, urgency, notes, created_at)
       VALUES ($1, NULL, $2, 'urgent_same_day', $3, now())`,
      ['ALERT-' + require('crypto').randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(), alertType, notes]
    );
  } catch (alertErr) {
    console.error('save-booking: failed to write a ' + alertType + ' Ops Alert', alertErr);
  }
}

// Returns { ok: true } and mutates body's money-relevant fields in place
// to the Stripe-verified values, or { ok: false, message } if the booking
// should NOT be written (either the charge doesn't check out, or it
// couldn't be verified at all). Skips entirely for tier === 'custom'.
// UNCHANGED logic from the pre-migration version — see this file's header.
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
      'A booking save for PaymentIntent ' + paymentIntentId + ' (' + (body.email || 'no email') + ') could not be verified — STRIPE_SECRET_KEY is not set on this deployment. Booking was NOT written to Postgres.'
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
      'A booking save for PaymentIntent ' + paymentIntentId + ' (' + (body.email || 'no email') + ') could not be verified against Stripe — the read call failed twice. Booking was NOT written to Postgres. If this guest genuinely paid, find the PaymentIntent in the Stripe Dashboard and create the booking manually.'
    );
    return { ok: false, message: 'Could not verify payment. Please contact us to complete your booking.' };
  }

  var pi = piRes.data;
  var piTier = pi.metadata && pi.metadata.tier;
  var piGearCount = pi.metadata && pi.metadata.gearCount;
  var statusOk = pi.status === 'succeeded' || pi.status === 'processing';
  var tierMatches = piTier === body.tier;

  if (!statusOk || !tierMatches) {
    console.error('save-booking: PaymentIntent failed verification', paymentIntentId, { status: pi.status, piTier: piTier, bodyTier: body.tier });
    await recordVerificationAlert(
      'save_booking_charge_verification_failed',
      'A booking save for PaymentIntent ' + paymentIntentId + ' (' + (body.email || 'no email') + ') failed verification — Stripe status: ' + pi.status + ', PaymentIntent tier: ' + piTier + ', claimed tier: ' + body.tier + '. Booking was NOT written to Postgres. Check whether this is a real guest hitting an edge case or a fabricated request.'
    );
    return { ok: false, message: 'Could not verify payment for this booking.' };
  }

  body.total = pi.amount / 100;
  body.paymentStatus = pi.status;
  if (piGearCount != null && piGearCount !== '') {
    var verifiedGearCount = parseInt(piGearCount, 10);
    if (Number.isFinite(verifiedGearCount)) {
      body.gearKitsSelected = verifiedGearCount;
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

  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL env var');
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

    var data;
    try {
      data = await saveBooking(body);
    } catch (saveErr) {
      // A real error here (not the old ambiguous "might have secretly
      // succeeded" case) — the guest has already been charged, so this is
      // an unrecovered-save situation and needs the same staff follow-up
      // the old code raised for that case.
      console.error('save-booking: saveBooking() threw', saveErr);
      await recordVerificationAlert(
        'save_booking_failed_unrecovered',
        'A booking save threw for PaymentIntent ' + (body.paymentIntentId || '(none/custom)') + ' (' + (body.email || (body.contact && body.contact.email) || 'no email') + '): ' + saveErr.message + '. The guest has likely already been charged with no booking record on file. Needs manual follow-up.'
      );
      res.status(200).json({ ok: false, error: 'Could not save booking record.' });
      return;
    }

    if (data.deduped) {
      console.error('save-booking: dedup matched an existing booking for this PaymentIntent — treating as a retry, not a duplicate', data.bookingId);
    }

    // adventurePrepToken is minted inline by saveBooking() itself now
    // (every fresh booking gets one immediately — no more separate
    // adventurePrep_ensureToken backfill step, since there's no legacy
    // pre-migration data needing one retrofitted).
    var adventurePrepUrl = data.adventurePrepToken
      ? SITE_URL + '/complete-adventure-prep?token=' + encodeURIComponent(data.adventurePrepToken)
      : null;

    // Booking confirmation email (see lib/send-booking-confirmation.js).
    // Never blocks or fails this response — the booking and payment have
    // already succeeded by this point, same reasoning as the save-error
    // handling above. A send failure just gets logged.
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
