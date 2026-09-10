/* ============================================
   PSAC — Deposit hold failed, 2-hour deadline SMS
   New this session (Sept 2026 SMS build). Companion to the existing
   email-only send in api/trigger-deposit-holds.js
   (lib/email-templates/deposit-hold-failed-email.js) — same trigger (the
   9am Pacific T-1 hold attempt returning anything but 'succeeded'), same
   guest-facing 11am Pacific deadline, just the SMS-shaped version of the
   identical message: short, plain text, no HTML shell, bare link.

   Deliberately one of only two touchpoints that got an SMS variant this
   round, per Airey's own "narrower, hard deadlines only" scope call — this
   is the harder of the two (a guest with an unresolved payment method has
   real hours, not days, before their gear can't ship), so it's exactly
   the shape of send this project's SMS channel exists for.

   Consent is the caller's job, not this function's, same convention as
   every other SMS touchpoint (see lib/send-sms.js's own header).
   ============================================ */

var { sendSms } = require('./send-sms');

function buildBody({ tripDateFormatted, deadlineTimeFormatted, updatePaymentLink }) {
  return 'Palm Springs Adventure Club: Your gear deposit hold for ' +
    (tripDateFormatted || 'your trail day') +
    ' didn’t go through this morning. Update your payment method by ' +
    (deadlineTimeFormatted || 'the deadline today') +
    ' or we can’t get your gear out today: ' + updatePaymentLink;
}

/**
 * @param {object} opts
 * @param {string} opts.phone
 * @param {boolean} opts.smsConsent
 * @param {string} opts.tripDateFormatted
 * @param {string} opts.deadlineTimeFormatted
 * @param {string} opts.updatePaymentLink
 * @returns {Promise<{status: 'sent', sid: string} | {status: 'failed', error: string} | {status: 'skipped', reason: string}>}
 */
async function sendDepositHoldFailedSms(opts) {
  opts = opts || {};
  if (opts.smsConsent !== true) {
    return { status: 'skipped', reason: 'guest did not opt into SMS' };
  }
  if (!opts.phone) {
    return { status: 'skipped', reason: 'no contact phone on booking record' };
  }
  return sendSms({ to: opts.phone, body: buildBody(opts) });
}

module.exports = { sendDepositHoldFailedSms };
