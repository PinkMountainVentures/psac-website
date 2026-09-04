/* ============================================
   PSAC — "Your gear has arrived"
   NEW (Airey's direct request, 2026-09-05): the Delivered counterpart to
   gear-out-for-delivery-email.js -- same trigger source (the T-3+ hub's
   gear delivery card status logic), sent the moment delivery_status
   reaches 'delivered' (staff or Uber, via the existing gear-ops
   checkout flow -- api/checkout-gear.js's markDeliveredFinal action).
   Booker-only, same as the card. Event-driven (sent synchronously right
   there, not on a cron), same pattern as api/refund-gear-charge.js's own
   confirmation send.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Your gear' + (tokens.kitCount > 1 ? ' (' + tokens.kitCount + ' kits)' : '') + ' has arrived at ' + (tokens.address || 'your address') + '.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.deliveredTime - e.g. "7:52pm"
 * @param {string} tokens.address - full delivery street address (booker-only email, same posture as the card)
 * @param {number} [tokens.kitCount]
 */
function renderGearDeliveredEmail(tokens) {
  tokens = tokens || {};
  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'Your gear has arrived.',
    eyebrow: 'YOUR GEAR',
    headline: 'It\'s <em>here.</em>',
    bodyHtml: buildBodyHtml(tokens),
    detailRows: [
      { label: 'Delivered', value: tokens.deliveredTime || '' },
      { label: 'Address', value: tokens.address || '' },
    ].concat(tokens.kitCount ? [{ label: 'Kits', value: String(tokens.kitCount) + (tokens.kitCount === 1 ? ' gear kit' : ' gear kits') }] : []),
  });
}

module.exports = { renderGearDeliveredEmail };
