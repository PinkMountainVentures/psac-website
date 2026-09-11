/* ============================================
   PSAC — Trail-day message (T-day)
   Copy locked in psac-copy-drafts.md section 9. Base template. Trail-specific
   fields (trailheadLocation, tripTip) source from the trail database
   (PSAC_Trail_Database.xlsx); startTime sources from the booking record, not
   the trail database, since start time is something the guest chose, not a
   property of the trail. Folds in the return-instructions duffel list as a
   same-day safety net, in case the guest is checking out today too.

   UPDATED (Airey's direct request, 2026-09-10): adds a "Heading Out" CTA,
   using the shared base-wrapper CTA button (ctaText/ctaUrl) rather than a
   hand-rolled link, so it matches the brand button component exactly. Taps
   through to the existing Adventure Prep hub (tokens.hubLink), where the
   Heading Out button already renders once trail day arrives and
   heading_out_at is unset (adventure-prep-form.js's headingOutButtonHtml) —
   no new hub work needed. Companion SMS prompt lives in
   lib/send-heading-out-prompt-sms.js, sent alongside this email by
   api/send-trail-day-message.js.

   UPDATED AGAIN (Airey's direct request, 2026-09-10, same day): the
   "Get Guide"/trail-details link used to point straight at
   trails.ridewithgps_link. Now it points at the hub (tokens.hubLink)
   instead — the hub is the one central place a guest gets to RideWithGPS
   from (its own Get Guide button, now fixed to actually use the real
   link, see lib/adventure-prep-service.js/lib/waiver-service.js's
   ridewithgpsLink additions), rather than duplicating that link into
   every outbound message. tokens.trailLink is retired; tokens.hubLink now
   backs both the inline "Get Guide" text link and the CTA button.

   UPDATED (2026-09-10 email/SMS audit follow-up): the tribal entry-fee
   reminder fragment (psac-copy-drafts.md section 12) was drafted back in
   Aug 2026 but never implemented here -- the audit flagged it as the one
   place a guest could arrive at a locked gate with no warning. Now folds
   in via tokens.entryFeeFragment, built by the caller
   (api/send-trail-day-message.js) from the assigned trail's park and
   entry_fee_required columns.

   House style: never "hiking"/"hike", keep it "adventure" ("trekking poles",
   not "hiking poles").
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

var DUFFEL_RETURN_ITEMS = ['Backpack', 'Trekking poles', '2 Hydro Flask water bottles', 'First aid kit'];

function buildBodyHtml(tokens) {
  var itemsList = '<ul style="margin:0 0 16px 0; padding-left: 20px;">' +
    DUFFEL_RETURN_ITEMS.map(function (item) { return '<li style="margin-bottom:4px;">' + item + '</li>'; }).join('') +
    '</ul>';

  return '<p>Today\'s the day. Meet at ' + tokens.trailheadLocation + ' by ' + tokens.startTime + '. ' + (tokens.tripTip || '') + ' Full trail details and navigation: <a href="' + tokens.hubLink + '" style="color:#2A4747; text-decoration:underline;">Get Guide</a>.' + (tokens.entryFeeFragment ? ' ' + tokens.entryFeeFragment : '') + '</p>' +
    '<p>Before you head out: tap Heading Out below (or in your Adventure Prep hub) so we know your group is on the trail. It\'s what tells us when to start checking in if you\'re running long.</p>' +
    '<p>One more thing, in case you\'re checking out today too: when you\'re done, pack these back into your duffel:</p>' +
    itemsList +
    '<p>Everything else in your kit (sunscreen, electrolytes, the date pack, your bandana, the membership card) is yours to keep. Leave the duffel ' + (tokens.pickupArrangement || '') + ' and we\'ll take it from there.</p>' +
    '<p>Have a great adventure.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.trailheadLocation - from the trail database
 * @param {string} tokens.startTime - from the booking record
 * @param {string} [tokens.tripTip] - one trail-specific tip, from the trail database
 * @param {string} [tokens.pickupArrangement] - e.g. "with the hotel front desk"
 * @param {string} tokens.hubLink - hub link (Adventure Prep for the booker, sign-waiver for a signer), backs BOTH the inline "Get Guide" text link and the Heading Out CTA button (NEW, 2026-09-10). tokens.trailLink is retired -- the hub is now the one place guests get to RideWithGPS from.
 * @param {string} [tokens.entryFeeFragment] - NEW (2026-09-10 email/SMS
 *   audit follow-up): the trail-day tribal entry-fee reminder
 *   (psac-copy-drafts.md section 12's Indian Canyons/Tahquitz Canyon
 *   variants), folded into the same sentence as the Get Guide link.
 *   Omit entirely for a trail with entry_fee_required = false, or one
 *   whose park doesn't match either mapped fragment (fails safe: no
 *   fragment shown rather than a wrong one).
 */
function renderTrailDayEmail(tokens) {
  tokens = tokens || {};
  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'Today\'s the day. Here\'s where to meet and what to know.',
    eyebrow: 'TRAIL DAY',
    headline: 'Time to hit the <em>trail.</em>',
    bodyHtml: buildBodyHtml(tokens),
    ctaText: 'Heading Out',
    ctaUrl: tokens.hubLink
  });
}

module.exports = { renderTrailDayEmail, DUFFEL_RETURN_ITEMS };
