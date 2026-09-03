/* ============================================
   PSAC — Send the booking confirmation email via Resend
   Called from api/save-booking.js right after the Apps Script save
   succeeds and a bookingId is known. Calls Resend's REST API directly with
   fetch, no SDK/npm dependency — matches this repo's Stripe integration
   pattern (see api/create-payment-intent.js's header comment: dependency-
   free, fetch only).

   A send failure here must never fail the booking response: the booking
   and payment have already succeeded by the time this runs (same posture
   as save-booking.js itself), so a failure here is logged for follow-up,
   not surfaced to the guest.

   Env vars required (see .env.example, setup guide Part A6):
     RESEND_API_KEY
     BOOKING_CONFIRMATION_LOGO_URL   public HTTPS URL for the header logo

   Sending domain: mail.palmspringsadventureclub.com, verified separately in
   Resend from the root domain, so it never touches the root's existing
   Google Workspace MX/SPF/DKIM. reply_to keeps guest replies landing in the
   reservations@ Google Group on the root domain.
   ============================================ */

var { renderBookingConfirmationEmail } = require('./email-templates/booking-confirmation-email');

function resendAuthHeader() {
  return 'Bearer ' + process.env.RESEND_API_KEY;
}

// Treats the stored value as a plain calendar date (no time component) and
// formats in UTC, so a date like "2026-09-12" never silently shifts a day
// earlier depending on the server's local timezone offset — a guest-facing
// date has to be exactly right.
function formatTrailDate(dateStr) {
  if (!dateStr) return 'your scheduled date';
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function formatPartySize(headcount) {
  var n = headcount || 1;
  return n + ' guest' + (n === 1 ? '' : 's');
}

function formatGearKits(count) {
  var n = count || 0;
  return n + ' Trail Guide kit' + (n === 1 ? '' : 's');
}

// booking.total is already the same server-consistent, tax-inclusive dollar
// figure the guest was actually charged (set from
// api/create-payment-intent.js's authoritative response — see
// adventure-form.js's startStripePaymentWithKey) — safe to display as-is,
// this is a receipt, not a new money-moving action.
function formatTotalPaid(dollars) {
  var n = dollars || 0;
  return '$' + n.toFixed(2);
}

// NEW (Aug 2026): CA sales tax line item. Returns '' (row omitted, not
// shown as $0) for Custom Experience bookings, which have no real tax
// figure since they're never charged through create-payment-intent.js.
function formatSalesTax(dollars) {
  if (!dollars) return '';
  return '$' + dollars.toFixed(2);
}

/**
 * @param {object} booking - the same payload shape adventure-form.js's
 *   buildPayload() sends to /api/save-booking, plus bookingId and
 *   adventurePrepUrl merged in by the caller once the Apps Script response
 *   is known. adventurePrepUrl may be null (see api/save-booking.js) —
 *   the template renders without the Adventure Prep CTA in that case
 *   rather than shipping a broken link.
 * @returns {Promise<{status: 'sent', id: string} | {status: 'failed', error: string} | {status: 'skipped', reason: string}>}
 */
async function sendBookingConfirmationEmail(booking) {
  if (!process.env.RESEND_API_KEY) {
    return { status: 'failed', error: 'RESEND_API_KEY not configured' };
  }

  var email = booking && booking.contact && booking.contact.email;
  if (!email) {
    // Shouldn't happen (email is required at Step 8), but never throw over
    // a malformed record — treat as a data problem to investigate.
    return { status: 'skipped', reason: 'no contact email on booking record' };
  }

  var html = renderBookingConfirmationEmail({
    logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || 'https://palmspringsadventureclub.com/images/psac-logo-email-header.png',
    trailDate: formatTrailDate(booking.date),
    partySize: formatPartySize(booking.headcount),
    gearKits: formatGearKits(booking.gearKitsSelected),
    salesTax: formatSalesTax(booking.taxAmount),
    totalPaid: formatTotalPaid(booking.total),
    adventurePrepUrl: booking.adventurePrepUrl || ''
  });

  try {
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': resendAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Palm Springs Adventure Club <reservations@mail.palmspringsadventureclub.com>',
        reply_to: 'reservations@palmspringsadventureclub.com',
        to: [email],
        subject: 'Your Palm Springs Adventure Club reservation is confirmed',
        html: html
      })
    });

    var data = await res.json();

    if (!res.ok) {
      console.error('Resend error sending booking confirmation:', data);
      return { status: 'failed', error: (data && data.message) || 'Resend API error' };
    }

    return { status: 'sent', id: data.id };
  } catch (err) {
    console.error('sendBookingConfirmationEmail error:', err);
    return { status: 'failed', error: err.message || String(err) };
  }
}

module.exports = { sendBookingConfirmationEmail };
