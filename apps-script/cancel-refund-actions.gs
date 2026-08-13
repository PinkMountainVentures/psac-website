/**
 * apps-script/cancel-refund-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs,
 * same delivery pattern as the prior Operations UX patches
 * (ops-alerts-actions.gs). Adds the two Sheet-side actions
 * api/cancel-and-refund-booking.js needs: a server-to-server (no guest
 * token) lookup, and the single atomic write that closes out a
 * cancellation.
 *
 * Built against claude/psac-operations-ux-jtbd-prd-v1.md Section 5 (the
 * cancel-and-refund mechanism) and Section 14 (this fires before any of the
 * T-3 cutoff's other steps).
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file in
 *    the same Apps Script project).
 *
 * 2. Wire the two new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'cancelRefund_getBookingContext') {
 *        out = cancelRefund_getBookingContext(body);
 *      } else if (body.action === 'cancelRefund_writeCancellation') {
 *        out = cancelRefund_writeCancellation(body);
 *
 *    Same assumption as every prior patch: doPost already validates
 *    body.secret against BOOKINGS_WEBAPP_SECRET before dispatching on
 *    action.
 *
 * 3. No new tab or setup() function needed — this patch only reads/writes
 *    columns apps-script/adventure-prep-actions.gs's own setup already
 *    creates on Experience Bookings (bookingStatus, cancelledAt, refundId,
 *    refundAmount, cancellationReasons) and appends to the existing
 *    Adventure Prep Change Log tab via that file's own
 *    adventurePrep_appendChangeLog_ helper. adventure-prep-actions.gs must
 *    already be installed before this patch will run.
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

/**
 * Server-to-server booking lookup by bookingId — no adventurePrepToken
 * involved, since api/cancel-and-refund-booking.js is only ever called from
 * another server-side job (api/process-t3-cutoff.js,
 * api/check-hold-clearance-deadline.js), never a guest browser. Returns
 * just what that endpoint needs: enough to run the Stripe refund and to
 * check idempotency before doing it.
 */
function cancelRefund_getBookingContext(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var booking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
  if (!booking) return { notFound: true };
  return {
    bookingId: booking.bookingId,
    contactEmail: booking.contactEmail,
    contactName: booking.contactName,
    tripDate: booking.date,
    mainPaymentIntentId: booking.mainPaymentIntentId,
    // Defaults to 'active' the same way adventurePrep_getContextByToken
    // already does for Surface A's own bookingStatus !== 'active' check —
    // a booking that predates this column existing reads as active, not as
    // some falsy/blank status a caller might mishandle.
    bookingStatus: booking.bookingStatus || 'active',
  };
}

/**
 * The one atomic write PRD Section 5 describes: bookingStatus, cancelledAt,
 * refundId, refundAmount, cancellationReasons on Experience Bookings, plus
 * a `changeType: 'cancellation'` Adventure Prep Change Log row, in a single
 * locked call — never two separate writes a caller could see half-applied.
 *
 * Payload: { bookingId, bookingStatus, cancelledAt, refundId, refundAmount,
 *            cancellationReasons (comma-joined string, matching this
 *            column's existing no-JSON-suffix naming convention) }
 */
function cancelRefund_writeCancellation(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Experience Bookings');
    var found = adventurePrep_findRowByColumnValue_(sheet, 'bookingId', payload.bookingId);
    if (!found) return { ok: false, error: 'Booking not found' };
    var map = found.headerMap;

    function set(name, value) {
      if (!map[name]) return; // tolerate a column not existing yet rather than throwing
      sheet.getRange(found.rowIndex, map[name]).setValue(value === undefined || value === null ? '' : value);
    }
    set('bookingStatus', payload.bookingStatus);
    set('cancelledAt', payload.cancelledAt);
    set('refundId', payload.refundId);
    set('refundAmount', payload.refundAmount);
    set('cancellationReasons', payload.cancellationReasons);

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'cancellation',
      beforeT3Cutoff: !!payload.beforeT3Cutoff,
      newValueJson: JSON.stringify({
        bookingStatus: payload.bookingStatus,
        refundId: payload.refundId,
        refundAmount: payload.refundAmount,
        cancellationReasons: payload.cancellationReasons,
      }),
      refundOrChargeAmount: payload.refundAmount,
      stripeTransactionId: payload.refundId,
      staffNotes: payload.staffNotes || '',
    });

    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
