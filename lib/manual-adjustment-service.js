/**
 * lib/manual-adjustment-service.js
 *
 * MIGRATED (2026-08-31, Task 8 ops-proxy migration): Postgres replacement
 * for apps-script/manual-adjustment-actions.gs's five original functions
 * plus apps-script/ops-redesign-round2-actions.gs's three newer ones — all
 * 8 `manualAdjustment_*` types api/apply-manual-adjustment.js dispatches to.
 * Per Airey's Aug 2026 call (captured in both .gs files' own updated
 * comments and ops-manual-adjustment.html's header), all 8 types now
 * self-log their own audit_log row — no type relies on a separate
 * change_log_note step to have any audit trail at all.
 *
 * gearReturnedUncleaned deliberately does NOT touch gear_check_log — see
 * the .gs source's own header: that mapping is owned by a different,
 * unconfirmed document, not this PRD. Only the audit_log row is written.
 */

'use strict';

const { query } = require('./db');
const { genId } = require('./ids');
const { clearCadenceStagesSent } = require('./cadence-service');

async function appendAuditLog(entry) {
  await query(
    `INSERT INTO audit_log (
       audit_id, booking_id, change_type, before_t3_cutoff, old_value_json,
       new_value_json, staff_notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      genId('AUDIT'), entry.bookingId, entry.changeType, !!entry.beforeT3Cutoff,
      entry.oldValueJson != null ? JSON.stringify(entry.oldValueJson) : null,
      entry.newValueJson != null ? JSON.stringify(entry.newValueJson) : null,
      entry.staffNotes || '',
    ]
  );
}

/**
 * 8a reduction path, step "record the corrected kit count." Deliberately
 * does not touch gear_check_log or Stripe — those are
 * gearCheckLogAdjustment's job and staff's own manual Stripe-dashboard
 * work, respectively.
 */
async function kitCountCorrection({ bookingId, newConfirmedKitCount, staffNotes }) {
  // Defense-in-depth bounds check — api/apply-manual-adjustment.js already
  // clamps to [1,20] before this is ever called; a second, independent
  // trust boundary so a future caller can't reintroduce an unclamped write.
  const newCount = Number(newConfirmedKitCount);
  if (!isFinite(newCount) || Math.floor(newCount) !== newCount || newCount < 1 || newCount > 20) {
    return { ok: false, error: 'newConfirmedKitCount must be a whole number between 1 and 20' };
  }

  await query(`INSERT INTO adventure_prep (booking_id) VALUES ($1) ON CONFLICT (booking_id) DO NOTHING`, [bookingId]);
  const oldRows = await query(`SELECT confirmed_kit_count FROM adventure_prep WHERE booking_id = $1`, [bookingId]);
  const oldValue = oldRows.length ? oldRows[0].confirmed_kit_count : null;
  await query(`UPDATE adventure_prep SET confirmed_kit_count = $2 WHERE booking_id = $1`, [bookingId, newCount]);

  await appendAuditLog({
    bookingId,
    changeType: 'kit_count_correction',
    oldValueJson: { confirmedKitCount: oldValue },
    newValueJson: { confirmedKitCount: newCount },
    staffNotes: staffNotes || '',
  });

  return { ok: true, bookingId, oldConfirmedKitCount: oldValue, newConfirmedKitCount: newCount };
}

/** 8a reduction path, step "remove the corresponding Gear Check Log rows/unit assignment." Only removes not-yet-checked-out rows — never touches an already-checked-out row. */
async function gearCheckLogAdjustment({ bookingId, kitNumbersToRemove, staffNotes }) {
  const kitNumbers = (kitNumbersToRemove || []).map(String);
  const rows = await query(
    `SELECT item_row_id, kit_number FROM gear_check_log WHERE booking_id = $1 AND checked_out_at IS NULL`,
    [bookingId]
  );
  const toDelete = rows.filter((r) => kitNumbers.indexOf(String(r.kit_number)) !== -1);
  if (toDelete.length) {
    await query(
      `DELETE FROM gear_check_log WHERE item_row_id = ANY($1::text[])`,
      [toDelete.map((r) => r.item_row_id)]
    );
  }

  await appendAuditLog({
    bookingId,
    changeType: 'gear_check_log_adjustment',
    oldValueJson: { kitNumbersToRemove: kitNumbers },
    newValueJson: { removedRowCount: toDelete.length },
    staffNotes: staffNotes || '',
  });

  return { ok: true, bookingId, removedRowCount: toDelete.length };
}

/** The explicit, generic audit-trail step — changeType is caller-supplied (defaults to 'kit_count'), staffNotes always prefixed so this entry's origin is identifiable in the Recent Change Log table. */
async function changeLogNote({ bookingId, changeType, staffNotes }) {
  await appendAuditLog({
    bookingId,
    changeType: changeType || 'kit_count',
    beforeT3Cutoff: false,
    staffNotes: 'Manual adjustment (off-system): ' + (staffNotes || ''),
  });
  return { ok: true, bookingId };
}

/** 8c: logs the audit trail for gear checked back in unused after a T-1 hold-clearance cancellation. See this file's header for why it doesn't also mutate gear_check_log directly. */
async function gearReturnedUncleaned({ bookingId, staffNotes }) {
  await appendAuditLog({
    bookingId,
    changeType: 'gear_return',
    beforeT3Cutoff: false,
    staffNotes: staffNotes || '',
  });
  return { ok: true, bookingId };
}

const ADDRESS_FIELD_MAP = {
  deliveryAddressLine1: 'delivery_address_line1',
  deliveryAddressLine2: 'delivery_address_line2',
  deliveryCity: 'delivery_city',
  deliveryState: 'delivery_state',
  deliveryZip: 'delivery_zip',
  deliveryAddressRaw: 'delivery_address_raw',
  deliveryAddressValidated: 'delivery_address_validated',
  deliveryLat: 'delivery_lat',
  deliveryLng: 'delivery_lng',
};

/** Staff need to enter/correct a guest's delivery address after a phone/SMS/email interaction. Own small fixed whitelist — only ever touches address fields, never an open-ended cell edit. */
async function updateDeliveryAddress(payload) {
  const { bookingId, staffNotes } = payload;
  await query(`INSERT INTO adventure_prep (booking_id) VALUES ($1) ON CONFLICT (booking_id) DO NOTHING`, [bookingId]);

  const written = [];
  const setClauses = [];
  const params = [bookingId];
  Object.keys(ADDRESS_FIELD_MAP).forEach((key) => {
    if (!(key in payload)) return; // caller may omit line2, lat/lng, etc.
    const col = ADDRESS_FIELD_MAP[key];
    params.push(payload[key]);
    setClauses.push(`${col} = $${params.length}`);
    written.push(key);
  });
  if (setClauses.length) {
    await query(`UPDATE adventure_prep SET ${setClauses.join(', ')} WHERE booking_id = $1`, params);
  }

  await appendAuditLog({
    bookingId,
    changeType: 'update_delivery_address',
    newValueJson: { writtenFields: written, deliveryAddressRaw: payload.deliveryAddressRaw || '' },
    staffNotes: staffNotes || '',
  });

  return { ok: true, bookingId, writtenFields: written };
}

/**
 * Updates the booking's trail day and clears booking_cadence_log so the
 * stall-detection cadence re-evaluates cleanly against the new date. Does
 * NOT itself re-run trail selection — that's the caller's job
 * (api/apply-manual-adjustment.js calls lib/run-trail-assignment.js's
 * runTrailAssignmentForBooking with operation:'refresh' right after this
 * write succeeds).
 */
async function trailDayChange({ bookingId, newTripDate, staffNotes }) {
  const rows = await query(`SELECT date FROM experience_bookings WHERE booking_id = $1`, [bookingId]);
  if (!rows.length) return { ok: false, error: 'Booking not found' };
  const oldDateRaw = rows[0].date;
  const oldDate = oldDateRaw ? (oldDateRaw instanceof Date ? oldDateRaw.toISOString().slice(0, 10) : String(oldDateRaw)) : null;

  await query(`UPDATE experience_bookings SET date = $2 WHERE booking_id = $1`, [bookingId, newTripDate]);
  await clearCadenceStagesSent(bookingId);

  await appendAuditLog({
    bookingId,
    changeType: 'trail_day_change',
    oldValueJson: { tripDate: oldDate },
    newValueJson: { tripDate: newTripDate },
    staffNotes: staffNotes || '',
  });

  return { ok: true, bookingId, oldTripDate: oldDate, newTripDate };
}

/**
 * Covers a wrong size/type caught before delivery, a unit found damaged/
 * dirty after allocation, and gear lost/destroyed/broken in transit or
 * mid-rental. `reason` drives the ORIGINAL unit's new status. If
 * noSubstitute is true, the new-unit side is skipped entirely.
 */
const SWAP_REASON_TO_ORIGINAL_STATUS = {
  damaged_before_delivery: 'damaged_pending_repair',
  broken_during_rental: 'damaged_pending_repair',
  dirty_before_delivery: 'needs_cleaning',
  wrong_size_or_type: 'available',
  lost_or_destroyed_in_transit: 'retired',
};

async function swapAllocatedUnit({ bookingId, originalUnitId, reason, newUnitId, noSubstitute, staffNotes }) {
  const originalRows = await query(`SELECT unit_id, status FROM gear_units WHERE unit_id = $1`, [originalUnitId]);
  if (!originalRows.length) return { ok: false, error: 'Original unit not found: ' + originalUnitId };

  const newOriginalStatus = SWAP_REASON_TO_ORIGINAL_STATUS[reason] || 'damaged_pending_repair';
  if (newOriginalStatus === 'retired') {
    await query(
      `UPDATE gear_units SET status = $2, current_booking_id = NULL, retired_at = NOW(), retired_reason = $3 WHERE unit_id = $1`,
      [originalUnitId, newOriginalStatus, 'manual_adjustment_swap: ' + reason + ' (booking ' + bookingId + ')']
    );
  } else {
    // Freed from this booking either way — a unit pending repair/cleaning/retirement is no longer "this booking's."
    await query(`UPDATE gear_units SET status = $2, current_booking_id = NULL WHERE unit_id = $1`, [originalUnitId, newOriginalStatus]);
  }

  const gearRows = await query(
    `SELECT item_row_id, checked_out_at FROM gear_check_log WHERE booking_id = $1 AND unit_id = $2`,
    [bookingId, originalUnitId]
  );
  const gearRow = gearRows[0] || null;

  const result = { ok: true, bookingId, originalUnitId, originalNewStatus: newOriginalStatus, newUnitId: null };

  if (!noSubstitute && newUnitId) {
    const newRows = await query(`SELECT unit_id, status FROM gear_units WHERE unit_id = $1`, [newUnitId]);
    if (!newRows.length) return { ok: false, error: 'New unit not found: ' + newUnitId };
    if (newRows[0].status !== 'available') return { ok: false, error: `New unit ${newUnitId} is not available (status: ${newRows[0].status})` };
    // Match the booking's current stage: if the original was already
    // checked_out (post-delivery breakage), the replacement steps straight
    // into checked_out too; otherwise (pre-delivery swap) allocated.
    const wasCheckedOut = !!(gearRow && gearRow.checked_out_at);
    const newStatus = wasCheckedOut ? 'checked_out' : 'allocated';
    await query(`UPDATE gear_units SET status = $2, current_booking_id = $3 WHERE unit_id = $1`, [newUnitId, newStatus, bookingId]);
    if (gearRow) {
      await query(`UPDATE gear_check_log SET unit_id = $2 WHERE item_row_id = $1`, [gearRow.item_row_id, newUnitId]);
    }
    result.newUnitId = newUnitId;
    result.newUnitStatus = newStatus;
  }

  await appendAuditLog({
    bookingId,
    changeType: 'gear_unit_swap',
    oldValueJson: { unitId: originalUnitId, reason },
    newValueJson: { newUnitId: result.newUnitId, noSubstitute: !!noSubstitute },
    staffNotes: staffNotes || '',
  });

  return result;
}

/**
 * For a guest who cancels after gear is already out. Sets booking_status
 * to 'cancelled_post_delivery' (not a generic 'cancelled') so the booking
 * still surfaces in Return Check-In's queue for gear pickup even though
 * the trip itself is off. No refund — refund_amount is written as 0
 * explicitly, not left blank, so it reads as "checked, zero."
 */
async function postDeliveryCancellation({ bookingId, cancellationReason, staffNotes }) {
  const rows = await query(`SELECT booking_id FROM experience_bookings WHERE booking_id = $1`, [bookingId]);
  if (!rows.length) return { ok: false, error: 'Booking not found' };
  const now = new Date().toISOString();
  await query(
    `UPDATE experience_bookings SET booking_status = 'cancelled_post_delivery', cancelled_at = $2, cancellation_reasons = $3, refund_amount = 0 WHERE booking_id = $1`,
    [bookingId, now, cancellationReason || 'post_delivery_cancellation']
  );

  await appendAuditLog({
    bookingId,
    changeType: 'post_delivery_cancellation',
    newValueJson: { bookingStatus: 'cancelled_post_delivery', refundAmount: 0, reason: cancellationReason || '' },
    staffNotes: staffNotes || '',
  });

  return { ok: true, bookingId, bookingStatus: 'cancelled_post_delivery', cancelledAt: now };
}

module.exports = {
  kitCountCorrection,
  gearCheckLogAdjustment,
  changeLogNote,
  gearReturnedUncleaned,
  updateDeliveryAddress,
  trailDayChange,
  swapAllocatedUnit,
  postDeliveryCancellation,
};
