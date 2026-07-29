/**
 * PSAC — Plan Your Day intake form backend.
 *
 * Receives JSON submissions from adventure-form.js (buildPayload()) and
 * appends them as a row to the "Submissions" sheet in this spreadsheet.
 *
 * Deployment: see apps-script/DEPLOY.md in the site repo for step-by-step
 * setup instructions. Once deployed, paste the Web App /exec URL into
 * SUBMIT_ENDPOINT near the top of adventure-form.js.
 */

var SHEET_NAME = 'Submissions';

var COLUMNS = [
  'Submitted At',
  'Tier',
  'Total ($)',
  'Gear Packages',
  'Headcount',
  'Date Requested',
  'Time Preference',
  'Who\'s Coming',
  'Roster (name / age / fitness)',
  'Contact Name',
  'Contact Email',
  'Contact Phone',
  'Q1 — What\'s bringing you out',
  'Q4 — Best outdoor experience',
  'Q5 — Activity planned',
  'Q6 — Duration',
  'Q7 — Physical considerations',
  'Q8 — What draws you',
  'Q9 — Specific ask',
  'Q10 — Gear already owned',
  'Q12 — How you want to feel after',
  'Q13 — Recovery preferences',
  'Q14 — Recovery taste',
  'Q15 — Anything else',
  'Raw JSON'
];

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var sheet = getOrCreateSheet_();
    var row = buildRow_(payload);
    sheet.appendRow(row);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getOrCreateSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function buildRow_(p) {
  var q1 = joinStitch_(p.q1);
  var q12 = joinStitch_(p.q12);
  var roster = joinRoster_(p.roster);
  var contact = p.contact || {};

  return [
    p.submittedAt || new Date().toISOString(),
    tierLabel_(p.tier),
    p.total != null ? p.total : '',
    p.q11_gear_packages != null ? p.q11_gear_packages : '',
    p.headcount != null ? p.headcount : '',
    p.date || '',
    p.timePreference || '',
    whoLabel_(p.who),
    roster,
    contact.name || '',
    contact.email || '',
    contact.phone || '',
    q1,
    p.q4_experience || '',
    joinList_(p.q5_activity),
    p.q6_duration || '',
    p.q7_physical || '',
    joinList_(p.q8_draws),
    p.q9_specific || '',
    joinList_(p.q10_gear_owned),
    q12,
    joinList_(p.q13_recovery),
    p.q14_taste || '',
    p.q15_other || '',
    JSON.stringify(p)
  ];
}

function joinStitch_(field) {
  if (!field || !field.starter) return '';
  return (field.starter + ' ' + (field.text || '')).trim();
}

function joinList_(arr) {
  if (!arr || !arr.length) return '';
  return arr.join(', ');
}

function joinRoster_(roster) {
  if (!roster || !roster.length) return '';
  return roster
    .filter(function (r) { return r && (r.name || r.age); })
    .map(function (r) {
      return (r.name || '(no name)') + ' / age ' + (r.age || '?') + ' / ' + (r.fitness || 'unspecified');
    })
    .join('; ');
}

var TIER_LABELS = {
  trail: 'Trail Guide',
  p2p: 'Peaks to Pools',
  custom: 'Custom Experience'
};

function tierLabel_(key) {
  return TIER_LABELS[key] || key || '';
}

var WHO_LABELS = {
  solo: 'Just me',
  partner: 'Me and my partner',
  friends: 'A group of friends',
  friends_kids: 'A group of friends, including kids',
  family_kids: 'Family, including kids'
};

function whoLabel_(key) {
  return WHO_LABELS[key] || key || '';
}

/**
 * Run this once manually from the Apps Script editor (select doGet or this
 * function and click Run) to confirm the sheet + header row get created
 * before you do a real end-to-end test from the site.
 */
function testSetup() {
  getOrCreateSheet_();
}
