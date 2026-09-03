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
 * @param {boolean} [tokens.isAttendingGuardian] - true for an attending
 *   adult the booker pre-assigned as a minor's guardian (Part 3.3's case).
 *   NOT the same as the non-attending guardian_only case (Part 5), which
 *   never reaches this template.
 * @param {string[]} [tokens.guardianForChildNames] - the minor(s) this
 *   signer is guardian for, only meaningful when isAttendingGuardian is true
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

  // NEW (copy pass, 2026-09-03): split by known guardian status --
  // isAttendingGuardian/guardianForChildNames come from
  // sendSignerLinksForBooking's own guardian_person_id lookup (Part 3.1's
  // correction: the doc originally assumed this was already known and it
  // wasn't, that lookup is what makes it real now). This is the attending
  // guardian case (3.3), a different person from the non-attending
  // guardian_only case, which gets its own, entirely different email tied
  // to Part 5's own hub, not this one.
  var isGuardian = !!tokens.isAttendingGuardian && (tokens.guardianForChildNames || []).length > 0;
  var childNamesDisplay = isGuardian ? tokens.guardianForChildNames.join(' and ') : '';

  var headline = isGuardian
    ? 'Hi ' + signerFirstName + ', <em>you\u2019re in, and so is ' + childNamesDisplay + '.</em>'
    : 'Hi ' + signerFirstName + ', <em>you\u2019re in.</em> A couple of things need your attention.';

  var bodyHtml = isGuardian
    ? '<p>' + ownerName + ' is bringing you and ' + childNamesDisplay + ' along on their adventure day with Palm Springs Adventure Club, on ' + tripDateDisplay + '. You\u2019ll both be placed on a trail that fits the group and get everything you need to be out there comfortably. A couple of things are left, and only you can handle them, starting with your own signature and confirming for ' + childNamesDisplay + ', that\u2019s what gets you both geared up and locked in.</p>'
    : '<p>' + ownerName + ' is bringing you along on their adventure day with Palm Springs Adventure Club, on ' + tripDateDisplay + '. You\u2019ll be placed on a trail that fits the group and get everything you need to be out there comfortably. A couple of things are left, and only you can handle them, starting with your signature, that\u2019s what gets your gear on its way.</p>';

  var preheader = isGuardian
    ? ownerName + ' is bringing you and ' + childNamesDisplay + ' along on their adventure day. A couple of things need your attention.'
    : ownerName + ' is bringing you along on their adventure day. A couple of things need your attention.';

  return renderActionNeededEmail({
    logoUrl: tokens.logoUrl,
    preheader: preheader,
    urgencyLabel: 'YOUR SIGNATURE NEEDED',
    eyebrow: 'YOU\'RE INVITED',
    headline: headline,
    bodyHtml: bodyHtml,
    ctaText: 'Get Started',
    ctaUrl: tokens.signerUrl,
  });
}

module.exports = { renderSignerWaiverInviteEmail };
