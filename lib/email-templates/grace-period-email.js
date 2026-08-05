/* ============================================
   PSAC — Grace-period notice (missing item, 48-hour deadline)
   Copy locked in psac-copy-drafts.md section 11. Action-needed template. Fires
   the moment an item is marked Missing at check-in. Branches on item count: a
   single missing item names it inline, multiple missing items get a bulleted
   list instead of inline paragraph text.

   No CTA: this is a reply-to-this-email flow, not a link-based one.
   ============================================ */

var { renderActionNeededEmail } = require('./action-needed-wrapper');

function buildBodyHtml(items, deadline) {
  if (items.length === 1) {
    return '<p>When we checked in your gear, we noticed ' + items[0] + ' didn\'t come back with the rest of the kit. No rush to worry, these things happen. If you can track it down, just let us know within 48 hours and there\'s no charge at all.</p>' +
      '<p>If we don\'t hear back by ' + deadline + ', the item\'s replacement cost gets deducted from your deposit hold, per the terms you agreed to at booking.</p>' +
      '<p>Reply here anytime, happy to help track it down.</p>';
  }

  var itemsList = '<ul style="margin:0 0 16px 0; padding-left: 20px;">' +
    items.map(function (item) { return '<li style="margin-bottom:4px;">' + item + '</li>'; }).join('') +
    '</ul>';

  return '<p>When we checked in your gear, we noticed a few items didn\'t come back with the rest of the kit:</p>' +
    itemsList +
    '<p>No rush to worry, these things happen. If you can track them down, just let us know within 48 hours and there\'s no charge at all.</p>' +
    '<p>If we don\'t hear back by ' + deadline + ', each item\'s replacement cost gets deducted from your deposit hold, per the terms you agreed to at booking.</p>' +
    '<p>Reply here anytime, happy to help track them down.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string[]} tokens.items - one or more missing item names, e.g. ["your Hydro Flask bottle"]
 * @param {string} tokens.deadline - the 48-hour deadline date/time
 */
function renderGracePeriodEmail(tokens) {
  tokens = tokens || {};
  var items = tokens.items || [];
  var isSingle = items.length <= 1;

  return renderActionNeededEmail({
    logoUrl: tokens.logoUrl,
    preheader: isSingle
      ? 'One item from your gear kit is still missing — no charge if you can track it down within 48 hours.'
      : 'A few items from your gear kit are still missing — no charge if you can track them down within 48 hours.',
    urgencyLabel: '48-HOUR WINDOW',
    eyebrow: 'GEAR CHECK-IN',
    headline: isSingle ? 'One thing\'s <em>still missing.</em>' : 'A few things are <em>still missing.</em>',
    bodyHtml: buildBodyHtml(items, tokens.deadline)
  });
}

// Subject line branches on item count too — exported so the send wrapper (and
// any future caller) doesn't have to re-derive this logic.
function gracePeriodSubject(items) {
  items = items || [];
  return items.length <= 1 ? 'One item from your gear kit' : 'A few items from your gear kit';
}

module.exports = { renderGracePeriodEmail, gracePeriodSubject };
