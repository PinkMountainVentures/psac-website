/* ============================================
   PSAC — Return instructions (standalone send, three property-type variants)
   Copy locked in psac-copy-drafts.md section 10. Base template. Standalone send,
   same day as the trail day. Trigger timing not finalized (trail start time + 2
   hours, tentative default; open to a duration-aware refinement against the
   booking's q6_duration + a buffer, see the doc note) — that decision belongs to
   whatever schedules the send, not this template.

   Duffel-item list matches trail-day-email.js's DUFFEL_RETURN_ITEMS exactly —
   imported from there rather than redeclared, so the two never drift apart.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');
var { DUFFEL_RETURN_ITEMS } = require('./trail-day-email');

var PICKUP_LINE_BY_PROPERTY_TYPE = {
  hotel: function () {
    return 'Leave the duffel with the hotel front desk whenever you\'re ready, and we\'ll pick it up from there.';
  },
  airbnb: function (pickupArrangement) {
    return 'Leave the duffel ' + (pickupArrangement || '[pickup arrangement]') + ' whenever you head out, and we\'ll take it from there.';
  },
  privateHome: function (pickupArrangement) {
    return 'Leave the duffel ' + (pickupArrangement || '[pickup arrangement]') + ' and we\'ll swing by to pick it up.';
  }
};

function buildBodyHtml(tokens) {
  var itemsList = '<ul style="margin:0 0 16px 0; padding-left: 20px;">' +
    DUFFEL_RETURN_ITEMS.map(function (item) { return '<li style="margin-bottom:4px;">' + item + '</li>'; }).join('') +
    '</ul>';

  var pickupLineFn = PICKUP_LINE_BY_PROPERTY_TYPE[tokens.propertyType] || PICKUP_LINE_BY_PROPERTY_TYPE.hotel;
  var pickupLine = pickupLineFn(tokens.pickupArrangement);

  return '<p>Hope today was a good one. Pack these back into your duffel:</p>' +
    itemsList +
    '<p>Everything else is yours to keep. ' + pickupLine + '</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {'hotel'|'airbnb'|'privateHome'} tokens.propertyType
 * @param {string} [tokens.pickupArrangement] - required for airbnb/privateHome once the coordination page collects it; not yet collected anywhere, see doc note
 */
function renderReturnInstructionsEmail(tokens) {
  tokens = tokens || {};
  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'One last step: returning your gear kit.',
    eyebrow: 'GEAR RETURN',
    headline: 'Almost done, <em>one last step.</em>',
    bodyHtml: buildBodyHtml(tokens)
  });
}

module.exports = { renderReturnInstructionsEmail };
