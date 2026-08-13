/**
 * apps-script/manual-adjustment-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Sheet-side support for api/apply-manual-adjustment.js — Operations UX PRD
 * Section 8's three manual-exception playbooks (8a post-hold kit-count
 * change, 8b post-T-3 trail re-issuance — that one reuses
 * api/write-manual-trail-override.js directly, nothing new needed here —
 * and 8c post-hold-failure gear return), consolidated behind Section 13's
 * "constrained form for the three off-system playbooks... not an open-ended
 * cell edit."
 *
 * Four adjustment types, matching Section 13's own list exactly:
 *   - kit_count_correction     (8a, reduction path: corrected kit count
 *                                after staff manually processes the Stripe
 *                                refund elsewhere)
 *   - gear_check_log_adjustment (8a, reduction path: remove the Gear Check
 *                                Log rows/unit assignment for the removed
 *                                kit — deliberately separate from the count
 *                                correction above, per 8a's own 4-step list)
 *   - change_log_note          (8a, either direction: the actual audit-
 *                                trail entry noting this was handled off-
 *                                system — a separate, explicit step per 8a)
 *   - gear_returned_uncleaned  (8c: gear pulled for a booking that then
 *                                cancels via the T-1 hold-clearance failure
 *                                gets checked back in unused)
 *
 * ============================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ============================================================================
 *
 * `gear_returned_uncleaned`'s exact resulting Gear Check Log state — what
 * "returned, unused, no cleaning needed" looks like as a field or status
 * value on that tab — is explicitly owned by `psac-internal-ops-ux-brief.md`'s
 * schema, not this PRD (Section 8c, Section 16: "flagged here for whoever
 * owns that document to confirm the mapping"). This file's
 * manualAdjustment_gearReturnedUncleaned only appends the Change Log audit
 * row the PRD does specify; it does NOT touch Gear Check Log rows at all,
 * since guessing at that other document's schema risks writing a state that
 * conflicts with whatever it actually defines. Whoever builds that tool
 * should wire the actual Gear Check Log mutation in once that mapping is
 * confirmed — flagged in this session's build-review addendum, not silently
 * assumed handled here.
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file).
 *    Requires apps-script/adventure-prep-actions.gs already pasted in
 *    (reuses its shared helpers, same convention as every other patch).
 *
 * 2. Wire the four new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'manualAdjustment_kitCountCorrection') {
 *        out = manualAdjustment_kitCountCorrection(body);
 *      } else if (body.action === 'manualAdjustment_gearCheckLogAdjustment') {
 *        out = manualAdjustment_gearCheckLogAdjustment(body);
 *      } else if (body.action === 'manualAdjustment_changeLogNote') {
 *        out = manualAdjustment_changeLogNote(body);
 *      } else if (body.action === 'manualAdjustment_gearReturnedUncleaned') {
 *        out = manualAdjustment_gearReturnedUncleaned(body);
 *
 * No new setup() function needed — this patch writes only to tabs/columns
 * that already exist (Adventure Prep, Gear Check Log, Adventure Prep
 * Change Log), all created by earlier patches.
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

/**
 * 8a reduction path, step "record the corrected kit count." Deliberately
 * does NOT touch Gear Check Log or Stripe — those are
 * manualAdjustment_gearCheckLogAdjustment's job and staff's own manual
 * Stripe-dashboard work, respectively, per 8a's own 4-separate-steps list.
 *
 * BUG FIX (independent bug pass, Aug 2026): this used to ALSO append its
 * own Change Log row here, unconditionally — but 8a's documented 4-step
 * playbook has a separate, explicit "log the change via the Manual
 * Adjustment page" step (manualAdjustment_changeLogNote below), which staff
 * are meant to run as its own step for every one of these playbooks. Doing
 * both meant one real kit-count correction produced TWO Change Log rows —
 * this function's own auto-logged one, plus the one staff explicitly add
 * afterward. Removed here; the explicit change_log_note step is now the
 * only place this correction gets logged, matching the documented playbook
 * and this file's own module comment ("the actual audit-trail entry ... a
 * separate, explicit step per 8a").
 */
function manualAdjustment_kitCountCorrection(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_(ss, payload.bookingId);
    var oldValue = target.sheet.getRange(target.rowIndex, target.headerMap['confirmedKitCount']).getValue();
    target.sheet.getRange(target.rowIndex, target.headerMap['confirmedKitCount']).setValue(payload.newConfirmedKitCount);

    return { ok: true, bookingId: payload.bookingId, oldConfirmedKitCount: oldValue, newConfirmedKitCount: payload.newConfirmedKitCount };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 8a reduction path, step "remove the corresponding Gear Check Log
 * rows/unit assignment." Removes not-yet-checked-out rows for the given
 * kit numbers — same "never touch an already-checked-out row" posture as
 * every other Gear Check Log mutation in this stack.
 */
function manualAdjustment_gearCheckLogAdjustment(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var gearSheet = ss.getSheetByName('Gear Check Log');
    var kitNumbers = (payload.kitNumbersToRemove || []).map(String);
    var rows = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
      return String(r.bookingId) === String(payload.bookingId) &&
        kitNumbers.indexOf(String(r.kitNumber)) !== -1 &&
        r.checkedOutAt === '';
    });
    var rowIndexes = rows.map(function (r) { return r.__rowIndex; }).sort(function (a, b) { return b - a; });
    rowIndexes.forEach(function (rowIndex) { gearSheet.deleteRow(rowIndex); });

    return { ok: true, bookingId: payload.bookingId, removedRowCount: rowIndexes.length };
  } finally {
    lock.releaseLock();
  }
}

/**
 * The explicit audit-trail step every manual-exception playbook ends with
 * (8a: "staff logs the change via the Manual Adjustment page... which
 * appends a Adventure Prep Change Log row"; 8b/8c have their own dedicated
 * paths that log inline instead — see write-manual-trail-override.js and
 * manualAdjustment_gearReturnedUncleaned below). `changeType` is caller-
 * supplied rather than fixed, since 8a's own text names `kit_count` for
 * this specific playbook but doesn't rule out this same generic note-append
 * mechanism being reused for some other off-system exception later.
 */
function manualAdjustment_changeLogNote(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_appendChangeLog_(ss, {
    bookingId: payload.bookingId,
    changeType: payload.changeType || 'kit_count',
    beforeT3Cutoff: false,
    staffNotes: 'Manual adjustment (off-system): ' + (payload.staffNotes || ''),
  });
  return { ok: true, bookingId: payload.bookingId };
}

/**
 * 8c: logs the audit trail for gear checked back in unused after a T-1
 * hold-clearance cancellation. See this file's header for why it doesn't
 * also mutate Gear Check Log directly.
 */
function manualAdjustment_gearReturnedUncleaned(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_appendChangeLog_(ss, {
    bookingId: payload.bookingId,
    changeType: 'gear_return',
    beforeT3Cutoff: false,
    staffNotes: payload.staffNotes || '',
  });
  return { ok: true, bookingId: payload.bookingId };
}
