/**
 * apps-script/ops-alerts-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs,
 * same delivery pattern as apps-script/trail-selection-actions.gs and
 * apps-script/adventure-prep-actions.gs. Adds the one action those two
 * builds didn't: writing to the `Ops Alerts` tab (created empty back in the
 * Aug 2026 tab-creation pass, never populated by any code until now).
 *
 * Built against claude/psac-operations-ux-jtbd-prd-v1.md Section 6 (the
 * `Ops Alerts` schema and urgency tiers) and Section 13 (endpoint list).
 * This is the FIRST piece of the actual Operations UX build — everything
 * before this was Adventure Prep's or Trail Selection Logic's own build,
 * this file is deliberately small and self-contained since it exists to
 * unblock a specific, already-confirmed gap (the kit-count charge-failure
 * follow-up, see lib/finalize-kit-change.js's own updated comment) rather
 * than to stand in for the rest of Section 13's endpoint list, which is
 * still to come.
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file in
 *    the same Apps Script project — order doesn't matter, this project
 *    shares one global scope, same as the two prior patches).
 *
 * 2. Wire the new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'opsAlerts_recordAlert') {
 *        out = opsAlerts_recordAlert(body);
 *      } else if (body.action === 'opsAlerts_resolveAlert') {
 *        out = opsAlerts_resolveAlert(body);
 *      } else if (body.action === 'opsAlerts_getAlert') {
 *        out = opsAlerts_getAlert(body);
 *
 *    Same assumption as the other two patches: doPost already validates
 *    body.secret against BOOKINGS_WEBAPP_SECRET before dispatching on
 *    action. This function does not re-check the secret itself.
 *
 * 3. Run opsAlerts_setup() once from the Apps Script editor after pasting.
 *    Writes the header row onto the existing (currently empty) `Ops Alerts`
 *    tab if it isn't already there. Safe to re-run.
 *
 * ADDED (build review, Aug 2026, Section 13): opsAlerts_resolveAlert and
 * opsAlerts_getAlert, backing api/resolve-ops-alert.js — the Ops Alerts
 * page's "Resolve" action (a button plus a note field, per Section 6/13,
 * "never a status cell a human edits directly").
 *
 * This patch deliberately reuses adventurePrep_ensureTabWithHeaders_,
 * adventurePrep_headerMap_, adventurePrep_newId_, and adventurePrep_nowIso_
 * from apps-script/adventure-prep-actions.gs (already pasted into this same
 * project) rather than redefining local copies — they're generic helpers,
 * not Adventure-Prep-specific despite the function-name prefix, and the
 * project's shared global scope makes them available here for free.
 * apps-script/adventure-prep-actions.gs must already be installed before
 * this patch will run.
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

var OPS_ALERTS_HEADERS = [
  'alertId', 'bookingId', 'alertType', 'createdAt', 'amount',
  'stripeErrorDetail', 'status', 'resolvedAt', 'resolvedBy', 'notes', 'urgency',
];

function opsAlerts_setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_ensureTabWithHeaders_(ss, 'Ops Alerts', OPS_ALERTS_HEADERS);
}

/**
 * Appends one row to `Ops Alerts`. Every field except bookingId, alertType,
 * amount, stripeErrorDetail, and urgency is filled in here, not by the
 * caller — status always starts 'Open', resolvedAt/resolvedBy/notes always
 * start blank, matching Section 6's schema ("resolves ... via the Ops
 * Alerts page's 'Resolve' action", never pre-filled at write time).
 *
 * Payload: { bookingId, alertType, amount, stripeErrorDetail, urgency }
 * alertType is currently only ever 'kit_charge_failed' (the one producer
 * wired up so far, lib/finalize-kit-change.js) but this function itself
 * doesn't validate the value — 'deposit_hold_failed' (Section 6, owned by
 * bucket 2.9's build) and any future alert type reuse the same row shape
 * and this same write path, per Section 6's own "room for future alert
 * types" note on the schema.
 */
function opsAlerts_recordAlert(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Ops Alerts');
    if (!sheet) throw new Error('opsAlerts_recordAlert: "Ops Alerts" tab does not exist — run opsAlerts_setup() first');
    var map = adventurePrep_headerMap_(sheet);
    var row = new Array(sheet.getLastColumn()).fill('');
    row[map['alertId'] - 1] = adventurePrep_newId_('ALERT');
    row[map['bookingId'] - 1] = payload.bookingId;
    row[map['alertType'] - 1] = payload.alertType;
    row[map['createdAt'] - 1] = adventurePrep_nowIso_();
    row[map['amount'] - 1] = payload.amount != null ? payload.amount : '';
    row[map['stripeErrorDetail'] - 1] = payload.stripeErrorDetail || '';
    row[map['status'] - 1] = 'Open';
    row[map['resolvedAt'] - 1] = '';
    row[map['resolvedBy'] - 1] = '';
    row[map['notes'] - 1] = '';
    row[map['urgency'] - 1] = payload.urgency || '';
    sheet.appendRow(row);
    return { ok: true, alertId: row[map['alertId'] - 1] };
  } finally {
    lock.releaseLock();
  }
}

/**
 * The Resolve action itself: sets status='Resolved', resolvedAt=now,
 * resolvedBy, and notes, in one write. Idempotent in the sense that
 * resolving an already-Resolved alert again just overwrites resolvedAt/
 * resolvedBy/notes with the latest call rather than erroring — the ops app
 * is the only writer here (Section 13: never a direct sheet edit), so a
 * double-submit from a slow UI click is the only realistic repeat case, and
 * overwriting harmlessly is preferable to a confusing error for staff.
 */
function opsAlerts_resolveAlert(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Ops Alerts');
    if (!sheet) throw new Error('opsAlerts_resolveAlert: "Ops Alerts" tab does not exist — run opsAlerts_setup() first');
    var found = adventurePrep_findRowByColumnValue_(sheet, 'alertId', payload.alertId);
    if (!found) return { ok: false, error: 'Alert not found' };
    var map = found.headerMap;
    sheet.getRange(found.rowIndex, map['status']).setValue('Resolved');
    sheet.getRange(found.rowIndex, map['resolvedAt']).setValue(adventurePrep_nowIso_());
    sheet.getRange(found.rowIndex, map['resolvedBy']).setValue(payload.resolvedBy || '');
    sheet.getRange(found.rowIndex, map['notes']).setValue(payload.notes || '');
    return { ok: true, alertId: payload.alertId };
  } finally {
    lock.releaseLock();
  }
}

function opsAlerts_getAlert(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Ops Alerts');
  var found = adventurePrep_findRowByColumnValue_(sheet, 'alertId', payload.alertId);
  if (!found) return { notFound: true };
  var row = sheet.getRange(found.rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  var obj = {};
  Object.keys(found.headerMap).forEach(function (h) { obj[h] = row[found.headerMap[h] - 1]; });
  return obj;
}
