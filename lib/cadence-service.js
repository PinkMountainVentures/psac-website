/**
 * lib/cadence-service.js
 *
 * MIGRATED (2026-08-31, check-adventure-prep-cadence build session): Postgres
 * replacement for apps-script/cadence-actions.gs's four functions —
 * `cadence_listActiveBookings`, `cadence_getBookingContext`,
 * `cadence_recordStageSent`, `cadence_setStallFlags`. Completes Task 9
 * (the other half was api/process-t3-cutoff.js / lib/t3-cutoff-service.js,
 * done in the prior build turn).
 *
 * SCHEMA NOTE — a gap the .gs file's own header calls out is already closed
 * in db/schema.sql, no migration needed this turn:
 *
 * cadence-actions.gs's header says its PASTE-IN patch adds three columns to
 * the Experience Bookings sheet — `adventurePrepStalledFlag`,
 * `phoneFallbackDue`, `cadenceStagesSent` — the last being a homemade
 * comma-joined idempotency marker ("t7,t5,t3") because a flat spreadsheet
 * row has nowhere else to put a set of "which stages already fired" facts.
 * The first two exist as real boolean columns on experience_bookings (and,
 * confusingly, ALSO on adventure_prep — same vestigial duplicate already
 * flagged for t3_cutoff_processed_at in lib/t3-cutoff-service.js's header;
 * this file writes the experience_bookings copies only, for the same reason:
 * that's the table cadence_setStallFlags's real Sheet target maps to, and
 * the one this file's own listActiveBookings/getBookingContext read back).
 *
 * The third — cadenceStagesSent — was NOT ported as a comma-string column.
 * db/schema.sql already has a purpose-built `booking_cadence_log` table
 * (booking_id, stage, sent_at; PRIMARY KEY (booking_id, stage)) sitting
 * unused, exactly the kind of one-row-per-fact table a relational database
 * gives you instead of a delimited string column. Idempotent "record this
 * stage as sent" becomes a plain `INSERT ... ON CONFLICT DO NOTHING` — no
 * read-parse-append-write, no LockService needed at all (this file needs no
 * lock anywhere, unlike the .gs version's two LockService.getScriptLock()
 * calls). This is a genuine improvement the schema already anticipated, not
 * a workaround.
 *
 * Called by: api/check-adventure-prep-cadence.js (all four).
 */

'use strict';

const { sql, query } = require('./db');

/**
 * Postgres equivalent of cadence_listActiveBookings. No date filtering here
 * — same as the .gs version, every active booking is a candidate, and
 * lib/cadence.js's determineCadenceStage (untouched by this migration)
 * decides per-booking whether today is one of its marks.
 */
async function listActiveBookings() {
  const rows = await sql`
    SELECT booking_id, date, created_at
    FROM experience_bookings
    WHERE (booking_status = 'active' OR booking_status IS NULL)
  `;
  return {
    bookings: rows.map((r) => ({
      bookingId: r.booking_id,
      // Same defensive instanceof-Date check already applied in
      // lib/t3-cutoff-service.js and lib/cancel-refund-service.js: a `date`
      // column can come back as a JS Date object from the local pg driver,
      // and lib/cadence.js's determineCadenceStage regex-matches tripDate
      // against /^\d{4}-\d{2}-\d{2}/, which a raw Date's default toString()
      // does not satisfy.
      tripDate: r.date ? (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date)) : '',
      // createdAt is only ever passed to `new Date(...)` by the caller
      // (never regex-matched), and `new Date()` accepts a Date object
      // directly — no equivalent bug possible here, but normalized to an
      // ISO string anyway for a predictable shape leaving this module.
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    })),
  };
}

/**
 * Postgres equivalent of cadence_getBookingContext. waiverTrack computed
 * identically to lib/t3-cutoff-service.js's getProcessingContext (same
 * zero/partial/complete tri-state, same underlying signals) — intentionally
 * not re-derived differently here, matching the .gs version's own comment
 * that this must match t3Cutoff_getProcessingContext's logic exactly.
 */
async function getBookingContext(bookingId) {
  const rows = await sql`
    SELECT eb.booking_id, eb.date, eb.created_at, eb.contact_email, eb.contact_name, eb.contact_phone,
           eb.sms_consent, eb.adventure_prep_token, eb.adventure_prep_stalled_flag, eb.phone_fallback_due,
           ap.booking_id AS ap_booking_id, ap.assigned_at, ap.delivery_address_line1, ap.delivery_address_raw,
           ap.all_waivers_complete
    FROM experience_bookings eb
    LEFT JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
    WHERE eb.booking_id = ${bookingId}
  `;
  if (!rows.length) return { notFound: true };
  const r = rows[0];

  const signedRows = await sql`
    SELECT 1 FROM waiver_signatures WHERE booking_id = ${bookingId} AND status = 'signed' LIMIT 1
  `;
  const anySigned = signedRows.length > 0;
  const waiverTrack = r.all_waivers_complete === true ? 'complete' : (anySigned ? 'partial' : 'zero');

  const hasAddress = !!(r.ap_booking_id !== null && (r.delivery_address_line1 || r.delivery_address_raw));

  const stageRows = await sql`
    SELECT stage FROM booking_cadence_log WHERE booking_id = ${bookingId}
  `;

  return {
    bookingId: r.booking_id,
    tripDate: r.date ? (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date)) : '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    contactEmail: r.contact_email,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    smsConsent: r.sms_consent === true,
    adventurePrepToken: r.adventure_prep_token,
    assignedAt: r.assigned_at ? new Date(r.assigned_at).toISOString() : '',
    waiverTrack,
    hasAddress,
    adventurePrepStalledFlag: r.adventure_prep_stalled_flag === true,
    phoneFallbackDue: r.phone_fallback_due === true,
    // Array, not a comma-string — see this file's header. Caller checks
    // membership with .includes(stage) instead of split(',').indexOf(stage).
    cadenceStagesSent: stageRows.map((sr) => sr.stage),
  };
}

/**
 * Postgres equivalent of cadence_recordStageSent. A single atomic
 * INSERT ... ON CONFLICT DO NOTHING against the (booking_id, stage)
 * composite primary key IS the idempotency guarantee — no lock, no
 * read-then-append, no possibility of the same stage landing twice even
 * under a genuinely concurrent retry.
 */
async function recordStageSent(bookingId, stage) {
  const rows = await query(
    `INSERT INTO booking_cadence_log (booking_id, stage) VALUES ($1, $2)
     ON CONFLICT (booking_id, stage) DO NOTHING
     RETURNING stage`,
    [bookingId, stage]
  );
  return { ok: true, alreadyRecorded: rows.length === 0 };
}

/**
 * Postgres equivalent of cadence_setStallFlags. Single atomic UPDATE,
 * COALESCE-guarded exactly like lib/cancel-refund-service.js's
 * writeCancellation: a field left `undefined` by the caller passes SQL NULL
 * through to COALESCE and leaves the column untouched; an explicit `true`
 * or `false` writes through (COALESCE only treats NULL as "missing" — a
 * literal `false` param is never mistaken for "not provided"). Replaces the
 * .gs version's LockService.getScriptLock()-wrapped read-then-write.
 */
async function setStallFlags({ bookingId, adventurePrepStalledFlag, phoneFallbackDue }) {
  const rows = await query(
    `UPDATE experience_bookings
     SET adventure_prep_stalled_flag = COALESCE($2::boolean, adventure_prep_stalled_flag),
         phone_fallback_due = COALESCE($3::boolean, phone_fallback_due)
     WHERE booking_id = $1
     RETURNING booking_id`,
    [
      bookingId,
      adventurePrepStalledFlag !== undefined ? !!adventurePrepStalledFlag : null,
      phoneFallbackDue !== undefined ? !!phoneFallbackDue : null,
    ]
  );
  if (!rows.length) return { ok: false, error: 'Booking not found' };
  return { ok: true };
}

/**
 * NEW (2026-08-31, Task 8 ops-proxy migration): apps-script/ops-redesign-
 * round2-actions.gs's manualAdjustment_trailDayChange clears the sheet's
 * `cadenceStagesSent` comma-string to '' whenever a staffer manually moves a
 * booking's trip date, so the stall-detection cadence re-evaluates cleanly
 * against the new date instead of thinking stages already fired for the old
 * one. This file's Postgres equivalent of that marker is one-row-per-fact
 * (see this file's header) -- "clear it" is a plain DELETE, no lock needed,
 * same reasoning as recordStageSent's INSERT ... ON CONFLICT above. Not part
 * of the original four cadence-actions.gs functions; added here rather than
 * in the new lib/manual-adjustment-service.js because it's cadence-log
 * table ownership, consistent with this file owning every other read/write
 * of booking_cadence_log.
 */
async function clearCadenceStagesSent(bookingId) {
  await query(`DELETE FROM booking_cadence_log WHERE booking_id = $1`, [bookingId]);
  return { ok: true };
}

module.exports = {
  listActiveBookings,
  getBookingContext,
  recordStageSent,
  setStallFlags,
  clearCadenceStagesSent,
};
