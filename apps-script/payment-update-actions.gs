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
 *
 * 2. Wire the new action into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'paymentUpdate_getBookingForToken') {
 *        out = paymentUpdate_getBookingForToken(body);
 *
 * No setup() needed — reads only, no new tabs/columns.
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

/**
 * Low-stakes guest-token auth, same posture as api/validate-delivery-
 * address.js: this is called directly from the guest's browser (the deposit-
 * hold-failed email's own link), so it can't safely hold a shared secret.
 * Reuses the booking's existing `adventurePrepToken` rather than minting a
 * new token type — one guest secret per booking, not two.
 */
function paymentUpdate_getBookingForToken(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var booking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
  if (!booking) return { notFound: true };
  if (!booking.adventurePrepToken || String(booking.adventurePrepToken) !== String(payload.token)) {
    return { unauthorized: true };
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
