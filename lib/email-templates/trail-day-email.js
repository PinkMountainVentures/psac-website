/* ============================================
   PSAC — Trail-day message (T-day)
   Copy locked in psac-copy-drafts.md section 9. Base template. Trail-specific
   fields (trailheadLocation, tripTip) source from the trail database
   (PSAC_Trail_Database.xlsx); startTime sources from the booking record, not
   the trail database, since start time is something the guest chose, not a
   property of the trail. Folds in the return-instructions duffel list as a
   same-day safety net, in case the guest is checking out today too.

   House style: never "hiking"/"hike", keep it "adventure" ("trekking poles",
   not "hiking poles").
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

var DUFFEL_RETURN_ITEMS = ['Backpack', 'Trekking poles', '2 Hydro Flask water bottles', 'First aid kit'];

function buildBodyHtml(tokens) {
  var itemsList = '<ul style="margin:0 0 16px 0; padding-left: 20px;">' +
    DUFFEL_RETURN_ITEMS.map(function (item) { return '<li style="margin-bottom:4px;">' + item + '</li>'; }).join('') +
    '</ul>';

  return '<p>Today\'s the day. Meet at ' + tokens.trailheadLocation + ' by ' + tokens.startTime + '. ' + (tokens.tripTip || '') + ' Full trail details and navigation: <a href="' + tokens.trailLink + '" style="color:#2A4747; text-decoration:underline;">' + tokens.trailLink + '</a>.</p>' +
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
 * @param {string} tokens.trailLink
 * @param {string} [tokens.pickupArrangement] - e.g. "with the hotel front desk"
 */
function renderTrailDayEmail(tokens) {
  tokens = tokens || {};
  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'Today\'s the day. Here\'s where to meet and what to know.',
    eyebrow: 'TRAIL DAY',
    headline: 'Time to hit the <em>trail.</em>',
    bodyHtml: buildBodyHtml(tokens)
  });
}

module.exports = { renderTrailDayEmail, DUFFEL_RETURN_ITEMS };
