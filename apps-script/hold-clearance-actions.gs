/**
 * apps-script/hold-clearance-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Sheet-side support for api/check-hold-clearance-deadline.js — Operations
 * UX PRD Section 6's noon Pacific, T-1 dispatch-day go/no-go check, and
 * Section 18 item 5a's resolution of what happens when a hold never clears.
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file).
 *
 * 2. Wire the two new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'holdClearance_listBookingsForTripDate') {
 *        out = holdClearance_listBookingsForTripDate(body);
 *      } else if (body.action === 'holdClearance_findOpenDepositAlert') {
 *        out = holdClearance_findOpenDepositAlert(body);
 *
 * No new setup() needed — reads/writes only tabs and columns already
 * created by earlier patches (Experience Bookings' own `depositStatus`
 * column is pre-existing per the booking flow's own build, not new here;
 * `Ops Alerts` was created by apps-script/ops-alerts-actions.gs).
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

/**
 * Every active booking whose trip date is exactly `tripDate` (the caller
 * passes "tomorrow," Pacific — see api/check-hold-clearance-deadline.js's
 * own header for why this cron runs on T-1 dispatch day, not trip day
 * itself), with each one's current `depositStatus` — read fresh at call
 * time, since bucket 2.9's own create-deposit-hold.js / Stripe webhook may
 * have updated it any time between the 9am attempt and this noon check.
 */
function holdClearance_listBookingsForTripDate(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var status = r.bookingStatus || 'active';
    return status === 'active' && String(r.date || '').indexOf(payload.tripDate) === 0;
  });
  return {
    bookings: rows.map(function (r) {
      return {
        bookingId: r.bookingId,
        depositStatus: r.depositStatus || '',
        contactEmail: r.contactEmail,
        contactName: r.contactName,
        // Needed by api/trigger-deposit-holds.js to build the guest-facing
        // "update payment method" link (api/create-payment-update-session.js)
        // without a second round-trip.
        adventurePrepToken: r.adventurePrepToken || '',
      };
    }),
  };
}

/**
 * Finds an OPEN `deposit_hold_failed` Ops Alert for this booking, if any —
 * so a hold that clears between the 9am attempt and the noon check can have
 * its alert resolved automatically rather than sitting Open forever after
 * the underlying problem already fixed itself.
 */
function holdClearance_findOpenDepositAlert(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Ops Alerts');
  if (!sheet) return { found: false };
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    return String(r.bookingId) === String(payload.bookingId) &&
      r.alertType === 'deposit_hold_failed' &&
      r.status === 'Open';
  });
  if (!rows.length) return { found: false };
  return { found: true, alertId: rows[0].alertId };
}
