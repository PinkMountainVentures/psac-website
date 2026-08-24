/* ============================================
   PSAC — Gear deposit / shortfall refund confirmation (new copy)
   Not in the original locked PRD copy drafts — the refund/partial-refund
   action itself (api/refund-gear-charge.js) is new, in-scope work this
   build adds to close the gap the design pass flagged (Section 10
   addendum: "there is no staff-facing refund/partial-refund action
   anywhere in gear reconciliation"). Base template, not action-needed —
   good news, nothing further required of the guest.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Good news, ' + (tokens.guestName || 'there') + ' — we\'ve refunded $' + tokens.amount + ' back to the card on file' + (tokens.reason ? ' (' + tokens.reason + ')' : '') + '.</p>' +
    '<p>It can take a few business days to show up on your statement, depending on your bank. Thanks for adventuring with Palm Springs Adventure Club.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} [tokens.guestName]
 * @param {string|number} tokens.amount
 * @param {string} [tokens.reason] - short plain-language reason, e.g. "recovered item"
 */
function renderGearRefundConfirmationEmail(tokens) {
  tokens = tokens || {};
  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: "We've issued a refund related to your gear deposit.",
    eyebrow: 'GEAR DEPOSIT',
    headline: 'A refund is <em>on its way.</em>',
    bodyHtml: buildBodyHtml(tokens),
  });
}

module.exports = { renderGearRefundConfirmationEmail };
