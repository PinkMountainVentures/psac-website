/* ============================================
   PSAC — "Your gear deposit hold is coming" pre-notification
   Sent a day or two before the T-1 gear-checkout hold actually gets placed. Copy
   locked in psac-copy-drafts.md section 5. Action-needed template: not urgent in
   the sense of a deadline, but time-boxed (fires right before something happens
   to the guest's card) and gives them a chance to fix a card problem before staff
   try to place the hold rather than after it fails.

   No CTA yet: there's no self-serve "update your card" flow built. Once one
   exists, pass cardUpdateUrl through and this template will render the button
   automatically (see action-needed-wrapper.js).
   ============================================ */

var { renderActionNeededEmail } = require('./action-needed-wrapper');

function buildBodyHtml() {
  return '<p>Quick heads up: in the next day or two, we\'ll place a $65 refundable hold on the card on file for your gear kit.</p>' +
    '<p>This is not a charge, it\'s released once your gear comes back in good shape.</p>' +
    '<p>If your card on file has changed, now\'s a good time to update it so nothing gets held up before your trail day.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} [tokens.cardUpdateUrl] - optional, omit until a self-serve card-update flow exists
 */
function renderDepositHoldHeadsUpEmail(tokens) {
  tokens = tokens || {};
  return renderActionNeededEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'Your $65 refundable gear deposit hold is coming in the next day or two.',
    urgencyLabel: 'DEPOSIT HOLD COMING',
    eyebrow: 'GEAR DEPOSIT',
    headline: 'Your hold is <em>on its way.</em>',
    bodyHtml: buildBodyHtml(),
    ctaText: tokens.cardUpdateUrl ? 'Update Your Card' : undefined,
    ctaUrl: tokens.cardUpdateUrl
  });
}

module.exports = { renderDepositHoldHeadsUpEmail };
