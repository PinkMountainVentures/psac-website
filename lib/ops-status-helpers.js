/**
 * lib/ops-status-helpers.js
 *
 * Postgres port of the four pure display-bucket helpers from
 * apps-script/ops-redesign-round1-actions.gs (opsRedesign_holdStatusBucket_,
 * opsRedesign_paymentStatusBucket_, opsRedesign_bookingStatusInfo_,
 * opsRedesign_deliveryReturnStatus_). Pulled out into their own tiny module
 * — rather than inlined into lib/booking-detail-service.js, the first
 * caller — because the .gs source's own header is explicit that All
 * Bookings and Booking Detail "must never disagree about what a given
 * booking's state actually is" by sharing these exact functions. All
 * Bookings/Ops Alerts Expanded (Task 8, still on Apps Script as of this
 * write) should require() this same module when they're migrated, not
 * re-derive their own copies.
 *
 * No state, no I/O — pure functions over a Postgres row's fields. Callers
 * pass the raw snake_case row (or the one field each needs) rather than a
 * camelCase-remapped object, since these are meant to be called directly
 * against whatever a `SELECT * FROM experience_bookings` already returns.
 */

'use strict';

/**
 * Hold Status display bucket for a raw deposit_status value. Per Airey's
 * own Aug 27 correction (baked into claude/psac-ops-all-bookings.html):
 * the live deposit-hold code only ever writes 'held' for an outstanding
 * hold — there is no real "Placed" vs "Active" distinction, so blank/null
 * reads as "Not Yet Placed" and 'held' reads as "Active." 'refunded' (a
 * captured-then-refunded correction, gearService.recordRefund) has no
 * dedicated bucket in the approved 6-value list — mapped here to
 * "Released" (net capture is zero), same judgment call the .gs source
 * flagged. 'shortfall_charge_in_progress' (a brief in-flight lock state,
 * gearService.beginShortfallCharge) maps to "Captured (partial)" as the
 * closest approximation — transient, should rarely be observed live.
 */
function holdStatusBucket(depositStatus) {
  const s = String(depositStatus || '');
  if (!s) return 'not_yet_placed';
  if (s === 'held') return 'active';
  if (s === 'released' || s === 'refunded') return 'released';
  if (s === 'partial_capture' || s === 'shortfall_charge_in_progress') return 'captured_partial';
  if (s === 'full_capture' || s === 'full_capture_pending_review' || s === 'shortfall_charged') return 'captured_full';
  if (s === 'failed') return 'failed';
  return 'not_yet_placed';
}

/**
 * Payment Status bucket, from experience_bookings.payment_status — a real
 * column now (see schema.sql's own comment on it), not re-derived from a
 * fullPayloadJson blob the way the .gs version did (this schema
 * deliberately has no such blob — Finding #8). A null/blank value (should
 * only happen for a booking saved before this column existed, if ever)
 * defaults to 'succeeded', the exact same fallback the .gs source used for
 * its own pre-field-existing rows.
 */
function paymentStatusBucket(paymentStatus) {
  const status = paymentStatus || 'succeeded';
  if (status === 'succeeded') return 'succeeded';
  if (status === 'processing') return 'pending';
  return 'failed';
}

/** Booking Status bucket + cancellation reason list, from booking_status/cancellation_reasons. */
function bookingStatusInfo(row) {
  const status = row.booking_status || 'active';
  if (status === 'active') return { bucket: 'confirmed', reasons: [] };
  const reasons = String(row.cancellation_reasons || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { bucket: 'cancelled', reasons };
}

/**
 * Delivery/Return status for a booking, derived from the fields the
 * gear-ops delivery/return state machine writes (delivery_status,
 * return_status — see lib/gear-service.js). Falls back to the pre-Round-2
 * signal (gear_delivered_at alone) so a booking reads as 'delivered' even
 * if delivery_status was never set, same fallback the .gs source had.
 */
function deliveryReturnStatus(row) {
  const deliveryStatus = row.delivery_status || (row.gear_delivered_at ? 'delivered' : '');
  const returnStatus = row.return_status || '';
  return { deliveryStatus, returnStatus };
}

module.exports = {
  holdStatusBucket,
  paymentStatusBucket,
  bookingStatusInfo,
  deliveryReturnStatus,
};
