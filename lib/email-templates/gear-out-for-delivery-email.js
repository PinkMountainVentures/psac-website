/* ============================================
   PSAC — "Your gear is out for delivery"
   NEW (Airey's direct request, 2026-09-05): triggered by the exact same
   status logic as the T-3+ hub's guest-facing gear delivery card
   (adventure-prep-form.js's computeGearDeliveryStatus() -- see that
   file's own header comment for the full Packing/Packed/Out for
   Delivery/Delivered state machine). Sent the moment a booking's
   computed state would read "Out for Delivery": a real staff-picked
   delivery slot exists and now is within 1 hour of it. Booker-only,
   same as the card itself (Surface A; see waiver-signer-form.js's own
   comment on why this never renders/sends on Surface B or the
   guardian-only hub).

   Distinct from the older, still-unwired gear-on-its-way-email.js --
   that one is a broad "gear's headed your way sometime this evening"
   T-1 heads-up with no fixed send instant of its own; this one fires at
   the specific moment the card itself would flip to Out for Delivery,
   with the real slot-based arrival estimate.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Your gear' + (tokens.kitCount > 1 ? ' (' + tokens.kitCount + ' kits)' : '') + ' is on its way, arriving around ' + tokens.arrivalTime + ' tonight.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.arrivalTime - e.g. "7:00pm"
 * @param {string} tokens.address - full delivery street address (booker-only email, same posture as the card)
 * @param {number} [tokens.kitCount]
 */
function renderGearOutForDeliveryEmail(tokens) {
  tokens = tokens || {};
  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'Your gear is out for delivery, arriving around ' + tokens.arrivalTime + ' tonight.',
    eyebrow: 'YOUR GEAR',
    headline: 'Out for <em>delivery.</em>',
    bodyHtml: buildBodyHtml(tokens),
    detailRows: [
      { label: 'Arriving', value: 'Around ' + tokens.arrivalTime + ' tonight' },
      { label: 'Address', value: tokens.address || '' },
    ].concat(tokens.kitCount ? [{ label: 'Kits', value: String(tokens.kitCount) + (tokens.kitCount === 1 ? ' gear kit' : ' gear kits') }] : []),
  });
}

module.exports = { renderGearOutForDeliveryEmail };
