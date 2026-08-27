/**
 * apps-script/ops-redesign-round1-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Backs the Ops App Redesign's two genuinely new hubs (Phase 4, Round 1 of
 * claude/psac-ops-ux-journey-map-phases-1-3.md): All Bookings and the
 * expanded Ops Alerts, plus Stalled Bookings and Cancellations (previously
 * dead nav items with zero backend at all).
 *
 * ============================================================================
 * SCHEMA — new Experience Bookings columns this patch adds
 * ============================================================================
 *
 * Round 1 needs no new columns of its own (All Bookings/Ops Alerts/Stalled/
 * Cancellations are all reads over columns that already exist — depositStatus,
 * bookingStatus, cancellationReasons, adventurePrepStalledFlag,
 * phoneFallbackDue, gearDeliveredAt, etc). The two new write columns below
 * are added here because Stalled Bookings' one new write action
 * (`stalled_markCalled`) needs somewhere to record it, and it's cheapest to
 * fold into this same setup() rather than a sixth tiny patch file.
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file).
 *    Requires apps-script/adventure-prep-actions.gs, apps-script/cadence-
 *    actions.gs, apps-script/gear-inventory-actions.gs, and apps-script/ops-
 *    alerts-actions.gs already pasted in (reuses their shared helpers and
 *    constants — GEAR_ITEM_TYPE_CONFIG, RECONCILED_DEPOSIT_STATUSES_, etc).
 *
 * 2. Wire the new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'allBookings_listAll') {
 *        out = allBookings_listAll(body);
 *      } else if (body.action === 'opsAlerts_listExpanded') {
 *        out = opsAlerts_listExpanded(body);
 *      } else if (body.action === 'stalled_listAll') {
 *        out = stalled_listAll(body);
 *      } else if (body.action === 'stalled_markCalled') {
 *        out = stalled_markCalled(body);
 *      } else if (body.action === 'cancellations_listAll') {
 *        out = cancellations_listAll(body);
 *
 * 3. Run opsRedesignRound1_setup() once from the Apps Script editor after
 *    pasting. Safe to re-run (idempotent, additive-only).
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

var OPS_REDESIGN_ROUND1_COLUMNS_ = ['stalledCalledAt', 'stalledCalledBy'];

function opsRedesignRound1_setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_appendColumnsIfMissing_(ss, 'Experience Bookings', OPS_REDESIGN_ROUND1_COLUMNS_);
}

// ---------------------------------------------------------------------------
// Shared helpers — hold/delivery/return status mapping, reused by both
// allBookings_listAll and opsAlerts_listExpanded so the two screens can
// never silently disagree about what a given booking's state actually is.
// ---------------------------------------------------------------------------

/**
 * Hold Status display bucket for a raw depositStatus value. Per Airey's own
 * Aug 27 correction (baked into claude/psac-ops-all-bookings.html): the
 * live deposit-hold code only ever writes 'held' for an outstanding hold —
 * there is no real "Placed" vs "Active" distinction, so blank/unset reads as
 * "Not Yet Placed" and 'held' reads as "Active." 'refunded' (a captured-then-
 * refunded correction, gearOps_recordRefund) has no dedicated bucket in the
 * approved 6-value list — mapped here to "Released" (net capture is zero),
 * flagged in the handoff doc as a judgment call rather than a spec'd value.
 * 'shortfall_charge_in_progress' (a brief in-flight lock state,
 * gearOps_beginShortfallCharge) is mapped to "Captured (partial)" as the
 * closest approximation — it's transient and should rarely be observed live.
 */
function opsRedesign_holdStatusBucket_(depositStatus) {
  var s = String(depositStatus || '');
  if (!s) return 'not_yet_placed';
  if (s === 'held') return 'active';
  if (s === 'released' || s === 'refunded') return 'released';
  if (s === 'partial_capture' || s === 'shortfall_charge_in_progress') return 'captured_partial';
  if (s === 'full_capture' || s === 'full_capture_pending_review' || s === 'shortfall_charged') return 'captured_full';
  if (s === 'failed') return 'failed';
  return 'not_yet_placed';
}

/** Payment Status bucket, from the verified pi.status stashed in fullPayloadJson at save-booking time (see api/save-booking.js's verifyChargeAgainstStripe). */
function opsRedesign_paymentStatusBucket_(fullPayloadJson) {
  var parsed = {};
  try { parsed = JSON.parse(fullPayloadJson || '{}'); } catch (e) { parsed = {}; }
  var status = parsed.paymentStatus || 'succeeded'; // rows saved before this field existed default to succeeded — save-booking.js only ever persists a verified succeeded/processing charge
  if (status === 'succeeded') return 'succeeded';
  if (status === 'processing') return 'pending';
  return 'failed';
}

/** Booking Status bucket + cancellation reason list, from bookingStatus/cancellationReasons. */
function opsRedesign_bookingStatusInfo_(row) {
  var status = row.bookingStatus || 'active';
  if (status === 'active') return { bucket: 'confirmed', reasons: [] };
  var reasons = String(row.cancellationReasons || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return { bucket: 'cancelled', reasons: reasons };
}

/**
 * Delivery/Return status for a booking, derived from the fields Round 2's
 * gear-assembly/return-checkin extensions write (deliveryStatus,
 * returnStatus — see ops-redesign-round2-actions.gs). Falls back to the
 * PRE-Round-2 signal (gearDeliveredAt alone) so All Bookings/Ops Alerts
 * still work correctly if Round 2 hasn't been pasted in yet: a booking with
 * gearDeliveredAt set but no deliveryStatus column value reads as
 * 'delivered' rather than blank.
 */
function opsRedesign_deliveryReturnStatus_(row) {
  var deliveryStatus = row.deliveryStatus || (row.gearDeliveredAt ? 'delivered' : '');
  var returnStatus = row.returnStatus || '';
  return { deliveryStatus: deliveryStatus, returnStatus: returnStatus };
}

// ---------------------------------------------------------------------------
// All Bookings (Phase 4, Round 1)
// ---------------------------------------------------------------------------

/**
 * Every booking, with every computed status field All Bookings' table and
 * filters need, plus the raw ingredients (openAlertCount, hasOpenTrailSwap,
 * hasReconciliationCase, checkoutStarted) the front end uses to build the
 * six-tier stacked link-out list per row (Phase 4 Round 1's own precedence
 * order, now a stacking order per the confirmed Aug 27 revision — see
 * claude/psac-ops-redesign-open-items-confirmed.md item 1). No pagination
 * yet (Round 1 spec flags volume/pagination as a real open question, not
 * specced) — returns every row, capped at 500 as a sanity backstop.
 */
function allBookings_listAll(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var bookingsSheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(bookingsSheet);

  var alertsSheet = ss.getSheetByName('Ops Alerts');
  var openAlertsByBooking = {};
  if (alertsSheet) {
    adventurePrep_readRowsAsObjects_(alertsSheet).forEach(function (a) {
      if (a.status !== 'Open') return;
      var key = String(a.bookingId);
      if (!openAlertsByBooking[key]) openAlertsByBooking[key] = [];
      openAlertsByBooking[key].push(a.alertType);
    });
  }

  var swapSheet = ss.getSheetByName('Trail Swap Requests');
  var openSwapByBooking = {};
  if (swapSheet) {
    adventurePrep_readRowsAsObjects_(swapSheet).forEach(function (s) {
      if (s.status !== 'Open') return;
      openSwapByBooking[String(s.bookingId)] = true;
    });
  }

  var gearSheet = ss.getSheetByName('Gear Check Log');
  var gearRowsByBooking = {};
  if (gearSheet) {
    adventurePrep_readRowsAsObjects_(gearSheet).forEach(function (g) {
      var key = String(g.bookingId);
      if (!gearRowsByBooking[key]) gearRowsByBooking[key] = [];
      gearRowsByBooking[key].push(g);
    });
  }

  var bookings = rows.map(function (r) {
    var bookingInfo = opsRedesign_bookingStatusInfo_(r);
    var deliveryReturn = opsRedesign_deliveryReturnStatus_(r);
    var openAlerts = openAlertsByBooking[String(r.bookingId)] || [];
    var gearRows = gearRowsByBooking[String(r.bookingId)] || [];
    var checkoutStarted = gearRows.some(function (g) { return g.unitId; });
    var reconciliationOpen = r.depositStatus === 'full_capture_pending_review' || r.depositStatus === 'shortfall_charged';

    return {
      bookingId: r.bookingId,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      tripDate: r.date,
      bookingStatusBucket: bookingInfo.bucket,
      cancellationReasons: bookingInfo.reasons,
      paymentStatusBucket: opsRedesign_paymentStatusBucket_(r.fullPayloadJson),
      holdStatusBucket: opsRedesign_holdStatusBucket_(r.depositStatus),
      deliveryStatus: deliveryReturn.deliveryStatus,
      returnStatus: deliveryReturn.returnStatus,
      openAlertCount: openAlerts.length,
      openAlertTypes: openAlerts,
      hasOpenTrailSwap: !!openSwapByBooking[String(r.bookingId)],
      hasReconciliationCase: reconciliationOpen,
      checkoutStarted: checkoutStarted,
      checkoutDelivered: deliveryReturn.deliveryStatus === 'delivered',
      checkedIn: deliveryReturn.returnStatus === 'checked_in',
    };
  });

  bookings.sort(function (a, b) { return String(a.tripDate).localeCompare(String(b.tripDate)); });
  return { bookings: bookings.slice(0, 500), truncated: bookings.length > 500 };
}

// ---------------------------------------------------------------------------
// Ops Alerts, expanded (Phase 4, Round 1)
// ---------------------------------------------------------------------------

// Mirrors gearOps_listReconciliationQueue's own exact query, per this
// build's own instruction to reuse that source rather than re-derive it.
function opsRedesign_reconciliationAlerts_(ss) {
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    return r.depositStatus === 'full_capture_pending_review' || r.depositStatus === 'shortfall_charged';
  });
  return rows.map(function (r) {
    return {
      source: 'reconciliation_required',
      bookingId: r.bookingId,
      description: 'Reconciliation needs review',
      urgencyTier: 'urgent',
      createdAt: r.reconciledAt || r.date || '',
      amount: r.gearShortfallCents != null && r.gearShortfallCents !== '' ? r.gearShortfallCents / 100 : '',
    };
  });
}

// A booking whose Gear Check Log rows show a MIXED allocation state (some
// rows have a unitId, some don't) has genuinely had an allocation attempt
// run and come up short — as opposed to a booking that simply hasn't
// reached checkout yet, where EVERY row still lacks a unitId. This is the
// exact same signal ops-gear-checkout.html's own fixed "Retry Allocation (short
// N)" precondition uses (Round 2) — kept consistent on purpose.
function opsRedesign_shortAllocationAlerts_(ss) {
  var bookingsSheet = ss.getSheetByName('Experience Bookings');
  var activeBookingIds = {};
  adventurePrep_readRowsAsObjects_(bookingsSheet).forEach(function (r) {
    if ((r.bookingStatus || 'active') === 'active') activeBookingIds[String(r.bookingId)] = r;
  });

  var gearSheet = ss.getSheetByName('Gear Check Log');
  var byBooking = {};
  adventurePrep_readRowsAsObjects_(gearSheet).forEach(function (g) {
    var key = String(g.bookingId);
    if (!activeBookingIds[key]) return;
    if (!byBooking[key]) byBooking[key] = [];
    byBooking[key].push(g);
  });

  var out = [];
  Object.keys(byBooking).forEach(function (bookingId) {
    var rows = byBooking[bookingId];
    var anyAllocated = rows.some(function (r) { return r.unitId; });
    var anyShort = rows.some(function (r) { return !r.unitId; });
    if (!anyAllocated || !anyShort) return; // either not started yet, or fully allocated
    out.push({
      source: 'manual_adjustment_short_allocation',
      bookingId: bookingId,
      description: 'Booking short-allocated, needs retry',
      urgencyTier: 'urgent',
      createdAt: activeBookingIds[bookingId].date || '',
      amount: '',
      shortCount: rows.filter(function (r) { return !r.unitId; }).length,
    });
  });
  return out;
}

// Call-today (T-3 phone-fallback) tier only, per the Round 1 spec — Nudged
// (T-5) is routine volume, not a fire, and stays off this page.
function opsRedesign_stalledCallTodayAlerts_(ss) {
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var isStalled = r.adventurePrepStalledFlag === true || r.adventurePrepStalledFlag === 'true';
    var isCallToday = r.phoneFallbackDue === true || r.phoneFallbackDue === 'true';
    return isStalled && isCallToday && !r.stalledCalledAt;
  });
  return rows.map(function (r) {
    return {
      source: 'stalled_call_today',
      bookingId: r.bookingId,
      description: 'Booking needs a call today',
      urgencyTier: 'urgent',
      createdAt: r.date || '',
      amount: '',
    };
  });
}

// Flat per-item-type threshold against Gear Units' live status counts —
// confirmed thresholds, Phase 4 Round 1's "Low-stock thresholds" table.
var OPS_ALERT_LOW_STOCK_THRESHOLDS_ = {
  poles: 0,
  backpack_standard: 1,
  backpack_plus: 2,
  bottle: 3,
  first_aid_kit: 1,
  duffel: 1,
};

function opsRedesign_gearStockAlerts_(ss) {
  var sheet = ss.getSheetByName('Gear Units');
  if (!sheet) return [];
  var rows = adventurePrep_readRowsAsObjects_(sheet);
  var availableByType = {};
  rows.forEach(function (u) {
    if (u.status !== 'available') return;
    availableByType[u.itemType] = (availableByType[u.itemType] || 0) + 1;
  });
  var out = [];
  Object.keys(OPS_ALERT_LOW_STOCK_THRESHOLDS_).forEach(function (itemType) {
    var available = availableByType[itemType] || 0;
    var threshold = OPS_ALERT_LOW_STOCK_THRESHOLDS_[itemType];
    if (available > threshold) return; // auto-clears — not included once stock recovers
    var label = (GEAR_ITEM_TYPE_CONFIG[itemType] || {}).label || itemType;
    out.push({
      source: 'gear_low_stock',
      bookingId: '',
      description: 'Low stock: ' + label,
      urgencyTier: 'urgent',
      createdAt: '',
      amount: '',
      itemType: itemType,
      availableCount: available,
      threshold: threshold,
    });
  });
  return out;
}

// For-your-awareness tier only — cancellations from the last 7 days, so
// this doesn't grow forever (Phase 3: "a fact to review, not a queue to
// work"). 7 days is a reasonable default, not a number Airey specified —
// flagged in the handoff.
function opsRedesign_cancellationAwarenessAlerts_(ss, nowIso) {
  var sheet = ss.getSheetByName('Experience Bookings');
  var cutoffMs = new Date(nowIso).getTime() - 7 * 24 * 60 * 60 * 1000;
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    if ((r.bookingStatus || 'active') === 'active') return false;
    if (!r.cancelledAt) return false;
    return new Date(r.cancelledAt).getTime() >= cutoffMs;
  });
  return rows.map(function (r) {
    return {
      source: 'cancellation_fyi',
      bookingId: r.bookingId,
      description: 'Cancellation (for awareness)',
      urgencyTier: 'awareness',
      createdAt: r.cancelledAt || '',
      amount: '',
      reasons: String(r.cancellationReasons || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    };
  });
}

/**
 * The expanded Ops Alerts feed: the existing sheet-backed payment/hold-
 * failure family (opsAlerts_listAll's own rows, unchanged), merged with five
 * new LIVE-COMPUTED producers (never written as Ops Alerts sheet rows —
 * Reconciliation required, Manual-adjustment short-allocation, Stalled
 * call-today, Gear low-stock, Cancellation FYI). Custom Tier requests are
 * DELIBERATELY NOT included here — no intake mechanism exists anywhere in
 * this codebase yet (confirmed via exhaustive grep across api/, lib/,
 * apps-script/, and every ops-*.html — zero matches for "custom tier" or
 * "customTier"). Per this build's explicit instruction, that's flagged as a
 * genuine blocker in the handoff doc, not built as a silent stub here.
 */
function opsAlerts_listExpanded(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var nowIso = (payload && payload.nowIso) || new Date().toISOString();

  var existing = opsAlerts_listAll(payload).alerts.map(function (a) {
    var tier = 'urgent';
    if (a.status === 'Open' && a.urgency === 'same_day_2hr') tier = 'critical';
    return {
      source: 'payment_hold_failure',
      alertId: a.alertId,
      bookingId: a.bookingId,
      alertType: a.alertType,
      description: a.alertType,
      urgencyTier: tier,
      urgency: a.urgency,
      amount: a.amount,
      createdAt: a.createdAt,
      status: a.status,
      resolvedAt: a.resolvedAt,
      resolvedBy: a.resolvedBy,
      stripeErrorDetail: a.stripeErrorDetail,
      notes: a.notes,
    };
  });

  var reconciliation = opsRedesign_reconciliationAlerts_(ss);
  var shortAllocation = opsRedesign_shortAllocationAlerts_(ss);
  var stalled = opsRedesign_stalledCallTodayAlerts_(ss);
  var gearStock = opsRedesign_gearStockAlerts_(ss);
  var cancellations = opsRedesign_cancellationAwarenessAlerts_(ss, nowIso);

  return {
    paymentHoldFailure: existing,
    reconciliationRequired: reconciliation,
    shortAllocation: shortAllocation,
    stalledCallToday: stalled,
    gearLowStock: gearStock,
    cancellationsFyi: cancellations,
    customTierBlocked: true, // no intake mechanism exists yet — see this function's header comment
  };
}

// ---------------------------------------------------------------------------
// Stalled Bookings (Phase 1, Surface 8 — approved design, never built)
// ---------------------------------------------------------------------------

/**
 * Every booking currently flagged adventurePrepStalledFlag===true, tagged
 * with which of the three tracks (Trail Details/1.2a, Waiver, Address) are
 * still outstanding and whether it's Nudged (T-5) or Call-today (T-3,
 * phoneFallbackDue) stage. One combined queue, not two separate pages, per
 * the approved design (Phase 1, Surface 8).
 */
function stalled_listAll(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var bookingsSheet = ss.getSheetByName('Experience Bookings');
  var stalledRows = adventurePrep_readRowsAsObjects_(bookingsSheet).filter(function (r) {
    return r.adventurePrepStalledFlag === true || r.adventurePrepStalledFlag === 'true';
  });

  var apSheet = ss.getSheetByName('Adventure Prep');
  var apByBooking = {};
  if (apSheet) {
    adventurePrep_readRowsAsObjects_(apSheet).forEach(function (ap) { apByBooking[String(ap.bookingId)] = ap; });
  }

  var waiverSheet = ss.getSheetByName('Waiver Signatures');
  var anySignedByBooking = {};
  if (waiverSheet) {
    adventurePrep_readRowsAsObjects_(waiverSheet).forEach(function (w) {
      if (w.status === 'signed') anySignedByBooking[String(w.bookingId)] = true;
    });
  }

  var bookings = stalledRows.map(function (r) {
    var ap = apByBooking[String(r.bookingId)] || {};
    var waiverComplete = ap.allWaiversComplete === true || ap.allWaiversComplete === 'true';
    var waiverTrack = waiverComplete ? 'complete' : (anySignedByBooking[String(r.bookingId)] ? 'partial' : 'zero');
    var outstandingTracks = [];
    if (!ap.assignedAt) outstandingTracks.push('trail_details'); // 1.2a
    if (waiverTrack !== 'complete') outstandingTracks.push('waiver');
    if (!(ap.deliveryAddressLine1 || ap.deliveryAddressRaw)) outstandingTracks.push('address');

    var isCallToday = r.phoneFallbackDue === true || r.phoneFallbackDue === 'true';
    return {
      bookingId: r.bookingId,
      contactName: r.contactName,
      contactPhone: r.contactPhone,
      contactEmail: r.contactEmail,
      tripDate: r.date,
      stage: isCallToday ? 'call_today' : 'nudged',
      outstandingTracks: outstandingTracks,
      waiverTrack: waiverTrack,
      calledAt: r.stalledCalledAt || '',
      calledBy: r.stalledCalledBy || '',
    };
  });

  bookings.sort(function (a, b) {
    var aCall = a.stage === 'call_today' ? 0 : 1;
    var bCall = b.stage === 'call_today' ? 0 : 1;
    if (aCall !== bCall) return aCall - bCall;
    return String(a.tripDate).localeCompare(String(b.tripDate));
  });

  return { bookings: bookings };
}

/** New write action: "Mark called" — records who called and when, does not clear adventurePrepStalledFlag (that's the cadence job's own job once tracks actually complete). */
function stalled_markCalled(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var found = adventurePrep_findRowByColumnValue_(ss.getSheetByName('Experience Bookings'), 'bookingId', payload.bookingId);
    if (!found) return { ok: false, error: 'Booking not found' };
    var sheet = ss.getSheetByName('Experience Bookings');
    var now = adventurePrep_nowIso_();
    if (found.headerMap['stalledCalledAt']) sheet.getRange(found.rowIndex, found.headerMap['stalledCalledAt']).setValue(now);
    if (found.headerMap['stalledCalledBy']) sheet.getRange(found.rowIndex, found.headerMap['stalledCalledBy']).setValue(payload.calledBy || '');
    return { ok: true, bookingId: payload.bookingId, calledAt: now };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Cancellations (Phase 1, Surface 9 — approved design, never built)
// ---------------------------------------------------------------------------

/**
 * Deliberately read-only, no Resolve/Edit/Reverse actions at all, by design
 * (Phase 1, Surface 9: "a fact to review, not a workflow to act on"). Every
 * cancelled booking, its firing reason(s) verbatim (the SOURCE enum values
 * — 'no_1.2a' etc — untranslated; the front end maps these to display
 * labels at render time only, same pattern the existing 16-string Ops
 * Alerts label-mapping table already uses), and its refund reference.
 */
function cancellations_listAll(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    return (r.bookingStatus || 'active') !== 'active';
  });
  var cancellations = rows.map(function (r) {
    return {
      bookingId: r.bookingId,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      tripDate: r.date,
      bookingStatus: r.bookingStatus,
      cancelledAt: r.cancelledAt || '',
      cancellationReasons: String(r.cancellationReasons || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      refundAmount: r.refundAmount != null ? r.refundAmount : '',
    };
  });
  cancellations.sort(function (a, b) { return String(b.cancelledAt).localeCompare(String(a.cancelledAt)); });
  return { cancellations: cancellations };
}
