/* ============================================
   PSAC — Shared Resend send function
   Generalizes the pattern proven in lib/send-booking-confirmation.js (the first
   touchpoint shipped and tested end to end) so every other touchpoint module
   calls one shared function instead of re-implementing the fetch call. Calls
   Resend's REST API directly, no SDK/npm dependency — same dependency-free
   convention as api/create-payment-intent.js.

   A send failure here must never throw past the caller: every touchpoint send
   happens after its triggering event (a booking, a check-in, a T-1 cron tick)
   has already succeeded, so a failure here is logged for follow-up, not
   surfaced to the guest. Callers should still check the returned status and
   log/alert on non-'sent' results, same posture as save-booking.js already
   does for the confirmation email.

   Env vars required (see .env.example):
     RESEND_API_KEY

   Sending domain: mail.palmspringsadventureclub.com, verified separately from
   the root domain, so it never touches the root's existing Google Workspace
   MX/SPF/DKIM. Default reply_to keeps guest replies landing in the
   reservations@ Google Group on the root domain, callers can override per send
   if a message needs a different reply destination.
   ============================================ */

var DEFAULT_FROM = 'Palm Springs Adventure Club <reservations@mail.palmspringsadventureclub.com>';
var DEFAULT_REPLY_TO = 'reservations@palmspringsadventureclub.com';

function resendAuthHeader() {
  return 'Bearer ' + process.env.RESEND_API_KEY;
}

/**
 * @param {object} opts
 * @param {string} opts.to - guest email address
 * @param {string} opts.subject
 * @param {string} opts.html - fully rendered HTML (already run through a wrapper's render function)
 * @param {string} [opts.from] - defaults to the reservations@mail. sending address
 * @param {string} [opts.replyTo] - defaults to reservations@palmspringsadventureclub.com
 * @returns {Promise<{status: 'sent', id: string} | {status: 'failed', error: string} | {status: 'skipped', reason: string}>}
 */
async function sendEmail(opts) {
  opts = opts || {};

  if (!process.env.RESEND_API_KEY) {
    return { status: 'failed', error: 'RESEND_API_KEY not configured' };
  }

  if (!opts.to) {
    return { status: 'skipped', reason: 'no recipient email provided' };
  }

  if (!opts.subject || !opts.html) {
    return { status: 'failed', error: 'sendEmail requires subject and html' };
  }

  try {
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': resendAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: opts.from || DEFAULT_FROM,
        reply_to: opts.replyTo || DEFAULT_REPLY_TO,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html
      })
    });

    var data = await res.json();

    if (!res.ok) {
      console.error('Resend error sending email:', opts.subject, data);
      return { status: 'failed', error: (data && data.message) || 'Resend API error' };
    }

    return { status: 'sent', id: data.id };
  } catch (err) {
    console.error('sendEmail error:', opts.subject, err);
    return { status: 'failed', error: err.message || String(err) };
  }
}

module.exports = { sendEmail };
