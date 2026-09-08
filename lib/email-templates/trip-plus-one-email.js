/* ============================================
   PSAC — "How was it?" T+1 email (Post-Adventure Check-in, 2026-09-08)
   See claude/psac-post-adventure-phase3-final-spec-2026-09-08.md,
   sections 4/5/7, and api/send-trip-plus-one-email.js (the cron that
   sends this). Sent trip date + 1, 9am Pacific -- the notification
   only, never an embedded rating or a reply-to: the CTA always lands on
   the recipient's own hub Check-in card (see adventure-prep-form.js's
   checkinCardHtml / waiver-signer-form.js's checkinCardHtml and
   guardianOnlyCheckinCardHtml), the same "The Turn" -> Check-in
   sequencing this email's own send time is the boundary for
   (computePostAdventurePhase in both frontend files).

   Four persona variants, one render function -- `persona` picks the
   copy, matching the reported_by_role values lib/feedback-service.js
   already uses everywhere else in this build:
     'booker'              -- Surface A, the booking owner
     'participant'         -- Surface B, plain attending signer
     'participant_guardian' -- Surface B, attending signer who's also a
                               guardian (same copy as guardian_only's
                               headline, see spec section 5: "The Turn"
                               and this email's headline both already
                               stay on the child's experience, so nothing
                               here needs to change for a non-attending
                               guardian either)
     'guardian_only'        -- Surface B, non-attending guardian --
                               genuinely different BODY copy (a remote
                               reader, per section 5), same headline as
                               participant_guardian.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

function copyForPersona(persona, trailName, ownerName, childLabel) {
  var trail = trailName || 'the trail';
  var owner = ownerName || 'the trip owner';
  var child = childLabel || 'them';
  if (persona === 'participant') {
    return {
      headline: 'How was your day on <em>' + trail + '?</em>',
      bodyHtml: '<p>Hope you had a good one out there. ' + owner + ' brought you along, we’d love to hear how the day went from your side too, takes less than a minute.</p>',
      preheader: 'Hope you had a good one out there, we’d love to hear how the day went.',
    };
  }
  if (persona === 'participant_guardian') {
    return {
      headline: 'How did ' + child + ' do on <em>' + trail + '?</em>',
      bodyHtml: '<p>Hope ' + child + ' had a great one out there today. We’d love to hear how it went, takes less than a minute.</p>',
      preheader: 'Hope ' + child + ' had a great one out there today, we’d love to hear how it went.',
    };
  }
  if (persona === 'guardian_only') {
    return {
      headline: 'How did ' + child + ' do on <em>' + trail + '?</em>',
      bodyHtml: '<p>Hope ' + child + ' had a great one out there today. We’d love to hear how it felt on your end too, takes less than a minute.</p>',
      preheader: 'Hope ' + child + ' had a great one out there today, we’d love to hear how it felt on your end too.',
    };
  }
  // 'booker' (default/fallback -- an unrecognized persona still gets a
  // sensible, generic send rather than a blank email)
  return {
    headline: 'How was <em>' + trail + '?</em>',
    bodyHtml: '<p>Hope ' + trail + ' treated you well. We’d love to hear how it went, takes less than a minute.</p>',
    preheader: 'Hope ' + trail + ' treated you well, we’d love to hear how it went.',
  };
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.persona - 'booker' | 'participant' | 'participant_guardian' | 'guardian_only'
 * @param {string} tokens.trailName
 * @param {string} [tokens.ownerName] - participant persona only
 * @param {string} [tokens.childLabel] - guardian personas only
 * @param {string} tokens.ctaUrl - this recipient's own hub URL (adventure_prep_token or signer_token)
 */
function renderTripPlusOneEmail(tokens) {
  tokens = tokens || {};
  var copy = copyForPersona(tokens.persona, tokens.trailName, tokens.ownerName, tokens.childLabel);
  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: copy.preheader,
    eyebrow: 'PEAKS TO POOLS',
    headline: copy.headline,
    bodyHtml: copy.bodyHtml,
    ctaText: 'See How It Went',
    ctaUrl: tokens.ctaUrl,
  });
}

module.exports = { renderTripPlusOneEmail };
