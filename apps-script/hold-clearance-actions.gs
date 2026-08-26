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
  // FIX (2026-08-25): see gearOps_normalizeDateString_'s header comment in
  // gear-inventory-actions.gs (same Apps Script project, shared global
  // scope) — the "date" cell is a real Date object, not a string, and a
  // naive String(r.date) comparison silently matched nothing. This is the
  // actual candidate list api/trigger-deposit-holds.js's T-1 cron depends
  // on, so this was the highest-impact of the three call sites this bug
  // hit.
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var status = r.bookingStatus || 'active';
    return status === 'active' && gearOps_normalizeDateString_(r.date).indexOf(payload.tripDate) === 0;
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
        // ADDED (payment-review, Aug 2026, High #24): api/check-hold-
        // clearance-deadline.js now re-verifies a non-'held' depositStatus
        // directly against Stripe before cancelling, in case the Sheet's
        // own 'held' write-back from this morning's hold attempt was
        // delayed or failed even though the hold itself succeeded. Needs
        // the PaymentIntent ID to check.
        depositPaymentIntentId: r.depositPaymentIntentId || '',
      };
    }),
  };
}

/**
 * Finds an OPEN Ops Alert of a given type for this booking, if any — so a
 * hold that clears between the 9am attempt and the noon check can have its
 * alert resolved automatically rather than sitting Open forever after the
 * underlying problem already fixed itself.
 *
 * GENERALIZED (payment-review, Aug 2026, High #11/#12): payload.alertType
 * is new and defaults to 'deposit_hold_failed' — every existing caller
 * (api/check-hold-clearance-deadline.js) doesn't pass it and is completely
 * unaffected. api/trigger-deposit-holds.js now reuses this same lookup with
 * both 'deposit_hold_failed' (dedup the guest-failure alert/email across
 * this cron's own 15-minute retry ticks) and a new 'deposit_hold_trigger_error'
 * (dedup the engineering-exception alert) — same mechanism, two alert types.
 */
function holdClearance_findOpenDepositAlert(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Ops Alerts');
  if (!sheet) return { found: false };
  var alertType = payload.alertType || 'deposit_hold_failed';
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    return String(r.bookingId) === String(payload.bookingId) &&
      r.alertType === alertType &&
      r.status === 'Open';
  });
  if (!rows.length) return { found: false };
  return { found: true, alertId: rows[0].alertId };
}
