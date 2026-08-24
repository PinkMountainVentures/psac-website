/* ============================================
   PSAC — Gear deposit Scenario 4 follow-up charge FAILED (new copy)
   Not in the original locked PRD's copy drafts — Section 10's own
   instruction is explicit: "a failed charge writes an Ops Alert and emails
   the guest, never let a failed charge notify no one." Same brand-voice
   rules as every other guest send in this build: never "PSAC", always
   "Palm Springs Adventure Club", no em dashes, never "consultation", never
   "hiking"/"hike".

   Action-needed template — this is the highest-urgency of the gear-deposit
   notices: a real charge attempt against the guest's card failed, staff
   need to follow up, and the guest should know money didn't move rather
   than wonder about a statement line that never appears.
   ============================================ */

var { renderActionNeededEmail } = require('./action-needed-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Thanks again for adventuring with Palm Springs Adventure Club. When your gear came back, we found ' + tokens.item + ' with ' + tokens.conditionNote + ' beyond normal wear, beyond what your $' + tokens.holdAmount + ' deposit hold covered.</p>' +
    '<p>We tried to charge $' + tokens.amount + ' to the card on file to cover the difference, as agreed to at booking, but the charge didn\'t go through on our end.</p>' +
    '<p>We\'ll follow up directly to sort out payment. If you\'d like to update the card on file in the meantime, just reply to this email.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.item
 * @param {string} tokens.conditionNote
 * @param {string|number} tokens.holdAmount
 * @param {string|number} tokens.amount - the shortfall amount that failed to charge
 */
function renderGearShortfallChargeFailedEmail(tokens) {
  tokens = tokens || {};
  return renderActionNeededEmail({
    logoUrl: tokens.logoUrl,
    preheader: "We couldn't process a charge related to your gear deposit.",
    urgencyLabel: 'PAYMENT ISSUE',
    eyebrow: 'GEAR DEPOSIT',
    headline: 'We couldn\'t process <em>this charge.</em>',
    bodyHtml: buildBodyHtml(tokens),
  });
}

module.exports = { renderGearShortfallChargeFailedEmail };
