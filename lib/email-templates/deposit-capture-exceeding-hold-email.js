/* ============================================
   PSAC — Deposit notice 2D: capture exceeding the hold (loss or major damage)
   Copy locked in psac-copy-drafts.md section 2, 2D (renamed from 2C this
   session, text unchanged). Action-needed template: a second charge actually
   landed on the guest's card, this is the highest-urgency of the four deposit
   outcomes.
   ============================================ */

var { renderActionNeededEmail } = require('./action-needed-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Thanks again for adventuring with Palm Springs Adventure Club. When we checked in your gear, ' + tokens.item + ' didn\'t come back with the rest of the kit.</p>' +
    // NOTE: $531 here is the flat "full retail value per kit" cap
    // disclosed to the guest at booking time (adventure-form.js's own
    // retailCapEach -- backpack + poles + 2 bottles + a shared delivery
    // duffel, same across tiers), not the per-kit deposit amount -- left
    // as-is, not part of this round's per-kit-deposit fix.
    '<p>Your $' + tokens.holdAmount + ' hold has been fully applied, and because full replacement runs $531, we\'ve charged an additional $' + tokens.additionalAmount + ' to the card on file to cover the difference, as agreed to at booking.</p>' +
    '<p>We know gear gets left behind sometimes. If ' + tokens.item + ' turns up, let us know and we\'ll refund the difference.</p>' +
    '<p>Questions? Just reply here and we\'ll sort it out.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.item
 * @param {string|number} tokens.additionalAmount - the charge beyond the hold
 * @param {string|number} tokens.holdAmount - the deposit hold that was fully
 *   applied, in dollars (per-kit rate x kit count -- see
 *   api/create-deposit-hold.js's TIERS table; NOT always $65).
 */
function renderDepositCaptureExceedingHoldEmail(tokens) {
  tokens = tokens || {};
  return renderActionNeededEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'An update on your gear deposit hold.',
    urgencyLabel: 'DEPOSIT NOTICE',
    eyebrow: 'GEAR DEPOSIT',
    headline: 'An update on <em>your deposit.</em>',
    bodyHtml: buildBodyHtml(tokens)
  });
}

module.exports = { renderDepositCaptureExceedingHoldEmail };
