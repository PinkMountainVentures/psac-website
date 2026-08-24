/**
 * apps-script/gear-inventory-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs,
 * same delivery pattern as every prior patch (ops-alerts-actions.gs,
 * cancel-refund-actions.gs, manual-adjustment-actions.gs, etc). Sheet-side
 * support for the Gear Inventory, Checkout & Deposit Reconciliation PRD
 * (claude/psac-gear-ops-inventory-jtbd-prd-v1.md) — the fourth and last of
 * the post-booking builds.
 *
 * Requires apps-script/adventure-prep-actions.gs already installed (reuses
 * its generic helpers: adventurePrep_ensureTabWithHeaders_, headerMap_,
 * readRowsAsObjects_, findRowByColumnValue_, newId_, nowIso_,
 * findExperienceBookingById_, getOrCreateRow_, appendChangeLog_,
 * appendColumnsIfMissing_ — same reuse convention ops-alerts-actions.gs and
 * cancel-refund-actions.gs already established).
 *
 * ============================================================================
 * WHAT THIS FILE OWNS
 * ============================================================================
 *   - The new `Gear Units` tab (Section 2): setup, Add/Retire/Mark-clean/
 *     Mark-deep-cleaned.
 *   - A new `unitId` + `photoUrl` column on the existing `Gear Check Log`
 *     tab (Section 4/13's "no unitId column exists yet" blocking fix).
 *   - Availability (Section 3), allocation (Section 3/4, size-matched,
 *     shortage-flagged), checkout scan-confirm + Mark Delivered (Section 4).
 *   - Per-item check-in: condition, photo, grace period, deep-clean routing
 *     (Section 5/9).
 *   - Reconciliation context + write-back (Section 7), the Scenario-4 queue
 *     (Section 10), shortfall-charge and refund audit write-backs (Section
 *     10, and the new refund/partial-refund gap the design pass surfaced).
 *   - Hold-renewal candidate listing (Section 8).
 *   - New columns appended to the existing `Experience Bookings` tab —
 *     additive only, via adventurePrep_appendColumnsIfMissing_, never
 *     inserted/reordered, so no existing data shifts.
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 * 1. Paste everything below the marker into Code.gs (or its own .gs file in
 *    the same Apps Script project — order doesn't matter, shared global
 *    scope, same as every prior patch).
 *
 * 2. Wire the new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'gearOps_listUnits') {
 *        out = gearOps_listUnits(body);
 *      } else if (body.action === 'gearOps_addUnit') {
 *        out = gearOps_addUnit(body);
 *      } else if (body.action === 'gearOps_retireUnit') {
 *        out = gearOps_retireUnit(body);
 *      } else if (body.action === 'gearOps_markClean') {
 *        out = gearOps_markClean(body);
 *      } else if (body.action === 'gearOps_markDeepCleaned') {
 *        out = gearOps_markDeepCleaned(body);
 *      } else if (body.action === 'gearOps_checkAvailabilityRaw') {
 *        out = gearOps_checkAvailabilityRaw(body);
 *      } else if (body.action === 'gearOps_getCheckoutQueue') {
 *        out = gearOps_getCheckoutQueue(body);
 *      } else if (body.action === 'gearOps_allocateUnits') {
 *        out = gearOps_allocateUnits(body);
 *      } else if (body.action === 'gearOps_getAllocation') {
 *        out = gearOps_getAllocation(body);
 *      } else if (body.action === 'gearOps_recordShortageResolution') {
 *        out = gearOps_recordShortageResolution(body);
 *      } else if (body.action === 'gearOps_confirmCheckoutScan') {
 *        out = gearOps_confirmCheckoutScan(body);
 *      } else if (body.action === 'gearOps_markDelivered') {
 *        out = gearOps_markDelivered(body);
 *      } else if (body.action === 'gearOps_getCheckinQueue') {
 *        out = gearOps_getCheckinQueue(body);
 *      } else if (body.action === 'gearOps_getCheckinContext') {
 *        out = gearOps_getCheckinContext(body);
 *      } else if (body.action === 'gearOps_checkInItem') {
 *        out = gearOps_checkInItem(body);
 *      } else if (body.action === 'gearOps_getReconciliationContext') {
 *        out = gearOps_getReconciliationContext(body);
 *      } else if (body.action === 'gearOps_writeReconciliation') {
 *        out = gearOps_writeReconciliation(body);
 *      } else if (body.action === 'gearOps_listReconciliationQueue') {
 *        out = gearOps_listReconciliationQueue(body);
 *      } else if (body.action === 'gearOps_recordShortfallCharge') {
 *        out = gearOps_recordShortfallCharge(body);
 *      } else if (body.action === 'gearOps_recordShortfallChargeFailure') {
 *        out = gearOps_recordShortfallChargeFailure(body);
 *      } else if (body.action === 'gearOps_recordRefund') {
 *        out = gearOps_recordRefund(body);
 *      } else if (body.action === 'gearOps_listHoldRenewalCandidates') {
 *        out = gearOps_listHoldRenewalCandidates(body);
 *      } else if (body.action === 'gearOps_recordHoldRenewed') {
 *        out = gearOps_recordHoldRenewed(body);
 *
 * 3. Run gearOps_setup() once from the Apps Script editor after pasting.
 *    Creates the `Gear Units` tab, appends `unitId`/`photoUrl` to
 *    `Gear Check Log`, and appends every new `Experience Bookings` column
 *    this build needs. Safe to re-run (idempotent, additive-only).
 *
 * 4. Seed the `Gear Units` tab against the real confirmed counts (Section
 *    2/16) — run gearOps_seedInitialInventory() ONCE after gearOps_setup().
 *    It's a no-op (throws) if the tab already has any data rows, so it can
 *    never double-seed.
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

var GEAR_UNITS_HEADERS = [
  'unitId', 'itemType', 'status', 'currentBookingId', 'replacementCostCents',
  'acquiredAt', 'retiredAt', 'retiredReason', 'qrToken', 'usesSinceDeepClean',
];

// New columns on the pre-existing `Gear Check Log` tab (Section 4/13's
// blocking fix — this tab had no unitId column at all until this patch).
// photoUrl is new too, Section 5/10's photo-upload requirement for
// Damaged/Missing items — a public Vercel Blob URL, matching the existing
// logo-URL "URL by reference, not binary in the Sheet" convention.
var GEAR_CHECK_LOG_NEW_COLUMNS = ['unitId', 'photoUrl'];

// New columns on the pre-existing `Experience Bookings` tab. All additive,
// all optional/blank until the relevant step actually runs for a given
// booking. See this file's header for what each one backs.
var GEAR_OPS_EXPERIENCE_BOOKINGS_NEW_COLUMNS = [
  'reconciledAt', 'reconciledAmountCents', 'gearShortfallCents',
  'shortfallChargeId', 'shortfallChargedAmountCents', 'shortfallChargedAt', 'shortfallStaffNotes',
  'depositRefundId', 'depositRefundAmountCents',
  'shortfallRefundId', 'shortfallRefundAmountCents',
  'refundedAt', 'refundStaffNotes',
  'depositHoldRenewedAt', 'gearDeliveredAt', 'gearDeliveredBy',
];

// Section 2/5/9/16: per-itemType configuration. Reference costs in CENTS
// (PRD Section 2 names the field replacementCostCents explicitly), matching
// Section 9's confirmed figures. Deep-clean thresholds per Section 5/16
// (poles and bottles: every 5 uses; backpacks/first-aid-kit/duffel: every
// 10). unitPrefix matches the existing informal convention already visible
// in the Ops UX mockups (GP-/LK-/HF-/FA-/RM-).
var GEAR_ITEM_TYPE_CONFIG = {
  backpack_standard: { label: 'Backpack, Standard', unitPrefix: 'GP', deepCleanThreshold: 10, defaultReplacementCostCents: 15900 },
  backpack_plus:      { label: 'Backpack, Plus',      unitPrefix: 'GP', deepCleanThreshold: 10, defaultReplacementCostCents: 15900 },
  poles:               { label: 'Trekking Poles (pair)', unitPrefix: 'LK', deepCleanThreshold: 5,  defaultReplacementCostCents: 12900 },
  bottle:              { label: 'Water Bottle',        unitPrefix: 'HF', deepCleanThreshold: 5,  defaultReplacementCostCents: 4200 },
  first_aid_kit:       { label: 'Hard-Shell First Aid Kit', unitPrefix: 'FA', deepCleanThreshold: 10, defaultReplacementCostCents: 999 },
  duffel:              { label: 'Duffel',              unitPrefix: 'RM', deepCleanThreshold: 10, defaultReplacementCostCents: 15900 },
};

// Real confirmed seed counts, Section 2/16 (2026-08-15) — corrected from the
// false "20 units each" premise. Poles = 1 PAIR, not a typo. Used only by
// gearOps_seedInitialInventory(), a one-time run.
var GEAR_SEED_COUNTS = {
  backpack_standard: 4,
  backpack_plus: 4,
  poles: 1,
  bottle: 20,
  first_aid_kit: 8,
  duffel: 8,
};

// Maps the existing Gear Check Log `itemName` strings (written by
// bookings-code.gs's buildGearLogRows(), unchanged by this patch) to a
// GEAR_ITEM_TYPE_CONFIG key — every gear-ops action that needs to know
// "what kind of thing is this row" (allocation, availability) reads this
// map rather than assuming a 1:1 field. Backpack rows are deliberately
// ambiguous here (bookings-code.gs doesn't know size at booking time,
// packSizePreference doesn't exist yet on Adventure Prep's schema per
// Section 2/13) — gearOps_resolveBackpackType_() below resolves the real
// size at allocation time; this map's 'backpack_standard' entry is only
// ever a fallback default, never trusted as the final answer once a roster
// match is possible.
var GEAR_ITEM_NAME_TO_TYPE = {
  'Gregory Miko 20L Backpack': 'backpack_standard',
  'Hydro Flask Big Mouth 32oz Bottle': 'bottle',
  'Leki Khumbu Lite Trekking Poles': 'poles',
  'Hard-Shell First Aid Kit': 'first_aid_kit',
  'REI Pack Mule 90L Duffel': 'duffel',
};

function gearOps_setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_ensureTabWithHeaders_(ss, 'Gear Units', GEAR_UNITS_HEADERS);
  adventurePrep_appendColumnsIfMissing_(ss, 'Gear Check Log', GEAR_CHECK_LOG_NEW_COLUMNS);
  adventurePrep_appendColumnsIfMissing_(ss, 'Experience Bookings', GEAR_OPS_EXPERIENCE_BOOKINGS_NEW_COLUMNS);
}

/**
 * One-time seed against the real confirmed counts (GEAR_SEED_COUNTS).
 * Refuses to run if the tab already has ANY data rows — this is meant to
 * run exactly once, right after gearOps_setup(), never as a top-up (use
 * gearOps_addUnit for that, one unit at a time, so each new unit gets a
 * real QR label generated).
 */
function gearOps_seedInitialInventory() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Gear Units');
  if (!sheet) throw new Error('gearOps_seedInitialInventory: run gearOps_setup() first');
  if (sheet.getLastRow() > 1) {
    throw new Error('gearOps_seedInitialInventory: Gear Units already has data rows — refusing to reseed. Use gearOps_addUnit for one-off additions.');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rows = [];
    var now = adventurePrep_nowIso_();
    var counters = {};
    Object.keys(GEAR_SEED_COUNTS).forEach(function (itemType) {
      var count = GEAR_SEED_COUNTS[itemType];
      var cfg = GEAR_ITEM_TYPE_CONFIG[itemType];
      counters[itemType] = counters[itemType] || 1;
      for (var i = 0; i < count; i++) {
        var num = counters[itemType]++;
        var unitId = cfg.unitPrefix + '-' + String(num).padStart(4, '0');
        rows.push([
          unitId, itemType, 'available', '', cfg.defaultReplacementCostCents,
          now, '', '', Utilities.getUuid(), 0,
        ]);
      }
    });
    var map = adventurePrep_headerMap_(sheet);
    sheet.getRange(2, 1, rows.length, GEAR_UNITS_HEADERS.length).setValues(rows);
    return { ok: true, unitsSeeded: rows.length };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Section 2/11: Gear Units CRUD (Add / Retire / Mark clean / Mark deep-cleaned)
// ---------------------------------------------------------------------------

function gearOps_findUnitRow_(sheet, unitId) {
  return adventurePrep_findRowByColumnValue_(sheet, 'unitId', unitId);
}

function gearOps_readUnit_(sheet, found) {
  var row = sheet.getRange(found.rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  var obj = {};
  Object.keys(found.headerMap).forEach(function (h) { obj[h] = row[found.headerMap[h] - 1]; });
  obj.__rowIndex = found.rowIndex;
  return obj;
}

/** Every Gear Units row, optionally filtered by itemType. Bulk keepsakes never appear here — they're not unit-tracked (Section 2). */
function gearOps_listUnits(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Gear Units');
  if (!sheet) return { units: [] };
  var rows = adventurePrep_readRowsAsObjects_(sheet);
  if (payload && payload.itemType) {
    rows = rows.filter(function (r) { return r.itemType === payload.itemType; });
  }
  return { units: rows };
}

/** Section 2: writes one new Gear Units row, status=available, generates a qrToken. */
function gearOps_addUnit(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Gear Units');
    if (!sheet) throw new Error('gearOps_addUnit: run gearOps_setup() first');
    var itemType = payload.itemType;
    if (!GEAR_ITEM_TYPE_CONFIG[itemType]) return { ok: false, error: 'Unknown itemType: ' + itemType };
    var cfg = GEAR_ITEM_TYPE_CONFIG[itemType];
    var unitId = String(payload.unitId || '').trim();
    if (!unitId) return { ok: false, error: 'unitId is required' };
    if (gearOps_findUnitRow_(sheet, unitId)) return { ok: false, error: 'A unit with this ID already exists' };

    var replacementCostCents = payload.replacementCostCents != null
      ? Number(payload.replacementCostCents) : cfg.defaultReplacementCostCents;
    var qrToken = Utilities.getUuid();
    sheet.appendRow([
      unitId, itemType, 'available', '', replacementCostCents,
      payload.acquiredAt || adventurePrep_nowIso_(), '', '', qrToken, 0,
    ]);
    return { ok: true, unitId: unitId, itemType: itemType, qrToken: qrToken, status: 'available' };
  } finally {
    lock.releaseLock();
  }
}

/** Section 2: status=retired, retiredReason required (enforced at the API layer too), retiredAt set. Row stays for audit history, never deleted. */
function gearOps_retireUnit(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Gear Units');
    var found = gearOps_findUnitRow_(sheet, payload.unitId);
    if (!found) return { ok: false, error: 'Unit not found' };
    var map = found.headerMap;
    sheet.getRange(found.rowIndex, map['status']).setValue('retired');
    sheet.getRange(found.rowIndex, map['retiredAt']).setValue(adventurePrep_nowIso_());
    sheet.getRange(found.rowIndex, map['retiredReason']).setValue(payload.retiredReason || '');
    sheet.getRange(found.rowIndex, map['currentBookingId']).setValue('');
    return { ok: true, unitId: payload.unitId };
  } finally {
    lock.releaseLock();
  }
}

/** Section 5: needs_cleaning -> available. Never touches usesSinceDeepClean — only a genuine deep clean resets that. */
function gearOps_markClean(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Gear Units');
    var found = gearOps_findUnitRow_(sheet, payload.unitId);
    if (!found) return { ok: false, error: 'Unit not found' };
    sheet.getRange(found.rowIndex, found.headerMap['status']).setValue('available');
    return { ok: true, unitId: payload.unitId, status: 'available' };
  } finally {
    lock.releaseLock();
  }
}

/** Section 5: needs_deep_clean -> available, AND resets usesSinceDeepClean to 0. */
function gearOps_markDeepCleaned(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Gear Units');
    var found = gearOps_findUnitRow_(sheet, payload.unitId);
    if (!found) return { ok: false, error: 'Unit not found' };
    var map = found.headerMap;
    sheet.getRange(found.rowIndex, map['status']).setValue('available');
    sheet.getRange(found.rowIndex, map['usesSinceDeepClean']).setValue(0);
    return { ok: true, unitId: payload.unitId, status: 'available', usesSinceDeepClean: 0 };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Section 3: availability (raw data only — date/"has this trip passed"
// math happens in Node, lib/cadence.js, not here, matching this project's
// established split of responsibilities).
// ---------------------------------------------------------------------------

/**
 * Returns every Gear Units row (itemType/status/currentBookingId only —
 * enough for the Node side to compute assemblable-kit counts) plus a
 * {bookingId: tripDate} map for every booking any allocated/checked_out
 * unit currently points at, so Node can decide "has that trip already
 * happened" (Section 3: "already allocated/checked_out to bookings whose
 * trip date has passed, and are therefore due back").
 */
function gearOps_checkAvailabilityRaw(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Gear Units');
  if (!sheet) return { units: [], bookingTripDates: {} };
  var rows = adventurePrep_readRowsAsObjects_(sheet).map(function (r) {
    return { unitId: r.unitId, itemType: r.itemType, status: r.status, currentBookingId: r.currentBookingId || '' };
  });
  var bookingIds = rows
    .filter(function (r) { return r.currentBookingId && (r.status === 'allocated' || r.status === 'checked_out'); })
    .map(function (r) { return r.currentBookingId; });
  var uniqueIds = bookingIds.filter(function (id, i) { return bookingIds.indexOf(id) === i; });
  var bookingsSheet = ss.getSheetByName('Experience Bookings');
  var tripDates = {};
  uniqueIds.forEach(function (id) {
    var b = adventurePrep_findExperienceBookingById_(ss, id);
    if (b) tripDates[id] = b.date;
  });
  return { units: rows, bookingTripDates: tripDates };
}

// ---------------------------------------------------------------------------
// Section 4: checkout queue, allocation, scan-confirm, Mark Delivered
// ---------------------------------------------------------------------------

/**
 * Every active Experience Bookings row whose trip date matches the given
 * date (the checkout view's own T-1 date, per the mockup's "Aug 14 (T-1 for
 * Aug 15)" framing) — enough for the checkout queue list. Waiver-status /
 * "Cleared to pack" are already computed elsewhere (Operations UX's own
 * existing view); this action only adds what's new here (gearKitCount, and
 * whether allocation has already run).
 */
function gearOps_getCheckoutQueue(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var status = r.bookingStatus || 'active';
    return status === 'active' && String(r.date || '').indexOf(payload.tripDate) === 0;
  });
  return {
    bookings: rows.map(function (r) {
      return {
        bookingId: r.bookingId, contactName: r.contactName, contactEmail: r.contactEmail,
        tier: r.tier, gearKitCount: r.gearKitCount, tripDate: r.date,
        gearDeliveredAt: r.gearDeliveredAt || '',
      };
    }),
  };
}

/**
 * Resolves the correct backpack sub-type for a Gear Check Log row's person,
 * matched by personName against the booking's reconfirmedRosterJson roster
 * (Section 2/13). packSizePreference doesn't exist on that schema yet — a
 * cross-chat dependency this build cannot add itself (Section 2/13's own
 * explicit instruction: "stub this piece with a documented placeholder
 * rather than blocking on it"). Falls back to 'backpack_standard' whenever
 * the field is absent (today, always) or the name can't be matched.
 * Name-matching is itself a known fragility (Gear Check Log stores a plain
 * personName string, not a stable roster ref) — flagged here rather than
 * silently trusted, worth revisiting once packSizePreference lands and a
 * more stable per-person key exists to join on.
 */
function gearOps_resolveBackpackType_(ss, bookingId, personName) {
  var ap = adventurePrep_readAdventurePrepRow_(ss, bookingId);
  if (ap && ap.reconfirmedRosterJson) {
    try {
      var roster = JSON.parse(ap.reconfirmedRosterJson);
      var match = roster.filter(function (p) { return p && p.name === personName; })[0];
      if (match && match.packSizePreference === 'plus') return 'backpack_plus';
      if (match && match.packSizePreference === 'standard') return 'backpack_standard';
    } catch (e) { /* fall through to default below */ }
  }
  return 'backpack_standard'; // documented placeholder default, see comment above
}

/**
 * Section 3/4: allocates specific available Gear Units to a booking's
 * already-existing Gear Check Log rows (written at booking time by
 * bookings-code.gs, corrected by any kit-count adjustments since). Reads
 * those rows as the source of truth for "what does this booking actually
 * need" rather than recomputing from gearKitCount independently, so a
 * kit-count change already reflected in Gear Check Log is automatically
 * respected here too.
 *
 * Idempotent and incremental: only touches rows with a blank unitId AND a
 * blank checkedOutAt (never re-allocates something already checked out, and
 * never re-picks a unit for a row that already has one — safe to call again
 * if staff reopens a checkout record).
 *
 * A shortage (no available unit of the needed type/size) leaves that row's
 * unitId blank and adds an entry to the returned `shortages` array rather
 * than blocking the rest of the booking's allocation — Section 3/16:
 * "a plain flag... no dedicated workflow beyond it," never a hard stop.
 */
function gearOps_allocateUnits(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var bookingId = payload.bookingId;
    var gearSheet = ss.getSheetByName('Gear Check Log');
    var unitsSheet = ss.getSheetByName('Gear Units');
    var gearRows = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
      return String(r.bookingId) === String(bookingId) && !r.checkedOutAt;
    });
    var unitRows = adventurePrep_readRowsAsObjects_(unitsSheet);
    var gearMap = adventurePrep_headerMap_(gearSheet);
    var unitMap = adventurePrep_headerMap_(unitsSheet);

    var shortages = [];
    var allocation = [];

    gearRows.forEach(function (row) {
      if (row.unitId) {
        // Already allocated on an earlier call — report it, don't re-pick.
        allocation.push({ kitNumber: row.kitNumber, personName: row.personName, itemName: row.itemName, unitId: row.unitId });
        return;
      }
      var itemType = GEAR_ITEM_NAME_TO_TYPE[row.itemName];
      if (!itemType) return; // not a trackable item this patch knows about
      if (itemType === 'backpack_standard') {
        itemType = gearOps_resolveBackpackType_(ss, bookingId, row.personName);
      }

      var candidate = unitRows.filter(function (u) {
        return u.itemType === itemType && u.status === 'available';
      })[0];

      if (!candidate) {
        shortages.push({
          itemType: itemType, label: (GEAR_ITEM_TYPE_CONFIG[itemType] || {}).label || itemType,
          kitNumber: row.kitNumber, personName: row.personName,
        });
        allocation.push({ kitNumber: row.kitNumber, personName: row.personName, itemName: row.itemName, unitId: '', shortage: true });
        return;
      }

      // Mark this unit as no longer available to a LATER row in this same
      // loop (in-memory only — the sheet write happens right after).
      candidate.status = 'allocated';

      unitsSheet.getRange(candidate.__rowIndex, unitMap['status']).setValue('allocated');
      unitsSheet.getRange(candidate.__rowIndex, unitMap['currentBookingId']).setValue(bookingId);
      gearSheet.getRange(row.__rowIndex, gearMap['unitId']).setValue(candidate.unitId);

      allocation.push({ kitNumber: row.kitNumber, personName: row.personName, itemName: row.itemName, unitId: candidate.unitId, itemType: itemType });
    });

    return { ok: true, bookingId: bookingId, allocation: allocation, shortages: shortages };
  } finally {
    lock.releaseLock();
  }
}

/** Reads back the current allocation state for a booking without re-running allocation — for reopening an already-allocated checkout record. */
function gearOps_getAllocation(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var gearSheet = ss.getSheetByName('Gear Check Log');
  var rows = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
    return String(r.bookingId) === String(payload.bookingId);
  });
  return {
    allocation: rows.map(function (r) {
      return { kitNumber: r.kitNumber, personName: r.personName, itemName: r.itemName, unitId: r.unitId || '', checkedOutAt: r.checkedOutAt || '' };
    }),
  };
}

/**
 * Section 3/16's confirmed-sufficient handling for the oversell case: a
 * single one-line, timestamped decision recorded to the booking's Change
 * Log, matching the design pass's "no reassignment engine, no PO form, no
 * message composer" instruction. Does not itself move any units or contact
 * a guest — that's staff's own follow-through, this just leaves a record.
 */
function gearOps_recordShortageResolution(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_appendChangeLog_(ss, {
    bookingId: payload.bookingId,
    changeType: 'gear_shortage_resolution',
    beforeT3Cutoff: false,
    staffNotes: '[' + (payload.itemType || 'item') + '] ' + (payload.resolution || '') + (payload.note ? ' — ' + payload.note : ''),
  });
  return { ok: true, bookingId: payload.bookingId };
}

/**
 * Section 4/6: the scan-to-confirm step, including the scan-mismatch case
 * the design pass flagged as real/expected but not fully designed. Returns
 * a distinct `mismatch` reason rather than a bare error, so the client can
 * render a clear staff-facing explanation instead of a generic failure.
 * On a genuine match: flips the Gear Units row to checked_out, increments
 * usesSinceDeepClean by exactly 1 (Section 2: "incremented once per
 * checkout"), and writes checkedOutAt onto the matching Gear Check Log row.
 */
function gearOps_confirmCheckoutScan(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var unitsSheet = ss.getSheetByName('Gear Units');
    var unitFound = gearOps_findUnitRow_(unitsSheet, payload.unitId);
    if (!unitFound) {
      return { ok: false, mismatch: { reason: 'unit_not_found', detail: 'No unit with this ID exists in inventory.' } };
    }
    var unit = gearOps_readUnit_(unitsSheet, unitFound);

    if (unit.status === 'retired') {
      return { ok: false, mismatch: { reason: 'retired', detail: 'This unit was retired and should not be in circulation.' } };
    }
    if (String(unit.currentBookingId || '') !== String(payload.bookingId)) {
      return {
        ok: false,
        mismatch: {
          reason: unit.currentBookingId ? 'allocated_elsewhere' : 'not_allocated',
          detail: unit.currentBookingId
            ? ('This unit is currently allocated to booking #' + unit.currentBookingId + ', not this one.')
            : 'This unit is not currently allocated to any booking — allocate it to this booking first.',
          actualBookingId: unit.currentBookingId || null,
        },
      };
    }

    var gearSheet = ss.getSheetByName('Gear Check Log');
    var gearFound = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
      return String(r.bookingId) === String(payload.bookingId) && String(r.unitId) === String(payload.unitId);
    })[0];
    if (!gearFound) {
      return { ok: false, mismatch: { reason: 'no_gear_log_row', detail: 'This unit is allocated to this booking, but no Gear Check Log row references it — an engineering data-integrity gap worth a look.' } };
    }

    var gearMap = adventurePrep_headerMap_(gearSheet);
    gearSheet.getRange(gearFound.__rowIndex, gearMap['checkedOutAt']).setValue(adventurePrep_nowIso_());

    var unitMap = unitFound.headerMap;
    unitsSheet.getRange(unitFound.rowIndex, unitMap['status']).setValue('checked_out');
    unitsSheet.getRange(unitFound.rowIndex, unitMap['usesSinceDeepClean']).setValue(Number(unit.usesSinceDeepClean || 0) + 1);

    return { ok: true, unitId: payload.unitId, itemName: gearFound.itemName, checkedOutAt: adventurePrep_nowIso_() };
  } finally {
    lock.releaseLock();
  }
}

/** Section 4: the deliberate minimum-viable interim replacement for Uber Direct — one staff-triggered, timestamped action. */
function gearOps_markDelivered(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var now = adventurePrep_nowIso_();
    target.sheet.getRange(target.rowIndex, target.headerMap['gearDeliveredAt']).setValue(now);
    target.sheet.getRange(target.rowIndex, target.headerMap['gearDeliveredBy']).setValue(payload.deliveredBy || '');
    return { ok: true, bookingId: payload.bookingId, gearDeliveredAt: now, gearDeliveredBy: payload.deliveredBy || '' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Small helper distinct from adventurePrep_getOrCreateRow_ (which targets
 * the `Adventure Prep` tab specifically) — this one targets `Experience
 * Bookings`, where the row always already exists (booking time), so this
 * never creates, only finds-or-errors.
 */
function adventurePrep_getOrCreateRow_findExperienceBooking_(ss, bookingId) {
  var sheet = ss.getSheetByName('Experience Bookings');
  var found = adventurePrep_findRowByColumnValue_(sheet, 'bookingId', bookingId);
  if (!found) throw new Error('Booking not found: ' + bookingId);
  return { sheet: sheet, rowIndex: found.rowIndex, headerMap: found.headerMap };
}

// ---------------------------------------------------------------------------
// Section 5/9: Return Check-In
// ---------------------------------------------------------------------------

/** Every active booking whose trip date is exactly `tripDate` — the check-in queue's own "returned yesterday" list, same shape as the checkout queue. */
function gearOps_getCheckinQueue(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var status = r.bookingStatus || 'active';
    return status === 'active' && String(r.date || '').indexOf(payload.tripDate) === 0 && r.gearDeliveredAt;
  });
  return {
    bookings: rows.map(function (r) {
      return { bookingId: r.bookingId, contactName: r.contactName, tripDate: r.date, gearDeliveredAt: r.gearDeliveredAt };
    }),
  };
}

/** Every trackable Gear Check Log row for a booking, joined with its unit's current itemType/usesSinceDeepClean/replacementCostCents — everything the check-in screen needs to render per-item, in one call. */
function gearOps_getCheckinContext(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var gearSheet = ss.getSheetByName('Gear Check Log');
  var unitsSheet = ss.getSheetByName('Gear Units');
  var gearRows = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
    return String(r.bookingId) === String(payload.bookingId) && r.unitId;
  });
  var unitRows = adventurePrep_readRowsAsObjects_(unitsSheet);
  var unitsById = {};
  unitRows.forEach(function (u) { unitsById[u.unitId] = u; });

  var items = gearRows.map(function (r) {
    var u = unitsById[r.unitId] || {};
    return {
      unitId: r.unitId, itemName: r.itemName, itemType: u.itemType || GEAR_ITEM_NAME_TO_TYPE[r.itemName] || '',
      kitNumber: r.kitNumber, personName: r.personName,
      condition: r.condition || '', checkedOutAt: r.checkedOutAt || '', checkedInAt: r.checkedInAt || '',
      graceDeadline: r.graceDeadline || '', recoveredAt: r.recoveredAt || '', notes: r.notes || '', photoUrl: r.photoUrl || '',
      usesSinceDeepClean: u.usesSinceDeepClean != null ? u.usesSinceDeepClean : '',
      deepCleanThreshold: (GEAR_ITEM_TYPE_CONFIG[u.itemType] || {}).deepCleanThreshold || '',
      replacementCostCents: u.replacementCostCents != null ? u.replacementCostCents : '',
    };
  });
  return { bookingId: payload.bookingId, items: items };
}

/**
 * Section 5: settled means every trackable item's condition is Good/
 * Damaged/Recovered, or Missing with its grace deadline already passed
 * (still eligible for reconciliation as a real loss) — never Missing with
 * grace still open. `nowIso` is passed in from Node (this project's
 * established pattern for anything date-comparison-sensitive across the
 * JSON boundary, see adventurePrep_finalizeKitChange's own header) rather
 * than read from `new Date()` here.
 */
function gearOps_isBookingSettled_(gearRows, nowIso) {
  var now = new Date(nowIso).getTime();
  return gearRows.every(function (r) {
    if (!r.unitId) return true; // not a trackable row (shouldn't happen post-filter, defensive)
    if (r.condition === 'Good' || r.condition === 'Damaged' || r.condition === 'Recovered') return true;
    if (r.condition === 'Missing') {
      if (!r.graceDeadline) return false; // Missing but no deadline ever set — data gap, treat as unsettled
      return new Date(r.graceDeadline).getTime() <= now;
    }
    return false; // no condition recorded yet at all — not checked in
  });
}

/**
 * Per-item check-in. Writes condition/checkedInAt/notes/photoUrl on the
 * Gear Check Log row, and routes the Gear Units row per Section 5:
 *   - Good or Recovered: usesSinceDeepClean (already incremented at
 *     checkout) is compared against this itemType's threshold — routes to
 *     needs_deep_clean if reached, needs_cleaning otherwise.
 *   - Damaged: status -> damaged_pending_repair (photo required, enforced
 *     at the API layer).
 *   - Missing: sets graceDeadline (nowIso + 48h, computed by the caller and
 *     passed in — see this file's `nowIso` convention above), Gear Units
 *     row is deliberately left at status=checked_out (still logically "out
 *     in the field" until Recovered or reconciliation settles it; a truly
 *     lost-forever unit is a separate, manual Retire Unit action staff take
 *     once they give up looking, not automated here).
 */
function gearOps_checkInItem(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var gearSheet = ss.getSheetByName('Gear Check Log');
    var found = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
      return String(r.bookingId) === String(payload.bookingId) && String(r.unitId) === String(payload.unitId);
    })[0];
    if (!found) return { ok: false, error: 'Gear Check Log row not found for this booking/unit' };
    var gearMap = adventurePrep_headerMap_(gearSheet);

    var condition = payload.condition;
    if (['Good', 'Damaged', 'Missing', 'Recovered'].indexOf(condition) === -1) {
      return { ok: false, error: 'condition must be Good, Damaged, Missing, or Recovered' };
    }

    var nowIso = payload.nowIso || new Date().toISOString();
    var set = function (col, value) { gearSheet.getRange(found.__rowIndex, gearMap[col]).setValue(value === undefined || value === null ? '' : value); };

    set('condition', condition);
    if (!found.checkedInAt || condition !== 'Missing') set('checkedInAt', nowIso);
    set('notes', payload.notes || found.notes || '');
    if (payload.photoUrl) set('photoUrl', payload.photoUrl);

    var unitsSheet = ss.getSheetByName('Gear Units');
    var unitFound = gearOps_findUnitRow_(unitsSheet, payload.unitId);
    var routedTo = null;

    if (condition === 'Missing') {
      set('graceDeadline', payload.graceDeadline || '');
      set('recoveredAt', '');
      routedTo = 'checked_out'; // unchanged, see header comment
    } else if (condition === 'Damaged') {
      set('graceDeadline', '');
      if (unitFound) {
        unitsSheet.getRange(unitFound.rowIndex, unitFound.headerMap['status']).setValue('damaged_pending_repair');
      }
      routedTo = 'damaged_pending_repair';
    } else {
      // Good or Recovered — both run the same cleaning/deep-clean routing.
      set('graceDeadline', '');
      if (condition === 'Recovered') set('recoveredAt', nowIso);
      if (unitFound) {
        var unit = gearOps_readUnit_(unitsSheet, unitFound);
        var threshold = (GEAR_ITEM_TYPE_CONFIG[unit.itemType] || {}).deepCleanThreshold;
        var uses = Number(unit.usesSinceDeepClean || 0);
        routedTo = (threshold && uses >= threshold) ? 'needs_deep_clean' : 'needs_cleaning';
        unitsSheet.getRange(unitFound.rowIndex, unitFound.headerMap['status']).setValue(routedTo);
      }
    }

    return { ok: true, bookingId: payload.bookingId, unitId: payload.unitId, condition: condition, routedTo: routedTo };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Section 7/10: reconciliation
// ---------------------------------------------------------------------------

/**
 * Everything api/reconcile-gear-deposit.js needs in one call: the booking's
 * Stripe/tier context, every trackable Gear Check Log row (for the
 * settled-check and the itemized total), and whether it's currently
 * settled. Does NOT talk to Stripe itself — that endpoint owns every Stripe
 * call directly, this only ever reads the Sheet.
 */
function gearOps_getReconciliationContext(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var booking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
  if (!booking) return { notFound: true };

  var gearSheet = ss.getSheetByName('Gear Check Log');
  var gearRows = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
    return String(r.bookingId) === String(payload.bookingId) && r.unitId;
  });
  var unitsSheet = ss.getSheetByName('Gear Units');
  var unitRows = adventurePrep_readRowsAsObjects_(unitsSheet);
  var unitsById = {};
  unitRows.forEach(function (u) { unitsById[u.unitId] = u; });

  var settled = gearOps_isBookingSettled_(gearRows, payload.nowIso || new Date().toISOString());

  return {
    bookingId: booking.bookingId,
    tier: booking.tier,
    contactEmail: booking.contactEmail,
    contactName: booking.contactName,
    mainPaymentIntentId: booking.mainPaymentIntentId,
    depositPaymentIntentId: booking.depositPaymentIntentId,
    depositStatus: booking.depositStatus || '',
    reconciledAt: booking.reconciledAt || '',
    reconciledAmountCents: booking.reconciledAmountCents != null && booking.reconciledAmountCents !== '' ? Number(booking.reconciledAmountCents) : null,
    // Added for api/charge-gear-shortfall.js and api/refund-gear-charge.js —
    // both need this booking's full shortfall/refund state in one call
    // rather than re-reading the Experience Bookings row a second way.
    // Additive only, existing callers (api/reconcile-gear-deposit.js) are
    // unaffected.
    gearShortfallCents: booking.gearShortfallCents != null && booking.gearShortfallCents !== '' ? Number(booking.gearShortfallCents) : null,
    shortfallChargeId: booking.shortfallChargeId || '',
    shortfallChargedAmountCents: booking.shortfallChargedAmountCents != null && booking.shortfallChargedAmountCents !== '' ? Number(booking.shortfallChargedAmountCents) : null,
    shortfallChargedAt: booking.shortfallChargedAt || '',
    depositRefundId: booking.depositRefundId || '',
    depositRefundAmountCents: booking.depositRefundAmountCents || '',
    shortfallRefundId: booking.shortfallRefundId || '',
    shortfallRefundAmountCents: booking.shortfallRefundAmountCents || '',
    refundedAt: booking.refundedAt || '',
    settled: settled,
    items: gearRows.map(function (r) {
      var u = unitsById[r.unitId] || {};
      return {
        unitId: r.unitId, itemName: r.itemName, itemType: u.itemType || '',
        condition: r.condition || '', graceDeadline: r.graceDeadline || '', recoveredAt: r.recoveredAt || '',
        photoUrl: r.photoUrl || '',
        replacementCostCents: u.replacementCostCents != null ? u.replacementCostCents : (GEAR_ITEM_TYPE_CONFIG[u.itemType] || {}).defaultReplacementCostCents || 0,
      };
    }),
  };
}

/**
 * Section 7's write-back: depositStatus (released/partial_capture/
 * full_capture/full_capture_pending_review), reconciledAt,
 * reconciledAmountCents (amount actually captured), gearShortfallCents
 * (Scenario 4 only — the fixed, stored figure charge-gear-shortfall.js
 * reads back rather than recomputing live, per Section 10's idempotency-key
 * correction), plus an audit Change Log row listing every settled item.
 */
function gearOps_writeReconciliation(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var set = function (col, value) {
      if (!target.headerMap[col]) return;
      target.sheet.getRange(target.rowIndex, target.headerMap[col]).setValue(value === undefined || value === null ? '' : value);
    };
    set('depositStatus', payload.depositStatus);
    set('reconciledAt', payload.reconciledAt);
    set('reconciledAmountCents', payload.reconciledAmountCents);
    set('gearShortfallCents', payload.gearShortfallCents != null ? payload.gearShortfallCents : '');

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'gear_reconciliation',
      beforeT3Cutoff: false,
      newValueJson: JSON.stringify({
        depositStatus: payload.depositStatus,
        reconciledAmountCents: payload.reconciledAmountCents,
        gearShortfallCents: payload.gearShortfallCents || 0,
        itemizedItems: payload.itemizedItems || [],
      }),
      refundOrChargeAmount: payload.reconciledAmountCents != null ? payload.reconciledAmountCents / 100 : '',
      stripeTransactionId: payload.stripeTransactionId || '',
      staffNotes: 'Automated gear deposit reconciliation.',
    });

    return { ok: true, bookingId: payload.bookingId };
  } finally {
    lock.releaseLock();
  }
}

/** Section 10: the Scenario-4-only manual-review queue. */
function gearOps_listReconciliationQueue(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    return r.depositStatus === 'full_capture_pending_review' || r.depositStatus === 'shortfall_charged';
  });
  return {
    bookings: rows.map(function (r) {
      return {
        bookingId: r.bookingId, contactName: r.contactName, tripDate: r.date,
        depositStatus: r.depositStatus, reconciledAmountCents: r.reconciledAmountCents,
        gearShortfallCents: r.gearShortfallCents, reconciledAt: r.reconciledAt,
        shortfallChargedAmountCents: r.shortfallChargedAmountCents || '', shortfallChargedAt: r.shortfallChargedAt || '',
      };
    }),
  };
}

/** api/charge-gear-shortfall.js's write-back on a successful charge. */
function gearOps_recordShortfallCharge(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var set = function (col, value) {
      if (!target.headerMap[col]) return;
      target.sheet.getRange(target.rowIndex, target.headerMap[col]).setValue(value === undefined || value === null ? '' : value);
    };
    set('depositStatus', 'shortfall_charged');
    set('shortfallChargeId', payload.shortfallChargeId);
    set('shortfallChargedAmountCents', payload.shortfallChargedAmountCents);
    set('shortfallChargedAt', payload.shortfallChargedAt);
    set('shortfallStaffNotes', payload.staffNotes || '');

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId, changeType: 'gear_shortfall_charge', beforeT3Cutoff: false,
      refundOrChargeAmount: payload.shortfallChargedAmountCents != null ? payload.shortfallChargedAmountCents / 100 : '',
      stripeTransactionId: payload.shortfallChargeId || '', staffNotes: payload.staffNotes || '',
    });
    return { ok: true, bookingId: payload.bookingId };
  } finally {
    lock.releaseLock();
  }
}

/** api/charge-gear-shortfall.js's write-back on a FAILED charge — status stays reviewable, not silently stuck. */
function gearOps_recordShortfallChargeFailure(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_appendChangeLog_(ss, {
    bookingId: payload.bookingId, changeType: 'gear_shortfall_charge_failed', beforeT3Cutoff: false,
    staffNotes: payload.detail || 'Shortfall charge attempt failed.',
  });
  return { ok: true, bookingId: payload.bookingId };
}

/**
 * api/refund-gear-charge.js's write-back — the new refund/partial-refund
 * gap the design pass surfaced (Section 10 addendum). `target` is
 * 'deposit' (the capture from reconciliation) or 'shortfall' (the Scenario
 * 4 follow-up charge); each gets its own pair of refundId/refundAmountCents
 * columns so a booking can show both if both ever happened.
 */
function gearOps_recordRefund(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var set = function (col, value) {
      if (!target.headerMap[col]) return;
      target.sheet.getRange(target.rowIndex, target.headerMap[col]).setValue(value === undefined || value === null ? '' : value);
    };
    if (payload.refundTarget === 'shortfall') {
      set('shortfallRefundId', payload.refundId);
      set('shortfallRefundAmountCents', payload.refundAmountCents);
    } else {
      set('depositRefundId', payload.refundId);
      set('depositRefundAmountCents', payload.refundAmountCents);
    }
    set('refundedAt', payload.refundedAt);
    set('refundStaffNotes', payload.staffNotes || '');

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId, changeType: 'gear_refund', beforeT3Cutoff: false,
      refundOrChargeAmount: payload.refundAmountCents != null ? -Math.abs(payload.refundAmountCents) / 100 : '',
      stripeTransactionId: payload.refundId || '', staffNotes: '[' + (payload.refundTarget || 'deposit') + '] ' + (payload.staffNotes || ''),
    });
    return { ok: true, bookingId: payload.bookingId };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Section 8: hold-renewal safety net
// ---------------------------------------------------------------------------

/**
 * Candidates for renewal: active bookings with depositStatus='held',
 * not yet reconciled, and NOT already renewed once (the actual "has it
 * been >=3 days" math is date arithmetic done in Node, lib/cadence.js — see
 * api/renew-deposit-hold.js — this just returns raw rows to filter). Also
 * returns depositHoldRenewedAt so Node can re-derive the reference point
 * for a SECOND renewal if reconciliation is still stuck days after the
 * first one (Section 8's safety net is a recurring backstop, not a
 * one-shot).
 */
function gearOps_listHoldRenewalCandidates(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var status = r.bookingStatus || 'active';
    return status === 'active' && r.depositStatus === 'held' && !r.reconciledAt;
  });
  return {
    bookings: rows.map(function (r) {
      return {
        bookingId: r.bookingId, tripDate: r.date, depositHoldRenewedAt: r.depositHoldRenewedAt || '',
        mainPaymentIntentId: r.mainPaymentIntentId, depositPaymentIntentId: r.depositPaymentIntentId,
        contactEmail: r.contactEmail, contactName: r.contactName,
      };
    }),
  };
}

/** Written by api/renew-deposit-hold.js right after a successful renewal, so the NEXT day's candidate list uses this as the new reference point (Section 8's recurring-safety-net framing). */
function gearOps_recordHoldRenewed(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    target.sheet.getRange(target.rowIndex, target.headerMap['depositHoldRenewedAt']).setValue(payload.renewedAt || adventurePrep_nowIso_());
    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId, changeType: 'gear_hold_renewed', beforeT3Cutoff: false,
      staffNotes: 'Old hold ' + (payload.oldPaymentIntentId || '') + ' cancelled, new hold ' + (payload.newPaymentIntentId || '') + ' placed by the automated 3-day safety net.',
    });
    return { ok: true, bookingId: payload.bookingId };
  } finally {
    lock.releaseLock();
  }
}
