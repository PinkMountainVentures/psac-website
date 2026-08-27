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

// Mirrors api/reconcile-gear-deposit.js's own ALREADY_RECONCILED_STATUSES —
// any depositStatus this booking could only reach by having already gone
// through reconciliation once. Used by gearOps_checkInItem's post-incident
// safety net below (2026-08-25) to detect a condition correction landing
// after the hold is already resolved.
var RECONCILED_DEPOSIT_STATUSES_ = ['released', 'partial_capture', 'full_capture', 'full_capture_pending_review', 'shortfall_charged'];

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
/**
 * Normalizes a Bookings sheet "date" cell to a plain 'yyyy-MM-dd' string
 * for comparison against a caller-supplied tripDate.
 *
 * REAL BUG FOUND 2026-08-25, during the gear-ops live verification pass:
 * bookings-code.gs writes payload.date as a plain ISO string
 * ("2026-08-29") via appendRow(). With the "date" column's format left as
 * Sheets' default "Automatic", Sheets silently auto-converts that
 * unambiguous date-looking string into a real Date-typed cell on write —
 * confirmed directly against the live sheet (the date column reads
 * right-aligned, Sheets' own signal for a number/date value, not text).
 * Every date-filtered queue in this codebase was comparing
 * String(r.date || '').indexOf(payload.tripDate) === 0 against that cell
 * — String(aDateObject) reads like "Sat Aug 29 2026 00:00:00 GMT-0700
 * (Pacific Daylight Time)", which never starts with an ISO tripDate
 * string, so the filter silently excluded every booking, always. This
 * affected THREE call sites: gearOps_getCheckoutQueue and
 * gearOps_getCheckinQueue below, and holdClearance_listBookingsForTripDate
 * (hold-clearance-actions.gs) — the last of which the actual T-1
 * deposit-hold-placement cron (api/trigger-deposit-holds.js) depends on to
 * find bookings due for a hold, meaning that cron has likely never found a
 * real candidate on its own in production; every hold placed so far came
 * from a manual/direct call instead. Handles both a real Date object (the
 * live, actual case) and a plain string (a booking saved before this fix,
 * or if the column's format is ever changed to Plain Text), so this is
 * safe regardless of which type a given cell happens to hold.
 */
function gearOps_normalizeDateString_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value || '');
}

function gearOps_getCheckoutQueue(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var status = r.bookingStatus || 'active';
    return status === 'active' && gearOps_normalizeDateString_(r.date).indexOf(payload.tripDate) === 0;
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
    return status === 'active' && gearOps_normalizeDateString_(r.date).indexOf(payload.tripDate) === 0 && r.gearDeliveredAt;
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
  // BUG FIX (payment-review, Aug 2026, High #16): Array.prototype.every on a
  // genuinely EMPTY gearRows array returns true (vacuous truth) — a booking
  // with zero Gear Check Log rows for it at all (not the already-fixed
  // filtered-to-empty-by-unitId case just below, but really zero rows,
  // e.g. a booking that was never allocated gear in the first place, or a
  // gearOps_getReconciliationContext call that ran before any check-in
  // record existed yet) read as "settled" with nothing to reconcile,
  // instead of correctly reading as not settled / not applicable. Explicit
  // early return closes the gap the earlier 2026-08-25 fix (below) didn't
  // cover.
  if (!gearRows.length) return false;
  var now = new Date(nowIso).getTime();
  return gearRows.every(function (r) {
    // BUG FIX (2026-08-25, live reconciliation testing): this used to read
    // `if (!r.unitId) return true`, on the assumption the caller already
    // filtered gearRows down to unitId-having rows so this branch could
    // never actually fire. That assumption was wrong — the real caller,
    // gearOps_getReconciliationContext, filtered its own gearRows to
    // `r.unitId` truthy BEFORE calling here, so a booking that hadn't been
    // allocated/checked out yet produced an EMPTY gearRows array, and
    // `[].every(...)` is vacuously true in JS — meaning any booking whose
    // gear hadn't even been checked out yet read as "settled" with $0
    // itemized, and the reconciliation cron (api/trigger-gear-
    // reconciliation.js, every 15 min) auto-canceled its live deposit hold
    // almost immediately after it was placed, well before checkout — a real
    // production bug caught live when it silently canceled two active test
    // holds before their checkout even started. Fixed at both ends: this
    // function no longer receives a pre-filtered gearRows (the caller now
    // passes every row for the booking, unallocated included), and a row
    // with no unitId now correctly reads as NOT settled — it hasn't even
    // been checked out yet, so it can't possibly be checked in.
    if (!r.unitId) return false; // not yet allocated/checked out — never settled
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

    // Safety net (2026-08-25, post-incident — see Fix G/settle-buffer header
    // comments above for the full story): a condition write for a
    // chargeable state (Damaged/Missing) landing AFTER this booking's
    // deposit hold has already been reconciled previously went nowhere —
    // the correction was silently absorbed into the Sheet with no signal
    // that money might now be owed, and no automatic path was left to
    // recover it (Stripe's capture/cancel already happened and can't be
    // reopened). Catch it here instead: raise an Ops Alert so a human
    // decides whether a manual charge is needed, rather than the
    // newly-discovered cost being lost silently a second time. Never lets a
    // failure here block the check-in write itself — the condition/photo
    // are already saved above by this point.
    if (condition === 'Damaged' || condition === 'Missing') {
      try {
        var bookingForAlert = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
        if (bookingForAlert && RECONCILED_DEPOSIT_STATUSES_.indexOf(bookingForAlert.depositStatus) !== -1) {
          var lateUnit = unitFound ? gearOps_readUnit_(unitsSheet, unitFound) : null;
          var lateCostCents = lateUnit && lateUnit.replacementCostCents != null ? Number(lateUnit.replacementCostCents) : 0;
          opsAlerts_recordAlert({
            bookingId: payload.bookingId,
            alertType: 'gear_condition_corrected_after_reconciliation',
            amount: lateCostCents ? lateCostCents / 100 : 0,
            urgency: 'urgent_same_day',
            notes: 'Item ' + payload.unitId + ' (' + found.itemName + ') was marked ' + condition +
              ' after this booking\'s deposit hold was already reconciled (depositStatus=' + bookingForAlert.depositStatus +
              '). That reconciliation ran without this item\'s real condition, so the deposit outcome may no longer be' +
              ' correct — review whether a manual charge is owed (api/apply-manual-adjustment.js or api/charge-gear-shortfall.js).',
          });
        }
      } catch (alertErr) {
        // Never let the alert path block check-in itself.
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
  // BUG FIX (2026-08-25): this used to filter to `r.unitId` truthy, which
  // silently dropped every row for a booking that hadn't been
  // allocated/checked out yet — see gearOps_isBookingSettled_'s own header
  // comment for the full incident this caused. Now returns every Gear
  // Check Log row for the booking regardless of allocation state, so
  // gearOps_isBookingSettled_ actually sees the not-yet-checked-out rows
  // and can correctly call the booking unsettled.
  var gearRows = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
    return String(r.bookingId) === String(payload.bookingId);
  });
  var unitsSheet = ss.getSheetByName('Gear Units');
  var unitRows = adventurePrep_readRowsAsObjects_(unitsSheet);
  var unitsById = {};
  unitRows.forEach(function (u) { unitsById[u.unitId] = u; });

  var settled = gearOps_isBookingSettled_(gearRows, payload.nowIso || new Date().toISOString());

  // Settle-buffer support (2026-08-25, post-incident): the latest
  // checkedInAt across every row for this booking. api/reconcile-gear-
  // deposit.js uses this to require a booking to have sat fully settled for
  // a buffer window before it will actually resolve the Stripe hold — see
  // that file's own header comment for the incident this closes (a
  // condition correction landing after a cron tick had already read the
  // booking as settled-with-$0-itemized and canceled the hold for real,
  // an hour before the correcting edit). gearOps_checkInItem re-stamps
  // checkedInAt on every write, corrections included, so this naturally
  // reflects "time since the last edit to any item," not just first entry.
  var lastItemUpdateIso = gearRows.reduce(function (latest, r) {
    if (!r.checkedInAt) return latest;
    if (!latest || new Date(r.checkedInAt).getTime() > new Date(latest).getTime()) return r.checkedInAt;
    return latest;
  }, null);

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
    lastItemUpdateIso: lastItemUpdateIso || '',
    items: gearRows.map(function (r) {
      var u = unitsById[r.unitId];
      // BUG FIX (payment-review, Aug 2026, Medium #30): the old
      // `unitsById[r.unitId] || {}` fallback treated "this row's unitId
      // doesn't match ANY row in Gear Units" (a typo'd/retired/deleted
      // unit — a real Sheet data-integrity problem) identically to "this
      // Gear Check Log row genuinely has no itemType info yet" — both fell
      // through to `{}`, both silently priced at $0. For a Damaged/Missing
      // item that's real, documented damage getting charged nothing,
      // undercharging the guest with no signal anything was wrong. Kept
      // the $0 fallback (this function can't safely block the whole
      // reconciliation-context call over one bad row), but now flags it
      // with an Ops Alert so a human finds out and can charge it manually
      // (api/apply-manual-adjustment.js) instead of it being silently lost.
      // holdClearance_findOpenDepositAlert (apps-script/hold-clearance-
      // actions.gs, same script project/global scope) dedupes so repeated
      // calls to this function — it's read on every settle-buffer check,
      // not just once — don't spam a fresh alert every time.
      var itemType = u ? (u.itemType || '') : '';
      var replacementCostCents = u
        ? (u.replacementCostCents != null ? u.replacementCostCents : (GEAR_ITEM_TYPE_CONFIG[itemType] || {}).defaultReplacementCostCents || 0)
        : 0;
      if (!u && r.unitId && (r.condition === 'Damaged' || r.condition === 'Missing')) {
        try {
          var existingAlert = holdClearance_findOpenDepositAlert({ bookingId: payload.bookingId, alertType: 'gear_reconciliation_unmatched_unit' });
          if (!existingAlert || !existingAlert.found) {
            opsAlerts_recordAlert({
              bookingId: payload.bookingId,
              alertType: 'gear_reconciliation_unmatched_unit',
              amount: 0,
              urgency: 'urgent_same_day',
              notes: 'Gear Check Log row for unitId "' + r.unitId + '" (' + (r.itemName || 'unknown item') + ', condition: ' + r.condition + ') has no matching row in Gear Units — replacementCostCents defaulted to $0 for reconciliation purposes. Likely a typo\'d, retired, or deleted unit. Review whether a manual charge (api/apply-manual-adjustment.js) is owed for this item before/after this booking\'s deposit resolves.',
            });
          }
        } catch (alertErr) {
          // Never let the alert path block reconciliation context itself.
        }
      }
      return {
        unitId: r.unitId, itemName: r.itemName, itemType: itemType,
        condition: r.condition || '', graceDeadline: r.graceDeadline || '', recoveredAt: r.recoveredAt || '',
        photoUrl: r.photoUrl || '',
        replacementCostCents: replacementCostCents,
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

    // BUG FIX (payment-review, Aug 2026, High #14): compare-and-swap guard
    // against the renewal-vs-reconciliation race. create-deposit-hold.js
    // (purpose:'renewal') writes a NEW depositPaymentIntentId +
    // depositStatus:'held' the moment a renewed hold succeeds, BEFORE it
    // separately cancels the old hold. api/reconcile-gear-deposit.js reads
    // ctx.depositPaymentIntentId at the START of its own run, acts on
    // Stripe against THAT PaymentIntent, and only writes back here at the
    // end — a window in which a renewal can swap the PaymentIntent
    // reference out from under it. If the caller tells us which
    // PaymentIntent it actually acted against (payload.
    // expectedPaymentIntentId — optional, backward compatible with every
    // existing caller that omits it) and the Sheet's CURRENT
    // depositPaymentIntentId no longer matches, refuse the write rather
    // than clobbering the record of the new hold with stale figures
    // describing the old, already-superseded one.
    if (payload.expectedPaymentIntentId) {
      var currentPaymentIntentId = target.headerMap['depositPaymentIntentId']
        ? target.sheet.getRange(target.rowIndex, target.headerMap['depositPaymentIntentId']).getValue()
        : '';
      if (String(currentPaymentIntentId) !== String(payload.expectedPaymentIntentId)) {
        return {
          ok: false,
          stale: true,
          bookingId: payload.bookingId,
          expectedPaymentIntentId: payload.expectedPaymentIntentId,
          currentPaymentIntentId: currentPaymentIntentId,
        };
      }
    }

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

/**
 * BUG FIX (payment-review, Aug 2026, High #17): api/charge-gear-shortfall.js
 * had no server-side lock — Stripe's Idempotency-Key only dedupes an EXACT
 * retry (same bookingId + reconciledAt + amount); two overlapping requests
 * with DIFFERENT requestedAmountCents (a staff double-click landing between
 * an edit to the adjusted-amount field, or two staff members working the
 * same Reconciliation Review queue entry at once) both pass that gate as
 * two genuinely different Stripe idempotency keys, creating two separate
 * real off-session charges. Gate every charge attempt through this
 * compare-and-swap: only a caller that sees depositStatus still
 * 'full_capture_pending_review' proceeds, and it atomically claims the row
 * by flipping depositStatus to 'shortfall_charge_in_progress' — inside this
 * same LockService lock every other write-back in this file already uses —
 * before releasing the lock, so a second, concurrent request sees the
 * claimed state and is turned away before ever calling Stripe.
 *
 * A stale claim (the Stripe call started but the process never got back
 * here to record success or failure — a serverless timeout or crash, not
 * a normal error path, which already self-heals via
 * gearOps_recordShortfallChargeFailure reverting the claim below) is
 * allowed through again after SHORTFALL_CHARGE_LOCK_STALE_MS, so a
 * genuinely abandoned attempt doesn't block this booking's shortfall
 * charge forever. Requires a new 'shortfallChargeLockAt' column on
 * Experience Bookings — see the build checklist for the one-time sheet
 * change this needs before this function can be pasted in live.
 */
var SHORTFALL_CHARGE_LOCK_STALE_MS = 5 * 60 * 1000;

function gearOps_beginShortfallCharge(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var statusCol = target.headerMap['depositStatus'];
    var lockAtCol = target.headerMap['shortfallChargeLockAt'];
    var currentStatus = statusCol ? target.sheet.getRange(target.rowIndex, statusCol).getValue() : '';
    var currentLockAt = lockAtCol ? target.sheet.getRange(target.rowIndex, lockAtCol).getValue() : '';

    if (String(currentStatus) === 'shortfall_charge_in_progress') {
      var lockAgeMs = currentLockAt ? (new Date().getTime() - new Date(currentLockAt).getTime()) : Infinity;
      if (lockAgeMs < SHORTFALL_CHARGE_LOCK_STALE_MS) {
        return { ok: false, reason: 'charge_in_progress', depositStatus: String(currentStatus), lockAgeMs: lockAgeMs };
      }
      // Stale claim from an abandoned attempt — fall through and reclaim it.
    } else if (String(currentStatus) !== 'full_capture_pending_review') {
      return { ok: false, reason: 'not_in_review_state', depositStatus: String(currentStatus) };
    }

    var nowIso = payload.nowIso || new Date().toISOString();
    if (statusCol) target.sheet.getRange(target.rowIndex, statusCol).setValue('shortfall_charge_in_progress');
    if (lockAtCol) target.sheet.getRange(target.rowIndex, lockAtCol).setValue(nowIso);

    return { ok: true, bookingId: payload.bookingId };
  } finally {
    lock.releaseLock();
  }
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

  // BUG FIX (payment-review, Aug 2026, High #17): release this booking's
  // shortfall-charge claim (see gearOps_beginShortfallCharge above) on a
  // failed attempt, so the very next retry doesn't have to wait out
  // SHORTFALL_CHARGE_LOCK_STALE_MS to try again.
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_findExperienceBooking_(ss, payload.bookingId);
    var statusCol = target.headerMap['depositStatus'];
    if (statusCol) {
      var currentStatus = target.sheet.getRange(target.rowIndex, statusCol).getValue();
      if (String(currentStatus) === 'shortfall_charge_in_progress') {
        target.sheet.getRange(target.rowIndex, statusCol).setValue('full_capture_pending_review');
      }
    }
  } finally {
    lock.releaseLock();
  }

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
    // BUG FIX (payment-review, Aug 2026, Medium #34/#35): read the row's
    // state as it stood BEFORE this call's own writes below, both to
    // accumulate correctly and to decide the depositStatus transition off
    // the pre-write value.
    var before = adventurePrep_findExperienceBookingById_(ss, payload.bookingId) || {};
    var set = function (col, value) {
      if (!target.headerMap[col]) return;
      target.sheet.getRange(target.rowIndex, target.headerMap[col]).setValue(value === undefined || value === null ? '' : value);
    };

    // BUG FIX (Medium #34): depositRefundAmountCents/shortfallRefundAmountCents
    // used to be overwritten with just THIS call's refundAmountCents on every
    // call — a booking with two legitimate partial refunds (e.g. two
    // different recovered items refunded separately) ended up showing only
    // the most recent one, undercounting the true total refunded. Now
    // accumulates. Each individual refund's own amount/id/timestamp is still
    // separately and permanently recorded in the Change Log entry below on
    // every call regardless — this only fixes the running-total columns
    // cached on the booking row itself.
    var cumulativeRefundAmountCents;
    if (payload.refundTarget === 'shortfall') {
      cumulativeRefundAmountCents = Number(before.shortfallRefundAmountCents || 0) + Number(payload.refundAmountCents || 0);
      set('shortfallRefundId', payload.refundId);
      set('shortfallRefundAmountCents', cumulativeRefundAmountCents);
    } else {
      cumulativeRefundAmountCents = Number(before.depositRefundAmountCents || 0) + Number(payload.refundAmountCents || 0);
      set('depositRefundId', payload.refundId);
      set('depositRefundAmountCents', cumulativeRefundAmountCents);
    }
    set('refundedAt', payload.refundedAt);
    set('refundStaffNotes', payload.staffNotes || '');

    // BUG FIX (Medium #35): this never touched depositStatus at all — a
    // booking sitting in the Section 10 manual-review queue
    // (gearOps_listReconciliationQueue, gated on depositStatus being
    // 'full_capture_pending_review' or 'shortfall_charged') stayed there
    // forever even after every dollar actually captured/charged against it
    // had been fully refunded, inviting a duplicate refund or shortfall-
    // charge attempt later by a staff member with no signal it was already
    // resolved. Only advances the booking to a new terminal 'refunded'
    // status once EVERYTHING that was actually taken has been given back —
    // both the deposit capture (reconciledAmountCents) and, if one was ever
    // charged, the separate shortfall charge (shortfallChargedAmountCents).
    // A partial refund correctly leaves depositStatus unchanged, so the
    // booking stays visible in the queue for staff to keep tracking.
    // 'refunded' falls outside every existing status check downstream:
    // api/reconcile-gear-deposit.js's ALREADY_RECONCILED_STATUSES gets it
    // added alongside this fix so a stray reconciliation retry reports the
    // correct "already reconciled" rather than an "unexpected_deposit_status"
    // error; api/charge-gear-shortfall.js's own compare-and-swap already
    // only proceeds from the exact literal 'full_capture_pending_review',
    // so 'refunded' is naturally refused there with no separate change
    // needed.
    var currentStatus = String(before.depositStatus || '');
    if (currentStatus === 'full_capture_pending_review' || currentStatus === 'shortfall_charged') {
      var reconciledAmountCents = Number(before.reconciledAmountCents || 0);
      var shortfallChargedAmountCents = Number(before.shortfallChargedAmountCents || 0);
      var depositRefundedCents = payload.refundTarget === 'shortfall' ? Number(before.depositRefundAmountCents || 0) : cumulativeRefundAmountCents;
      var shortfallRefundedCents = payload.refundTarget === 'shortfall' ? cumulativeRefundAmountCents : Number(before.shortfallRefundAmountCents || 0);
      var depositFullyRefunded = reconciledAmountCents <= 0 || depositRefundedCents >= reconciledAmountCents;
      var shortfallFullyRefunded = shortfallChargedAmountCents <= 0 || shortfallRefundedCents >= shortfallChargedAmountCents;
      if (depositFullyRefunded && shortfallFullyRefunded) {
        set('depositStatus', 'refunded');
      }
    }

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId, changeType: 'gear_refund', beforeT3Cutoff: false,
      refundOrChargeAmount: payload.refundAmountCents != null ? -Math.abs(payload.refundAmountCents) / 100 : '',
      stripeTransactionId: payload.refundId || '', staffNotes: '[' + (payload.refundTarget || 'deposit') + '] ' + (payload.staffNotes || ''),
    });
    return { ok: true, bookingId: payload.bookingId, cumulativeRefundAmountCents: cumulativeRefundAmountCents };
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
  // BUG FIX (2026-08-25, live reconciliation testing, Fix H): this used to
  // also require `!r.reconciledAt`, on the assumption a booking's
  // reconciledAt only ever gets set once a hold is truly done. That's not
  // true across a hold's full lifecycle: `depositStatus` alone is already
  // the authoritative "is there a live hold right now" signal (reconcile-
  // gear-deposit.js's own ALREADY_RECONCILED_STATUSES check independently
  // guards against double-reconciling off of it), so requiring a blank
  // reconciledAt on top of that is redundant in the normal case and
  // actively wrong whenever a booking gets a genuinely fresh hold after an
  // earlier reconciliation already ran on it — reconciledAt is never
  // cleared when a new hold is placed (renewal, or recovering a hold that
  // was cancelled and re-placed), so a stale reconciledAt value from a
  // PRIOR reconciliation cycle silently and permanently excluded the
  // booking from ever being picked up again, hit live when a hold that
  // had been auto-released by the Fix G bug was re-placed — the fresh held
  // hold never appeared in this candidate list because reconciledAt from
  // the earlier cycle was still sitting on the row. Dropped the clause;
  // depositStatus === 'held' is sufficient on its own.
  // BUG FIX (2026-08-27, Ops App Redesign Round 2 cross-check): this used
  // to require status === 'active' only, which silently dropped a booking
  // the moment it moved to the new 'cancelled_post_delivery' status
  // (manualAdjustment_postDeliveryCancellation, ops-redesign-round2-actions.gs)
  // even while it still had a live depositStatus='held' hold on the
  // guest's card. That hold would then never be captured, released, or
  // renewed by any automated process — reconciliation and the renewal
  // safety net both use this same candidate list — so it would just sit
  // untouched until Stripe's own 5-7 day authorization naturally expired
  // it uncaptured, silently forfeiting any damage/missing-gear charge
  // PSAC was owed. A post-delivery cancellation still needs gear picked up
  // (gearOps_getCheckinQueueV2 already treats it that way) and its hold
  // still needs to resolve, so it belongs in this list too. Widened the
  // status check to match that precedent rather than adding a second,
  // divergent status allowlist.
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var status = r.bookingStatus || 'active';
    return (status === 'active' || status === 'cancelled_post_delivery') && r.depositStatus === 'held';
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
    // BUG FIX (payment-review, Aug 2026, High #13/#20): oldHoldCancelSucceeded
    // is new and defaults to true when omitted, so any caller that doesn't
    // pass it keeps this function's original "cancelled" wording exactly as
    // before. Both callers of this function (api/renew-deposit-hold.js's
    // 3-day safety net, api/apply-manual-adjustment.js's kit-count-correction
    // hold resize) now pass it explicitly, and it can legitimately be false —
    // the old hold's cancel attempt genuinely failed, so it's still live,
    // not cancelled, and the audit trail should say so rather than assume.
    var cancelSucceeded = payload.oldHoldCancelSucceeded !== false;
    var cancelNote = cancelSucceeded
      ? 'cancelled'
      : 'NOT cancelled (cancel attempt failed — still live, see Ops Alerts for detail)';
    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId, changeType: 'gear_hold_renewed', beforeT3Cutoff: false,
      staffNotes: 'Old hold ' + (payload.oldPaymentIntentId || '') + ' ' + cancelNote + ', new hold ' + (payload.newPaymentIntentId || '') + ' placed by the automated 3-day safety net.',
    });
    return { ok: true, bookingId: payload.bookingId };
  } finally {
    lock.releaseLock();
  }
}