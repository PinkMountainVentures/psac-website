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
 * ALLOW-LIST (2026-09-11, card-capture consolidation): this token
 * authorizes a meaningfully sensitive action (redirecting future
 * off-session charges to a new card), so — same posture as the original
 * Medium #41 fix below — it only works for a short, explicit list of
 * reasons, never "anytime a guest has this token." Each reason is checked
 * in turn; the first one that applies wins, and the matched reason comes
 * back on the result so callers (api/save-updated-payment-method.js, in
 * particular) can decide whether to chain an immediate hold retry.
 *
 * BUG FIX carried over unchanged from the .gs version (payment-review, Aug
 * 2026, Medium #41): the *first* reason below (deposit_hold_failed_
 * recovery) is exactly that original fix — scoped to only work while
 * there's a genuinely open deposit_hold_failed alert on the booking. A
 * stale/leaked/already-resolved link still fails closed (noOpenIssue)
 * instead of working forever; this change widens the enumerated set of
 * valid reasons, it doesn't loosen that posture.
 */
async function paymentUpdateGetBookingForToken({ bookingId, token }) {
  const rows = await query(`SELECT * FROM experience_bookings WHERE booking_id = $1`, [bookingId]);
  if (!rows.length) return { notFound: true };
  const booking = rows[0];
  if (!booking.adventure_prep_token || String(booking.adventure_prep_token) !== String(token)) {
    return { unauthorized: true };
  }

  const depositStatus = booking.deposit_status || '';

  // Reason 1: deposit_hold_failed_recovery — a hold was attempted and
  // failed; there's a genuinely open ops alert for it right now. Backs the
  // deposit-hold-failed email/SMS and the Hub's own failed-state banner.
  const openAlert = await findOpenAlert({ bookingId: booking.booking_id, alertType: 'deposit_hold_failed' });
  if (openAlert.found) {
    return buildOkResult(booking, 'deposit_hold_failed_recovery');
  }

  // Reason 2: deposit_hold_not_yet_attempted — a hold genuinely hasn't run
  // yet. depositStatus starts at 'scheduled_t1' at booking time (see
  // adventure-form.js) and only ever moves off it once create-deposit-
  // hold.js actually runs. This mirrors, on purpose, the exact condition
  // adventure-prep-form.js already uses to decide whether to show its own
  // pre-hold deposit note — valid for exactly as long as that note is on
  // screen, no day-count, nothing to pick. Backs the heads-up email and
  // the Hub's pre-hold note link.
  if (!depositStatus || depositStatus === 'scheduled_t1') {
    return buildOkResult(booking, 'deposit_hold_not_yet_attempted');
  }

  // Reason 3 (reserved): staff_requested — for a future staff-initiated
  // flow (e.g. Quick Rebook asking a guest to update a card mid-flow). No
  // caller mints a session under it yet, so there's nothing to check for
  // it here until one exists.

  return { noOpenIssue: true };
}

function buildOkResult(booking, reason) {
  return {
    ok: true,
    reason,
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
