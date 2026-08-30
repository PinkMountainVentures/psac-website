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
 *      } else if (body.action === 'adventurePrep_saveSignerDetails') {
 *        out = adventurePrep_saveSignerDetails(body);
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
 *    there. Safe to re-run. IMPORTANT if you already ran this in a prior
 *    session: run it again after this update — WAIVER_SIGNATURES_HEADERS
 *    just gained a new `detailsConfirmedAt` column (Surface B's "Confirm
 *    Your Details" hub tile, mockup-07) and it only lands on the live
 *    Waiver Signatures tab's header row when this function re-runs.
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
  // Round 2, Surface B redesign (mockup-07): "Confirm Your Details" is now
  // its own hub tile a non-owner signer can complete independently of
  // signing their waiver (previously phone/SMS-consent only ever got
  // captured as part of the old linear flow's final step, always after
  // signing). This column is that tile's own "done" marker — set only by
  // adventurePrep_saveSignerDetails_, never by
  // adventurePrep_saveWaiverSignature, so saving contact details can never
  // accidentally flip a waiver's status to 'signed'. Appended at the END —
  // do not insert — and run adventurePrep_setup() once after pasting this
  // in, same append-only requirement as every other schema change in this
  // file.
  'detailsConfirmedAt',
];

var EMERGENCY_CONTACT_HEADERS = [
  'contactId', 'bookingId', 'personRef', 'contactName', 'contactPhone', 'contactEmail', 'createdAt',
];

var ADVENTURE_PREP_CHANGE_LOG_HEADERS = [
  'changeId', 'bookingId', 'changeType', 'timestamp', 'beforeT3Cutoff',
  'oldValueJson', 'newValueJson', 'delta', 'refundOrChargeAmount',
  'stripeTransactionId', 'staffNotes', 'triggeringInput',
];

// Section 9 item 3 (waiver content/version management): waiver language
// needs to be updatable without a code push, and every signature needs to
// capture which version was actually shown to that signer. Implemented via
// 3 Script Properties (Apps Script editor -> Project Settings -> Script
// Properties — no .gs file edit or redeploy needed to change these):
//   WAIVER_VERSION      e.g. "v1.5"
//   WAIVER_BODY_HTML    the numbered-section body (h4/p/ul only — no outer
//                        doc title, since that's rendered client-side from
//                        WAIVER_VERSION so the version display can never
//                        drift out of sync with the body it's labeling)
//   WAIVER_STATUS_TAG   e.g. "Draft — Pending Final Attorney Review", or ''
//                        once legal signs off and the tag should disappear
// All 3 fall back to the real Version 1.5 draft text below if unset, so
// this works out of the box — Airey only needs Script Properties once the
// text needs to change, never for the initial build.
function adventurePrep_getWaiverContent_() {
  var props = PropertiesService.getScriptProperties();
  var statusTagProp = props.getProperty('WAIVER_STATUS_TAG');
  return {
    version: props.getProperty('WAIVER_VERSION') || ADVENTURE_PREP_WAIVER_DEFAULT_VERSION_,
    // Deliberately not `statusTagProp || default` — an explicitly-set empty
    // string ('', once legal signs off and the tag should disappear) must
    // stay '', which `||` would incorrectly override back to the default.
    // Only an unset property (null — Airey has never touched this yet)
    // falls back to the default "Draft" tag.
    statusTag: statusTagProp == null ? ADVENTURE_PREP_WAIVER_DEFAULT_STATUS_TAG_ : statusTagProp,
    bodyHtml: props.getProperty('WAIVER_BODY_HTML') || ADVENTURE_PREP_WAIVER_DEFAULT_BODY_HTML_,
  };
}

var ADVENTURE_PREP_WAIVER_DEFAULT_VERSION_ = 'v1.5';
var ADVENTURE_PREP_WAIVER_DEFAULT_STATUS_TAG_ = 'Draft — Pending Final Attorney Review';

// Real Version 1.5 draft text (Participant Agreement and Acknowledgment of
// Risk), confirmed against Airey's Google Doc — still marked draft/pending
// attorney review per the doc's own header. Sections 1–7 only; the outer
// "PALM SPRINGS ADVENTURE CLUB" title block and version line are rendered
// client-side (adventure-prep-form.js) from WAIVER_VERSION, not baked in
// here, so the two can never show mismatched versions.
var ADVENTURE_PREP_WAIVER_DEFAULT_BODY_HTML_ =
  "<p><b>PLEASE READ CAREFULLY. THIS AGREEMENT AFFECTS YOUR LEGAL RIGHTS AND CONTAINS A RELEASE OF LIABILITY.</b></p>" +
  "<p>In consideration of being permitted to book, rent equipment from, or otherwise participate in any activity, program, or service offered by Palm Springs Adventure Club, a DBA of Pink Mountain Ventures LLC, a California limited liability company, and its owners, members, managers, officers, employees, contractors (including gear delivery and courier providers), volunteers, and agents (collectively, “PSAC”), I agree to the following on behalf of myself, any additional adult participants on this booking, and any minor participants, including any child under 18 who accompanies me on a PSAC activity whether or not that child is formally named on this form or has rented equipment from PSAC. This Agreement is binding on me and on my heirs, next of kin, spouse, executors, administrators, personal representatives, and assigns.</p>" +
  "<h4>1. Acknowledgment of Risk</h4>" +
  "<p>I understand that hiking, trail running, and related outdoor recreation activities in desert and mountain terrain, including PSAC's self-guided trail experiences, involve known and unanticipated risks that could result in physical or emotional injury, illness, paralysis, death, or damage to myself, to property, or to third parties. I understand that these risks cannot be eliminated without changing the essential nature of the activity.</p>" +
  "<p>These risks include, among others:</p>" +
  "<ul>" +
  "<li>Walking on uneven, loose, or steep desert and mountain terrain, and the risk of slips, trips, and falls</li>" +
  "<li>Extreme heat, dehydration, and heat-related illness, including heat exhaustion and heat stroke. Even during PSAC's operating season of September through May, the Palm Springs area can experience high desert temperatures, particularly in the early and late months of that season, and heat-related illness can be severe, disabling, or fatal, even for fit, well-hydrated participants</li>" +
  "<li>Sun exposure</li>" +
  "<li>Flash flooding and sudden weather changes</li>" +
  "<li>Encounters with wildlife and insects, including venomous snakes, scorpions, and stinging or biting insects</li>" +
  "<li>Contact with cactus and other desert vegetation</li>" +
  "<li>Elevation gain and physical exertion</li>" +
  "<li>Becoming lost or disoriented</li>" +
  "<li>Unreliable or unavailable cellular telephone coverage on many desert and mountain trails</li>" +
  "<li>My own physical condition and fitness for the activity I have chosen</li>" +
  "</ul>" +
  "<p>All PSAC activities I am booking are self-guided. No PSAC employee or guide accompanies me on the trail, PSAC does not track my real-time location, and PSAC has no way of knowing whether I am overdue, lost, injured, or in distress unless I or someone else contacts PSAC or emergency services directly. In an emergency, I understand I should call 911 or the appropriate emergency service rather than relying on PSAC to notice or respond. I am solely responsible for my own navigation, pace, decision-making, and safety, using the route guidance and gear PSAC provides at my own discretion. I understand that PSAC prepares its route guidance in good faith, but that trail, weather, and other conditions can change without notice, and that I am responsible for evaluating conditions and my own ability to safely continue or turn back at any point.</p>" +
  "<p>I understand that PSAC provides rented outdoor equipment, including packs, trekking poles, hydration equipment, and related gear, as part of certain bookings. I agree to inspect equipment before use and to report any visible defect to PSAC before beginning the activity. I understand that equipment can fail or malfunction despite reasonable care, and I accept this risk.</p>" +
  "<p>I acknowledge that hiking, trail running, and related outdoor recreation are sport and recreational activities to which California's doctrine of primary assumption of risk applies, meaning PSAC has no legal duty to protect me from risks inherent to the activity itself.</p>" +
  "<h4>2. Release, Waiver, and Indemnification</h4>" +
  "<p><b>2.1 Release of PSAC.</b> To the fullest extent permitted by California law, I release and forever discharge PSAC from any and all claims, demands, damages, or causes of action arising out of or in any way connected with my participation in a PSAC activity or my use of PSAC's equipment, gear, or trail guidance, including claims alleging negligence by PSAC. Nothing in this Agreement releases, and PSAC does not seek to release, any claim for PSAC's gross negligence, willful misconduct, or violation of law.</p>" +
  "<p><b>2.2 My indemnification of PSAC.</b> To the fullest extent permitted by law, I agree to indemnify, defend, and hold harmless PSAC from and against any claims, damages, losses, or costs, including reasonable attorney's fees, that PSAC incurs because of (a) my own negligent, reckless, or intentional acts or omissions, or (b) my breach of this Agreement, including claims brought by third parties arising from my own conduct during a PSAC activity. This indemnification does not apply to any claim, loss, or cost arising from PSAC's own negligence.</p>" +
  "<h4>2A. Release of the Agua Caliente Band of Cahuilla Indians</h4>" +
  "<p>Because PSAC trails currently cross land within the Agua Caliente Indian Reservation: (1) I release and forever discharge the Agua Caliente Band of Cahuilla Indians, a federally recognized Indian tribe, and its officers, employees, agents, departments, and enterprises, from any and all claims arising out of or resulting from my participation in a PSAC activity on Reservation land; (2) this release is my personal covenant not to sue and does not waive, limit, or abrogate the Tribe's sovereign immunity, and does not constitute the Tribe's consent to suit, arbitration, or any particular forum; (3) the Agua Caliente Band of Cahuilla Indians is an express third-party beneficiary of this Section 2A and may enforce it directly; and (4) I understand that any trail beginning or ending on Reservation land may require a separate entrance fee payable directly to the Tribe, which is my responsibility and is not collected, remitted, or guaranteed by PSAC.</p>" +
  "<h4>2B. Release of the United States</h4>" +
  "<p>Because PSAC's activity includes trail segments on land administered by the Bureau of Land Management (BLM) under a Special Recreation Permit: (1) I release and forever discharge the United States of America, the Department of the Interior, the Bureau of Land Management, and their officers, employees, and agents, from any and all claims arising out of or resulting from my participation in a PSAC activity on BLM-administered land; (2) this release is my personal covenant not to sue and does not waive, limit, or expand any defense, immunity, or claims procedure otherwise available to the United States under the Federal Tort Claims Act or any other applicable law; and (3) I understand this release is provided to BLM as a condition of PSAC's Special Recreation Permit.</p>" +
  "<h4>3. Assumption of Risk</h4>" +
  "<p>I expressly agree and promise to accept all of the risks described above. My participation in PSAC activities is voluntary, and I choose to participate despite these risks.</p>" +
  "<h4>4. Certification of Fitness and Insurance</h4>" +
  "<p>I certify that I am physically fit to participate in the activity I have selected and that I have no medical condition, including cardiac, respiratory, or heat-sensitivity conditions, that would prevent my safe participation, or that I have disclosed any such condition to PSAC in advance. I understand PSAC's gear rental and trail guidance are not a substitute for consulting a physician about my fitness for strenuous hiking in high desert heat. I certify that I carry adequate health and other insurance to cover any injury I may suffer, or I agree to bear the cost of such injury myself.</p>" +
  "<h4>5. Governing Law</h4>" +
  "<p>If a legal action arising from this Agreement or my participation is brought by either party, it shall be brought exclusively in the state or federal courts located in Riverside County, California, and California law governs, without regard to conflict-of-law rules. This Section 5 governs disputes between me and PSAC only; it does not establish the jurisdiction, forum, or governing law for any claim against the Agua Caliente Band of Cahuilla Indians, which is governed by applicable tribal law and the Tribe's own claims procedures, or for any claim against the United States, which is governed by the Federal Tort Claims Act and other applicable federal law. If any part of this Agreement is found void or unenforceable, the remaining portions remain in full force. In any action to enforce or arising out of a breach of this Agreement, the prevailing party is entitled to recover its reasonable attorney's fees and costs.</p>" +
  "<h4>6. Minor Participants</h4>" +
  "<p>If any participant, or any child accompanying a participant on a PSAC activity, is under 18 years of age, whether or not that child is formally named on this booking or has rented equipment from PSAC, I represent that I am that child's parent or legal guardian, or have that parent or guardian's express authorization to make decisions regarding that child's participation. By signing, I agree to all of the above on my own behalf and on that child's behalf, including releasing, to the fullest extent permitted by California law, any claim that child might otherwise bring against PSAC, the Agua Caliente Band of Cahuilla Indians, and the United States, arising from their participation. I additionally certify that I will be personally present and directly supervising each such minor for the entire activity, and that PSAC does not permit unaccompanied minors on self-guided bookings.</p>" +
  "<p><b>6A. Children under age 14.</b> PSAC's gear rental is available only to participants age 14 and older. PSAC maintains trail content, including trails it identifies as generally suitable for young children, to help guests traveling with younger children choose an appropriate trail. I understand this content reflects PSAC's general knowledge of a trail's terrain, shade, and typical experience for families, and is not a personalized fitness, medical, or safety assessment of any specific child, and is not a guarantee that a given trail, or conditions on the day of my hike, will be safe or appropriate for that child. Because PSAC's hikes are self-guided, no PSAC staff member observes or evaluates any child before or during the hike, and PSAC has no ability to verify, monitor, or supervise any child on the trail, or provide gear sized or suited for children under 14. If I choose to bring a child under 14 on a self-guided hike, I understand and agree that the final decision to do so is mine alone, that I am solely responsible for assessing whether the specific trail and conditions on the day of my hike are appropriate for that child given that child's own health and ability, and that I am solely responsible for that child's supervision and safety at all times.</p>" +
  "<h4>7. Acknowledgment and Signature</h4>" +
  "<p>I have read this Participant Agreement and Acknowledgment of Risk in its entirety. I understand it contains a release of my legal right to sue PSAC for injuries or damages caused by PSAC's ordinary negligence, and a contractual assumption of risk, and I sign it voluntarily.</p>";

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
    // Section 9 item 3: waiver text/version served from Script Properties
    // (or the real v1.5 draft default below) instead of hardcoded in the
    // client — see adventurePrep_getWaiverContent_'s header comment.
    waiverContent: adventurePrep_getWaiverContent_(),
  };
}

// Whitelisted field names api/save-adventure-prep.js is allowed to write.
// Deliberately excludes candidateTrails/selectedTrailId/assignedAt/
// assignmentMethod (those are 2.2's and adventurePrep_selectTrail's own
// jobs), and confirmedKitCount (that's adjust-gear-kit-count.js's job,
// via its own dedicated debounce actions below — never a direct write from
// this generic save, so a client can never bypass the debounce/Stripe path).
// BUG FIX (Aug 2026): 'deliveryLat'/'deliveryLng' were long described (in
// api/validate-delivery-address.js's own header comment) as already
// whitelisted here, but they never actually were — the column exists on
// the live Adventure Prep tab (see trail-selection-actions.gs's
// TRAIL_SELECTION_ADVENTURE_PREP_HEADERS, confirmed against the real
// sheet), so a real geocode result had nowhere to land through
// adventurePrep_saveFields: setFields() silently rejected both keys
// (falls into the `if (!col)`... wait, no — it fell into the "key not in
// ADVENTURE_PREP_WRITABLE_FIELDS" branch above and got silently added to
// `rejectedFields` instead of ever reaching the column-lookup at all).
// Added now that Surface A's address step actually calls the validation
// endpoint and has real lat/lng to save.
// NEW (Round 2 build, Gear Kits & Delivery/Pickup mockup-04): the redesign
// adds a Delivery Note, a "return same address" toggle, an optional
// different return address, a Return Location (non-hotel path only), a
// Return Time (now all 4 windows, both paths), and a Return Note — none of
// which had columns on the live "Adventure Prep" tab before this build
// (confirmed against TRAIL_SELECTION_ADVENTURE_PREP_HEADERS in
// trail-selection-actions.gs, which is the tab's real source of truth).
// Added there too — see that file's comment for the one-time setup step
// this requires (running trailSelection_setup() once after pasting these
// changes in, to actually create the new header columns).
var ADVENTURE_PREP_WRITABLE_FIELDS = [
  'isParticipating', 'participatingRosterRef', 'reconfirmedRosterJson',
  'technicalComfort', 'heatComfort', 'bestForAttributes',
  'propertyType', 'deliveryAddressLine1', 'deliveryAddressLine2',
  'deliveryCity', 'deliveryState', 'deliveryZip', 'deliveryAddressRaw',
  'deliveryAddressValidated', 'deliveryLat', 'deliveryLng',
  'deliveryWindow', 'returnPreference', 'deliveryNote',
  'returnSameAsDelivery', 'returnAddressLine1', 'returnLocation',
  'returnWindow', 'returnNote',
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
    // BUG FIX (Round 2 build, Section 9 item 3): was the hardcoded
    // ADVENTURE_PREP_WAIVER_VERSION constant, which could silently drift
    // from whatever text was actually shown to this signer if the
    // Script Properties content was ever updated without also updating
    // this constant (or vice versa). Now reads the same live source the
    // client displayed, so a signature's stored version always matches
    // what that signer actually read and agreed to.
    set('waiverVersion', adventurePrep_getWaiverContent_().version);
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

/**
 * 5b. saveSignerDetails — Surface B's "Confirm Your Details" hub tile
 * (mockup-07, Round 2). Deliberately separate from
 * adventurePrep_saveWaiverSignature above: that function unconditionally
 * sets status='signed' every time it's called, which was fine while phone/
 * SMS-consent could only ever be saved AFTER the waiver step in the old
 * linear flow, but would be a real bug now that Confirm Your Details is
 * its own hub tile a guest can complete before ever opening Your Waiver —
 * calling saveWaiverSignature here would mark an unsigned waiver as
 * signed. This function only ever touches contact fields and
 * detailsConfirmedAt; it never writes status, signedAt, isGuardian, or any
 * of the fields the actual waiver signature owns. signerToken only — this
 * is a non-owner (Surface B) action, there is no owner equivalent because
 * the booking owner's own contact info is edited in the booking flow, not
 * here.
 */
function adventurePrep_saveSignerDetails(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (!payload.signerToken) return { ok: false, error: 'Missing signerToken' };
    var sheet = ss.getSheetByName('Waiver Signatures');
    var map = adventurePrep_headerMap_(sheet);
    var found = adventurePrep_findRowByColumnValue_(sheet, 'signerToken', payload.signerToken);
    if (!found) return { ok: false, error: 'Invalid or expired signer link' };
    var rowIndex = found.rowIndex;
    var now = adventurePrep_nowIso_();

    function set(name, value) {
      if (!map[name]) return;
      sheet.getRange(rowIndex, map[name]).setValue(value === undefined || value === null ? '' : value);
    }

    if (payload.signerEmail !== undefined) set('signerEmail', payload.signerEmail || '');
    if (payload.signerPhone !== undefined) set('signerPhone', payload.signerPhone || '');
    if (payload.smsConsent !== undefined) {
      set('smsConsent', !!payload.smsConsent);
      set('smsConsentAt', payload.smsConsentAt || now);
      set('smsConsentText', payload.smsConsentText || '');
    }
    set('detailsConfirmedAt', now);

    return { ok: true, detailsConfirmedAt: now };
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
 *
 * Round 2 (mockup-07): Surface B is now a scoped Adventure Home hub, not a
 * single linear form, so this also returns candidateTrails/selectedTrailId
 * (for the read-only "Your Trail" tile — every non-owner signer is
 * themselves an attending adult already on the roster, see
 * adventurePrep_sendSignerLinks's own signer list, which excludes both the
 * owner and minors, so a "Your Trail" tile is always meaningful here) and
 * waiverContent. Adding waiverContent here fixes a real drift bug: before
 * this, Surface B never received it at all and waiver-signer-form.js
 * hardcoded its own separate, stale "v1.4" placeholder legal text —
 * completely disconnected from the real Script-Properties-driven content
 * Surface A has used since Section 9 item 3 was resolved. A guest signing
 * through Surface B was shown a different waiver than a guest signing
 * through Surface A. Both surfaces now read the exact same live source.
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
    candidateTrails: ap ? ap.candidateTrails : '',
    selectedTrailId: ap ? ap.selectedTrailId : '',
    waiverContent: adventurePrep_getWaiverContent_(),
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

    // BUG FIX (payment-review, Aug 2026, Medium #38): lib/finalize-kit-
    // change.js reads confirmedKitCount, computes a delta against it, and
    // only AFTER a real Stripe charge/refund succeeds calls back here to
    // write the new count — a gap that spans a network round-trip to
    // Stripe, with no lock held across it (LockService can't span two
    // separate Apps Script invocations anyway). If a staff kit-count
    // correction (manualAdjustment_kitCountCorrection, which reads-and-
    // writes atomically under its own lock and always wins with whatever
    // value staff typed) lands in that gap, this call would otherwise
    // blindly overwrite confirmedKitCount back to a value computed from a
    // baseline that's no longer true — silently discarding the staff
    // correction's data-only write while treating the Stripe charge/refund
    // (which already happened for real) as reconciled, with nobody told
    // either side no longer agrees with the other. payload.
    // expectedConfirmedKitCount (optional, backward compatible — every
    // caller that omits it keeps this function's original unconditional-
    // write behavior) lets the caller name the baseline its Stripe action
    // was actually computed from; if the row's CURRENT confirmedKitCount no
    // longer matches, refuse the write entirely (no Gear Check Log changes
    // either) and let the caller alert instead of silently clobbering.
    if (payload.expectedConfirmedKitCount != null) {
      var currentConfirmedKitCount = target.sheet.getRange(target.rowIndex, target.headerMap['confirmedKitCount']).getValue();
      if (Number(currentConfirmedKitCount) !== Number(payload.expectedConfirmedKitCount)) {
        return {
          ok: false,
          stale: true,
          bookingId: payload.bookingId,
          expectedConfirmedKitCount: payload.expectedConfirmedKitCount,
          currentConfirmedKitCount: currentConfirmedKitCount,
        };
      }
    }

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
