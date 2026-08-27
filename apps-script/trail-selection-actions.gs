/**
 * apps-script/trail-selection-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Adds the five doPost actions bucket 2.2 needs: three reads
 * (getAdventurePrepContext, getTrailDatabase, getParkAccess) and two writes
 * (writeCandidateTrails, openTrailSwapRequest).
 *
 * ============================================================================
 * HOW TO INSTALL — please read before pasting
 * ============================================================================
 *
 * 1. Add a new Script Property (Project Settings → Script Properties, same
 *    place BOOKINGS_WEBAPP_SECRET already lives):
 *
 *      TRAIL_DATABASE_SHEET_ID = 13-SZ7Jix3R5fMLTVyRhgPX_btqnCC3ps5M7f_4nUQ8c
 *
 *    That's the real Drive file ID for "PSAC_Trail_Database" — confirmed by
 *    reading the file directly, not guessed. The Trails tab and Park Access
 *    tab live in two DIFFERENT spreadsheets (Trail Database vs. Bookings &
 *    Operations), so this script needs to open a second spreadsheet by ID —
 *    that's the one new piece of plumbing this patch adds beyond what
 *    save-booking/create-deposit-hold already do.
 *
 * 2. Paste everything below the "PASTE BELOW THIS LINE" marker into Code.gs,
 *    anywhere at the top level (order doesn't matter in Apps Script).
 *
 * 3. Wire the five actions into your EXISTING doPost's action dispatch. I
 *    don't have your actual doPost in front of me, so I can't hand you an
 *    exact diff — but going by the shape saveBooking/getBooking/
 *    updateDepositStatus already take (an `action` field dispatched after
 *    the shared-secret check), it's almost certainly one of these two
 *    shapes. Add a branch for each of the five new action names,
 *    each calling straight into the matching function below:
 *
 *      // if your doPost is an if/else-if chain:
 *      } else if (data.action === 'getAdventurePrepContext') {
 *        result = trailSelection_getAdventurePrepContext(data.bookingId);
 *      } else if (data.action === 'getTrailDatabase') {
 *        result = trailSelection_getTrailDatabase();
 *      } else if (data.action === 'getParkAccess') {
 *        result = trailSelection_getParkAccess();
 *      } else if (data.action === 'writeCandidateTrails') {
 *        result = trailSelection_writeCandidateTrails(data);
 *      } else if (data.action === 'openTrailSwapRequest') {
 *        result = trailSelection_openTrailSwapRequest(data);
 *
 *      // if your doPost is a switch(data.action):
 *      case 'getAdventurePrepContext':
 *        result = trailSelection_getAdventurePrepContext(data.bookingId);
 *        break;
 *      // ...and so on for the other four, same as above.
 *
 *    Every function below is named with a `trailSelection_` prefix
 *    specifically so it can't collide with any existing function name in
 *    your Code.gs, however your dispatch is currently structured.
 *
 *    IMPORTANT: this patch assumes your doPost already validates
 *    `data.secret` against BOOKINGS_WEBAPP_SECRET BEFORE dispatching on
 *    `action` — exactly like saveBooking/getBooking/updateDepositStatus
 *    already rely on. None of the five functions below re-check the secret
 *    themselves. If that assumption is wrong (i.e. each action currently
 *    checks the secret itself, individually), tell me and I'll adjust.
 *
 * 4. Run setup() again after pasting (or trailSelection_setup() below,
 *    which only touches the two NEW tabs this patch cares about — Adventure
 *    Prep and Trail Swap Requests already have their real headers in place
 *    per your Aug 2026 sheet read, so this is just a defensive header check,
 *    not a rebuild).
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

// Column headers, copied verbatim from the live sheets (confirmed by reading
// them directly, not inferred) — kept here as a single source of truth so a
// header typo shows up as an obvious KeyNotFound rather than a silent
// undefined write.
var TRAIL_SELECTION_ADVENTURE_PREP_HEADERS = [
  'bookingId', 'isParticipating', 'participatingRosterRef', 'confirmedKitCount',
  'pendingKitCount', 'pendingSince', 'technicalComfort', 'heatComfort',
  'bestForAttributes', 'candidateTrails', 'selectedTrailId', 'assignedAt',
  'assignmentMethod', 'propertyType', 'deliveryAddressLine1', 'deliveryAddressLine2',
  'deliveryCity', 'deliveryState', 'deliveryZip', 'deliveryLat', 'deliveryLng',
  'deliveryAddressValidated', 'deliveryAddressRaw', 'deliveryWindow',
  'returnPreference', 'allWaiversComplete', 'adventurePrepStalledFlag',
  'phoneFallbackDue', 't3CutoffProcessedAt',
];

var TRAIL_SELECTION_SWAP_REQUEST_HEADERS = [
  'bookingId', 'guestConcernSummary', 'receivedAt', 'status', 'reviewedBy',
  'newTrailId', 'staffNotes', 'resolvedAt', 'tierASafetyFiltersOverridden',
  'safetyOverrideReason',
];

/** Defensive header check for the two tabs this patch writes to. Safe to
 * re-run; does nothing if headers already match. Does NOT touch Trails or
 * Park Access — those already exist with real headers and this patch only
 * ever reads them. */
function trailSelection_setup() {
  trailSelection_ensureHeaders_(SpreadsheetApp.getActiveSpreadsheet(), 'Adventure Prep', TRAIL_SELECTION_ADVENTURE_PREP_HEADERS);
  trailSelection_ensureHeaders_(SpreadsheetApp.getActiveSpreadsheet(), 'Trail Swap Requests', TRAIL_SELECTION_SWAP_REQUEST_HEADERS);
}

function trailSelection_ensureHeaders_(spreadsheet, tabName, headers) {
  var sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) throw new Error('trailSelection_setup: tab "' + tabName + '" does not exist — create it first');
  var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var matches = headers.every(function (h, i) { return existing[i] === h; });
  if (!matches) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

/** Opens the separate Trail Database spreadsheet by the Script Property set in step 1 above. */
function trailSelection_openTrailDatabase_() {
  var id = PropertiesService.getScriptProperties().getProperty('TRAIL_DATABASE_SHEET_ID');
  if (!id) throw new Error('TRAIL_DATABASE_SHEET_ID script property is not set — see install step 1');
  return SpreadsheetApp.openById(id);
}

/** Every row on a tab as a header-keyed plain object, e.g. row['Trail ID']. */
function trailSelection_readRowsAsObjects_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = values[i][j];
    }
    rows.push(row);
  }
  return rows;
}

/** 1-indexed sheet row number for a given bookingId, or -1 if not found.
 * Assumes column A is bookingId, matching every other tab on this sheet. */
function trailSelection_findRowIndexByBookingId_(sheet, bookingId) {
  var ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(bookingId)) return i + 2; // +2: 1-indexed, plus header row
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 1. getAdventurePrepContext — the one action that reads TWO tabs
//    (Adventure Prep + Experience Bookings) since the roster this engine
//    needs today lives on Experience Bookings' fullPayloadJson, not on
//    Adventure Prep itself. See README "Where roster data actually lives."
// ---------------------------------------------------------------------------
function trailSelection_getAdventurePrepContext(bookingId) {
  if (!bookingId) return { notFound: true };
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var apSheet = ss.getSheetByName('Adventure Prep');
  var apRows = trailSelection_readRowsAsObjects_(apSheet);
  var adventurePrep = apRows.filter(function (r) { return String(r.bookingId) === String(bookingId); })[0] || null;

  var ebSheet = ss.getSheetByName('Experience Bookings');
  var ebRows = trailSelection_readRowsAsObjects_(ebSheet);
  var experienceBooking = ebRows.filter(function (r) { return String(r.bookingId) === String(bookingId); })[0] || null;

  if (!adventurePrep && !experienceBooking) return { notFound: true };
  return { adventurePrep: adventurePrep, experienceBooking: experienceBooking };
}

// ---------------------------------------------------------------------------
// 2. getTrailDatabase — every row on the Trails tab of the SEPARATE Trail
//    Database spreadsheet. No filtering here (e.g. by Bookable?) — the
//    engine itself decides that, on purpose, so a future non-bookable-aware
//    caller isn't silently starved of rows it might legitimately need
//    (trailSelection_getAdventurePrepContext follows the same "give the
//    engine everything, let it decide" principle).
// ---------------------------------------------------------------------------
function trailSelection_getTrailDatabase() {
  var trailDb = trailSelection_openTrailDatabase_();
  var sheet = trailDb.getSheetByName('Trails');
  if (!sheet) throw new Error('trailSelection_getTrailDatabase: "Trails" tab not found in Trail Database spreadsheet');
  return { rows: trailSelection_readTrailsRows_(sheet) };
}

/**
 * BUG FIX (Aug 2026, trail-selection live-testing investigation — CONFIRMED
 * root cause of every live booking coming back with 0 qualifying trails,
 * regardless of trip date or roster). trailSelection_readRowsAsObjects_
 * (the shared helper, still correct everywhere else it's used — Adventure
 * Prep, Experience Bookings, Park Access all have a normal single header
 * row) assumes row 1 of a sheet is always the header row. The Trails tab
 * does not follow that: row 1 is a purely visual section-grouping row
 * Airey added for readability when scanning 53 trails across many columns
 * by eye (mostly blank cells, with section labels like "IDENTITY",
 * "LOCATION", "STATS" spanning groups of columns) — the real column
 * headers ("Trail ID", "Trail Name", "Bookable?", ...) live on row 2.
 * Confirmed directly via a screenshot of the live sheet.
 *
 * Reading row 1 as the header row meant every trail's fields got keyed by
 * 'IDENTITY' / '' / 'LOCATION' / '' / ... instead of their real column
 * names, so `row['Trail ID']`, `row['Bookable?']`, etc. came back
 * `undefined` for literally every one of the 53 rows — normalizeTrailRow
 * turned that into `trailId: null` / `bookable: false` across the board,
 * which fails the Bookable? Tier A check (an ABSOLUTE exclusion) for every
 * trail and empties the candidate pool every single time. This is why
 * changing trip date, roster fitness, or trail-experience tags never made
 * a difference in testing — none of those affect this at all.
 *
 * Fixed by finding the real header row directly (the first row containing
 * a "Trail ID" cell) instead of assuming it's row 1, so this keeps working
 * regardless of how many category/grouping rows Airey adds above it later.
 */
function trailSelection_readTrailsRows_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headerRowIndex = -1;
  for (var i = 0; i < values.length; i++) {
    if (values[i].indexOf('Trail ID') !== -1) {
      headerRowIndex = i;
      break;
    }
  }
  if (headerRowIndex === -1) {
    throw new Error('trailSelection_readTrailsRows_: could not find a header row containing "Trail ID" on the Trails tab');
  }
  var headers = values[headerRowIndex];
  var rows = [];
  for (var r = headerRowIndex + 1; r < values.length; r++) {
    var row = {};
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue; // blank/section-label column, nothing real to key by
      row[headers[c]] = values[r][c];
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 3. getParkAccess — every row on the Bookings & Operations sheet's own
//    Park Access tab. Returns { rows: [] } today since that tab is
//    headers-only in production — see README "Park Access is empty," this
//    is expected, not a bug in this action.
// ---------------------------------------------------------------------------
function trailSelection_getParkAccess() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Park Access');
  if (!sheet) throw new Error('trailSelection_getParkAccess: "Park Access" tab not found');
  return { rows: trailSelection_readRowsAsObjects_(sheet) };
}

// ---------------------------------------------------------------------------
// 4. writeCandidateTrails — the primary write. Updates candidateTrails,
//    assignedAt, assignmentMethod on the Adventure Prep row for this
//    booking. Deliberately does NOT touch selectedTrailId — bucket 2.2
//    never sets that field, by design (PRD Section 10 step 7).
//    LockService, matching this repo's existing write convention exactly.
// ---------------------------------------------------------------------------
function trailSelection_writeCandidateTrails(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Adventure Prep');
    var rowIndex = trailSelection_findRowIndexByBookingId_(sheet, data.bookingId);
    if (rowIndex === -1) {
      throw new Error('writeCandidateTrails: no Adventure Prep row for bookingId ' + data.bookingId);
    }
    var headers = TRAIL_SELECTION_ADVENTURE_PREP_HEADERS;
    var col = function (name) { return headers.indexOf(name) + 1; }; // 1-indexed

    sheet.getRange(rowIndex, col('candidateTrails')).setValue(JSON.stringify(data.candidateTrails));
    sheet.getRange(rowIndex, col('assignedAt')).setValue(data.assignedAt);
    sheet.getRange(rowIndex, col('assignmentMethod')).setValue(data.assignmentMethod);

    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 5. openTrailSwapRequest — appends a system-generated row to Trail Swap
//    Requests when fewer than 3 candidates qualified (PRD Section 8).
//    tierASafetyFiltersOverridden / safetyOverrideReason are left blank —
//    those are staff-entered fields for when a HUMAN overrides Tier A while
//    working the swap request, not something this system-generated open
//    event has an opinion about yet.
// ---------------------------------------------------------------------------
function trailSelection_openTrailSwapRequest(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Trail Swap Requests');
    var headers = TRAIL_SELECTION_SWAP_REQUEST_HEADERS;
    var row = headers.map(function (h) {
      if (h === 'bookingId') return data.bookingId;
      if (h === 'guestConcernSummary') return data.guestConcernSummary;
      if (h === 'receivedAt') return data.receivedAt;
      if (h === 'status') return data.status || 'Open';
      return ''; // reviewedBy, newTrailId, staffNotes, resolvedAt, override fields — staff fills these in later
    });
    sheet.appendRow(row);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
