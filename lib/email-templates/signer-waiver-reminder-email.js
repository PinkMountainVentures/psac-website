/* ============================================
   PSAC — Signer waiver reminder (T-5/midpoint + T-3 morning)
   New touchpoint, added this session (Sept 2026 SMS build). The
   per-signer equivalent of adventure-prep-stall-reminder-email.js: that
   file reminds the BOOKER about every outstanding track (1.2a, waiver,
   address); this one reminds one specific non-owner signer about the one
   thing only they can do, their own signature, at the same two cadence
   moments (T-5/compressed-midpoint "reminder", T-3 morning
   "action_needed"). Fired per-signer from
   api/check-adventure-prep-cadence.js's own t5/midwindow/t3 stage
   handling, piggybacking on that job's existing idempotency guard
   (booking_cadence_log's per-booking, per-stage marker), not a new
   stage-tracking mechanism of its own.

   UPDATED (2026-09-10 email/SMS audit follow-up): now personalizes for a
   known attending guardian, mirroring signer-waiver-invite-email.js's own
   isAttendingGuardian/guardianForChildNames split. Originally shipped
   deliberately guardian-agnostic (flagged as a scope simplification, not
   an oversight, since the lookup needs a resolved person_id this signer
   usually doesn't have pre-signing) -- the lookup itself already existed
   for the invite email, so this just runs the same one
   (getIncompleteSignersForReminder now resolves it). A signer this
   lookup can't resolve yet (no person_id) falls through to the original
   guardian-agnostic copy below, unchanged.

   Two variants, same base/action-needed shell split as the booker's own
   stall reminder and this repo's established convention
   (base-wrapper.js's own header: "for anything routine, not urgent";
   action-needed-wrapper.js's: "for anything urgent, time-boxed"):
     'reminder'      -- T-5 / midwindow. Base shell, routine framing.
     'action_needed' -- T-3 morning. Action Needed shell, hard-deadline framing.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');
var { renderActionNeededEmail } = require('./action-needed-wrapper');

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.signerName
 * @param {string} tokens.ownerName - the booking owner who added this signer
 * @param {string} tokens.tripDateFormatted - e.g. "Saturday, September 12"
 * @param {string} tokens.signerUrl - the tokenized Surface B link
 * @param {'reminder'|'action_needed'} tokens.variant
 * @param {boolean} [tokens.isAttendingGuardian] - true for a known
 *   attending guardian (mirrors signer-waiver-invite-email.js's own flag)
 * @param {string[]} [tokens.guardianForChildNames] - the minor(s) this
 *   signer is guardian for, only meaningful when isAttendingGuardian is true
 * @returns {string} full HTML document
 */
function renderSignerWaiverReminderEmail(tokens) {
  tokens = tokens || {};
  var signerFirstName = (tokens.signerName || '').split(' ')[0] || 'there';
  var ownerName = tokens.ownerName || 'Your trip organizer';
  var tripDateFormatted = tokens.tripDateFormatted || 'the trail day';
  var isActionNeeded = tokens.variant === 'action_needed';
  var isGuardian = !!tokens.isAttendingGuardian && (tokens.guardianForChildNames || []).length > 0;
  var childNamesDisplay = isGuardian ? tokens.guardianForChildNames.join(' and ') : '';

  var headline = isActionNeeded
    ? 'We still need your signature'
    : 'Let’s get your signature squared away';

  var bodyHtml;
  if (isGuardian) {
    bodyHtml = isActionNeeded
      ? '<p>Hi ' + signerFirstName + ',</p>'
        + '<p>' + ownerName + '’s trail day is ' + tripDateFormatted + ', and without your signature confirming you as ' + childNamesDisplay + '’s guardian, we can’t have ' + childNamesDisplay + ' out there with the group.</p>'
        + '<p style="margin:16px 0 0 0;">We need this by 10pm tonight, or we won’t be able to include ' + childNamesDisplay + '.</p>'
      : '<p>Hi ' + signerFirstName + ',</p>'
        + '<p>' + ownerName + '’s trail day is coming up on ' + tripDateFormatted + '. We still need your signature, confirming you as ' + childNamesDisplay + '’s guardian, so you’re both covered to be out there with the group.</p>'
        + '<p style="margin:16px 0 0 0;">It only takes a couple minutes, and it’s the one thing only you can do for ' + childNamesDisplay + '’s spot on this trip.</p>';
  } else {
    bodyHtml = isActionNeeded
      ? '<p>Hi ' + signerFirstName + ',</p>'
        + '<p>' + ownerName + '’s trail day is ' + tripDateFormatted + ', and without your signature, we can’t have you out there with the group.</p>'
        + '<p style="margin:16px 0 0 0;">We need this by 10pm tonight, or we won’t be able to include you.</p>'
      : '<p>Hi ' + signerFirstName + ',</p>'
        + '<p>' + ownerName + '’s trail day is coming up on ' + tripDateFormatted + '. We still need your signature so you’re covered to be out there with the group.</p>'
        + '<p style="margin:16px 0 0 0;">It only takes a couple minutes, and it’s the one thing only you can do for this trip.</p>';
  }

  var preheader = isActionNeeded
    ? 'Action needed by 10pm tonight, we still need your signature.'
    : 'We still need your signature before ' + tripDateFormatted + '.';

  var renderFn = isActionNeeded ? renderActionNeededEmail : renderBaseEmail;

  return renderFn({
    logoUrl: tokens.logoUrl,
    preheader: preheader,
    urgencyLabel: 'ACTION NEEDED TONIGHT',
    eyebrow: 'YOUR SIGNATURE',
    headline: headline,
    bodyHtml: bodyHtml,
    ctaText: 'Sign Now',
    ctaUrl: tokens.signerUrl,
  });
}

module.exports = {
  renderSignerWaiverReminderEmail,
  subjectFor: (variant) => (variant === 'action_needed' ? 'Action needed by 10pm tonight, your signature' : 'We still need your signature'),
};
