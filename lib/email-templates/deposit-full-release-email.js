/* ============================================
   PSAC — Deposit notice 2A: full release (normal wear)
   Copy locked in psac-copy-drafts.md section 2, 2A. Base template — the one
   deposit outcome that's genuinely good news, nothing urgent about it.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Your gear made it back in great shape. We\'ve released your $' + tokens.holdAmount + ' hold, no charge was made to your card.</p>' +
    '<p>Thanks for taking care of it out there. We hope the trail treated you well.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string|number} tokens.holdAmount - the deposit hold that was
 *   released, in dollars (per-kit rate x kit count -- see
 *   api/create-deposit-hold.js's TIERS table; NOT always $65, e.g. a
 *   2-kit Trail booking holds $130).
 */
function renderDepositFullReleaseEmail(tokens) {
  tokens = tokens || {};
  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'Your gear deposit hold has been fully released.',
    eyebrow: 'GEAR DEPOSIT',
    headline: 'Your hold is <em>fully released.</em>',
    bodyHtml: buildBodyHtml(tokens)
  });
}

module.exports = { renderDepositFullReleaseEmail };
