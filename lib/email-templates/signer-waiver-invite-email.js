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

var { renderBaseEmail } = require('./base-wrapper');

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

  // REWRITTEN (Surface B copy refresh, 2026-09-14, per Airey's live-test
  // feedback that the 2026-09-03 pass's copy still read long and never
  // actually established what Palm Springs Adventure Club IS to someone
  // who's never seen the site -- see
  // claude/psac-surface-b-copy-refresh-proposal-2026-09-14.md Part 1.
  // Switched from the Action Needed shell to the Base shell: this is the
  // first, non-urgent touch (the reminder email already owns urgency
  // escalation at T-5/T-3, see signer-waiver-reminder-email.js), so the
  // old urgencyLabel ("YOUR SIGNATURE NEEDED") stacked a third framing of
  // the same idea on top of the eyebrow and headline before the reader
  // even knew what this was for.
  var headline = isGuardian
    ? 'Hi ' + signerFirstName + ', ' + ownerName + ' is bringing you and ' + childNamesDisplay + ' to the desert.'
    : 'Hi ' + signerFirstName + ', ' + ownerName + ' is bringing you to the desert.';

  var bodyHtml = isGuardian
    ? '<p>Palm Springs Adventure Club places small groups on a trail chosen for them, then delivers a full gear kit the night before for everyone attending, ' + childNamesDisplay + ' included.</p>'
      + '<p>' + ownerName + ' picked ' + tripDateDisplay + '. Before then we need two things only you can do: your own signature, and confirming you\u2019re ' + childNamesDisplay + '\u2019s parent or guardian for the day.</p>'
    : '<p>Palm Springs Adventure Club places small groups on a trail chosen for them, then delivers a full gear kit the night before, packs, poles, water, the works.</p>'
      + '<p>' + ownerName + ' picked ' + tripDateDisplay + '. Before then we just need your own signature, since no one else can sign for you.</p>';

  var preheader = isGuardian
    ? ownerName + ' is bringing you and ' + childNamesDisplay + ' to the desert. We just need your signature.'
    : ownerName + ' is bringing you to the desert. We just need your signature.';

  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: preheader,
    eyebrow: 'YOU\'RE IN',
    headline: headline,
    bodyHtml: bodyHtml,
    ctaText: 'Get Started',
    ctaUrl: tokens.signerUrl,
  });
}

// NEW (2026-09-10 email/SMS audit follow-up): subjectFor mirrors
// signer-waiver-reminder-email.js's own exported subjectFor pattern --
// the body/headline got their guardian split in the 2026-09-03 copy
// pass, but the subject line stayed hardcoded generic text at the
// call site (api/adventure-prep.js's sendSignerLinks), still reading
// "quick waiver needed" regardless of who's being emailed. This gives
// the caller a real subject to pass instead.
function subjectFor(tokens) {
  tokens = tokens || {};
  var ownerName = tokens.ownerName || 'Someone';
  var isGuardian = !!tokens.isAttendingGuardian && (tokens.guardianForChildNames || []).length > 0;
  if (isGuardian) {
    var childNamesDisplay = tokens.guardianForChildNames.join(' and ');
    return 'You\u2019re in, and so is ' + childNamesDisplay;
  }
  return 'You\u2019re in on ' + ownerName + '\u2019s trail day';
}

module.exports = { renderSignerWaiverInviteEmail, subjectFor };
