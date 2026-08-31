/**
 * lib/cancel-refund-service.js
 *
 * MIGRATED (2026-08-31, cancel-and-refund-booking build session): Postgres
 * replacement for apps-script/cancel-refund-actions.gs's two functions —
 * `cancelRefund_getBookingContext` and `cancelRefund_writeCancellation`.
 * Both are new to this file; nothing about this pair had a Postgres
 * equivalent yet in lib/gear-service.js or lib/booking-service.js (unlike
 * the deposit-hold engine, where 4 of 6 needed backend functions already
 * existed). `api/cancel-and-refund-booking.js`'s Ops Alert calls (the OTHER
 * three callBookingsWebApp calls in that file) reuse lib/gear-service.js's
 * already-exported `recordOpsAlert` directly instead — this file only owns
 * what genuinely didn't exist yet.
 *
 * Called by: api/cancel-and-refund-booking.js (both).
 */

'use strict';

const { sql, query } = require('./db');
const { genId } = require('./ids');

/**
 * Postgres equivalent of cancelRefund_getBookingContext. Server-to-server
 * lookup by bookingId (no adventurePrepToken involved) — this endpoint is
 * only ever called from another server-side job, never a guest browser.
 *
 * bookingStatus defaults to 'active' when blank/null, matching the .gs
 * version's own default (and adventurePrep_getContextByToken's identical
 * convention elsewhere in this codebase) — a booking that predates the
 * bookingStatus column existing reads as active, not as some falsy value a
 * caller might mishandle.
 */
async function getBookingContext(bookingId) {
  const rows = await sql`
    SELECT booking_id, contact_email, contact_name, date, main_payment_intent_id,
           booking_status, deposit_payment_intent_id, deposit_status
    FROM experience_bookings
    WHERE booking_id = ${bookingId}
  `;
  if (!rows.length) return { notFound: true };
  const r = rows[0];
  return {
    bookingId: r.booking_id,
    contactEmail: r.contact_email,
    contactName: r.contact_name,
    // BUG FIX (2026-08-31, process-t3-cutoff build session): caught while
    // building lib/t3-cutoff-service.js's own tripDate field the same way
    // — a plain `String(r.date)` on a `date`-typed column doesn't produce
    // 'YYYY-MM-DD' when the driver hands back a JS Date object (confirmed
    // against the local pg-based test driver; Neon's actual behavior here
    // is unconfirmed, see lib/db.js's header). Currently inert here
    // specifically — nothing in api/cancel-and-refund-booking.js reads
    // ctx.tripDate today — but fixed anyway for correctness and to match
    // the defensive instanceof-check lib/gear-service.js's own date
    // formatting already uses for this exact ambiguity.
    tripDate: r.date ? (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date)) : '',
    mainPaymentIntentId: r.main_payment_intent_id,
    bookingStatus: r.booking_status || 'active',
    depositPaymentIntentId: r.deposit_payment_intent_id || '',
    depositStatus: r.deposit_status || '',
  };
}

async function appendAuditLog(entry) {
  await query(
    `INSERT INTO audit_log (
       audit_id, booking_id, change_type, before_t3_cutoff, old_value_json,
       new_value_json, delta, refund_or_charge_amount, stripe_transaction_id, staff_notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      genId('AUDIT'), entry.bookingId, entry.changeType, !!entry.beforeT3Cutoff,
      entry.oldValueJson != null ? JSON.stringify(entry.oldValueJson) : null,
      entry.newValueJson != null ? JSON.stringify(entry.newValueJson) : null,
      entry.delta != null ? entry.delta : null, entry.refundOrChargeAmount != null ? entry.refundOrChargeAmount : null,
      entry.stripeTransactionId || '', entry.staffNotes || '',
    ]
  );
}

/**
 * Postgres equivalent of cancelRefund_writeCancellation: the one atomic
 * write PRD Section 5 describes — bookingStatus/cancelledAt/refundId/
 * refundAmount/cancellationReasons, PLUS (folded into this same call,
 * exactly like the .gs version) an optional deposit-hold-release write,
 * plus a single `changeType: 'cancellation'` audit_log row. A single
 * Postgres UPDATE is already atomic (matches this codebase's existing
 * CAS-single-UPDATE convention, replacing the .gs version's
 * LockService.getScriptLock()) — no transaction() needed since this is one
 * statement, not several.
 *
 * The deposit fields (depositStatus/depositReconciledAt/
 * depositReconciledAmountCents) are genuinely optional per call — on every
 * cancellation with no live hold to release (the normal T-3 gates), the
 * caller passes them as undefined and this must leave those columns
 * completely untouched, not null them out. COALESCE against the row's own
 * current value (rather than the .gs version's per-field `if
 * (payload.x !== undefined) set(...)` skip) gets the same "untouched when
 * not part of this call" behavior in one statement.
 */
async function writeCancellation({
  bookingId, bookingStatus, cancelledAt, refundId, refundAmount, cancellationReasons,
  beforeT3Cutoff, staffNotes, depositStatus, depositReconciledAt, depositReconciledAmountCents,
  depositHoldPaymentIntentId,
}) {
  const rows = await query(
    `UPDATE experience_bookings
     SET booking_status = $2,
         cancelled_at = $3,
         refund_id = $4,
         refund_amount = $5,
         cancellation_reasons = $6,
         deposit_status = COALESCE($7::deposit_status_t, deposit_status),
         reconciled_at = COALESCE($8::timestamptz, reconciled_at),
         reconciled_amount_cents = COALESCE($9::integer, reconciled_amount_cents)
     WHERE booking_id = $1
     RETURNING booking_id`,
    [
      bookingId, bookingStatus || null, cancelledAt || null, refundId || null,
      refundAmount != null ? refundAmount : null, cancellationReasons || null,
      depositStatus != null ? depositStatus : null,
      depositReconciledAt != null ? depositReconciledAt : null,
      depositReconciledAmountCents != null ? depositReconciledAmountCents : null,
    ]
  );
  if (!rows.length) return { ok: false, error: 'Booking not found' };

  await appendAuditLog({
    bookingId,
    changeType: 'cancellation',
    beforeT3Cutoff: !!beforeT3Cutoff,
    newValueJson: {
      bookingStatus, refundId, refundAmount, cancellationReasons,
      depositStatus, depositHoldPaymentIntentId: depositHoldPaymentIntentId || '',
    },
    refundOrChargeAmount: refundAmount,
    stripeTransactionId: refundId,
    staffNotes: (staffNotes || '') + (depositHoldPaymentIntentId
      ? ' Deposit hold ' + depositHoldPaymentIntentId + ' released as part of this cancellation.'
      : ''),
  });

  return { ok: true };
}

module.exports = {
  getBookingContext,
  writeCancellation,
};
