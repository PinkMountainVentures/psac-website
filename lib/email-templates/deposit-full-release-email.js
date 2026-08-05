/* ============================================
   PSAC — Deposit notice 2A: full release (normal wear)
   Copy locked in psac-copy-drafts.md section 2, 2A. Base template — the one
   deposit outcome that's genuinely good news, nothing urgent about it.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

function buildBodyHtml() {
  return '<p>Your gear made it back in great shape. We\'ve released your $65 hold, no charge was made to your card.</p>' +
    '<p>Thanks for taking care of it out there. We hope the trail treated you well.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 */
function renderDepositFullReleaseEmail(tokens) {
  tokens = tokens || {};
  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'Your gear deposit hold has been fully released.',
    eyebrow: 'GEAR DEPOSIT',
    headline: 'Your hold is <em>fully released.</em>',
    bodyHtml: buildBodyHtml()
  });
}

module.exports = { renderDepositFullReleaseEmail };
