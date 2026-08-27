/**
 * apps-script/payment-update-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Sheet-side support for api/create-payment-update-session.js and
 * api/save-updated-payment-method.js — the real "update your payment
 * method" destination for the deposit-hold-failed email
 * (lib/email-templates/deposit-hold-failed-email.js), closing the gap
 * flagged in the Aug 2026 build-review addendum (item 8: "no such page was
 * found built anywhere in this project").
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file).
 *    Requires apps-script/adventure-prep-actions.gs already pasted in
 *    (reuses adventurePrep_findExperienceBookingById_, shared global scope).
 *    As of the payment-review Medium #41 fix, also requires apps-script/
 *    hold-clearance-actions.gs already pasted in (reuses
 *    holdClearance_findOpenDepositAlert) — already live from an earlier
 *    round, nothing new to paste for this dependency specifically.
 *
 * 2. Wire the new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'paymentUpdate_getBookingForToken') {
 *        out = paymentUpdate_getBookingForToken(body);
 *      } else if (body.action === 'paymentUpdate_recordCardUpdated') {
 *        out = paymentUpdate_recordCardUpdated(body);
 *
 * No setup() needed — paymentUpdate_recordCardUpdated (added Aug 2026,
 * Medium #40) reuses the existing Adventure Prep Change Log tab, no new
 * tabs/columns.
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

/**
 * Guest-token auth, same posture as api/validate-delivery-address.js: this
 * is called directly from the guest's browser (the deposit-hold-failed
 * email's own link), so it can't safely hold a shared secret. Reuses the
 * booking's existing `adventurePrepToken` rather than minting a new token
 * type — one guest secret per booking, not two.
 *
 * BUG FIX (payment-review, Aug 2026, Medium #41): this token authorizes a
 * meaningfully more sensitive action than validate-delivery-address.js's
 * own use of it — redirecting a booking's future off-session charges to a
 * new card, not editing an address — but had no additional scoping,
 * expiry, or single-use protection: the same long-lived, non-expiring,
 * many-times-reused adventurePrepToken worked for this forever, for the
 * life of the booking, even long after any actual card-failure issue was
 * resolved. Rather than mint and track a whole second token type (a new
 * Sheet column, an expiry, a mint step wired into the email-send path),
 * scoped this action to only work while there's a genuinely open
 * deposit_hold_failed Ops Alert for the booking — the one real situation
 * this flow exists to resolve (see this file's own header). Reuses
 * holdClearance_findOpenDepositAlert (already generalized to take an
 * alertType in the payment-review's Batch-4 alerting pass) rather than a
 * new lookup. This closes all three gaps the finding named without a
 * schema change: scoping (only usable during a live, open problem),
 * expiry (bounded to however long that problem stays open, not
 * indefinite), and effectively single-use too — api/save-updated-payment-
 * method.js's own success path already auto-resolves this exact alert
 * (Medium #40), so a second use of the same leaked token immediately after
 * a legitimate one now also fails this same check.
 */
function paymentUpdate_getBookingForToken(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var booking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
  if (!booking) return { notFound: true };
  if (!booking.adventurePrepToken || String(booking.adventurePrepToken) !== String(payload.token)) {
    return { unauthorized: true };
  }
  var openAlert = holdClearance_findOpenDepositAlert({ bookingId: booking.bookingId, alertType: 'deposit_hold_failed' });
  if (!openAlert.found) {
    return { noOpenIssue: true };
  }
  return {
    ok: true,
    bookingId: booking.bookingId,
    mainPaymentIntentId: booking.mainPaymentIntentId,
    contactEmail: booking.contactEmail,
    contactName: booking.contactName,
    depositStatus: booking.depositStatus || '',
  };
}

/**
 * NEW (payment-review, Aug 2026, Medium #40): a successful card update in
 * api/save-updated-payment-method.js used to write nothing back to the
 * Sheet at all — no record of the event anywhere. Reuses the generic
 * Adventure Prep Change Log (adventurePrep_appendChangeLog_, already shared
 * across every other write-back in this project) rather than adding a new
 * dedicated column, since this is a one-off event log entry, not a field
 * that needs to be read back later. No setup()/new tab needed.
 */
function paymentUpdate_recordCardUpdated(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_appendChangeLog_(ss, {
    bookingId: payload.bookingId,
    changeType: 'payment_method_updated',
    newValueJson: JSON.stringify({ paymentMethodId: payload.paymentMethodId || '' }),
    staffNotes: 'Guest updated their card via the self-service payment-method-update page.',
  });
  return { ok: true };
}
