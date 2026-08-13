/* ============================================
   PSAC — Send the booking confirmation text via Twilio
   Called from api/save-booking.js, right alongside the confirmation
   email, only when the guest opted into texts at Step 8
   (contact.smsConsent === true, per psac-sms-consent-requirement.md).
   Mirrors lib/send-booking-confirmation.js's shape and posture: a send
   failure here must never fail the booking response, logged for
   follow-up only, same reasoning as the email and the sheet-save call
   before it.

   First message to a guest in a new A2P 10DLC conversation should
   identify the business and offer an opt-out, per carrier requirements —
   both are baked into the copy below rather than left to whoever wires
   up the next touchpoint to remember.

   Env vars required (see .env.example, setup guide Part B3):
     TWILIO_ACCOUNT_SID
     TWILIO_AUTH_TOKEN
     TWILIO_MESSAGING_SERVICE_SID
   ============================================ */

var { sendSms } = require('./send-sms');

// Same UTC-safe date formatting as the confirmation email
// (lib/email-templates/booking-confirmation-email.js) — a guest-facing
// date has to be exactly right, not shifted a day by server timezone.
function formatTrailDate(dateStr) {
  if (!dateStr) return 'your scheduled date';
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// NEW (Aug 2026): appends the Adventure Prep link when one is available
// (booking.adventurePrepUrl, set by api/save-booking.js). "Reply STOP to
// opt out." stays as the last line either way — that's the carrier-
// required opt-out, not something to push earlier in the message.
function buildBody(booking) {
  var msg = 'Palm Springs Adventure Club: You\'re confirmed for ' + formatTrailDate(booking.date) +
    '! Check your email for the full confirmation.';
  if (booking.adventurePrepUrl) {
    msg += ' Finish setting up your adventure: ' + booking.adventurePrepUrl;
  }
  msg += ' Reply STOP to opt out.';
  return msg;
}

/**
 * @param {object} booking - same payload shape as sendBookingConfirmationEmail,
 *   including adventurePrepUrl (may be null).
 * @returns {Promise<{status: 'sent', sid: string} | {status: 'failed', error: string} | {status: 'skipped', reason: string}>}
 */
async function sendBookingConfirmationSms(booking) {
  booking = booking || {};
  var contact = booking.contact || {};

  if (contact.smsConsent !== true) {
    return { status: 'skipped', reason: 'guest did not opt into SMS at Step 8' };
  }

  if (!contact.phone) {
    // Shouldn't happen, phone is required at Step 8 regardless of SMS
    // consent, but never throw over a malformed record.
    return { status: 'skipped', reason: 'no contact phone on booking record' };
  }

  return sendSms({
    to: contact.phone,
    body: buildBody(booking)
  });
}

module.exports = { sendBookingConfirmationSms };
