/* ============================================
   PSAC — Bookings & Operations Apps Script
   Bound to the "PSAC Bookings & Operations" Google Sheet
   (https://docs.google.com/spreadsheets/d/1LrBe77Yds7YQswbJoQ-ikIXpzcd1m_QqkTJPLK3Nsog).

   This file is kept here for reference/version history. It has to be
   pasted into that sheet's Apps Script editor by hand (Extensions >
   Apps Script) — see the deployment steps given alongside this file for
   the one-time setup.

   Responsibilities:
   - setup(): creates the People, Experience Bookings, and Gear Check Log
     tabs with headers, if they don't already exist. Run once manually.
   - doPost(e): receives booking data from the site's /api/save-booking
     endpoint, finds-or-creates the Person by email, appends an
     Experience Booking row, and generates the Gear Check Log item rows
     (per-kit items + shared delivery duffels). Also dispatches the five
     Trail Selection Logic actions (getAdventurePrepContext,
     getTrailDatabase, getParkAccess, writeCandidateTrails,
     openTrailSwapRequest) — those five functions themselves live in the
     separate apps-script/trail-selection-actions.gs file, pasted into
     this same Apps Script project as an additional .gs file (Apps Script
     projects share one global scope across files, no merge needed).
     Updated Aug 2026 when Trail Selection Logic (bucket 2.2) shipped.
     Updated again Aug 2026 when Adventure Prep (Surface A/B) shipped —
     dispatches thirteen more actions, all implemented in
     apps-script/adventure-prep-actions.gs (also pasted in as an
     additional .gs file). That file also appends new columns to
     Experience Bookings (adventurePrepToken, bookingStatus, cancelledAt,
     refundAmount, cancellationReasons) and to Adventure Prep
     (reconfirmedRosterJson, linksSentAt, createdAt) via its own
     adventurePrep_setup() — the HEADERS constant below is NOT updated to
     list them, since every read/write those new columns need goes through
     adventurePrep-actions.gs's own live-header-lookup helpers, never this
     file's hardcoded HEADERS array. Run adventurePrep_setup() once after
     pasting that file in, per its own install instructions.
     Updated again Aug 2026 when the Operations UX build shipped —
     dispatches the cadence_*, cancelRefund_*, holdClearance_*,
     manualAdjustment_*, opsAlerts_*, trailSwap_*, changeLog_*,
     paymentUpdate_*, and t3Cutoff_* actions, implemented across
     cadence-actions.gs, cancel-refund-actions.gs,
     hold-clearance-actions.gs, manual-adjustment-actions.gs,
     ops-alerts-actions.gs, trail-swap-actions.gs, change-log-actions.gs,
     payment-update-actions.gs, and t3-cutoff-actions.gs respectively.
     SYNCED 2026-08-24: this file had drifted from the live Apps Script
     project (all of the above were pasted directly into the editor and
     never copied back here) — brought back in sync from a direct copy of
     the live doPost, same day the getBookingByPaymentIntentId action
     below was added.
   - getBookingByPaymentIntentId (added 2026-08-24): a read-only recovery
     lookup for api/save-booking.js. Confirmed via psac-build-checklist.md
     that this Web App intermittently serves a generic Google interstitial
     page instead of its real JSON output even when the underlying
     execution (including a saveBooking call) completed and wrote data
     correctly — save-booking.js has no safe way to retry saveBooking
     itself (not idempotent, would create a duplicate booking), so instead
     it can recover the real bookingId/adventurePrepToken by looking the
     booking back up using the one value it already had before the failed
     call: the main PaymentIntent id.
   - ROOT-CAUSE FIX (2026-08-25, gear-ops live verification pass): the
     entire Gear Inventory build (apps-script/gear-inventory-actions.gs —
     units management, allocation, checkout, checkin, reconciliation,
     shortfall charge/refund, hold-renewal candidates) was fully
     implemented — all 23 gearOps_* functions exist and are individually
     correct — but this doPost() was NEVER updated to dispatch to any of
     them. Every gearOps_* call from the site (api/checkout-gear.js,
     api/check-in-gear-item.js, api/manage-gear-units.js,
     api/allocate-gear-units.js, api/reconcile-gear-deposit.js,
     api/charge-gear-shortfall.js, api/refund-gear-charge.js,
     api/check-gear-availability.js, api/renew-deposit-hold.js, and the
     new api/trigger-gear-reconciliation.js cron) was silently falling
     into the final `else { out = { ok: false, error: 'Unknown action' } }`
     branch — always HTTP 200 (Apps Script's ContentService always returns
     200), so callers saw a normally-shaped-but-empty/false response
     instead of a hard error, which is why the Ops app's checkout queue
     rendered as "no bookings" instead of visibly failing. Found by tracing
     the full call path end-to-end (front-end -> api/ops-proxy.js ->
     api/checkout-gear.js -> lib/apps-script-client.js -> here) after the
     gearOps_normalizeDateString_ date-filter fix, confirmed correct in
     isolation, still didn't fix the live symptom. All 23 actions are added
     below in one block, in the same order they're defined in
     gear-inventory-actions.gs.
   ============================================ */

var SHEETS = {
  people: 'People',
  bookings: 'Experience Bookings',
  gearLog: 'Gear Check Log'
};

var HEADERS = {
  'People': ['personId', 'name', 'email', 'phone', 'stripeCustomerId', 'membershipTier', 'memberSince', 'renewalDate', 'createdAt', 'smsConsent', 'smsConsentAt', 'smsConsentText'],
  'Experience Bookings': ['bookingId', 'createdAt', 'personId', 'contactName', 'contactEmail', 'contactPhone', 'tier', 'date', 'timePreference', 'gearKitCount', 'duffelCount', 'total', 'mainPaymentIntentId', 'depositPaymentIntentId', 'depositStatus', 'smsConsent', 'smsConsentAt', 'smsConsentText', 'fullPayloadJson'],
  'Gear Check Log': ['itemRowId', 'bookingId', 'kitNumber', 'personName', 'itemName', 'itemCost', 'checkedOutAt', 'checkedInAt', 'condition', 'graceDeadline', 'recoveredAt', 'notes']
};

// Reference item costs, matching the per-kit breakdown used to size the
// deposit hold (see api/create-deposit-hold.js on the site).
var ITEM_COSTS = {
  'Gregory Miko 20L Backpack': 159,
  'Hydro Flask Big Mouth 32oz Bottle': 42,
  'Leki Khumbu Lite Trekking Poles': 129,
  'REI Pack Mule 90L Duffel': 159,
  'Hard-Shell First Aid Kit': 9.99
};

// Run this once from the Apps Script editor (select "setup" in the
// function dropdown, then press Run). Creates the three tabs with the
// right headers if they're missing, and tidies up the default blank
// "Sheet1" Google leaves behind on a brand new spreadsheet.
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    var headers = HEADERS[name];
    var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    var needsHeaders = headers.some(function (h, i) { return existing[i] !== h; });
    if (needsHeaders) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  });
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 3) {
    ss.deleteSheet(def);
  }
}

function doPost(e) {
  var out;
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body || body.secret !== getSharedSecret()) {
      return respond({ ok: false, error: 'Unauthorized' });
    }
    if (body.action === 'saveBooking') {
      out = handleSaveBooking(body);
    } else if (body.action === 'getBooking') {
      out = handleGetBooking(body);
    } else if (body.action === 'getBookingByPaymentIntentId') {
      out = handleGetBookingByPaymentIntentId(body);
    } else if (body.action === 'updateDepositStatus') {
      out = handleUpdateDepositStatus(body);
    } else if (body.action === 'getAdventurePrepContext') {
      out = trailSelection_getAdventurePrepContext(body.bookingId);
    } else if (body.action === 'getTrailDatabase') {
      out = trailSelection_getTrailDatabase();
    } else if (body.action === 'getParkAccess') {
      out = trailSelection_getParkAccess();
    } else if (body.action === 'writeCandidateTrails') {
      out = trailSelection_writeCandidateTrails(body);
    } else if (body.action === 'openTrailSwapRequest') {
      out = trailSelection_openTrailSwapRequest(body);
    } else if (body.action === 'adventurePrep_getContextByToken') {
      out = adventurePrep_getContextByToken(body);
    } else if (body.action === 'adventurePrep_saveFields') {
      out = adventurePrep_saveFields(body);
    } else if (body.action === 'adventurePrep_selectTrail') {
      out = adventurePrep_selectTrail(body);
    } else if (body.action === 'adventurePrep_saveWaiverSignature') {
      out = adventurePrep_saveWaiverSignature(body);
    } else if (body.action === 'adventurePrep_saveEmergencyContact') {
      out = adventurePrep_saveEmergencyContact(body);
    } else if (body.action === 'adventurePrep_sendSignerLinks') {
      out = adventurePrep_sendSignerLinks(body);
    } else if (body.action === 'adventurePrep_getSignerContext') {
      out = adventurePrep_getSignerContext(body);
    } else if (body.action === 'adventurePrep_markSignerOpened') {
      out = adventurePrep_markSignerOpened(body);
    } else if (body.action === 'adventurePrep_getKitContext') {
      out = adventurePrep_getKitContext(body);
    } else if (body.action === 'adventurePrep_setPendingKitChange') {
      out = adventurePrep_setPendingKitChange(body);
    } else if (body.action === 'adventurePrep_finalizeKitChange') {
      out = adventurePrep_finalizeKitChange(body);
    } else if (body.action === 'adventurePrep_listPendingKitChanges') {
      out = adventurePrep_listPendingKitChanges(body);
    } else if (body.action === 'adventurePrep_ensureToken') {
      out = adventurePrep_ensureToken(body);
    } else if (body.action === 'cadence_getBookingContext') {
      out = cadence_getBookingContext(body);
    } else if (body.action === 'cadence_setStallFlags') {
      out = cadence_setStallFlags(body);
    } else if (body.action === 'cadence_recordStageSent') {
      out = cadence_recordStageSent(body);
    } else if (body.action === 'cadence_listActiveBookings') {
      out = cadence_listActiveBookings(body);
    } else if (body.action === 'cancelRefund_getBookingContext') {
      out = cancelRefund_getBookingContext(body);
    } else if (body.action === 'cancelRefund_writeCancellation') {
      out = cancelRefund_writeCancellation(body);
    } else if (body.action === 'holdClearance_findOpenDepositAlert') {
      out = holdClearance_findOpenDepositAlert(body);
    } else if (body.action === 'holdClearance_listBookingsForTripDate') {
      out = holdClearance_listBookingsForTripDate(body);
    } else if (body.action === 'manualAdjustment_kitCountCorrection') {
      out = manualAdjustment_kitCountCorrection(body);
    } else if (body.action === 'manualAdjustment_gearCheckLogAdjustment') {
      out = manualAdjustment_gearCheckLogAdjustment(body);
    } else if (body.action === 'manualAdjustment_changeLogNote') {
      out = manualAdjustment_changeLogNote(body);
    } else if (body.action === 'manualAdjustment_gearReturnedUncleaned') {
      out = manualAdjustment_gearReturnedUncleaned(body);
    } else if (body.action === 'manualAdjustment_updateDeliveryAddress') {
      out = manualAdjustment_updateDeliveryAddress(body);
    } else if (body.action === 'opsAlerts_recordAlert') {
      out = opsAlerts_recordAlert(body);
    } else if (body.action === 'opsAlerts_resolveAlert') {
      out = opsAlerts_resolveAlert(body);
    } else if (body.action === 'opsAlerts_listAll') {
      out = opsAlerts_listAll(body);
    } else if (body.action === 'trailSwap_logIntake') {
      out = trailSwap_logIntake(body);
    } else if (body.action === 'trailSwap_getRequestContext') {
      out = trailSwap_getRequestContext(body);
    } else if (body.action === 'trailSwap_getDropdownOptions') {
      out = trailSwap_getDropdownOptions(body);
    } else if (body.action === 'trailSwap_applyOverride') {
      out = trailSwap_applyOverride(body);
    } else if (body.action === 'trailSwap_listAll') {
      out = trailSwap_listAll(body);
    } else if (body.action === 'changeLog_listRecent') {
      out = changeLog_listRecent(body);
    } else if (body.action === 'paymentUpdate_getBookingForToken') {
      out = paymentUpdate_getBookingForToken(body);
    } else if (body.action === 'paymentUpdate_recordCardUpdated') {
      out = paymentUpdate_recordCardUpdated(body);
    } else if (body.action === 't3Cutoff_getProcessingContext') {
      out = t3Cutoff_getProcessingContext(body);
    } else if (body.action === 't3Cutoff_removeUncoveredKit') {
      out = t3Cutoff_removeUncoveredKit(body);
    } else if (body.action === 't3Cutoff_writeRideWithGpsAccess') {
      out = t3Cutoff_writeRideWithGpsAccess(body);
    } else if (body.action === 't3Cutoff_markProcessed') {
      out = t3Cutoff_markProcessed(body);
    } else if (body.action === 't3Cutoff_listActiveBookings') {
      out = t3Cutoff_listActiveBookings(body);
    // ADDED (payment-review, Aug 2026, Medium #42): a whole-invocation
    // overlap guard for api/process-t3-cutoff.js — see
    // t3Cutoff_acquireRunLock's own header comment in t3-cutoff-actions.gs.
    } else if (body.action === 't3Cutoff_acquireRunLock') {
      out = t3Cutoff_acquireRunLock(body);
    } else if (body.action === 't3Cutoff_releaseRunLock') {
      out = t3Cutoff_releaseRunLock(body);
    // ---- Gear Inventory build (gear-inventory-actions.gs) ----
    // ROOT-CAUSE FIX (2026-08-25): these 23 actions were fully implemented
    // in gear-inventory-actions.gs but had no dispatch branch here at all
    // — see this file's header comment for the full story. Order matches
    // the function order in gear-inventory-actions.gs.
    } else if (body.action === 'gearOps_listUnits') {
      out = gearOps_listUnits(body);
    } else if (body.action === 'gearOps_addUnit') {
      out = gearOps_addUnit(body);
    } else if (body.action === 'gearOps_retireUnit') {
      out = gearOps_retireUnit(body);
    } else if (body.action === 'gearOps_markClean') {
      out = gearOps_markClean(body);
    } else if (body.action === 'gearOps_markDeepCleaned') {
      out = gearOps_markDeepCleaned(body);
    } else if (body.action === 'gearOps_checkAvailabilityRaw') {
      out = gearOps_checkAvailabilityRaw(body);
    } else if (body.action === 'gearOps_getCheckoutQueue') {
      out = gearOps_getCheckoutQueue(body);
    } else if (body.action === 'gearOps_allocateUnits') {
      out = gearOps_allocateUnits(body);
    } else if (body.action === 'gearOps_getAllocation') {
      out = gearOps_getAllocation(body);
    } else if (body.action === 'gearOps_recordShortageResolution') {
      out = gearOps_recordShortageResolution(body);
    } else if (body.action === 'gearOps_confirmCheckoutScan') {
      out = gearOps_confirmCheckoutScan(body);
    } else if (body.action === 'gearOps_markDelivered') {
      out = gearOps_markDelivered(body);
    } else if (body.action === 'gearOps_getCheckinQueue') {
      out = gearOps_getCheckinQueue(body);
    } else if (body.action === 'gearOps_getCheckinContext') {
      out = gearOps_getCheckinContext(body);
    } else if (body.action === 'gearOps_checkInItem') {
      out = gearOps_checkInItem(body);
    } else if (body.action === 'gearOps_getReconciliationContext') {
      out = gearOps_getReconciliationContext(body);
    } else if (body.action === 'gearOps_writeReconciliation') {
      out = gearOps_writeReconciliation(body);
    } else if (body.action === 'gearOps_listReconciliationQueue') {
      out = gearOps_listReconciliationQueue(body);
    } else if (body.action === 'gearOps_recordShortfallCharge') {
      out = gearOps_recordShortfallCharge(body);
    } else if (body.action === 'gearOps_recordShortfallChargeFailure') {
      out = gearOps_recordShortfallChargeFailure(body);
    } else if (body.action === 'gearOps_recordRefund') {
      out = gearOps_recordRefund(body);
    } else if (body.action === 'gearOps_listHoldRenewalCandidates') {
      out = gearOps_listHoldRenewalCandidates(body);
    } else if (body.action === 'gearOps_recordHoldRenewed') {
      out = gearOps_recordHoldRenewed(body);
    // ---- Ops App Redesign Round 1 (ops-redesign-round1-actions.gs) ----
    } else if (body.action === 'allBookings_listAll') {
      out = allBookings_listAll(body);
    } else if (body.action === 'opsAlerts_listExpanded') {
      out = opsAlerts_listExpanded(body);
    } else if (body.action === 'stalled_listAll') {
      out = stalled_listAll(body);
    } else if (body.action === 'stalled_markCalled') {
      out = stalled_markCalled(body);
    } else if (body.action === 'cancellations_listAll') {
      out = cancellations_listAll(body);
    // ---- Ops App Redesign Round 2 (ops-redesign-round2-actions.gs) ----
    } else if (body.action === 'gearOps_markReadyForDelivery') {
      out = gearOps_markReadyForDelivery(body);
    } else if (body.action === 'gearOps_scheduleDelivery') {
      out = gearOps_scheduleDelivery(body);
    } else if (body.action === 'gearOps_markDeliveredFinal') {
      out = gearOps_markDeliveredFinal(body);
    } else if (body.action === 'gearOps_schedulePickup') {
      out = gearOps_schedulePickup(body);
    } else if (body.action === 'gearOps_markPickedUp') {
      out = gearOps_markPickedUp(body);
    } else if (body.action === 'gearOps_markReturned') {
      out = gearOps_markReturned(body);
    } else if (body.action === 'gearOps_getReturnContext') {
      out = gearOps_getReturnContext(body);
    } else if (body.action === 'gearOps_getCheckinQueueV2') {
      out = gearOps_getCheckinQueueV2(body);
    } else if (body.action === 'gearOps_syncReturnStatusIfSettled') {
      out = gearOps_syncReturnStatusIfSettled(body);
    } else if (body.action === 'manualAdjustment_trailDayChange') {
      out = manualAdjustment_trailDayChange(body);
    } else if (body.action === 'manualAdjustment_swapAllocatedUnit') {
      out = manualAdjustment_swapAllocatedUnit(body);
    } else if (body.action === 'manualAdjustment_postDeliveryCancellation') {
      out = manualAdjustment_postDeliveryCancellation(body);
    } else {
      out = { ok: false, error: 'Unknown action' };
    }
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return respond(out);
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSharedSecret() {
  return PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
}

function handleSaveBooking(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var personId, bookingId, gearRowsCreated;
  try {
    var contact = payload.contact || {};
    personId = findOrCreatePerson(ss, contact.name, contact.email, contact.phone,
      contact.smsConsent, contact.smsConsentAt, contact.smsConsentText);
    bookingId = 'BK-' + Utilities.getUuid().slice(0, 8).toUpperCase();
    var now = new Date().toISOString();

    var bookingsSheet = ss.getSheetByName(SHEETS.bookings);
    bookingsSheet.appendRow([
      bookingId,
      now,
      personId,
      contact.name || '',
      contact.email || '',
      contact.phone || '',
      payload.tier || '',
      payload.date || '',
      payload.timePreference || '',
      payload.gearKitsSelected || 0,
      payload.duffelCount || 0,
      payload.total || 0,
      payload.paymentIntentId || '',
      payload.depositPaymentIntentId || '',
      payload.depositStatus || '',
      // Point-in-time record of what this specific booking's guest agreed
      // to, distinct from the Person record's latest-wins value below —
      // see findOrCreatePerson()'s comment for why they're handled
      // differently.
      !!contact.smsConsent,
      contact.smsConsentAt || '',
      contact.smsConsentText || '',
      JSON.stringify(payload)
    ]);

    var gearRows = buildGearLogRows(bookingId, payload);
    if (gearRows.length) {
      var gearSheet = ss.getSheetByName(SHEETS.gearLog);
      gearSheet.getRange(gearSheet.getLastRow() + 1, 1, gearRows.length, gearRows[0].length).setValues(gearRows);
    }
    gearRowsCreated = gearRows.length;
  } finally {
    lock.releaseLock();
  }

  // NEW (Aug 2026): mint this booking's Adventure Prep token inline, right
  // here at booking time, instead of leaving every booking without one
  // until someone manually runs adventurePrep_ensureToken() as a backfill.
  // Per that function's own doc comment and the Adventure Prep build
  // handoff, token generation at booking time was explicitly deferred to
  // "the booking-flow chat's job" — this is that.
  //
  // Deliberately called AFTER releasing the lock above, not nested inside
  // it. adventurePrep_ensureToken() acquires its own LockService.
  // getScriptLock() — and Apps Script's script lock is scoped to the whole
  // script, not to a specific sheet/resource, so calling it while this
  // execution still held the lock above would just be this same execution
  // waiting on a lock only it could release: a guaranteed timeout, not a
  // real concurrency race. The tiny gap between releasing the lock and this
  // call is safe: the booking row already exists in the sheet by this
  // point, and ensureToken is idempotent (PRD-required: "stable,
  // non-rotating"), so nothing is lost even if something else touched this
  // booking in between.
  var adventurePrepToken = '';
  try {
    var tokenResult = adventurePrep_ensureToken({ bookingId: bookingId });
    if (tokenResult && tokenResult.ok) {
      adventurePrepToken = tokenResult.token;
    } else {
      console.error('adventurePrep_ensureToken did not return ok for booking ' + bookingId + ':', tokenResult);
    }
  } catch (tokenErr) {
    // Never fail the booking save over this — the guest already paid and
    // the booking row is already written. A missing token here just means
    // the confirmation email/SMS/closing screen won't have an Adventure
    // Prep link yet; adventurePrep_ensureToken can still be re-run for this
    // bookingId later (via the webapp) to backfill it.
    console.error('adventurePrep_ensureToken threw for booking ' + bookingId + ':', tokenErr);
  }

  return {
    ok: true,
    personId: personId,
    bookingId: bookingId,
    gearLogRowsCreated: gearRowsCreated,
    adventurePrepToken: adventurePrepToken
  };
}

// Looks up a single booking row by bookingId, for the Internal Operations
// UX calling api/create-deposit-hold.js at T-1. Returns just the fields
// that endpoint needs to place the hold itself server-side, never trusting
// tier/kit count/payment method from the caller.
function handleGetBooking(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var found = findBookingRow(ss, payload.bookingId);
  if (!found) {
    return { ok: false, error: 'Booking not found' };
  }
  var row = found.values;
  // FIX (2026-08-25, gear-ops live verification pass): the kit count used
  // to size the T-1 deposit hold must reflect the guest's real, CURRENT
  // kit count, never the count captured at booking time (row[9]). A guest
  // who adjusts their kit count post-booking via the normal Adventure Prep
  // flow (lib/finalize-kit-change.js) only ever writes Adventure Prep's
  // own confirmedKitCount column - it never touches this row - so reading
  // row[9] alone silently under- or over-sizes every hold placed after
  // such a change. Prefer confirmedKitCount when an Adventure Prep row
  // exists and has a real value; fall back to the booking-time count
  // otherwise (no Adventure Prep row yet, or a booking that predates this
  // fix).
  var ap = adventurePrep_readAdventurePrepRow_(ss, payload.bookingId);
  var hasConfirmedCount = ap && ap.confirmedKitCount !== '' && ap.confirmedKitCount != null;
  var effectiveGearKitCount = hasConfirmedCount ? ap.confirmedKitCount : row[9];
  return {
    ok: true,
    bookingId: row[0],
    tier: row[6],
    gearKitCount: effectiveGearKitCount,
    mainPaymentIntentId: row[12],
    depositPaymentIntentId: row[13],
    depositStatus: row[14]
  };
}

// Recovery lookup for api/save-booking.js (added 2026-08-24): if the
// original saveBooking call's response got lost to the confirmed-
// transient "Web App served a Google interstitial page instead of JSON"
// glitch (psac-build-checklist.md), the booking row itself may already
// have been written correctly — this lets the caller check by the one
// value it already had from BEFORE the failed call (the main
// PaymentIntent id), rather than duplicate the booking by retrying
// saveBooking itself. Read-only, safe to call as often as needed.
// adventurePrepToken isn't in this file's own HEADERS constant (see the
// file header comment), so its column is read the same way
// adventurePrep-actions.gs's own helpers do — a live header lookup, never
// a hardcoded index.
function handleGetBookingByPaymentIntentId(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pid = String(payload.paymentIntentId || '').trim();
  if (!pid) {
    return { ok: false, error: 'Missing paymentIntentId' };
  }
  var sheet = ss.getSheetByName(SHEETS.bookings);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][12] || '').trim() === pid) {
      var map = adventurePrep_headerMap_(sheet);
      var tokenCol = map['adventurePrepToken'];
      return {
        ok: true,
        personId: data[i][2],
        bookingId: data[i][0],
        adventurePrepToken: tokenCol ? (data[i][tokenCol - 1] || '') : ''
      };
    }
  }
  return { ok: false, error: 'No booking found for that PaymentIntent.' };
}

// Writes the outcome of a T-1 deposit hold attempt back onto the booking's
// row, called by api/create-deposit-hold.js after it resolves the hold
// with Stripe (held / failed / unavailable / requires_action), so the
// sheet reflects the real result instead of the "scheduled_t1" placeholder
// written at booking time.
// BUG FIX (payment-review, Aug 2026, Follow-up A — the reverse-direction
// twin of High #14's renewal-vs-reconciliation race, flagged during that
// fix but not closed until now): this write previously had no LockService
// lock at all, unlike every other depositStatus writer in this codebase
// (gearOps_writeReconciliation, gearOps_recordShortfallCharge, etc. all
// already lock). Added one here so the compare-and-swap check below is
// actually atomic with the write, not just a read-then-hope. The guard
// itself: when the caller explicitly passes payload.guardReconciled
// (api/create-deposit-hold.js does this only for a renewal write-back),
// refuse the write if the row's CURRENT depositStatus already reflects a
// completed reconciliation — meaning reconciliation's own ~15-minute cron
// finished FIRST and this renewal write would otherwise silently clobber
// that back to 'held' (or whatever the renewal attempt produced),
// reviving an already-settled, possibly fully-refunded booking with an
// unwanted live Stripe hold on the guest's card. Every other caller (the
// T-1 initial placement path) omits guardReconciled and is completely
// unaffected — the guard only ever activates when explicitly requested.
function handleUpdateDepositStatus(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var found = findBookingRow(ss, payload.bookingId);
    if (!found) {
      return { ok: false, error: 'Booking not found' };
    }

    if (payload.guardReconciled) {
      var currentStatus = found.sheet.getRange(found.rowIndex, 15).getValue();
      var RECONCILED_DEPOSIT_STATUSES = ['released', 'partial_capture', 'full_capture', 'full_capture_pending_review', 'shortfall_charged'];
      if (RECONCILED_DEPOSIT_STATUSES.indexOf(String(currentStatus)) !== -1) {
        return { ok: false, stale: true, bookingId: payload.bookingId, currentDepositStatus: String(currentStatus) };
      }
    }

    // depositPaymentIntentId is column 14, depositStatus is column 15
    // (1-indexed) in the Experience Bookings sheet — see HEADERS above.
    found.sheet.getRange(found.rowIndex, 14).setValue(payload.depositPaymentIntentId || '');
    found.sheet.getRange(found.rowIndex, 15).setValue(payload.depositStatus || '');
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// Shared lookup: finds a booking's row by bookingId in the Experience
// Bookings sheet. Returns { sheet, rowIndex, values } (rowIndex is
// 1-indexed, matching Range APIs) or null if not found.
function findBookingRow(ss, bookingId) {
  var id = String(bookingId || '').trim();
  if (!id) return null;
  var sheet = ss.getSheetByName(SHEETS.bookings);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim() === id) {
      return { sheet: sheet, rowIndex: i + 1, values: data[i] };
    }
  }
  return null;
}

// Dedup by email, case-insensitive. First write wins for name/phone on
// repeat bookings — fine for now, worth revisiting once there's a reason
// to let contact details update on file. SMS consent is handled the
// opposite way on purpose: always overwritten to the guest's latest
// answer, since a returning guest's texting preference can genuinely
// change between bookings, and the Person record should reflect their
// current stated choice rather than whatever they first said. The
// point-in-time record of what was actually agreed to on any one specific
// booking lives on that booking's own row in Experience Bookings instead,
// which never gets overwritten.
function findOrCreatePerson(ss, name, email, phone, smsConsent, smsConsentAt, smsConsentText) {
  var sheet = ss.getSheetByName(SHEETS.people);
  var data = sheet.getDataRange().getValues();
  var emailLower = String(email || '').trim().toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (emailLower && String(data[i][2] || '').trim().toLowerCase() === emailLower) {
      var rowIndex = i + 1;
      // smsConsent / smsConsentAt / smsConsentText are columns 10-12
      // (1-indexed) in the People sheet — see HEADERS above.
      sheet.getRange(rowIndex, 10, 1, 3).setValues([[!!smsConsent, smsConsentAt || '', smsConsentText || '']]);
      return data[i][0];
    }
  }
  var personId = 'PER-' + Utilities.getUuid().slice(0, 8).toUpperCase();
  sheet.appendRow([personId, name || '', email || '', phone || '', '', '', '', '', new Date().toISOString(),
    !!smsConsent, smsConsentAt || '', smsConsentText || '']);
  return personId;
}

// One row per physical item: 4 per gear kit (backpack, 2 bottles, poles)
// plus the shared delivery duffels (1 duffel per up to 2 kits), matching
// the duffelCount already computed client-side.
function buildGearLogRows(bookingId, payload) {
  var rows = [];
  var gearCount = Math.max(0, parseInt(payload.gearKitsSelected, 10) || 0);
  var duffelCount = Math.max(0, parseInt(payload.duffelCount, 10) || 0);
  var roster = (payload.roster || []).filter(function (p) { return p && p.gearKit; });

  for (var k = 0; k < gearCount; k++) {
    var personName = (roster[k] && roster[k].name) ? roster[k].name : ('Kit ' + (k + 1));
    rows.push(gearRow(bookingId, k + 1, personName, 'Gregory Miko 20L Backpack'));
    rows.push(gearRow(bookingId, k + 1, personName, 'Hydro Flask Big Mouth 32oz Bottle'));
    rows.push(gearRow(bookingId, k + 1, personName, 'Hydro Flask Big Mouth 32oz Bottle'));
    rows.push(gearRow(bookingId, k + 1, personName, 'Leki Khumbu Lite Trekking Poles'));
    rows.push(gearRow(bookingId, k + 1, personName, 'Hard-Shell First Aid Kit'));
  }
  for (var d = 0; d < duffelCount; d++) {
    rows.push(gearRow(bookingId, '', 'Shared', 'REI Pack Mule 90L Duffel'));
  }
  return rows;
}

function gearRow(bookingId, kitNumber, personName, itemName) {
  return [
    Utilities.getUuid().slice(0, 8).toUpperCase(),
    bookingId,
    kitNumber,
    personName,
    itemName,
    ITEM_COSTS[itemName] || '',
    '', '', '', '', '', ''
  ];
}