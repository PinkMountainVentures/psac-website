/* ============================================
   PSAC — Return instructions (standalone send)
   Copy locked in psac-copy-drafts.md section 10. Base template. Standalone send,
   same day as the trail day.

   UPDATED (2026-09-11 email/SMS audit follow-up, wiring pass): this file's
   own propertyType map ('hotel'/'airbnb'/'privateHome', invented labels
   with zero live callers) is retired in favor of a plain pickupArrangement
   string, built by the caller with lib/delivery-handoff-note.js's
   buildPickupArrangement(property_type, return_note || delivery_note) --
   the exact same helper and precedence trail-day-email.js already uses for
   its own "Leave the duffel ___" line (see api/send-trail-day-message.js).
   That helper keys off adventure_prep.property_type's real three values,
   so no second translation layer is needed here. This also resolves this
   file's old "pickupArrangement... not yet collected anywhere" note: it
   is collected, as return_note/delivery_note, and already flows through
   buildPickupArrangement for the trail-day send.

   Trigger timing: this template no longer speculates about it (the old
   "trail start time + 2 hours, tentative default" note is gone). See
   api/send-return-instructions.js's own header for the real answer --
   adventure_prep.expected_return_at, computed from the guest's actual
   Heading Out check-in time plus the assigned trail's easy-pace estimate
   (lib/adventure-prep-service.js's confirmHeadingOutByBookingId, shipped
   2026-09-08), which is a better duration-aware signal than the
   q6_duration refinement this file used to speculate about.

   Duffel-item list matches trail-day-email.js's DUFFEL_RETURN_ITEMS exactly —
   imported from there rather than redeclared, so the two never drift apart.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');
var { DUFFEL_RETURN_ITEMS } = require('./trail-day-email');

function buildBodyHtml(tokens) {
  var itemsList = '<ul style="margin:0 0 16px 0; padding-left: 20px;">' +
    DUFFEL_RETURN_ITEMS.map(function (item) { return '<li style="margin-bottom:4px;">' + item + '</li>'; }).join('') +
    '</ul>';

  return '<p>Hope today was a good one. Pack these back into your duffel:</p>' +
    itemsList +
    '<p>Everything else is yours to keep. Leave the duffel ' + (tokens.pickupArrangement || '') + ' and we\'ll take it from there.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} [tokens.pickupArrangement] - from lib/delivery-handoff-note.js's buildPickupArrangement(property_type, return_note || delivery_note), same as trail-day-email.js
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
