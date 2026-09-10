/* ============================================
   PSAC — Unified stall-reminder SMS, T-3 morning "action needed" only
   New this session (Sept 2026 SMS build). Companion to the existing
   email-only send in api/check-adventure-prep-cadence.js
   (lib/email-templates/adventure-prep-stall-reminder-email.js). Per
   Airey's own "narrower, hard deadlines only" scope call, SMS goes out
   ONLY for the T-3 morning 'action_needed' variant, never the earlier
   T-5/compressed-midpoint 'reminder' variant — that one stays email-only,
   same reasoning as lib/send-deposit-hold-failed-sms.js: SMS is reserved
   for genuinely time-boxed sends, not routine nudges with days of runway
   left.

   Reuses outstandingTrackPhrases/joinNaturally straight from the email
   template module rather than re-deriving the same dynamic
   outstanding-tracks list a second time.
   ============================================ */

var { sendSms } = require('./send-sms');
var { outstandingTrackPhrases, joinNaturally } = require('./email-templates/adventure-prep-stall-reminder-email');

function buildBody({ tripDateFormatted, adventurePrepLink, tracks }) {
  var listText = joinNaturally(outstandingTrackPhrases(tracks || {})) || 'finish a few last details';
  return 'Palm Springs Adventure Club: Your trail day is ' + (tripDateFormatted || 'coming up') +
    ' and we still need you to ' + listText + '. Finish by 10pm tonight or we can’t hold your reservation: ' + adventurePrepLink;
}

/**
 * @param {object} opts
 * @param {string} opts.phone
 * @param {boolean} opts.smsConsent
 * @param {string} opts.tripDateFormatted
 * @param {string} opts.adventurePrepLink
 * @param {object} opts.tracks - { assignedAtMissing, waiverIncomplete, addressMissing }
 * @returns {Promise<{status: 'sent', sid: string} | {status: 'failed', error: string} | {status: 'skipped', reason: string}>}
 */
async function sendStallReminderActionNeededSms(opts) {
  opts = opts || {};
  if (opts.smsConsent !== true) {
    return { status: 'skipped', reason: 'guest did not opt into SMS' };
  }
  if (!opts.phone) {
    return { status: 'skipped', reason: 'no contact phone on booking record' };
  }
  return sendSms({ to: opts.phone, body: buildBody(opts) });
}

module.exports = { sendStallReminderActionNeededSms };
