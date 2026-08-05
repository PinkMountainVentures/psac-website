/* ============================================
   PSAC — "Gear is on its way" (T-1, evening)
   Copy locked in psac-copy-drafts.md section 8. Base template: routine, not
   urgent. Links trail details, since by this point the guest should already
   have seen the trail once at the (not-yet-drafted) trail-reveal touchpoint —
   see the note in section 8 of psac-copy-drafts.md.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Your gear kit is packed and headed to ' + tokens.deliveryLocation + ', expected between ' + tokens.deliveryWindow + '. ' + (tokens.handoffNote || '') + '</p>' +
    '<p>Tomorrow\'s the day. Here\'s your trail again for reference: ' + tokens.trailName + '. Full details, map, and turn-by-turn navigation: <a href="' + tokens.trailLink + '" style="color:#2A4747; text-decoration:underline;">' + tokens.trailLink + '</a>. We\'ll send trailhead and start-time specifics again in the morning.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.deliveryLocation
 * @param {string} tokens.deliveryWindow - e.g. "5-7pm"
 * @param {string} [tokens.handoffNote] - property-type-specific handoff note, e.g. "We'll leave it with the front desk."
 * @param {string} tokens.trailName
 * @param {string} tokens.trailLink
 */
function renderGearOnItsWayEmail(tokens) {
  tokens = tokens || {};
  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'Your gear kit is packed and on its way. Tomorrow\'s the day.',
    eyebrow: 'GEAR DELIVERY',
    headline: 'Tomorrow\'s the <em>big day.</em>',
    bodyHtml: buildBodyHtml(tokens)
  });
}

module.exports = { renderGearOnItsWayEmail };
