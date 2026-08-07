/* ============================================
   PSAC — Shared Twilio send function
   Mirrors lib/send-email.js's shape: one shared function every SMS
   touchpoint module calls, instead of re-implementing the request. Calls
   Twilio's REST API directly via fetch, no SDK/npm dependency — same
   dependency-free convention as the rest of this repo (see
   api/create-payment-intent.js's header comment).

   A send failure here must never throw past the caller: every touchpoint
   send happens after its triggering event (a booking, a check-in, a T-1
   cron tick) has already succeeded, so a failure here is logged for
   follow-up, not surfaced to the guest. Callers should check the returned
   status and log/alert on non-'sent' results, same posture as
   lib/send-email.js.

   Consent is the caller's job, not this function's: check
   contact.smsConsent === true before calling sendSms at all. Per the
   internal ops brief's fallback rule (text if consent is true, otherwise
   a phone call or email), that branch belongs in the caller, this
   function sends unconditionally once called.

   Phone numbers must be E.164 (+1XXXXXXXXXX for a US number) — Twilio
   rejects anything else. toE164() below normalizes a plain 10 or
   11-digit US number; anything it can't confidently normalize (a
   non-US number, a malformed string) comes back null rather than being
   guessed at, so a bad number fails loudly in the logs instead of
   silently misdialing.

   Env vars required (see .env.example, setup guide Part B3):
     TWILIO_ACCOUNT_SID
     TWILIO_AUTH_TOKEN
     TWILIO_MESSAGING_SERVICE_SID   pooled sender, handles number/campaign
                                     selection for you
   ============================================ */

function twilioAuthHeader() {
  var credentials = process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN;
  return 'Basic ' + Buffer.from(credentials).toString('base64');
}

// US-only for now — every guest so far books through a US-based flow.
// Revisit if international guests become a real case.
function toE164(raw) {
  if (!raw) return null;
  var digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.to - guest phone number, any common US format,
 *   normalized to E.164 internally
 * @param {string} opts.body - message text
 * @returns {Promise<{status: 'sent', sid: string} | {status: 'failed', error: string} | {status: 'skipped', reason: string}>}
 */
async function sendSms(opts) {
  opts = opts || {};

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_MESSAGING_SERVICE_SID) {
    return { status: 'failed', error: 'Twilio env vars not configured' };
  }

  if (!opts.to) {
    return { status: 'skipped', reason: 'no recipient phone number provided' };
  }

  var to = toE164(opts.to);
  if (!to) {
    return { status: 'failed', error: 'could not normalize phone number to E.164: ' + opts.to };
  }

  if (!opts.body) {
    return { status: 'failed', error: 'sendSms requires body' };
  }

  try {
    var params = new URLSearchParams();
    params.append('To', to);
    params.append('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
    params.append('Body', opts.body);

    var res = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Messages.json',
      {
        method: 'POST',
        headers: {
          'Authorization': twilioAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      }
    );

    var data = await res.json();

    if (!res.ok) {
      console.error('Twilio error sending SMS:', data);
      return { status: 'failed', error: (data && data.message) || 'Twilio API error' };
    }

    return { status: 'sent', sid: data.sid };
  } catch (err) {
    console.error('sendSms error:', err);
    return { status: 'failed', error: err.message || String(err) };
  }
}

module.exports = { sendSms, toE164 };
