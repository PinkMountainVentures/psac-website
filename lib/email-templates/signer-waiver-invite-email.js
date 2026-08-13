/* ============================================
   PSAC — Non-owner signer waiver invite
   Sent from api/send-signer-links.js once the booking owner confirms at
   Surface A's step 10 ("Confirm & Send") — never earlier, per Adventure
   Prep PRD Section 7 ("links go out when the booking owner confirms ...
   not the moment contact info is typed"). One of these goes to every
   required adult signer besides the booking owner.

   Action-needed template: this is something the recipient needs to do
   (their own waiver, no one can sign it for them), tied to the same T-3
   cutoff as everything else in this booking, even though it isn't
   framed as urgent on day one. No copy for this touchpoint existed in
   psac-copy-drafts.md as of this build — flagged in the handoff for
   Airey's review, written to match the established voice rules (never
   "PSAC", no em dashes, never "consultation", never "hiking"/"hike").
   ============================================ */

var { renderActionNeededEmail } = require('./action-needed-wrapper');

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.signerName
 * @param {string} tokens.ownerName - the booking owner who added this signer
 * @param {string} tokens.tripDateDisplay - already formatted for display, e.g. "August 20"
 * @param {string} tokens.signerUrl - the tokenized Surface B link
 */
function renderSignerWaiverInviteEmail(tokens) {
  tokens = tokens || {};
  var signerFirstName = (tokens.signerName || '').split(' ')[0] || 'there';
  var ownerName = tokens.ownerName || 'Your trip organizer';
  // BUG FIX (independent bug pass, Aug 2026): "trip" replaced with
  // "adventure" to match this project's established brand-voice convention
  // (adventure-form.js, all email templates, and the site copy consistently
  // say "adventure," never "trip").
  var tripDateDisplay = tokens.tripDateDisplay || 'your upcoming adventure';

  var bodyHtml =
    '<p>' + ownerName + ' added you to an upcoming day on the trail with Palm Springs Adventure Club, on ' + tripDateDisplay + '.</p>' +
    '<p>Before the day arrives, we need a few quick things directly from you: your own signed Release of Liability, since no one else can sign on your behalf, plus a couple of optional questions that only take a minute.</p>' +
    '<p>The whole thing takes about two minutes, most of it optional.</p>';

  return renderActionNeededEmail({
    logoUrl: tokens.logoUrl,
    preheader: ownerName + ' added you to an adventure on ' + tripDateDisplay + '. A couple quick things need your own signature.',
    urgencyLabel: 'YOUR SIGNATURE NEEDED',
    eyebrow: 'YOU\'RE INVITED',
    headline: 'Hi ' + signerFirstName + ', <em>a couple quick things.</em>',
    bodyHtml: bodyHtml,
    ctaText: 'Get Started',
    ctaUrl: tokens.signerUrl,
  });
}

module.exports = { renderSignerWaiverInviteEmail };
