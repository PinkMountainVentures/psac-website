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
     (per-kit items + shared delivery duffels).
   ============================================ */

var SHEETS = {
  people: 'People',
  bookings: 'Experience Bookings',
  gearLog: 'Gear Check Log'
};

var HEADERS = {
  'People': ['personId', 'name', 'email', 'phone', 'stripeCustomerId', 'membershipTier', 'memberSince', 'renewalDate', 'createdAt'],
  'Experience Bookings': ['bookingId', 'createdAt', 'personId', 'contactName', 'contactEmail', 'contactPhone', 'tier', 'date', 'timePreference', 'gearKitCount', 'duffelCount', 'total', 'mainPaymentIntentId', 'depositPaymentIntentId', 'depositStatus', 'fullPayloadJson'],
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
  try {
    var contact = payload.contact || {};
    var personId = findOrCreatePerson(ss, contact.name, contact.email, contact.phone);
    var bookingId = 'BK-' + Utilities.getUuid().slice(0, 8).toUpperCase();
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
      JSON.stringify(payload)
    ]);

    var gearRows = buildGearLogRows(bookingId, payload);
    if (gearRows.length) {
      var gearSheet = ss.getSheetByName(SHEETS.gearLog);
      gearSheet.getRange(gearSheet.getLastRow() + 1, 1, gearRows.length, gearRows[0].length).setValues(gearRows);
    }

    return { ok: true, personId: personId, bookingId: bookingId, gearLogRowsCreated: gearRows.length };
  } finally {
    lock.releaseLock();
  }
}

// Dedup by email, case-insensitive. First write wins for name/phone on
// repeat bookings — fine for now, worth revisiting once there's a reason
// to let contact details update on file.
function findOrCreatePerson(ss, name, email, phone) {
  var sheet = ss.getSheetByName(SHEETS.people);
  var data = sheet.getDataRange().getValues();
  var emailLower = String(email || '').trim().toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (emailLower && String(data[i][2] || '').trim().toLowerCase() === emailLower) {
      return data[i][0];
    }
  }
  var personId = 'PER-' + Utilities.getUuid().slice(0, 8).toUpperCase();
  sheet.appendRow([personId, name || '', email || '', phone || '', '', '', '', '', new Date().toISOString()]);
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
