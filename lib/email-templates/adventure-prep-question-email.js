/* ============================================
   PSAC — Adventure Prep "Questions?" panel, guest message notification
   Sent from api/send-help-message.js when a guest submits the in-page
   "Questions? Ask us anything" panel (complete-adventure-prep.html /
   sign-waiver.html — see ap-styles.css's .help-panel rules). Replaces the
   provisional mailto: fallback (coordinating chat, 2026-09-02) with a real
   send: this lands in the reservations@ inbox with reply-to set to the
   guest's own address, so a staffer can just hit reply and the thread
   continues by email from there — no separate messaging system.

   Routine, not urgent (uses base-wrapper.js, not action-needed-wrapper.js):
   this is an internal notification to PSAC staff, not a guest-facing
   touchpoint, so it skips the guest-brand chrome (no CTA button — "reply"
   IS the action) but keeps the same visual wrapper as everything else for
   consistency in the inbox.
   ============================================ */

var { renderBaseEmail } = require('./base-wrapper');

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Preserves line breaks the guest actually typed in the textarea without
// trusting any HTML they typed.
function messageToHtml(message) {
  return '<p style="white-space: pre-wrap;">' + escapeHtml(message).replace(/\n/g, '<br>') + '</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.guestName
 * @param {string} tokens.guestEmail - may be empty if none on file
 * @param {string} tokens.bookingId
 * @param {string} tokens.tripDateDisplay - already formatted, e.g. "August 20"
 * @param {string} tokens.sourcePage - 'Adventure Prep hub' or 'Waiver signer page'
 * @param {string} tokens.message - the guest's raw typed text
 */
function renderAdventurePrepQuestionEmail(tokens) {
  tokens = tokens || {};
  var guestName = escapeHtml(tokens.guestName || 'A guest');
  var sourcePage = escapeHtml(tokens.sourcePage || 'Adventure Prep');

  var detailRows = [
    { label: 'From', value: guestName + (tokens.guestEmail ? ' &lt;' + escapeHtml(tokens.guestEmail) + '&gt;' : ' (no email on file)') },
    { label: 'Booking', value: escapeHtml(tokens.bookingId || 'unknown') },
    { label: 'Trip date', value: escapeHtml(tokens.tripDateDisplay || 'unknown') },
    { label: 'Sent from', value: sourcePage },
  ];

  return renderBaseEmail({
    logoUrl: tokens.logoUrl,
    preheader: guestName + ' asked a question from the ' + sourcePage + ' page.',
    eyebrow: 'GUEST QUESTION',
    headline: guestName + ' <em>asked a question.</em>',
    bodyHtml: messageToHtml(tokens.message),
    detailRows: detailRows,
  });
}

module.exports = { renderAdventurePrepQuestionEmail };
