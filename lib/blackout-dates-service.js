/**
 * lib/blackout-dates-service.js
 *
 * NEW (2026-09-09). Postgres I/O for the booking-calendar blackout-dates
 * feature -- letting Airey block the booking flow's date picker on dates
 * he's out of town and can't fulfill gear rental operations. Backs
 * api/manage-blackout-dates.js, same one-service-per-ops-CRUD-page pattern
 * as lib/trails-parks-service.js / lib/gear-service.js.
 *
 * Table shape and the three locked design decisions (exact-date entry,
 * dedicated ops page, conflict-scan-on-create) are documented on
 * db/2026-09-09_add_booking_blackout_dates.sql's own header -- not
 * repeated here.
 */

'use strict';

const { query } = require('./db');
const { genId } = require('./ids');

function toDateStr(v) {
  if (!v) return '';
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}
function toIso(v) {
  if (!v) return '';
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function rowToWire(r) {
  return {
    blackoutId: String(r.blackout_id),
    startDate: toDateStr(r.start_date),
    endDate: toDateStr(r.end_date),
    note: r.note || '',
    createdAt: toIso(r.created_at),
    createdBy: r.created_by || '',
  };
}

async function listBlackoutDates() {
  const rows = await query(`SELECT * FROM booking_blackout_dates ORDER BY start_date DESC`);
  return { blackoutDates: rows.map(rowToWire) };
}

/**
 * Creates a blackout range, then scans experience_bookings for any
 * already-booked, non-cancelled date that now falls inside it -- Airey's
 * confirmed decision that this should never silently strand a booked
 * guest, it should surface immediately as something to resolve (reschedule
 * the guest, or adjust the blackout), the same "never leave it to be found
 * by accident" posture as getParkNameMismatches() in
 * lib/trails-parks-service.js.
 *
 * "Non-cancelled" here means cancelled_at IS NULL -- the same definition
 * lib/all-bookings-service.js's own cancelled bucket uses (booking_status
 * is free-form text with values discovered live, not a safe filter on its
 * own; cancelled_at is the one column every cancellation path actually
 * sets).
 *
 * One ops_alerts row per conflicting booking (not one summary alert) --
 * each conflict has a real booking_id to attach to, so it shows up on that
 * booking's own row in All Bookings and can be resolved individually, same
 * as the existing gear_issue / trail_checkin_missing families. Skips
 * re-raising an alert for a booking that already has an Open
 * booking_blackout_conflict alert, so re-saving/adjusting a range doesn't
 * spam duplicates.
 */
async function createBlackoutDate({ startDate, endDate, note, createdBy }) {
  if (!startDate || !endDate) {
    return { ok: false, error: 'startDate and endDate are required' };
  }
  if (String(endDate) < String(startDate)) {
    return { ok: false, error: 'End date must be on or after the start date' };
  }

  const inserted = await query(
    `INSERT INTO booking_blackout_dates (start_date, end_date, note, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [startDate, endDate, note ? String(note).trim() : null, createdBy || null]
  );
  const blackout = rowToWire(inserted[0]);

  const conflictRows = await query(
    `SELECT booking_id, contact_name, contact_email, date
     FROM experience_bookings
     WHERE date BETWEEN $1 AND $2 AND cancelled_at IS NULL
     ORDER BY date`,
    [startDate, endDate]
  );

  const conflicts = [];
  for (const b of conflictRows) {
    const bookingId = b.booking_id;
    const already = await query(
      `SELECT alert_id FROM ops_alerts
       WHERE booking_id = $1 AND alert_type = 'booking_blackout_conflict' AND status = 'Open'
       LIMIT 1`,
      [bookingId]
    );
    const bookingDate = toDateStr(b.date);
    conflicts.push({
      bookingId,
      contactName: b.contact_name || '',
      contactEmail: b.contact_email || '',
      date: bookingDate,
      alertRaised: !already.length,
    });
    if (already.length) continue; // don't duplicate an already-open conflict alert for the same booking

    const alertNote = `Booked for ${bookingDate}, which falls inside a new blackout window `
      + `(${blackout.startDate} to ${blackout.endDate})${note ? ` — "${String(note).trim()}"` : ''}.`;
    await query(
      `INSERT INTO ops_alerts (alert_id, booking_id, alert_type, status, urgency, notes)
       VALUES ($1, $2, 'booking_blackout_conflict', 'Open', 'standard_24hr', $3)`,
      [genId('ALERT'), bookingId, alertNote]
    );
  }

  return { ok: true, blackout, conflicts };
}

async function deleteBlackoutDate({ blackoutId }) {
  const rows = await query(
    `DELETE FROM booking_blackout_dates WHERE blackout_id = $1 RETURNING blackout_id`,
    [blackoutId]
  );
  if (!rows.length) return { ok: false, error: 'Blackout range not found' };
  return { ok: true, blackoutId: String(blackoutId) };
}

module.exports = {
  listBlackoutDates,
  createBlackoutDate,
  deleteBlackoutDate,
};
