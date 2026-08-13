/**
 * apps-script/ops-app-list-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Read-only "list everything" actions backing the internal ops app's table
 * views — Trail Swap Requests, Ops Alerts, and Manual Adjustment's recent-
 * activity list. None of the three prior patches (trail-swap-actions.gs,
 * ops-alerts-actions.gs, manual-adjustment-actions.gs) built one of these,
 * since each only needed the single-row lookup its own write path required.
 * Closes that gap so the ops app's list pages have real data to render.
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file).
 *    Requires apps-script/adventure-prep-actions.gs, apps-script/ops-alerts-
 *    actions.gs, and apps-script/trail-swap-actions.gs already pasted in.
 *
 * 2. Wire the three new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'opsAlerts_listAll') {
 *        out = opsAlerts_listAll(body);
 *      } else if (body.action === 'trailSwap_listAll') {
 *        out = trailSwap_listAll(body);
 *      } else if (body.action === 'changeLog_listRecent') {
 *        out = changeLog_listRecent(body);
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

// BUG FIX (independent bug pass, Aug 2026): the only two writers of an
// `urgency` value are lib/finalize-kit-change.js's opsAlertUrgency()
// (which writes 'urgent_same_day' or 'standard_24hr') and
// api/trigger-deposit-holds.js (which writes 'same_day_2hr'). This map's
// old keys ('same_day_2hr', '24hr', '48hr') never matched
// 'urgent_same_day'/'standard_24hr' at all, so every kit-change alert fell
// through to the default bucket (9) and the intended urgency-based sort
// never actually applied to them. Keys now match the real written values;
// same_day_2hr and urgent_same_day are both "act today" urgency and are
// ranked together ahead of the 24-hour bucket.
var OPS_ALERT_URGENCY_SORT_ = { same_day_2hr: 0, urgent_same_day: 1, standard_24hr: 2 };

/**
 * Every Ops Alerts row, Open first (same_day_2hr, then 24hr, then 48hr,
 * then anything else), most-recently-created first within each group, so
 * whoever opens the page sees the same-day-2hr hold failure at the very top
 * without any client-side sorting. Capped at 100 rows — this is a live
 * operational queue, not an archive; Resolved rows age out of relevance
 * long before that cap matters at this business's volume.
 */
function opsAlerts_listAll(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Ops Alerts');
  if (!sheet) return { alerts: [] };
  var rows = adventurePrep_readRowsAsObjects_(sheet);
  rows.sort(function (a, b) {
    var aOpen = a.status === 'Open' ? 0 : 1;
    var bOpen = b.status === 'Open' ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    var aUrg = OPS_ALERT_URGENCY_SORT_[a.urgency] != null ? OPS_ALERT_URGENCY_SORT_[a.urgency] : 9;
    var bUrg = OPS_ALERT_URGENCY_SORT_[b.urgency] != null ? OPS_ALERT_URGENCY_SORT_[b.urgency] : 9;
    if (aUrg !== bUrg) return aUrg - bUrg;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
  return { alerts: rows.slice(0, 100) };
}

/** Every Trail Swap Requests row, Open first, most-recent first. */
function trailSwap_listAll(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Trail Swap Requests');
  if (!sheet) return { requests: [] };
  var rows = adventurePrep_readRowsAsObjects_(sheet);
  rows.sort(function (a, b) {
    var aOpen = a.status === 'Open' ? 0 : 1;
    var bOpen = b.status === 'Open' ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return String(b.receivedAt).localeCompare(String(a.receivedAt));
  });
  return { requests: rows.slice(0, 100) };
}

/**
 * Most recent 30 Adventure Prep Change Log rows, newest first. Deliberately
 * NOT filtered to only manual-adjustment-originated entries — this tab is
 * shared with every other change-logging write path in this project
 * (trail_manual_override, kit_count, t3-cutoff processing, etc.), and
 * filtering by changeType here would require hardcoding an assumption about
 * which values are "manual adjustment" versus not, which isn't reliably
 * knowable (changeLogNote's own changeType is caller-supplied, not fixed).
 * The ops app's Manual Adjustment page labels this "Recent Change Log
 * Entries," not "Recent adjustments," to stay honest about that.
 */
function changeLog_listRecent(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Adventure Prep Change Log');
  if (!sheet) return { entries: [] };
  var rows = adventurePrep_readRowsAsObjects_(sheet);
  rows.sort(function (a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); });
  return { entries: rows.slice(0, 30) };
}
