/* ============================================
   PSAC — Deposit notice 2B: partial capture (damage covered within the hold)
   Copy locked in psac-copy-drafts.md section 2, 2B. Action-needed template —
   money moved off the guest's hold, that's worth flagging even though the
   guest doesn't need to do anything.
   ============================================ */

var { renderActionNeededEmail } = require('./action-needed-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Thanks again for adventuring with Palm Springs Adventure Club. When your gear came back, we found ' + tokens.item + ' with ' + tokens.conditionNote + ' beyond normal wear.</p>' +
    '<p>We\'re applying $' + tokens.capturedAmount + ' of your $' + tokens.holdAmount + ' hold to cover the repair or replacement. The remaining $' + tokens.releasedAmount + ' has been released back to your card.</p>' +
    '<p>Breakdown:<br>' + tokens.item + ': $' + tokens.capturedAmount + '</p>' +
    '<p>If anything here looks off, just reply to this email and we\'ll work it out together.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.item
 * @param {string} tokens.conditionNote
 * @param {string|number} tokens.capturedAmount
 * @param {string|number} tokens.releasedAmount
 * @param {string|number} tokens.holdAmount - the full deposit hold this
 *   capture/release was drawn from, in dollars (per-kit rate x kit count
 *   -- see api/create-deposit-hold.js's TIERS table; NOT always $65).
 */
function renderDepositPartialCaptureEmail(tokens) {
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

module.exports = { renderDepositPartialCaptureEmail };
