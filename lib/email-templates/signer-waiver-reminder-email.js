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

  // REWRITTEN (Surface B copy refresh, 2026-09-14): both variants used
  // to restate the same stakes twice in a row (e.g. "without your
  // signature we can't have you out there" immediately followed by
  // "we need this by 10pm tonight or we won't be able to include you"
  // -- same claim, said twice). Collapsed to one sentence per idea, per
  // claude/psac-surface-b-copy-refresh-proposal-2026-09-14.md Part 2.
  // Urgency escalation between the two variants stays exactly as it
  // was (that split is correct and this pass doesn't touch it).
  var bodyHtml;
  if (isGuardian) {
    bodyHtml = isActionNeeded
      ? '<p>Hi ' + signerFirstName + ', ' + ownerName + '’s trail day is ' + tripDateFormatted + '.</p>'
        + '<p style="margin:16px 0 0 0;">Sign by 10pm tonight confirming you as ' + childNamesDisplay + '’s guardian, or we can’t include ' + childNamesDisplay + '.</p>'
      : '<p>Hi ' + signerFirstName + ', ' + ownerName + '’s trail day is ' + tripDateFormatted + ' and we still need your signature confirming you as ' + childNamesDisplay + '’s guardian.</p>'
        + '<p style="margin:16px 0 0 0;">Takes about two minutes.</p>';
  } else {
    bodyHtml = isActionNeeded
      ? '<p>Hi ' + signerFirstName + ', ' + ownerName + '’s trail day is ' + tripDateFormatted + '.</p>'
        + '<p style="margin:16px 0 0 0;">Sign by 10pm tonight or we can’t include you, no one else can sign for you.</p>'
      : '<p>Hi ' + signerFirstName + ', ' + ownerName + '’s trail day is ' + tripDateFormatted + ' and we still need your signature, no one else can sign for you.</p>'
        + '<p style="margin:16px 0 0 0;">Takes about two minutes.</p>';
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
