/* ============================================
   PSAC — T-0 "Heading Out" SMS prompt
   Copy locked in psac-copy-drafts.md section 9. Companion to the trail-day
   email's own Heading Out CTA (lib/email-templates/trail-day-email.js) —
   both channels prompt the same action for the same reason (Airey's direct
   request, 2026-09-10): tap Heading Out so the trip's heading_out_at gets
   set, which is what the Trail Return/SAR system (lib/trail-checkin-
   incident-service.js) uses to know a group is out there and when to start
   checking in if they run long.

   Deliberately narrow: this is not a full SMS restatement of the trail-day
   email (trail-day itself stays email-only per the Sept 2026 SMS build's
   "hard deadlines only" scope call, psac-copy-drafts.md section 14) — only
   the Heading Out prompt gets an SMS variant, since Airey's own framing for
   this addition was specifically about the Heading Out action, not trail-
   day messaging generally.

   No inbound SMS parsing exists in this repo (confirmed by grep — see
   lib/kit-sync-service.js's own "zero existing webhook endpoints" note) —
   so this is a link-based prompt to the existing hub, never a "reply
   STARTED" instruction. The Heading Out button already renders there once
   trail day arrives and heading_out_at is unset
   (adventure-prep-form.js's headingOutButtonHtml/trailDayBodyHtml); no new
   hub work needed for this to function on tap.
   ============================================ */

'use strict';

var { sendSms } = require('./send-sms');

/**
 * @param {object} opts
 * @param {string} opts.phone
 * @param {boolean} opts.smsConsent
 * @param {string} opts.trailheadLocation
 * @param {string} opts.startTime
 * @param {string} opts.hubLink
 */
async function sendHeadingOutPromptSms(opts) {
  opts = opts || {};

  if (opts.smsConsent !== true || !opts.phone) {
    return { status: 'skipped', reason: 'no sms consent or no phone on file' };
  }

  var body = 'Palm Springs Adventure Club: Today\'s the day! Meet at ' + opts.trailheadLocation +
    ' by ' + opts.startTime + '. When you head out, tap Heading Out in your Adventure Prep hub so we know you\'re on the trail: ' + opts.hubLink;

  return sendSms({ to: opts.phone, body: body });
}

module.exports = { sendHeadingOutPromptSms };
