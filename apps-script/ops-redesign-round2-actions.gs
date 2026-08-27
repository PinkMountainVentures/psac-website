/**
 * apps-script/ops-redesign-round2-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Backs Phase 4, Round 2 of claude/psac-ops-ux-journey-map-phases-1-3.md —
 * the two-leg gear logistics state machines (outbound: Ready for Delivery /
 * Delivery Scheduled / Delivered; inbound: Pickup Scheduled / Picked Up
 * (optional) / Returned (required gate) / Checked-In (automatic)), Gear
 * Units' Mark Repaired (no new function needed — reuses gearOps_markClean
 * unconditionally, confirmed decision, see claude/psac-ops-redesign-open-
 * items-confirmed.md item 3), and Manual Adjustment's three new types.
 *
 * Deliberately does NOT redefine any function from gear-inventory-
 * actions.gs, manual-adjustment-actions.gs, or ops-redesign-round1-
 * actions.gs — Apps Script's shared global scope means a same-named
 * function in a later-pasted file WOULD silently override an earlier one,
 * but relying on paste order for correctness is exactly the kind of
 * fragility this project's whole "PASTE-IN PATCH, additive only" convention
 * exists to avoid. Every new behavior here has its own new function name,
 * even where it duplicates a couple of lines from an existing one (e.g.
 * gearOps_markDeliveredFinal below vs. the older gearOps_markDelivered).
 *
 * ============================================================================
 * SCHEMA — new Experience Bookings columns this patch adds
 * ============================================================================
 *
 * deliveryStatus, deliveryServiceType, deliveryTimeSlot, deliveryScheduledAt,
 * deliveryReadyAt — the outbound leg's new explicit state, alongside the
 * existing gearDeliveredAt/gearDeliveredBy (untouched, still written too).
 *
 * returnStatus, pickupServiceType, pickupScheduledAt, pickupAddressOverride,
 * pickupTimeNote, pickedUpAt, gearReturnedAt — the inbound leg, entirely new
 * (there is no prior "returned" signal anywhere in this codebase today).
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file).
 *    Requires apps-script/adventure-prep-actions.gs, apps-script/gear-
 *    inventory-actions.gs, and apps-script/manual-adjustment-actions.gs
 *    already pasted in (reuses their shared helpers/constants).
 *
 * 2. Wire the new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'gearOps_markReadyForDelivery') {
 *        out = gearOps_markReadyForDelivery(body);
 *      } else if (body.action === 'gearOps_scheduleDelivery') {
 *        out = gearOps_scheduleDelivery(body);
 *      } else if (body.action === 'gearOps_markDeliveredFinal') {
 *        out = gearOps_markDeliveredFinal(body);
 *      } else if (body.action === 'gearOps_schedulePickup') {
 *        out = gearOps_schedulePickup(body);
 *      } else if (body.action === 'gearOps_markPickedUp') {
 *        out = gearOps_markPickedUp(body);
 *      } else if (body.action === 'gearOps_markReturned') {
 *        out = gearOps_markReturned(body);
 *      } else if (body.action === 'gearOps_getReturnContext') {
 *        out = gearOps_getReturnContext(body);
 *      } else if (body.action === 'gearOps_getCheckinQueueV2') {
 *        out = gearOps_getCheckinQueueV2(body);
 *      } else if (body.action === 'gearOps_syncReturnStatusIfSettled') {
 *        out = gearOps_syncReturnStatusIfSettled(body);
 *      } else if (body.action === 'manualAdjustment_trailDayChange') {
 *        out = manualAdjustment_trailDayChange(body);
 *      } else if (body.action === 'manualAdjustment_swapAllocatedUnit') {
 *        out = manualAdjustment_swapAllocatedUnit(body);
 *      } else if (body.action === 'manualAdjustment_postDeliveryCancellation') {
 *        out = manualAdjustment_postDeliveryCancellation(body);
 *
 * 3. Run opsRedesignRound2_setup() once from the Apps Script editor after
 *    pasting. Safe to re-run (idempotent, additive-only).
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

var OPS_REDESIGN_ROUND2_COLUMNS_ = [
  'deliveryStatus', 'deliveryServiceType', 'deliveryTimeSlot', 'deliveryScheduledAt', 'deliveryReadyAt',
  'returnStatus', 'pickupServiceType', 'pickupScheduledAt', 'pickupAddressOverride', 'pickupTimeNote', 'pickedUpAt', 'gearReturnedAt',
];

function opsRedesignRound2_setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_appendColumnsIfMissing_(ss, 'Experience Bookings', OPS_REDESIGN_ROUND2_COLUMNS_);
}

// ---------------------------------------------------------------------------
// Outbound leg: Ready for Delivery -> Delivery Scheduled -> Delivered
// ---------------------------------------------------------------------------

function gearOps_markReadyForDelivery(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var now = adventurePrep_nowIso_();
    target.sheet.getRange(target.rowIndex, target.headerMap['deliveryStatus']).setValue('ready_for_delivery');
    target.sheet.getRange(target.rowIndex, target.headerMap['deliveryReadyAt']).setValue(now);
    return { ok: true, bookingId: payload.bookingId, deliveryStatus: 'ready_for_delivery' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * deliveryServiceType: 'psac_staff' | 'uber_direct'. deliveryTimeSlot: a
 * string chosen client-side from the dropdown constrained to the guest's
 * own deliveryWindow (Adventure Prep) — this function does not itself
 * validate the slot falls within that window; the UI is the constraint
 * (Round 2 spec: "the UI should constrain the time picker to that window,
 * not just display it as a label"). When deliveryServiceType is
 * 'uber_direct', this is the trigger point for the actual courier dispatch
 * call per this project's existing Uber Direct integration plans (bucket
 * 2.11) — that dispatch call itself is explicitly OUT OF SCOPE for this
 * build (still Post-MVP, per the kickoff prompt), so this function only
 * writes the field; it does not call any dispatch API.
 */
function gearOps_scheduleDelivery(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var now = adventurePrep_nowIso_();
    target.sheet.getRange(target.rowIndex, target.headerMap['deliveryStatus']).setValue('delivery_scheduled');
    target.sheet.getRange(target.rowIndex, target.headerMap['deliveryServiceType']).setValue(payload.deliveryServiceType || '');
    target.sheet.getRange(target.rowIndex, target.headerMap['deliveryTimeSlot']).setValue(payload.deliveryTimeSlot || '');
    target.sheet.getRange(target.rowIndex, target.headerMap['deliveryScheduledAt']).setValue(now);
    return { ok: true, bookingId: payload.bookingId, deliveryStatus: 'delivery_scheduled' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Supersedes the older gearOps_markDelivered (still defined in gear-
 * inventory-actions.gs, now unused dead code rather than removed — see
 * this file's header for why it isn't redefined in place). Writes the SAME
 * gearDeliveredAt/gearDeliveredBy columns that function always wrote (so
 * gearOps_getCheckinQueue's old V1 filter, and anything else reading those
 * two columns, keeps working unchanged), plus the new deliveryStatus field.
 */
function gearOps_markDeliveredFinal(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var now = adventurePrep_nowIso_();
    target.sheet.getRange(target.rowIndex, target.headerMap['gearDeliveredAt']).setValue(now);
    target.sheet.getRange(target.rowIndex, target.headerMap['gearDeliveredBy']).setValue(payload.deliveredBy || '');
    target.sheet.getRange(target.rowIndex, target.headerMap['deliveryStatus']).setValue('delivered');
    return { ok: true, bookingId: payload.bookingId, gearDeliveredAt: now, gearDeliveredBy: payload.deliveredBy || '', deliveryStatus: 'delivered' };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Inbound leg: Pickup Scheduled -> (optional) Picked Up -> Returned (gate) -> Checked-In (automatic)
// ---------------------------------------------------------------------------

/**
 * pickupAddressOverride/pickupTimeNote: blank = use the default (same
 * address as delivery, standard nightly sweep time) — Round 2's
 * default-plus-override model. Non-blank = the guest/property genuinely
 * needs something different; staff read and act on the free-text note the
 * same way they already handle propertyType gaps elsewhere in this app.
 */
function gearOps_schedulePickup(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var now = adventurePrep_nowIso_();
    target.sheet.getRange(target.rowIndex, target.headerMap['returnStatus']).setValue('pickup_scheduled');
    target.sheet.getRange(target.rowIndex, target.headerMap['pickupServiceType']).setValue(payload.pickupServiceType || '');
    target.sheet.getRange(target.rowIndex, target.headerMap['pickupAddressOverride']).setValue(payload.pickupAddressOverride || '');
    target.sheet.getRange(target.rowIndex, target.headerMap['pickupTimeNote']).setValue(payload.pickupTimeNote || '');
    target.sheet.getRange(target.rowIndex, target.headerMap['pickupScheduledAt']).setValue(now);
    return { ok: true, bookingId: payload.bookingId, returnStatus: 'pickup_scheduled' };
  } finally {
    lock.releaseLock();
  }
}

/** Optional, skippable per Round 2's own decision — settable manually today, automatable later via an Uber Direct webhook with zero staff effort. Not required to reach Returned. */
function gearOps_markPickedUp(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var now = adventurePrep_nowIso_();
    target.sheet.getRange(target.rowIndex, target.headerMap['returnStatus']).setValue('picked_up');
    target.sheet.getRange(target.rowIndex, target.headerMap['pickedUpAt']).setValue(now);
    return { ok: true, bookingId: payload.bookingId, returnStatus: 'picked_up' };
  } finally {
    lock.releaseLock();
  }
}

/** The required gate: gear is physically back at the business. This is what should actually reveal the per-item condition-assessment view on Return Check-In, not trail-day/delivered filtering alone. */
function gearOps_markReturned(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var now = adventurePrep_nowIso_();
    target.sheet.getRange(target.rowIndex, target.headerMap['returnStatus']).setValue('returned');
    target.sheet.getRange(target.rowIndex, target.headerMap['gearReturnedAt']).setValue(now);
    return { ok: true, bookingId: payload.bookingId, returnStatus: 'returned' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Called by the Node layer right after every successful per-item check-in
 * write (api/check-in-gear-item.js), so Checked-In gets set the instant
 * the LAST item's condition is recorded — automatic, not a button staff
 * clicks, matching Round 2's spec exactly. Reuses gearOps_isBookingSettled_
 * (gear-inventory-actions.gs, already global-scope-shared) rather than
 * re-deriving "is every item judged" a second way.
 */
function gearOps_syncReturnStatusIfSettled(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var gearSheet = ss.getSheetByName('Gear Check Log');
  var gearRows = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
    return String(r.bookingId) === String(payload.bookingId);
  });
  var nowIso = payload.nowIso || adventurePrep_nowIso_();
  var settled = gearOps_isBookingSettled_(gearRows, nowIso);
  if (!settled) return { ok: true, bookingId: payload.bookingId, settled: false };

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var found = adventurePrep_findRowByColumnValue_(ss.getSheetByName('Experience Bookings'), 'bookingId', payload.bookingId);
    if (!found) return { ok: false, error: 'Booking not found' };
    var sheet = ss.getSheetByName('Experience Bookings');
    if (found.headerMap['returnStatus']) sheet.getRange(found.rowIndex, found.headerMap['returnStatus']).setValue('checked_in');
    return { ok: true, bookingId: payload.bookingId, settled: true, returnStatus: 'checked_in' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Everything the Pickup Scheduled panel's default-preview needs: the
 * delivery address/time to show as the default, plus current return-leg
 * field values for pre-filling an override edit. ALSO reused by the
 * checkout page's Delivery Scheduled mini-form (proxied there as
 * gearCheckout_getDeliveryContext, api/checkout-gear.js's
 * 'getDeliveryContext' action) purely to read `deliveryWindow` — the
 * guest's own 3pm-5pm/5pm-7pm/7pm-9pm Adventure Prep selection the Delivery
 * Time dropdown must be constrained to (journey map's "the UI should
 * constrain the time picker to that window, not just display it as a
 * label"). One read function, two callers — no reason to duplicate this
 * Adventure Prep lookup a second time for a single extra field.
 */
function gearOps_getReturnContext(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var booking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
  if (!booking) return { notFound: true };
  var ap = adventurePrep_readAdventurePrepRow_(ss, payload.bookingId);
  return {
    bookingId: payload.bookingId,
    deliveryAddressLine1: ap ? ap.deliveryAddressLine1 : '',
    deliveryAddressLine2: ap ? ap.deliveryAddressLine2 : '',
    deliveryCity: ap ? ap.deliveryCity : '',
    deliveryState: ap ? ap.deliveryState : '',
    deliveryZip: ap ? ap.deliveryZip : '',
    deliveryAddressRaw: ap ? ap.deliveryAddressRaw : '',
    deliveryWindow: ap ? ap.deliveryWindow : '',
    deliveryStatus: booking.deliveryStatus || '',
    deliveryReadyAt: booking.deliveryReadyAt || '',
    deliveryScheduledAt: booking.deliveryScheduledAt || '',
    deliveryTimeSlot: booking.deliveryTimeSlot || '',
    deliveryServiceType: booking.deliveryServiceType || '',
    gearDeliveredAt: booking.gearDeliveredAt || '',
    gearDeliveredBy: booking.gearDeliveredBy || '',
    returnStatus: booking.returnStatus || '',
    pickupServiceType: booking.pickupServiceType || '',
    pickupAddressOverride: booking.pickupAddressOverride || '',
    pickupTimeNote: booking.pickupTimeNote || '',
    pickedUpAt: booking.pickedUpAt || '',
    gearReturnedAt: booking.gearReturnedAt || '',
  };
}

/**
 * Supersedes gearOps_getCheckinQueue (V1, still defined and unused —
 * see this file's header). Shows the WHOLE return pipeline for a trip
 * date, not just "delivered" bookings — Pickup Scheduled through Checked-
 * In — so staff can see upcoming pickups, not only ones already back.
 * Also includes 'cancelled_post_delivery' bookings (Manual Adjustment's
 * new post-delivery-cancellation type, below) alongside 'active' ones,
 * since gear still has to come back even though the trip itself is off.
 */
function gearOps_getCheckinQueueV2(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var status = r.bookingStatus || 'active';
    var statusOk = status === 'active' || status === 'cancelled_post_delivery';
    return statusOk && gearOps_normalizeDateString_(r.date).indexOf(payload.tripDate) === 0 && r.gearDeliveredAt;
  });
  return {
    bookings: rows.map(function (r) {
      return {
        bookingId: r.bookingId, contactName: r.contactName, tripDate: r.date,
        bookingStatus: r.bookingStatus || 'active',
        gearDeliveredAt: r.gearDeliveredAt,
        returnStatus: r.returnStatus || '',
        pickupServiceType: r.pickupServiceType || '',
        pickupScheduledAt: r.pickupScheduledAt || '',
        pickedUpAt: r.pickedUpAt || '',
        gearReturnedAt: r.gearReturnedAt || '',
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Manual Adjustment — three new types (Round 2 field-level spec)
// ---------------------------------------------------------------------------

/**
 * Updates the booking's trail day and clears cadenceStagesSent so the
 * stall-detection cadence re-evaluates cleanly against the new date rather
 * than treating stages already sent against the OLD date as sent for the
 * new one too. Does NOT itself re-run the trail-selection engine — that's
 * the Node-layer caller's job (api/apply-manual-adjustment.js calls
 * lib/run-trail-assignment.js's runTrailAssignmentForBooking with
 * operation:'refresh' right after this write succeeds, reusing the exact
 * `trail_refresh` mechanism Trail Selection Logic PRD Section 2 Amendment 2
 * already defines, per this build's explicit instruction not to invent a
 * second recompute path).
 */
function manualAdjustment_trailDayChange(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var oldDate = target.sheet.getRange(target.rowIndex, target.headerMap['date']).getValue();
    target.sheet.getRange(target.rowIndex, target.headerMap['date']).setValue(payload.newTripDate);
    if (target.headerMap['cadenceStagesSent']) target.sheet.getRange(target.rowIndex, target.headerMap['cadenceStagesSent']).setValue('');

    // BUG FIX (Ops App Redesign, Aug 2026, caught building the Manual
    // Adjustment page's own Adjustment Type filter): this originally wrote
    // no Change Log row at all, unlike its sibling swap_allocated_unit and
    // post_delivery_cancellation (both below), which each log their own
    // changeType inline. Left as-is, a trail day/date change would have
    // been invisible to the Manual Adjustment page's "Recent Change Log
    // entries" table entirely — no audit trail, and nothing for the
    // Adjustment Type filter to ever match against. Logging here now,
    // matching the other two new types' own pattern instead of relying on
    // staff to separately run change_log_note as its own step.
    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'trail_day_change',
      oldValueJson: JSON.stringify({ tripDate: oldDate }),
      newValueJson: JSON.stringify({ tripDate: payload.newTripDate }),
      staffNotes: payload.staffNotes || '',
    });

    return { ok: true, bookingId: payload.bookingId, oldTripDate: oldDate, newTripDate: payload.newTripDate };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Covers a wrong size/type caught before delivery, a unit found damaged/
 * dirty after allocation, and gear lost/destroyed/broken in transit or
 * mid-rental. `reason` drives the ORIGINAL unit's new status:
 *   - 'damaged_before_delivery' | 'broken_during_rental'  -> damaged_pending_repair
 *   - 'dirty_before_delivery'                              -> needs_cleaning
 *   - 'wrong_size_or_type'                                 -> available (nothing wrong with the unit itself, just the wrong pick — goes straight back to the pool)
 *   - 'lost_or_destroyed_in_transit'                       -> retired
 * If payload.noSubstitute is true, the new-unit side is skipped entirely
 * (booking rescheduled/refunded through a separate playbook instead) — the
 * checkbox's own UI copy, not re-validated here beyond "newUnitId is only
 * required when noSubstitute is falsy."
 */
var MANUAL_ADJ_SWAP_REASON_TO_ORIGINAL_STATUS_ = {
  damaged_before_delivery: 'damaged_pending_repair',
  broken_during_rental: 'damaged_pending_repair',
  dirty_before_delivery: 'needs_cleaning',
  wrong_size_or_type: 'available',
  lost_or_destroyed_in_transit: 'retired',
};

function manualAdjustment_swapAllocatedUnit(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var unitsSheet = ss.getSheetByName('Gear Units');
    var gearSheet = ss.getSheetByName('Gear Check Log');
    var unitMap = adventurePrep_headerMap_(unitsSheet);

    var originalFound = adventurePrep_findRowByColumnValue_(unitsSheet, 'unitId', payload.originalUnitId);
    if (!originalFound) return { ok: false, error: 'Original unit not found: ' + payload.originalUnitId };
    var newOriginalStatus = MANUAL_ADJ_SWAP_REASON_TO_ORIGINAL_STATUS_[payload.reason] || 'damaged_pending_repair';
    unitsSheet.getRange(originalFound.rowIndex, unitMap['status']).setValue(newOriginalStatus);
    if (newOriginalStatus === 'retired') {
      unitsSheet.getRange(originalFound.rowIndex, unitMap['retiredAt']).setValue(adventurePrep_nowIso_());
      unitsSheet.getRange(originalFound.rowIndex, unitMap['retiredReason']).setValue('manual_adjustment_swap: ' + payload.reason + ' (booking ' + payload.bookingId + ')');
    }
    if (newOriginalStatus !== 'available') {
      // Freed from this booking either way — a unit pending repair/cleaning/retirement is no longer "this booking's."
      unitsSheet.getRange(originalFound.rowIndex, unitMap['currentBookingId']).setValue('');
    } else {
      unitsSheet.getRange(originalFound.rowIndex, unitMap['currentBookingId']).setValue('');
    }

    var gearRow = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
      return String(r.bookingId) === String(payload.bookingId) && String(r.unitId) === String(payload.originalUnitId);
    })[0];

    var result = { ok: true, bookingId: payload.bookingId, originalUnitId: payload.originalUnitId, originalNewStatus: newOriginalStatus, newUnitId: null };

    if (!payload.noSubstitute && payload.newUnitId) {
      var newFound = adventurePrep_findRowByColumnValue_(unitsSheet, 'unitId', payload.newUnitId);
      if (!newFound) return { ok: false, error: 'New unit not found: ' + payload.newUnitId };
      var currentStatus = unitsSheet.getRange(newFound.rowIndex, unitMap['status']).getValue();
      if (currentStatus !== 'available') return { ok: false, error: 'New unit ' + payload.newUnitId + ' is not available (status: ' + currentStatus + ')' };
      // Match the booking's current stage: if the original was already
      // checked_out (post-delivery breakage), the replacement steps straight
      // into checked_out too; otherwise (pre-delivery swap) allocated.
      var wasCheckedOut = gearRow && gearRow.checkedOutAt;
      var newStatus = wasCheckedOut ? 'checked_out' : 'allocated';
      unitsSheet.getRange(newFound.rowIndex, unitMap['status']).setValue(newStatus);
      unitsSheet.getRange(newFound.rowIndex, unitMap['currentBookingId']).setValue(payload.bookingId);
      if (gearRow) {
        var gearMap = adventurePrep_headerMap_(gearSheet);
        gearSheet.getRange(gearRow.__rowIndex, gearMap['unitId']).setValue(payload.newUnitId);
      }
      result.newUnitId = payload.newUnitId;
      result.newUnitStatus = newStatus;
    }

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'gear_unit_swap',
      oldValueJson: JSON.stringify({ unitId: payload.originalUnitId, reason: payload.reason }),
      newValueJson: JSON.stringify({ newUnitId: result.newUnitId, noSubstitute: !!payload.noSubstitute }),
      staffNotes: payload.staffNotes || '',
    });

    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * For a guest who cancels after gear is already out. Sets bookingStatus to
 * 'cancelled_post_delivery' (matching the existing 'cancelled_hold_failed'/
 * 'cancelled_no_adventure_prep' naming pattern) rather than a general
 * 'cancelled', specifically so the booking still surfaces in Return Check-
 * In's queue for gear pickup (gearOps_getCheckinQueueV2, above) even
 * though the trip itself is off. No refund is issued — confirmed against
 * the live 72-hour cancellation policy (gear delivery happens T-1, inside
 * the 72-hour window by definition) — refundAmount is written as 0
 * explicitly, not left blank, so it reads as "checked, zero" rather than
 * "not yet processed."
 */
function manualAdjustment_postDeliveryCancellation(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var now = adventurePrep_nowIso_();
    target.sheet.getRange(target.rowIndex, target.headerMap['bookingStatus']).setValue('cancelled_post_delivery');
    target.sheet.getRange(target.rowIndex, target.headerMap['cancelledAt']).setValue(now);
    target.sheet.getRange(target.rowIndex, target.headerMap['cancellationReasons']).setValue(payload.cancellationReason || 'post_delivery_cancellation');
    target.sheet.getRange(target.rowIndex, target.headerMap['refundAmount']).setValue(0);

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'post_delivery_cancellation',
      newValueJson: JSON.stringify({ bookingStatus: 'cancelled_post_delivery', refundAmount: 0, reason: payload.cancellationReason || '' }),
      staffNotes: payload.staffNotes || '',
    });

    return { ok: true, bookingId: payload.bookingId, bookingStatus: 'cancelled_post_delivery', cancelledAt: now };
  } finally {
    lock.releaseLock();
  }
}
