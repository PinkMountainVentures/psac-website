/**
 * lib/hold-clearance-service.js
 *
 * MIGRATED (2026-08-31, deposit-hold engine build session): Postgres
 * replacement for apps-script/hold-clearance-actions.gs's two functions —
 * `holdClearance_listBookingsForTripDate` and `holdClearance_findOpenDepositAlert`
 * (the second of which already has a Postgres equivalent, `findOpenAlert`,
 * in lib/gear-service.js — reused directly rather than duplicated; see that
 * file's own header for why it's generalized past its original
 * hold-clearance-only name). This file only needed to add the one function
 * that didn't already have a Postgres equivalent, plus `opsAlerts_resolveAlert`
 * (apps-script/ops-alerts-actions.gs), which api/check-hold-clearance-
 * deadline.js is the first Postgres-side caller of.
 *
 * Called by: api/trigger-deposit-holds.js, api/check-hold-clearance-
 * deadline.js (both `listBookingsForTripDate`); api/check-hold-clearance-
 * deadline.js (`resolveAlert`).
 */

'use strict';

const { query } = require('./db');

/**
 * Postgres equivalent of holdClearance_listBookingsForTripDate. Every
 * booking whose trip date is exactly `tripDate` and whose bookingStatus
 * reads as active (matching the .gs version's own `r.bookingStatus ||
 * 'active'` default-to-active-when-blank logic), with the fields both
 * callers need: depositStatus/depositPaymentIntentId/tier so each can
 * re-verify a stale-looking status before acting on it (High #24 / Medium
 * #43 in api/check-hold-clearance-deadline.js), and contactEmail/
 * contactName/adventurePrepToken so api/trigger-deposit-holds.js can build
 * its guest-facing "update payment method" link without a second round
 * trip.
 *
 * BUG FIX (2026-08-31, deposit-hold engine build session): the .gs version
 * this replaces never actually returned a `tripDate` field, even though
 * api/trigger-deposit-holds.js's own processOneBooking reads
 * `booking.tripDate` to fill in the guest-facing failure email's "your
 * gear hold for [date] didn't go through" line — a pre-existing gap (not
 * introduced by this migration) that silently fell back to
 * formatTripDate's own `!isoDateStr -> 'today'` default, always showing
 * "today" instead of the guest's actual trip date. The caller already has
 * `tripDate` in scope (it's the query's own filter value), so this is a
 * free fix: return it on every row instead of leaving that field
 * perpetually undefined.
 */
async function listBookingsForTripDate({ tripDate }) {
  const rows = await query(
    `SELECT booking_id, deposit_status, contact_email, contact_name,
            adventure_prep_token, deposit_payment_intent_id, tier
     FROM experience_bookings
     WHERE date = $1
       AND (booking_status = 'active' OR booking_status IS NULL)`,
    [tripDate]
  );
  return {
    bookings: rows.map((r) => ({
      bookingId: r.booking_id,
      tripDate,
      depositStatus: r.deposit_status || '',
      contactEmail: r.contact_email,
      contactName: r.contact_name,
      adventurePrepToken: r.adventure_prep_token || '',
      depositPaymentIntentId: r.deposit_payment_intent_id || '',
      tier: r.tier || '',
    })),
  };
}

/**
 * Postgres equivalent of opsAlerts_resolveAlert. `notes` is overwritten
 * entirely, not appended — matches the .gs version's own comment ("a
 * double-submit from a slow UI click is the only realistic repeat case,
 * and overwriting harmlessly is preferable to a confusing error for
 * staff").
 */
async function resolveAlert({ alertId, resolvedBy, notes }) {
  const rows = await query(
    `UPDATE ops_alerts
     SET status = 'Resolved', resolved_at = NOW(), resolved_by = $2, notes = $3
     WHERE alert_id = $1
     RETURNING alert_id`,
    [alertId, resolvedBy || '', notes || '']
  );
  if (!rows.length) return { ok: false, error: 'Alert not found' };
  return { ok: true, alertId };
}

module.exports = {
  listBookingsForTripDate,
  resolveAlert,
};
