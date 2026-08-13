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
  'REI Pack Mule 90L Duffel': 159
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
  return {
    ok: true,
    bookingId: row[0],
    tier: row[6],
    gearKitCount: row[9],
    mainPaymentIntentId: row[12],
    depositPaymentIntentId: row[13],
    depositStatus: row[14]
  };
}

// Writes the outcome of a T-1 deposit hold attempt back onto the booking's
// row, called by api/create-deposit-hold.js after it resolves the hold
// with Stripe (held / failed / unavailable / requires_action), so the
// sheet reflects the real result instead of the "scheduled_t1" placeholder
// written at booking time.
function handleUpdateDepositStatus(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var found = findBookingRow(ss, payload.bookingId);
  if (!found) {
    return { ok: false, error: 'Booking not found' };
  }
  // depositPaymentIntentId is column 14, depositStatus is column 15
  // (1-indexed) in the Experience Bookings sheet — see HEADERS above.
  found.sheet.getRange(found.rowIndex, 14).setValue(payload.depositPaymentIntentId || '');
  found.sheet.getRange(found.rowIndex, 15).setValue(payload.depositStatus || '');
  return { ok: true };
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
