/* ============================================
   PSAC — "Gear is on its way" (T-1, evening)
   Copy locked in psac-copy-drafts.md section 8. Base template: routine, not
   urgent. Links trail details, since by this point the guest should already
   have seen the trail once at the (not-yet-drafted) trail-reveal touchpoint —
   see the note in section 8 of psac-copy-drafts.md.

   UPDATED (Airey's direct request, 2026-09-10): the "Get Guide"/trail-
   details link now points at the hub (tokens.hubLink), not straight at
   trails.ridewithgps_link. The hub is the one central place a guest gets
   to RideWithGPS from (its own Get Guide button, now fixed to actually
   use the real link -- see lib/adventure-prep-service.js/lib/waiver-
   service.js's ridewithgpsLink additions), rather than duplicating that
   link into every outbound message. tokens.trailLink is retired.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Your gear kit is packed and headed to ' + tokens.deliveryLocation + ', expected between ' + tokens.deliveryWindow + '. ' + (tokens.handoffNote || '') + '</p>' +
    '<p>Tomorrow\'s the day. Here\'s your trail again for reference: ' + tokens.trailName + '. Full details, map, and turn-by-turn navigation: <a href="' + tokens.hubLink + '" style="color:#2A4747; text-decoration:underline;">Get Guide</a>. We\'ll send trailhead and start-time specifics again in the morning.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.deliveryLocation
 * @param {string} tokens.deliveryWindow - e.g. "5-7pm"
 * @param {string} [tokens.handoffNote] - property-type-specific handoff note, e.g. "We'll leave it with the front desk."
 * @param {string} tokens.trailName
 * @param {string} tokens.hubLink - hub link (Adventure Prep for the booker, sign-waiver for a signer), backs the inline "Get Guide" text link (NEW, 2026-09-10, replaces tokens.trailLink)
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
