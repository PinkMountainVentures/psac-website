/* ============================================
   PSAC — T-3 hard-deadline outreach: address still missing
   Fires only if the delivery address is still missing 3 days out. Copy locked in
   psac-copy-drafts.md section 7. Routes to the Trip Prep flow (still to be built)
   rather than inventing a new manual process. Action-needed template: genuinely
   time-boxed, the trail day is 3 days out and gear can't be delivered without an
   address.

   PHONE_FALLBACK_SCRIPT below is staff talking points, not guest-facing copy —
   it's the true last resort for guests without SMS consent who haven't
   responded to the email/SMS version. Exported here so it lives next to the
   copy it's a fallback for, but it never gets sent through Resend/Twilio.
   ============================================ */

var { renderActionNeededEmail } = require('./action-needed-wrapper');

var PHONE_FALLBACK_SCRIPT =
  '"Hi, this is [staff name] from Palm Springs Adventure Club. Your trail day\'s coming up in a few days and we\'re still missing your delivery address. ' +
  'Do you have a minute to get that squared away now, or would you rather I text you a link to finish it yourself?"\n' +
  '[Collect address, property type, delivery notes if doing it by phone; otherwise send the Trip Prep link SMS.]';

function buildBodyHtml() {
  return '<p>Your trail day is in 3 days and we still need your delivery address to get your gear to you on time.</p>' +
    '<p>Takes just a couple minutes.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.tripPrepUrl - required, this is the whole point of the message
 */
function renderT3AddressReminderEmail(tokens) {
  tokens = tokens || {};
  return renderActionNeededEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'Your trail day is in 3 days and we still need your delivery address.',
    urgencyLabel: 'ADDRESS STILL NEEDED',
    eyebrow: 'TRIP PREP',
    headline: 'Let\'s get your gear <em>to the right place.</em>',
    bodyHtml: buildBodyHtml(),
    ctaText: 'Finish Your Trip Prep',
    ctaUrl: tokens.tripPrepUrl
  });
}

module.exports = { renderT3AddressReminderEmail, PHONE_FALLBACK_SCRIPT };
