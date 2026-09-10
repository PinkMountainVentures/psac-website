/* ============================================
   PSAC — Signer waiver reminder SMS, T-3 morning "action needed" only
   New this session (Sept 2026 SMS build). Companion to
   lib/email-templates/signer-waiver-reminder-email.js's 'action_needed'
   variant. SMS is sent ONLY at the T-3 morning hard-deadline moment, not
   the earlier T-5/midpoint 'reminder' variant, matching the same
   narrower SMS-scope decision applied to every other touchpoint this
   session (see lib/send-adventure-prep-stall-reminder-sms.js's header).

   Gated on this specific SIGNER's own sms_consent/signer_phone (captured
   on Surface B's own "Confirm Your Details" screen), never the booker's
   contact.smsConsent -- a signer who hasn't reached that screen yet has
   no phone on file and gets email only, same fallback posture as every
   other consent-gated send in this repo.
   ============================================ */

var { sendSms } = require('./send-sms');

function buildBody({ ownerName, tripDateFormatted, signerUrl }) {
  return 'Palm Springs Adventure Club: ' + (ownerName || 'Your trip organizer') +
    '’s trail day is ' + (tripDateFormatted || 'coming up') +
    '. Without your signature we can’t include you. Sign by 10pm tonight: ' + signerUrl;
}

/**
 * @param {object} opts
 * @param {string} opts.signerPhone
 * @param {boolean} opts.smsConsent
 * @param {string} opts.ownerName
 * @param {string} opts.tripDateFormatted
 * @param {string} opts.signerUrl
 * @returns {Promise<{status: 'sent', sid: string} | {status: 'failed', error: string} | {status: 'skipped', reason: string}>}
 */
async function sendSignerWaiverReminderSms(opts) {
  opts = opts || {};
  if (opts.smsConsent !== true) {
    return { status: 'skipped', reason: 'signer did not opt into SMS' };
  }
  if (!opts.signerPhone) {
    return { status: 'skipped', reason: 'no phone on file for this signer' };
  }
  return sendSms({ to: opts.signerPhone, body: buildBody(opts) });
}

module.exports = { sendSignerWaiverReminderSms };
