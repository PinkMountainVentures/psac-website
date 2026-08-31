'use strict';

const { query } = require('./db');
const { genId } = require('./ids');
const { findOpenAlert } = require('./gear-service');

/**
 * lib/payment-update-service.js
 *
 * MIGRATED (Task 18): Postgres replacement for apps-script/payment-update-
 * actions.gs's two functions — paymentUpdate_getBookingForToken and
 * paymentUpdate_recordCardUpdated. Backs api/create-payment-update-
 * session.js and api/save-updated-payment-method.js (the "update your
 * payment method" flow behind the deposit-hold-failed email's link).
 *
 * Reuses lib/gear-service.js's findOpenAlert — already the generalized
 * Postgres equivalent of holdClearance_findOpenDepositAlert, per that
 * file's own header comment — rather than a third re-implementation of
 * "is there a genuinely open alert of this type for this booking."
 */

/**
 * Guest-token auth, same posture as the .gs version and lib/adventure-prep-
 * service.js's own findBookingByToken: reuses the booking's existing
 * adventure_prep_token rather than a second token type.
 *
 * BUG FIX carried over unchanged from the .gs version (payment-review, Aug
 * 2026, Medium #41): this token authorizes a meaningfully more sensitive
 * action (redirecting future off-session charges to a new card) than the
 * same token's use elsewhere (editing a delivery address), so it's scoped
 * to only work while there's a genuinely open deposit_hold_failed alert on
 * the booking — the one real situation this flow exists to resolve. A
 * stale/leaked/already-resolved link fails closed (noOpenIssue) instead of
 * working forever.
 */
async function paymentUpdateGetBookingForToken({ bookingId, token }) {
  const rows = await query(`SELECT * FROM experience_bookings WHERE booking_id = $1`, [bookingId]);
  if (!rows.length) return { notFound: true };
  const booking = rows[0];
  if (!booking.adventure_prep_token || String(booking.adventure_prep_token) !== String(token)) {
    return { unauthorized: true };
  }
  const openAlert = await findOpenAlert({ bookingId: booking.booking_id, alertType: 'deposit_hold_failed' });
  if (!openAlert.found) return { noOpenIssue: true };
  return {
    ok: true,
    bookingId: booking.booking_id,
    mainPaymentIntentId: booking.main_payment_intent_id,
    contactEmail: booking.contact_email,
    contactName: booking.contact_name,
    depositStatus: booking.deposit_status || '',
  };
}

/**
 * Postgres equivalent of paymentUpdate_recordCardUpdated. The .gs version
 * wrote this to the shared Adventure Prep Change Log tab rather than a new
 * column, since it's a one-off event record, not a field read back later —
 * this schema's equivalent one-off event log is audit_log, already used
 * the same way by every sibling *-service.js file in this migration (see
 * e.g. lib/gear-service.js's own appendAuditLog).
 */
async function recordCardUpdated({ bookingId, paymentMethodId }) {
  await query(
    `INSERT INTO audit_log (audit_id, booking_id, change_type, new_value_json, staff_notes)
     VALUES ($1, $2, 'payment_method_updated', $3, $4)`,
    [
      genId('AUDIT'),
      bookingId,
      JSON.stringify({ paymentMethodId: paymentMethodId || '' }),
      'Guest updated their card via the self-service payment-method-update page.',
    ]
  );
  return { ok: true };
}

module.exports = { paymentUpdateGetBookingForToken, recordCardUpdated };
