/**
 * apps-script/adventure-prep-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs,
 * exactly the same delivery pattern as apps-script/trail-selection-actions.gs
 * (bucket 2.2's own patch). Adds everything Adventure Prep's two guest
 * surfaces (Surface A, Surface B) and adjust-gear-kit-count.js need on the
 * Sheet side: three new tabs, and a set of new doPost actions.
 *
 * Built against claude/psac-adventure-prep-jtbd-prd-v1.md Section 6 (schema),
 * Section 7 (waiver link mechanics), Section 8 (roster-row confirmation,
 * this chat's own answer, flagged for Airey in the handoff), and Section 1
 * (the gear-kit debounce).
 *
 * ============================================================================
 * HOW TO INSTALL — please read before pasting
 * ============================================================================
 *
 * 1. Paste everything below the "PASTE BELOW THIS LINE" marker into Code.gs
 *    (or as its own additional .gs file in the same Apps Script project —
 *    order doesn't matter, Apps Script shares one global scope per project).
 *
 * 2. Wire the new actions into the EXISTING doPost's action dispatch, same
 *    if/else-if chain trail-selection-actions.gs already added five branches
 *    to. Add one branch per action below:
 *
 *      } else if (body.action === 'adventurePrep_getContextByToken') {
 *        out = adventurePrep_getContextByToken(body);
 *      } else if (body.action === 'adventurePrep_saveFields') {
 *        out = adventurePrep_saveFields(body);
 *      } else if (body.action === 'adventurePrep_selectTrail') {
 *        out = adventurePrep_selectTrail(body);
 *      } else if (body.action === 'adventurePrep_saveWaiverSignature') {
 *        out = adventurePrep_saveWaiverSignature(body);
 *      } else if (body.action === 'adventurePrep_saveEmergencyContact') {
 *        out = adventurePrep_saveEmergencyContact(body);
 *      } else if (body.action === 'adventurePrep_sendSignerLinks') {
 *        out = adventurePrep_sendSignerLinks(body);
 *      } else if (body.action === 'adventurePrep_getSignerContext') {
 *        out = adventurePrep_getSignerContext(body);
 *      } else if (body.action === 'adventurePrep_markSignerOpened') {
 *        out = adventurePrep_markSignerOpened(body);
 *      } else if (body.action === 'adventurePrep_getKitContext') {
 *        out = adventurePrep_getKitContext(body);
 *      } else if (body.action === 'adventurePrep_setPendingKitChange') {
 *        out = adventurePrep_setPendingKitChange(body);
 *      } else if (body.action === 'adventurePrep_finalizeKitChange') {
 *        out = adventurePrep_finalizeKitChange(body);
 *      } else if (body.action === 'adventurePrep_listPendingKitChanges') {
 *        out = adventurePrep_listPendingKitChanges(body);
 *      } else if (body.action === 'adventurePrep_ensureToken') {
 *        out = adventurePrep_ensureToken(body);
 *
 *    This assumes your doPost already validates `body.secret` against
 *    BOOKINGS_WEBAPP_SECRET BEFORE dispatching on `action`, exactly like the
 *    existing five trailSelection_* actions and saveBooking/getBooking
 *    already rely on. None of the functions below re-check the secret
 *    themselves — the browser never talks to this webapp directly, only
 *    this repo's own api/*.js functions do, server-side, with the secret
 *    attached. A guest's adventurePrepToken/signerToken is a DIFFERENT,
 *    lower-stakes credential — see "Two layers of auth" below.
 *
 * 3. Run adventurePrep_setup() once from the Apps Script editor (function
 *    dropdown -> adventurePrep_setup -> Run) after pasting. Creates the
 *    three new tabs (Waiver Signatures, Emergency Contact, Adventure Prep
 *    Change Log) if missing, and appends new columns to the existing
 *    Adventure Prep tab and Experience Bookings tab if they're not already
 *    there. Safe to re-run.
 *
 * 4. Experience Bookings needs `adventurePrepToken` populated on every row
 *    for Surface A to be reachable at all. THIS PATCH ADDS THE COLUMN but
 *    does not backfill it — token generation at booking time is explicitly
 *    the booking-flow chat's job (PRD Section 15, item 9, "not this chat's
 *    scope"), not built here. Until that ships, no real booking has a
 *    working Surface A link. adventurePrep_ensureToken({bookingId}) is
 *    provided as a manual backfill/testing helper — run it once per test
 *    booking (via the Apps Script editor's "Run" with a temporary wrapper,
 *    or have it called through the webapp) to generate and store a token
 *    for that one row so Surface A can be exercised before the real
 *    booking-flow change ships. See the accompanying handoff doc.
 *
 * ============================================================================
 * TWO LAYERS OF AUTH — read this before assuming a guest can do more than intended
 * ============================================================================
 *
 * Layer 1 (this webapp's own front door): every request needs
 * BOOKINGS_WEBAPP_SECRET, checked once in the existing doPost before any
 * action runs, same as always. A guest's browser never has this secret —
 * it only ever talks to this repo's own Vercel api/*.js functions, which
 * hold the secret server-side and attach it to every webapp call they make
 * on the guest's behalf (see lib/apps-script-client.js).
 *
 * Layer 2 (per-guest access): `token` (an adventurePrepToken, Surface A) or
 * `signerToken` (Surface B) is the guest's OWN credential, checked inside
 * the functions below by simple equality against the stored value on the
 * relevant row. This is deliberately not cryptographically hardened beyond
 * being a random UUID — PRD Section 11's own accepted trade-off is "anyone
 * holding the link can access and modify the booking's Adventure Prep data,
 * no further verification," matching how airline/hotel confirmation links
 * already work. A guest token grants access to exactly one booking's
 * Adventure Prep data (or, for a signerToken, exactly one signer's own
 * waiver/contact fields), never anything else on the Sheet.
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Header lookups are always done by READING the live sheet's header row,
// never by trusting a hardcoded JS array's column order. This is
// deliberately different from trailSelection_findRowIndexByBookingId_'s
// pattern (which assumes column A = bookingId and uses a separate hardcoded
// headers constant) — two separate top-level `var TRAIL_SELECTION_..._HEADERS`
// declarations across two pasted-in files would otherwise silently race on
// which one "wins" in Apps Script's shared global scope. Reading headers
// live sidesteps that risk entirely and is the safer pattern for a second
// patch file layered on top of the first. New columns this patch adds are
// always appended after whatever's already in a tab, never inserted, so
// existing data never shifts columns.
// ---------------------------------------------------------------------------

var ADVENTURE_PREP_NEW_COLUMNS = [
  'reconfirmedRosterJson', 'linksSentAt', 'createdAt',
];

var EXPERIENCE_BOOKINGS_NEW_COLUMNS = [
  'adventurePrepToken', 'bookingStatus', 'cancelledAt', 'refundAmount', 'cancellationReasons',
];

var WAIVER_SIGNATURES_HEADERS = [
  'signatureId', 'bookingId', 'signerToken', 'role', 'rosterRef', 'signerName',
  'signerEmail', 'signerPhone', 'smsConsent', 'smsConsentAt', 'smsConsentText',
  'isGuardian', 'guardianForChildrenJson', 'waiverVersion', 'participantsCoveredJson',
  'ipAddress', 'status', 'sentAt', 'openedAt', 'signedAt', 'createdAt',
];

var EMERGENCY_CONTACT_HEADERS = [
  'contactId', 'bookingId', 'personRef', 'contactName', 'contactPhone', 'contactEmail', 'createdAt',
];

var ADVENTURE_PREP_CHANGE_LOG_HEADERS = [
  'changeId', 'bookingId', 'changeType', 'timestamp', 'beforeT3Cutoff',
  'oldValueJson', 'newValueJson', 'delta', 'refundOrChargeAmount',
  'stripeTransactionId', 'staffNotes', 'triggeringInput',
];

var ADVENTURE_PREP_WAIVER_VERSION = 'v1.4'; // matches the mockups' waiver text version

function adventurePrep_setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_ensureTabWithHeaders_(ss, 'Waiver Signatures', WAIVER_SIGNATURES_HEADERS);
  adventurePrep_ensureTabWithHeaders_(ss, 'Emergency Contact', EMERGENCY_CONTACT_HEADERS);
  adventurePrep_ensureTabWithHeaders_(ss, 'Adventure Prep Change Log', ADVENTURE_PREP_CHANGE_LOG_HEADERS);
  adventurePrep_appendColumnsIfMissing_(ss, 'Adventure Prep', ADVENTURE_PREP_NEW_COLUMNS);
  adventurePrep_appendColumnsIfMissing_(ss, 'Experience Bookings', EXPERIENCE_BOOKINGS_NEW_COLUMNS);
}

function adventurePrep_ensureTabWithHeaders_(ss, tabName, headers) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
  }
  var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var matches = headers.every(function (h, i) { return existing[i] === h; });
  if (!matches) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
}

// Appends any column in `newColumns` not already present, after whatever
// columns the tab already has. Never touches existing column positions.
function adventurePrep_appendColumnsIfMissing_(ss, tabName, newColumns) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('adventurePrep_setup: tab "' + tabName + '" does not exist — create it first (run setup() for Experience Bookings, trailSelection_setup() for Adventure Prep)');
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var missing = newColumns.filter(function (c) { return existing.indexOf(c) === -1; });
  if (missing.length) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  }
}

/** Reads a tab's live header row and returns a {headerName: 1-indexedCol} map. */
function adventurePrep_headerMap_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) { if (h) map[h] = i + 1; });
  return map;
}

function adventurePrep_readRowsAsObjects_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      if (headers[j]) row[headers[j]] = values[i][j];
    }
    row.__rowIndex = i + 1; // 1-indexed sheet row, for callers that need to write back
    rows.push(row);
  }
  return rows;
}

function adventurePrep_findRowByColumnValue_(sheet, columnName, value) {
  var map = adventurePrep_headerMap_(sheet);
  var col = map[columnName];
  if (!col) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value) && String(value) !== '') {
      return { rowIndex: i + 2, headerMap: map };
    }
  }
  return null;
}

function adventurePrep_newId_(prefix) {
  return prefix + '-' + Utilities.getUuid().slice(0, 8).toUpperCase();
}

function adventurePrep_nowIso_() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Experience Bookings lookups (adventurePrepToken -> bookingId, and the
// safe subset of booking fields Surface A/B are allowed to read).
// ---------------------------------------------------------------------------

function adventurePrep_findExperienceBookingByToken_(ss, token) {
  var sheet = ss.getSheetByName('Experience Bookings');
  var found = adventurePrep_findRowByColumnValue_(sheet, 'adventurePrepToken', token);
  if (!found) return null;
  var row = sheet.getRange(found.rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  var obj = {};
  Object.keys(found.headerMap).forEach(function (h) { obj[h] = row[found.headerMap[h] - 1]; });
  obj.__rowIndex = found.rowIndex;
  return obj;
}

function adventurePrep_findExperienceBookingById_(ss, bookingId) {
  var sheet = ss.getSheetByName('Experience Bookings');
  var found = adventurePrep_findRowByColumnValue_(sheet, 'bookingId', bookingId);
  if (!found) return null;
  var row = sheet.getRange(found.rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  var obj = {};
  Object.keys(found.headerMap).forEach(function (h) { obj[h] = row[found.headerMap[h] - 1]; });
  obj.__rowIndex = found.rowIndex;
  return obj;
}

/**
 * Idempotent: generates and stores a fresh adventurePrepToken for a booking
 * that doesn't have one yet. Returns the existing token unchanged if one is
 * already present, never rotates a live link (PRD Section 11: "stable,
 * non-rotating"). See install step 4 above for why this exists at all.
 */
function adventurePrep_ensureToken(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var booking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
    if (!booking) return { ok: false, error: 'Booking not found' };
    if (booking.adventurePrepToken) {
      return { ok: true, token: booking.adventurePrepToken, created: false };
    }
    var token = Utilities.getUuid();
    var sheet = ss.getSheetByName('Experience Bookings');
    var map = adventurePrep_headerMap_(sheet);
    sheet.getRange(booking.__rowIndex, map['adventurePrepToken']).setValue(token);
    return { ok: true, token: token, created: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Adventure Prep tab: get-or-create, generic field save.
// ---------------------------------------------------------------------------

function adventurePrep_getOrCreateRow_(ss, bookingId) {
  var sheet = ss.getSheetByName('Adventure Prep');
  if (!sheet) throw new Error('Adventure Prep tab does not exist — run trailSelection_setup() first');
  var found = adventurePrep_findRowByColumnValue_(sheet, 'bookingId', bookingId);
  var map = adventurePrep_headerMap_(sheet);
  if (found) return { rowIndex: found.rowIndex, headerMap: map, sheet: sheet };

  var newRow = new Array(sheet.getLastColumn()).fill('');
  newRow[map['bookingId'] - 1] = bookingId;
  if (map['createdAt']) newRow[map['createdAt'] - 1] = adventurePrep_nowIso_();
  sheet.appendRow(newRow);
  return { rowIndex: sheet.getLastRow(), headerMap: map, sheet: sheet };
}

function adventurePrep_readAdventurePrepRow_(ss, bookingId) {
  var sheet = ss.getSheetByName('Adventure Prep');
  var found = adventurePrep_findRowByColumnValue_(sheet, 'bookingId', bookingId);
  if (!found) return null;
  var row = sheet.getRange(found.rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  var obj = {};
  Object.keys(found.headerMap).forEach(function (h) { obj[h] = row[found.headerMap[h] - 1]; });
  obj.__rowIndex = found.rowIndex;
  return obj;
}

/**
 * 1. getContextByToken — Surface A's one load-everything call. Auto-creates
 * the Adventure Prep row on first visit (a brand-new booking has no row
 * there yet, per bookings-code.gs's setup(), which never creates one).
 */
function adventurePrep_getContextByToken(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var booking = adventurePrep_findExperienceBookingByToken_(ss, payload.token);
  if (!booking) return { notFound: true };

  var apLock = LockService.getScriptLock();
  apLock.waitLock(15000);
  var ap;
  try {
    var got = adventurePrep_getOrCreateRow_(ss, booking.bookingId);
    ap = adventurePrep_readAdventurePrepRow_(ss, booking.bookingId);
  } finally {
    apLock.releaseLock();
  }

  var waiverSheet = ss.getSheetByName('Waiver Signatures');
  var waivers = adventurePrep_readRowsAsObjects_(waiverSheet).filter(function (r) {
    return String(r.bookingId) === String(booking.bookingId);
  });

  var contactSheet = ss.getSheetByName('Emergency Contact');
  var contacts = adventurePrep_readRowsAsObjects_(contactSheet).filter(function (r) {
    return String(r.bookingId) === String(booking.bookingId);
  });

  return {
    bookingId: booking.bookingId,
    experienceBooking: {
      bookingId: booking.bookingId,
      contactName: booking.contactName,
      contactEmail: booking.contactEmail,
      tier: booking.tier,
      date: booking.date,
      gearKitCount: booking.gearKitCount,
      fullPayloadJson: booking.fullPayloadJson,
      bookingStatus: booking.bookingStatus || 'active',
      cancelledAt: booking.cancelledAt || null,
      refundAmount: booking.refundAmount || null,
      cancellationReasons: booking.cancellationReasons || null,
    },
    adventurePrep: ap,
    waiverSignatures: waivers,
    emergencyContacts: contacts,
  };
}

// Whitelisted field names api/save-adventure-prep.js is allowed to write.
// Deliberately excludes candidateTrails/selectedTrailId/assignedAt/
// assignmentMethod (those are 2.2's and adventurePrep_selectTrail's own
// jobs), and confirmedKitCount (that's adjust-gear-kit-count.js's job,
// via its own dedicated debounce actions below — never a direct write from
// this generic save, so a client can never bypass the debounce/Stripe path).
var ADVENTURE_PREP_WRITABLE_FIELDS = [
  'isParticipating', 'participatingRosterRef', 'reconfirmedRosterJson',
  'technicalComfort', 'heatComfort', 'bestForAttributes',
  'propertyType', 'deliveryAddressLine1', 'deliveryAddressLine2',
  'deliveryCity', 'deliveryState', 'deliveryZip', 'deliveryAddressRaw',
  'deliveryAddressValidated', 'deliveryWindow', 'returnPreference',
];

function adventurePrep_saveFields(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var booking = adventurePrep_findExperienceBookingByToken_(ss, payload.token);
    if (!booking) return { ok: false, error: 'Invalid or expired link' };

    var target = adventurePrep_getOrCreateRow_(ss, booking.bookingId);
    var fields = payload.fields || {};
    var rejected = [];
    Object.keys(fields).forEach(function (key) {
      if (ADVENTURE_PREP_WRITABLE_FIELDS.indexOf(key) === -1) {
        rejected.push(key);
        return;
      }
      var col = target.headerMap[key];
      if (!col) { rejected.push(key); return; }
      var value = fields[key];
      target.sheet.getRange(target.rowIndex, col).setValue(
        (typeof value === 'object' && value !== null) ? JSON.stringify(value) : value
      );
    });
    return { ok: true, bookingId: booking.bookingId, rejectedFields: rejected };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 3. selectTrail — the self-service re-selection mechanic (PRD Section 4:
 * "re-selecting among the current 3 ... self-service, instant") PLUS the
 * Operations UX PRD Section 7 addendum this build owns: assignmentMethod
 * must recompute to match whichever entry's own `source` the guest just
 * selected, not stay frozen at whatever it was set to originally.
 */
function adventurePrep_selectTrail(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var booking = adventurePrep_findExperienceBookingByToken_(ss, payload.token);
    if (!booking) return { ok: false, error: 'Invalid or expired link' };
    var target = adventurePrep_getOrCreateRow_(ss, booking.bookingId);
    var ap = adventurePrep_readAdventurePrepRow_(ss, booking.bookingId);

    var candidateTrails = [];
    try { candidateTrails = JSON.parse(ap.candidateTrails || '[]'); } catch (e) { candidateTrails = []; }
    var match = candidateTrails.filter(function (c) { return String(c.trailId) === String(payload.trailId); })[0];
    if (!match) return { ok: false, error: 'trailId is not one of this booking\'s current candidates' };

    target.sheet.getRange(target.rowIndex, target.headerMap['selectedTrailId']).setValue(match.trailId);
    target.sheet.getRange(target.rowIndex, target.headerMap['assignmentMethod']).setValue(match.source || 'rules_v1');
    return { ok: true, selectedTrailId: match.trailId, assignmentMethod: match.source || 'rules_v1' };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Waiver Signatures
// ---------------------------------------------------------------------------

/**
 * 4. saveWaiverSignature — handles BOTH the booking owner (Surface A step 9,
 * identified by `token`, role='owner') and a non-owner signer (Surface B,
 * identified by `signerToken`, role='non_owner'). Upserts: a signer visiting
 * their own link twice (e.g. to fix a typo before actually submitting)
 * updates the same row rather than creating a duplicate.
 */
function adventurePrep_saveWaiverSignature(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var bookingId, role, existingRow;
    var sheet = ss.getSheetByName('Waiver Signatures');
    var map = adventurePrep_headerMap_(sheet);

    if (payload.signerToken) {
      var found = adventurePrep_findRowByColumnValue_(sheet, 'signerToken', payload.signerToken);
      if (!found) return { ok: false, error: 'Invalid or expired signer link' };
      var rowVals = sheet.getRange(found.rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
      bookingId = rowVals[map['bookingId'] - 1];
      role = 'non_owner';
      existingRow = found.rowIndex;
    } else if (payload.token) {
      var booking = adventurePrep_findExperienceBookingByToken_(ss, payload.token);
      if (!booking) return { ok: false, error: 'Invalid or expired link' };
      bookingId = booking.bookingId;
      role = 'owner';
      var ownerFound = adventurePrep_findOwnerWaiverRow_(sheet, bookingId);
      existingRow = ownerFound ? ownerFound.rowIndex : null;
    } else {
      return { ok: false, error: 'Missing token or signerToken' };
    }

    var now = adventurePrep_nowIso_();
    var rowIndex;
    if (existingRow) {
      rowIndex = existingRow;
    } else {
      var blank = new Array(sheet.getLastColumn()).fill('');
      sheet.appendRow(blank);
      rowIndex = sheet.getLastRow();
    }

    function set(name, value) {
      if (!map[name]) return;
      sheet.getRange(rowIndex, map[name]).setValue(value === undefined || value === null ? '' : value);
    }

    set('signatureId', sheet.getRange(rowIndex, map['signatureId']).getValue() || adventurePrep_newId_('SIG'));
    set('bookingId', bookingId);
    set('role', role);
    if (payload.signerToken) set('signerToken', payload.signerToken);
    set('rosterRef', payload.rosterRef || '');
    set('signerName', payload.signerName || '');
    set('signerEmail', payload.signerEmail || '');
    if (payload.signerPhone !== undefined) set('signerPhone', payload.signerPhone || '');
    if (payload.smsConsent !== undefined) {
      set('smsConsent', !!payload.smsConsent);
      set('smsConsentAt', payload.smsConsentAt || now);
      set('smsConsentText', payload.smsConsentText || '');
    }
    set('isGuardian', !!payload.isGuardian);
    set('guardianForChildrenJson', JSON.stringify(payload.guardianForChildren || []));
    set('waiverVersion', ADVENTURE_PREP_WAIVER_VERSION);
    set('participantsCoveredJson', JSON.stringify(payload.participantsCovered || []));
    set('ipAddress', payload.ipAddress || '');
    set('status', 'signed');
    set('signedAt', now);
    if (!sheet.getRange(rowIndex, map['createdAt']).getValue()) set('createdAt', now);

    adventurePrep_recomputeAllWaiversComplete_(ss, bookingId);

    return { ok: true, bookingId: bookingId, signedAt: now };
  } finally {
    lock.releaseLock();
  }
}

function adventurePrep_findOwnerWaiverRow_(sheet, bookingId) {
  var map = adventurePrep_headerMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][map['bookingId'] - 1]) === String(bookingId) && values[i][map['role'] - 1] === 'owner') {
      return { rowIndex: i + 2 };
    }
  }
  return null;
}

/**
 * Recomputes Adventure Prep.allWaiversComplete (PRD Section 10, "Adventure
 * Prep computes and maintains this boolean, Ops UX reads it directly").
 * Required signers = the owner (if isParticipating) + every non-owner adult
 * this booking sent a link to (one Waiver Signatures row per required
 * signer, role='non_owner', written by sendSignerLinks below). Complete
 * only when every required row's status === 'signed'.
 */
function adventurePrep_recomputeAllWaiversComplete_(ss, bookingId) {
  var waiverSheet = ss.getSheetByName('Waiver Signatures');
  var rows = adventurePrep_readRowsAsObjects_(waiverSheet).filter(function (r) {
    return String(r.bookingId) === String(bookingId);
  });
  var ap = adventurePrep_readAdventurePrepRow_(ss, bookingId);
  var ownerRequired = ap && ap.isParticipating !== false && ap.isParticipating !== 'false' && ap.isParticipating !== '';
  var ownerRow = rows.filter(function (r) { return r.role === 'owner'; })[0];
  var nonOwnerRows = rows.filter(function (r) { return r.role === 'non_owner'; });

  var allComplete = true;
  if (ownerRequired && (!ownerRow || ownerRow.status !== 'signed')) allComplete = false;
  nonOwnerRows.forEach(function (r) { if (r.status !== 'signed') allComplete = false; });
  // A booking that hasn't reached the owner's waiver step yet, and has no
  // signer rows at all, deliberately reads as NOT complete (allComplete
  // starts true only if there's nothing to check, which never happens once
  // isParticipating is known — see README note in the handoff about the
  // "zero" vs "partial" vs "complete" tri-state this feeds Operations UX's
  // Section 3, which this endpoint doesn't itself compute, only the
  // booking-level boolean does).

  var target = adventurePrep_getOrCreateRow_(ss, bookingId);
  if (target.headerMap['allWaiversComplete']) {
    target.sheet.getRange(target.rowIndex, target.headerMap['allWaiversComplete']).setValue(allComplete);
  }
  return allComplete;
}

// ---------------------------------------------------------------------------
// Emergency Contact
// ---------------------------------------------------------------------------

function adventurePrep_saveEmergencyContact(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var bookingId, personRef;
    if (payload.signerToken) {
      var waiverSheet = ss.getSheetByName('Waiver Signatures');
      var found = adventurePrep_findRowByColumnValue_(waiverSheet, 'signerToken', payload.signerToken);
      if (!found) return { ok: false, error: 'Invalid or expired signer link' };
      var map = adventurePrep_headerMap_(waiverSheet);
      var rowVals = waiverSheet.getRange(found.rowIndex, 1, 1, waiverSheet.getLastColumn()).getValues()[0];
      bookingId = rowVals[map['bookingId'] - 1];
      personRef = payload.signerToken;
    } else if (payload.token) {
      var booking = adventurePrep_findExperienceBookingByToken_(ss, payload.token);
      if (!booking) return { ok: false, error: 'Invalid or expired link' };
      bookingId = booking.bookingId;
      personRef = 'owner';
    } else {
      return { ok: false, error: 'Missing token or signerToken' };
    }

    var sheet = ss.getSheetByName('Emergency Contact');
    var row = [
      adventurePrep_newId_('EC'), bookingId, personRef,
      payload.contactName || '', payload.contactPhone || '', payload.contactEmail || '',
      adventurePrep_nowIso_(),
    ];
    sheet.appendRow(row);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Signer link generation and resolution (Surface A step 10 -> Surface B)
// ---------------------------------------------------------------------------

/**
 * 6. sendSignerLinks — Surface A's step 10 "Confirm & Send" trigger (PRD
 * Section 12 step 9 / Section 7: "links go out when the booking owner
 * confirms ... not the moment contact info is typed"). Writes a `sent`
 * Waiver Signatures row per non-owner signer and returns the generated
 * tokens; actually EMAILING them is api/send-signer-links.js's job (via
 * lib/send-email.js), same "Apps Script never sends email itself"
 * convention already established by save-booking.js/create-deposit-hold.js.
 */
function adventurePrep_sendSignerLinks(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var booking = adventurePrep_findExperienceBookingByToken_(ss, payload.token);
    if (!booking) return { ok: false, error: 'Invalid or expired link' };

    var sheet = ss.getSheetByName('Waiver Signatures');
    var map = adventurePrep_headerMap_(sheet);
    var now = adventurePrep_nowIso_();
    var results = [];

    (payload.signers || []).forEach(function (signer) {
      // Idempotent per rosterRef: re-running "Confirm & Send" for a booking
      // that already sent this specific signer a link updates that same
      // row (new token only if none exists yet) rather than duplicating it
      // or re-issuing a new link the guest already has.
      var existing = null;
      var lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
        for (var i = 0; i < values.length; i++) {
          if (String(values[i][map['bookingId'] - 1]) === String(booking.bookingId) &&
              String(values[i][map['rosterRef'] - 1]) === String(signer.rosterRef)) {
            existing = {
              rowIndex: i + 2,
              token: values[i][map['signerToken'] - 1],
              // BUGFIX (build review, Aug 2026): this was previously omitted,
              // which made the `existing.status === 'signed'` check below
              // always false (reading undefined off a two-key object), so
              // every re-run of "Confirm & Send" silently reset an
              // already-signed row back to 'sent' — flipping
              // allWaiversComplete back to false and causing
              // send-signer-links.js to re-email a "waiver needed" notice
              // to someone who'd already signed. Carrying the real stored
              // status through is what actually makes this idempotent, per
              // this function's own doc comment above.
              status: values[i][map['status'] - 1],
            };
            break;
          }
        }
      }

      var rowIndex, token;
      if (existing) {
        rowIndex = existing.rowIndex;
        token = existing.token || Utilities.getUuid();
      } else {
        var blank = new Array(sheet.getLastColumn()).fill('');
        sheet.appendRow(blank);
        rowIndex = sheet.getLastRow();
        token = Utilities.getUuid();
      }

      function set(name, value) {
        if (!map[name]) return;
        sheet.getRange(rowIndex, map[name]).setValue(value === undefined || value === null ? '' : value);
      }
      set('signatureId', sheet.getRange(rowIndex, map['signatureId']).getValue() || adventurePrep_newId_('SIG'));
      set('bookingId', booking.bookingId);
      set('signerToken', token);
      set('role', 'non_owner');
      set('rosterRef', signer.rosterRef || '');
      set('signerName', signer.name || '');
      set('signerEmail', signer.email || '');
      set('status', existing && existing.status === 'signed' ? 'signed' : 'sent');
      set('sentAt', now);
      if (!sheet.getRange(rowIndex, map['createdAt']).getValue()) set('createdAt', now);

      results.push({ name: signer.name, email: signer.email, signerToken: token, rosterRef: signer.rosterRef });
    });

    var target = adventurePrep_getOrCreateRow_(ss, booking.bookingId);
    if (target.headerMap['linksSentAt']) {
      target.sheet.getRange(target.rowIndex, target.headerMap['linksSentAt']).setValue(now);
    }
    adventurePrep_recomputeAllWaiversComplete_(ss, booking.bookingId);

    return { ok: true, signers: results, ownerName: booking.contactName, tripDate: booking.date };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 7. getSignerContext — Surface B's one load-everything call. Returns the
 * roster's minor rows (for the guardian certification checklist, PRD
 * Section 5/12) and this signer's own current row state (so re-visiting an
 * already-signed link renders the done screen instead of the form again).
 */
function adventurePrep_getSignerContext(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var waiverSheet = ss.getSheetByName('Waiver Signatures');
  var found = adventurePrep_findRowByColumnValue_(waiverSheet, 'signerToken', payload.signerToken);
  if (!found) return { notFound: true };
  var map = found.headerMap;
  var row = waiverSheet.getRange(found.rowIndex, 1, 1, waiverSheet.getLastColumn()).getValues()[0];
  var signerRow = {};
  Object.keys(map).forEach(function (h) { signerRow[h] = row[map[h] - 1]; });

  var booking = adventurePrep_findExperienceBookingById_(ss, signerRow.bookingId);
  if (!booking) return { notFound: true };

  var ap = adventurePrep_readAdventurePrepRow_(ss, signerRow.bookingId);
  var roster = [];
  try {
    if (ap && ap.reconfirmedRosterJson) roster = JSON.parse(ap.reconfirmedRosterJson);
  } catch (e) { roster = []; }
  if (!roster.length) {
    // Fall back to the booking-time roster if 1.2a's reconfirmation hasn't
    // run yet — a non-owner signer's link can arrive before the owner
    // finishes their own flow is not the expected order (links send at
    // step 10, after reconfirmation), but this keeps the page from
    // breaking if it's ever visited out of order.
    try {
      var payloadJson = JSON.parse(booking.fullPayloadJson || '{}');
      roster = payloadJson.roster || [];
    } catch (e2) { roster = []; }
  }
  // BUG FIX (Aug 2026, independent bug pass): '14-17' used an ASCII hyphen,
  // but adventure-form.js's roster step (the only place this bucket value
  // actually gets written) generates it with an EN DASH ('14–17', U+2013)
  // — see that file's cardWho(). A real 14-17-year-old roster entry never
  // matched here, so Surface B's guardian-certification checklist would
  // silently omit them. Same bug class already fixed in
  // apps-script/trail-swap-actions.gs's own local minors check, and in
  // adventure-prep-form.js's MINOR_BUCKETS / lib/trail-selection-engine.js's
  // MINOR_AGE_BUCKETS, fixed alongside this one.
  var minors = roster.filter(function (p) {
    return p.ageRange === 'Under 14' || p.ageRange === '14–17' || p.age === 'Under 14' || p.age === '14–17';
  });

  return {
    bookingId: signerRow.bookingId,
    ownerName: booking.contactName,
    tripDate: booking.date,
    minors: minors,
    signer: signerRow,
  };
}

function adventurePrep_markSignerOpened(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Waiver Signatures');
  var found = adventurePrep_findRowByColumnValue_(sheet, 'signerToken', payload.signerToken);
  if (!found) return { ok: false, error: 'Invalid or expired signer link' };
  var map = found.headerMap;
  var current = sheet.getRange(found.rowIndex, map['status']).getValue();
  if (current === 'sent') {
    sheet.getRange(found.rowIndex, map['status']).setValue('opened');
    sheet.getRange(found.rowIndex, map['openedAt']).setValue(adventurePrep_nowIso_());
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Gear-kit-count debounce support (PRD Section 1) — read/write only. All
// Stripe calls and the actual delta math live in api/adjust-gear-kit-count.js
// and api/process-pending-kit-changes.js on the Vercel side, never here,
// matching every other money-touching endpoint's split in this repo.
// ---------------------------------------------------------------------------

function adventurePrep_getKitContext(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var booking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
  if (!booking) return { notFound: true };
  var ap = adventurePrep_readAdventurePrepRow_(ss, payload.bookingId);
  return {
    bookingId: booking.bookingId,
    tier: booking.tier,
    tripDate: booking.date, // added for api/process-pending-kit-changes.js's T-3 cutoff math — Experience Bookings' own 'date' column, not stored on the Adventure Prep row itself
    mainPaymentIntentId: booking.mainPaymentIntentId,
    bookedGearKitCount: booking.gearKitCount,
    confirmedKitCount: (ap && ap.confirmedKitCount) || booking.gearKitCount,
    pendingKitCount: ap ? ap.pendingKitCount : '',
    pendingSince: ap ? ap.pendingSince : '',
    reconfirmedRosterJson: ap ? ap.reconfirmedRosterJson : '',
  };
}

function adventurePrep_setPendingKitChange(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_(ss, payload.bookingId);
    target.sheet.getRange(target.rowIndex, target.headerMap['pendingKitCount']).setValue(payload.pendingKitCount);
    target.sheet.getRange(target.rowIndex, target.headerMap['pendingSince']).setValue(payload.pendingSince);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Finalizes a debounce window: writes the new confirmedKitCount, clears the
 * pending fields, applies the Gear Check Log delta the caller computed, and
 * appends the Adventure Prep Change Log row — all in one locked call so the
 * money side (already resolved by the caller against Stripe before this is
 * invoked) and the physical checklist never drift apart (PRD Section 10:
 * "Gear Check Log regeneration ... atomically with the money side").
 */
function adventurePrep_finalizeKitChange(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var target = adventurePrep_getOrCreateRow_(ss, payload.bookingId);
    target.sheet.getRange(target.rowIndex, target.headerMap['confirmedKitCount']).setValue(payload.newConfirmedKitCount);
    target.sheet.getRange(target.rowIndex, target.headerMap['pendingKitCount']).setValue('');
    target.sheet.getRange(target.rowIndex, target.headerMap['pendingSince']).setValue('');

    var gearSheet = ss.getSheetByName('Gear Check Log');
    var itemCosts = {
      'Gregory Miko 20L Backpack': 159,
      'Hydro Flask Big Mouth 32oz Bottle': 42,
      'Leki Khumbu Lite Trekking Poles': 129,
      'REI Pack Mule 90L Duffel': 159,
    };
    (payload.gearLogAdd || []).forEach(function (kit) {
      ['Gregory Miko 20L Backpack', 'Hydro Flask Big Mouth 32oz Bottle', 'Hydro Flask Big Mouth 32oz Bottle', 'Leki Khumbu Lite Trekking Poles'].forEach(function (itemName) {
        gearSheet.appendRow([
          Utilities.getUuid().slice(0, 8).toUpperCase(), payload.bookingId, kit.kitNumber,
          kit.personName || ('Kit ' + kit.kitNumber), itemName, itemCosts[itemName] || '',
          '', '', '', '', '', 'added via adjust-gear-kit-count.js',
        ]);
      });
    });
    if (payload.gearLogRemoveCount > 0) {
      // Removes the LAST N kit groups (highest kitNumber first) rather than
      // a specific physical unit — per Adventure Prep PRD Section 1/10, which
      // physical-unit-ID this should release, if any, is a genuinely open
      // question flagged for whoever owns this Apps Script (unresolved as of
      // this build). This is a placeholder-row deletion, not a unit-release.
      var gearRows = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
        return String(r.bookingId) === String(payload.bookingId) && r.kitNumber !== '' && r.checkedOutAt === '';
      });
      var byKit = {};
      gearRows.forEach(function (r) {
        var k = String(r.kitNumber);
        (byKit[k] = byKit[k] || []).push(r);
      });
      var kitNumbers = Object.keys(byKit).map(Number).sort(function (a, b) { return b - a; });
      var toRemove = kitNumbers.slice(0, payload.gearLogRemoveCount);
      var rowsToDelete = [];
      toRemove.forEach(function (k) { byKit[String(k)].forEach(function (r) { rowsToDelete.push(r.__rowIndex); }); });
      rowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (rowIndex) {
        gearSheet.deleteRow(rowIndex);
      });
    }

    // BUGFIX (build review, Aug 2026): duffel count was never reconciled
    // here before, only the per-kit items were. bookings-code.gs's own
    // buildGearLogRows() ties delivery duffels to kit count at booking time
    // (one shared duffel per up to two kits) — a post-booking kit-count
    // change needs the same reconciliation, or delivery packaging silently
    // drifts from the guest's actual confirmed kit count. The caller
    // (lib/finalize-kit-change.js) computes duffelDelta/newDuffelCount from
    // the same formula, this just applies it: add/remove shared duffel rows
    // (fungible placeholders, no kitNumber, so any N of them can be
    // removed, unlike the kit-numbered items above) and update Experience
    // Bookings' own duffelCount column so it doesn't go stale.
    var duffelDelta = payload.duffelDelta || 0;
    if (duffelDelta > 0) {
      for (var dAdd = 0; dAdd < duffelDelta; dAdd++) {
        gearSheet.appendRow([
          Utilities.getUuid().slice(0, 8).toUpperCase(), payload.bookingId, '',
          'Shared', 'REI Pack Mule 90L Duffel', itemCosts['REI Pack Mule 90L Duffel'],
          '', '', '', '', '', 'added via adjust-gear-kit-count.js',
        ]);
      }
    } else if (duffelDelta < 0) {
      var duffelRows = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
        return String(r.bookingId) === String(payload.bookingId) && r.kitNumber === '' &&
          r.itemName === 'REI Pack Mule 90L Duffel' && r.checkedOutAt === '';
      });
      var duffelsToRemove = duffelRows.slice(0, Math.abs(duffelDelta));
      duffelsToRemove.map(function (r) { return r.__rowIndex; })
        .sort(function (a, b) { return b - a; })
        .forEach(function (rowIndex) { gearSheet.deleteRow(rowIndex); });
    }
    if (payload.newDuffelCount != null) {
      var duffelBooking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
      if (duffelBooking) {
        var bookingsSheet = ss.getSheetByName('Experience Bookings');
        var bookingsMap = adventurePrep_headerMap_(bookingsSheet);
        if (bookingsMap['duffelCount']) {
          bookingsSheet.getRange(duffelBooking.__rowIndex, bookingsMap['duffelCount']).setValue(payload.newDuffelCount);
        }
      }
    }

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'kit_count',
      beforeT3Cutoff: !!payload.beforeT3Cutoff,
      oldValueJson: JSON.stringify({ confirmedKitCount: payload.oldConfirmedKitCount }),
      newValueJson: JSON.stringify({ confirmedKitCount: payload.newConfirmedKitCount }),
      delta: payload.delta,
      refundOrChargeAmount: payload.refundOrChargeAmount,
      stripeTransactionId: payload.stripeTransactionId,
      staffNotes: payload.staffNotes || '',
    });

    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function adventurePrep_appendChangeLog_(ss, entry) {
  var sheet = ss.getSheetByName('Adventure Prep Change Log');
  var map = adventurePrep_headerMap_(sheet);
  var row = new Array(sheet.getLastColumn()).fill('');
  row[map['changeId'] - 1] = adventurePrep_newId_('LOG');
  row[map['bookingId'] - 1] = entry.bookingId;
  row[map['changeType'] - 1] = entry.changeType;
  row[map['timestamp'] - 1] = adventurePrep_nowIso_();
  if (map['beforeT3Cutoff']) row[map['beforeT3Cutoff'] - 1] = !!entry.beforeT3Cutoff;
  if (map['oldValueJson']) row[map['oldValueJson'] - 1] = entry.oldValueJson || '';
  if (map['newValueJson']) row[map['newValueJson'] - 1] = entry.newValueJson || '';
  if (map['delta']) row[map['delta'] - 1] = entry.delta != null ? entry.delta : '';
  if (map['refundOrChargeAmount']) row[map['refundOrChargeAmount'] - 1] = entry.refundOrChargeAmount != null ? entry.refundOrChargeAmount : '';
  if (map['stripeTransactionId']) row[map['stripeTransactionId'] - 1] = entry.stripeTransactionId || '';
  if (map['staffNotes']) row[map['staffNotes'] - 1] = entry.staffNotes || '';
  if (map['triggeringInput']) row[map['triggeringInput'] - 1] = entry.triggeringInput || '';
  sheet.appendRow(row);
}

/**
 * For api/process-pending-kit-changes.js's cron tick: every Adventure Prep
 * row with a non-blank pendingKitCount, so the caller can decide (in Node,
 * not Apps Script) which ones are past their 1-hour/T-3 finalization
 * deadline. Deliberately returns ALL pending rows rather than filtering by
 * time here — Apps Script's Date handling across the JSON boundary is more
 * error-prone than doing that comparison in Node against real Date objects.
 */
function adventurePrep_listPendingKitChanges(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Adventure Prep');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    return r.pendingKitCount !== '' && r.pendingKitCount != null;
  });
  // Join in each row's trip date from Experience Bookings — the T-3 cutoff
  // half of the caller's "1 hour OR T-3 cutoff, whichever first" decision
  // needs it, and it isn't (and shouldn't be) duplicated onto the Adventure
  // Prep tab itself. One extra lookup per pending row; this list is
  // expected to stay small (only bookings with a change in flight right
  // now), so no batching optimization here.
  rows.forEach(function (r) {
    var booking = adventurePrep_findExperienceBookingById_(ss, r.bookingId);
    r.date = booking ? booking.date : '';
  });
  return { rows: rows };
}
