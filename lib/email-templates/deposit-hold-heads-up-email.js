/* ============================================
   PSAC — "Your gear deposit hold is coming" pre-notification

   CORRECTED (payment/card-capture consolidation, 2026-09-11): this used
   to say "a day or two before" -- confirmed against
   api/send-deposit-hold-heads-up.js's own 8am Pacific gate, this actually
   fires the MORNING OF T-1 itself, one hour ahead of the 9am Pacific
   hold-placement cron (api/trigger-deposit-holds.js). Copy locked in
   psac-copy-drafts.md section 5, opening clause added per the 2026-09-10
   email/SMS Sinek/Godin/Miller audit (this was the flattest email in that
   audit -- pure administrivia with no acknowledgment that the reason for
   the hold is the trail day getting close). Action-needed template: not
   urgent in the sense of a deadline, but time-boxed (fires right before
   something happens to the guest's card) and gives them a chance to fix
   a card problem before staff try to place the hold rather than after it
   fails.

   WIRED (payment/card-capture consolidation, 2026-09-11): cardUpdateUrl
   now points at the guest's Adventure Hub (/complete-adventure-prep?
   token=...), same link-back-to-Hub pattern every other guest touchpoint
   already uses -- not a standalone page. api/send-deposit-hold-heads-
   up.js builds it and passes it through; the guest lands on the Hub's own
   "Update Card" screen (adventure-prep-form.js's renderUpdateCard(),
   authorized under the `deposit_hold_not_yet_attempted` reason -- see
   lib/payment-update-service.js).
   ============================================ */

var { renderActionNeededEmail } = require('./action-needed-wrapper');

function buildBodyHtml(tokens) {
  return '<p>Your trail day\'s getting close, so here\'s one housekeeping item before the fun part. In the next day or two, we\'ll place a $' + tokens.depositAmount + ' refundable hold on the card on file for your gear kit' + (tokens.kitCount > 1 ? 's' : '') + '.</p>' +
    '<p>This is not a charge, it\'s released once your gear comes back in good shape.</p>' +
    '<p>If your card on file has changed, now\'s a good time to update it so nothing gets held up before your trail day.</p>';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string|number} tokens.depositAmount - the total hold about to be
 *   placed, in dollars (per-kit rate x kit count -- see
 *   api/create-deposit-hold.js's TIERS table; NOT always $65, e.g. a
 *   2-kit Trail booking holds $130). NOT WIRED YET (2026-09-02): nothing
 *   currently calls this template -- fixed anyway per Airey's "find all
 *   the locations" request, so it's correct whenever it does get wired.
 * @param {number} [tokens.kitCount] - only used to pluralize "gear kit(s)"
 * @param {string} [tokens.cardUpdateUrl] - the guest's Adventure Hub link
 *   (/complete-adventure-prep?token=...); omit only if the booking somehow
 *   has no adventure_prep_token on file.
 */
function renderDepositHoldHeadsUpEmail(tokens) {
  tokens = tokens || {};
  return renderActionNeededEmail({
    logoUrl: tokens.logoUrl,
    preheader: 'Your $' + tokens.depositAmount + ' refundable gear deposit hold is coming in the next day or two.',
    urgencyLabel: 'DEPOSIT HOLD COMING',
    eyebrow: 'GEAR DEPOSIT',
    headline: 'Your hold is <em>on its way.</em>',
    bodyHtml: buildBodyHtml(tokens),
    ctaText: tokens.cardUpdateUrl ? 'Update Your Card' : undefined,
    ctaUrl: tokens.cardUpdateUrl
  });
}

module.exports = { renderDepositHoldHeadsUpEmail };
