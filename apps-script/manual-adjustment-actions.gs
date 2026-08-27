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
 * cell edit," plus a fifth type added Aug 2026 at Airey's direct request
 * (see manualAdjustment_updateDeliveryAddress below).
 *
 * Five adjustment types, matching api/apply-manual-adjustment.js's own
 * list exactly:
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
 *   - update_delivery_address  (Aug 2026, not in the original locked PRD:
 *                                staff need to enter or correct a guest's
 *                                delivery address after a phone/SMS/email
 *                                interaction, not just through Surface A's
 *                                own self-service field. Writes the same
 *                                columns adventurePrep_saveFields writes,
 *                                just keyed by bookingId instead of the
 *                                guest's token, since staff work from the
 *                                booking record, not a token.)
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
 *    (reuses its shared helpers, same convention as every other patch), AND
 *    requires that file's ADVENTURE_PREP_WRITABLE_FIELDS to include
 *    'deliveryLat' and 'deliveryLng' (added this same round — the Adventure
 *    Prep tab already has both columns per trail-selection-actions.gs's own
 *    header list, they just weren't in the writable-fields whitelist yet).
 *
 * 2. Wire the five new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'manualAdjustment_kitCountCorrection') {
 *        out = manualAdjustment_kitCountCorrection(body);
 *      } else if (body.action === 'manualAdjustment_gearCheckLogAdjustment') {
 *        out = manualAdjustment_gearCheckLogAdjustment(body);
 *      } else if (body.action === 'manualAdjustment_changeLogNote') {
 *        out = manualAdjustment_changeLogNote(body);
 *      } else if (body.action === 'manualAdjustment_gearReturnedUncleaned') {
 *        out = manualAdjustment_gearReturnedUncleaned(body);
 *      } else if (body.action === 'manualAdjustment_updateDeliveryAddress') {
 *        out = manualAdjustment_updateDeliveryAddress(body);
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
 * REVERSED (Ops App Redesign, Aug 2026, Round 2 — direct instruction from
 * Airey after reviewing the Manual Adjustment page's new Adjustment Type
 * filter): this function used to deliberately NOT log its own Change Log
 * row (see the superseded comment this replaces — the reasoning was that
 * 8a's documented playbook has a separate, explicit change_log_note step,
 * and logging in both places double-logged one correction). Airey's call:
 * this and its two siblings below (manualAdjustment_gearCheckLogAdjustment,
 * manualAdjustment_updateDeliveryAddress) should each auto-log their own
 * row regardless — matching how the three newer Round 2 types
 * (trail_day_change/swap_allocated_unit/post_delivery_cancellation) already
 * behave. Staff can still run change_log_note separately for freeform
 * context if they want to, same as before; it just no longer needs to be
 * the ONLY place this shows up in the audit trail.
 */
function manualAdjustment_kitCountCorrection(payload) {
  // BUG FIX (payment-review, Aug 2026, Critical #7, floor corrected per
  // Airey): this wrote payload.newConfirmedKitCount straight to the Sheet
  // with zero bounds checking. api/apply-manual-adjustment.js now clamps
  // to [1,20] before this is ever called (every booking requires at least
  // 1 kit - there is no valid 0-kit booking), but this is a second,
  // independent trust boundary (server-to-server, but not the same code)
  // - defense-in-depth so a future caller can't reintroduce the
  // unclamped-write bug from this side.
  var newCount = Number(payload.newConfirmedKitCount);
  if (!isFinite(newCount) || Math.floor(newCount) !== newCount || newCount < 1 || newCount > 20) {
    return { ok: false, error: 'newConfirmedKitCount must be a whole number between 1 and 20' };
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_(ss, payload.bookingId);
    var oldValue = target.sheet.getRange(target.rowIndex, target.headerMap['confirmedKitCount']).getValue();
    target.sheet.getRange(target.rowIndex, target.headerMap['confirmedKitCount']).setValue(newCount);

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'kit_count_correction',
      oldValueJson: JSON.stringify({ confirmedKitCount: oldValue }),
      newValueJson: JSON.stringify({ confirmedKitCount: newCount }),
      staffNotes: payload.staffNotes || '',
    });

    return { ok: true, bookingId: payload.bookingId, oldConfirmedKitCount: oldValue, newConfirmedKitCount: newCount };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 8a reduction path, step "remove the corresponding Gear Check Log
 * rows/unit assignment." Removes not-yet-checked-out rows for the given
 * kit numbers — same "never touch an already-checked-out row" posture as
 * every other Gear Check Log mutation in this stack.
 *
 * Logs its own Change Log row (Ops App Redesign, Aug 2026, Round 2 —
 * direct instruction from Airey; see manualAdjustment_kitCountCorrection's
 * own comment above for the full reasoning, same call here).
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

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'gear_check_log_adjustment',
      oldValueJson: JSON.stringify({ kitNumbersToRemove: kitNumbers }),
      newValueJson: JSON.stringify({ removedRowCount: rowIndexes.length }),
      staffNotes: payload.staffNotes || '',
    });

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

/**
 * Aug 2026, added at Airey's direct request (not in the original locked
 * PRD): staff need to enter or correct a guest's delivery address after a
 * phone/SMS/email interaction, not just through Surface A's own
 * self-service field. Writes the exact same columns
 * adventurePrep_saveFields writes for the address group, just keyed by
 * bookingId (via adventurePrep_getOrCreateRow_, same helper
 * kit_count_correction above already uses) instead of a guest token,
 * since staff work from the booking record, not a token. Deliberately its
 * own small fixed whitelist (not the full ADVENTURE_PREP_WRITABLE_FIELDS
 * list) — this endpoint should only ever touch address fields, matching
 * the "constrained form, not an open-ended cell edit" posture the rest of
 * this file follows.
 *
 * Logs its own Change Log row (Ops App Redesign, Aug 2026, Round 2 —
 * direct instruction from Airey, reversing the original "no auto-log"
 * convention; see manualAdjustment_kitCountCorrection's own comment above
 * for the full reasoning, same call here).
 */
function manualAdjustment_updateDeliveryAddress(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_(ss, payload.bookingId);
    var writable = [
      'deliveryAddressLine1', 'deliveryAddressLine2', 'deliveryCity',
      'deliveryState', 'deliveryZip', 'deliveryAddressRaw',
      'deliveryAddressValidated', 'deliveryLat', 'deliveryLng',
    ];
    var written = [];
    writable.forEach(function (key) {
      if (!(key in payload)) return; // caller may omit line2, lat/lng, etc.
      var col = target.headerMap[key];
      if (!col) return; // column doesn't exist on this sheet — skip, don't throw
      var value = payload[key];
      target.sheet.getRange(target.rowIndex, col).setValue(
        (typeof value === 'object' && value !== null) ? JSON.stringify(value) : value
      );
      written.push(key);
    });

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'update_delivery_address',
      newValueJson: JSON.stringify({ writtenFields: written, deliveryAddressRaw: payload.deliveryAddressRaw || '' }),
      staffNotes: payload.staffNotes || '',
    });

    return { ok: true, bookingId: payload.bookingId, writtenFields: written };
  } finally {
    lock.releaseLock();
  }
}
