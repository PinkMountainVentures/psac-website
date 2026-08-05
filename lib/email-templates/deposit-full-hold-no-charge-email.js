/* ============================================
   PSAC — Deposit notice 2C: full hold captured, no additional charge (new)
   Copy locked in psac-copy-drafts.md section 2, 2C. Newly identified gap, closed
   this session: the ops brief's four-scenario model always had this outcome
   (repair/replacement cost lands at or within the $65 hold, nothing further to
   charge), but no guest-facing copy existed for it until now. Action-needed
   template, same reasoning as 2B — money moved, worth flagging.
   ============================================ */

var { renderActionNeededEmail } = require('./action-needed-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Thanks again for adventuring with Palm Springs Adventure Club. When your gear came back, we found ' + tokens.item + ' with ' + tokens.conditionNote + ' beyond normal wear.</p>' +
    '<p>The repair or replacement cost met your full $' + tokens.holdAmount + ' hold, so we\'re applying all of it. Nothing further beyond that.</p>' +
    '<p>Breakdown:<br>' + tokens.item + ': $' + tokens.holdAmount + '</p>' +
    '<p>If anything here looks off, just reply to this email and we\'ll work it out together.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.item
 * @param {string} tokens.conditionNote
 * @param {string|number} tokens.holdAmount - normally 65 (or 65 x kit count for multi-kit bookings)
 */
function renderDepositFullHoldNoChargeEmail(tokens) {
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

module.exports = { renderDepositFullHoldNoChargeEmail };
