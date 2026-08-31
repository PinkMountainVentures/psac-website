/**
 * lib/t3-cutoff-service.js
 *
 * MIGRATED (2026-08-31, process-t3-cutoff build session): Postgres
 * replacement for apps-script/t3-cutoff-actions.gs's six functions —
 * `t3Cutoff_listActiveBookings`, `t3Cutoff_getProcessingContext`,
 * `t3Cutoff_markProcessed`, `t3Cutoff_removeUncoveredKit`,
 * `t3Cutoff_writeRideWithGpsAccess`, `t3Cutoff_acquireRunLock` /
 * `t3Cutoff_releaseRunLock`. `api/process-t3-cutoff.js`'s three
 * `opsAlerts_recordAlert` calls reuse lib/gear-service.js's already-
 * exported `recordOpsAlert` directly instead — no new alert primitive
 * needed here, same pattern as the deposit-hold and cancel-refund builds.
 *
 * FIXED (2026-08-31, roster/gear-kit ID-link fix — was previously flagged
 * here as an open gap, not fixed in the original process-t3-cutoff build):
 * the .gs version's `t3Cutoff_getProcessingContext` returned
 * `reconfirmedRosterJson` (a JSON blob of roster entries, each carrying
 * `rosterRef`/`gearKit`/`name`), and `api/process-t3-cutoff.js`'s own
 * `findUncoveredRosterMembers` parsed that JSON to decide which roster
 * members have a personal kit lacking a signed waiver — matching primarily
 * by `rosterRef`, falling back to name only as a defensive backstop.
 * Postgres has no equivalent JSON blob — roster is real
 * `booking_participants` rows — and until this fix, neither
 * `booking_participants.gear_kit` nor `gear_check_log.participant_id` was
 * ever actually written by `lib/booking-service.js`, so this file's
 * `listUncoveredKitPersonNames` (now `listUncoveredKitParticipants`) had no
 * choice but to match by the denormalized `person_name` string alone —
 * exactly the name-collision risk the .gs version's own comment already
 * flagged. `lib/booking-service.js` (both the booking_participants and
 * gear_check_log INSERTs) and `lib/finalize-kit-change.js` (the
 * post-booking kit-add path) now both write `participant_id` for real, so
 * `listUncoveredKitParticipants` below joins on it directly — an exact ID
 * match, not a name guess — and `removeUncoveredKit` deletes by that same
 * ID. A `NULL` participant_id (a row that predates this fix; should not
 * occur for any booking/kit-add created after it) falls back to the old
 * name-matched behavior, kept as a narrow safety net rather than the
 * primary path.
 *
 * Called by: api/process-t3-cutoff.js (all).
 */

'use strict';

const { sql, query } = require('./db');
const { genId } = require('./ids');

const T3_CUTOFF_RUN_LOCK_STALE_MS = 10 * 60 * 1000; // 10 min — generous vs. this cron's own ~15-min tick cadence

/**
 * Postgres equivalent of t3Cutoff_listActiveBookings. bookingStatus reads
 * as active when blank/null, matching the .gs version's own default.
 */
async function listActiveBookings() {
  const rows = await sql`
    SELECT booking_id, date
    FROM experience_bookings
    WHERE (booking_status = 'active' OR booking_status IS NULL)
      AND t3_cutoff_processed_at IS NULL
  `;
  // BUG FIX (2026-08-31, process-t3-cutoff build session): caught by
  // testing, not inspection — a plain `String(r.date)` on a `date`-typed
  // column comes back as "Tue Sep 01 2026 00:00:00 GMT+0000 (...)" against
  // the local pg-based test driver (a JS Date object's default string
  // coercion), NOT 'YYYY-MM-DD'. The caller here, api/process-t3-cutoff.js,
  // feeds this straight into lib/t3-cutoff.js's isBeforeT3Cutoff, whose
  // regex only matches a real 'YYYY-MM-DD' prefix — a non-matching string
  // makes it "fail open" (treated as NOT yet due), silently excluding
  // every booking from this cron's candidate list forever. Whether Neon's
  // HTTP driver returns dates as JS Date objects or as strings in
  // production is unconfirmed (this codebase's own established uncertainty
  // — see lib/db.js's header), so this uses the same defensive
  // instanceof-check lib/gear-service.js's own date-formatting code
  // already adopted for exactly this ambiguity, rather than assuming
  // either shape.
  return {
    bookings: rows.map((r) => ({
      bookingId: r.booking_id,
      tripDate: r.date ? (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date)) : '',
    })),
  };
}

/**
 * Distinct person names with a still-unclaimed, per-person gear kit
 * (kit_number IS NOT NULL excludes shared-duffel rows, which have no
 * per-person waiver requirement) who lack a signed waiver on this booking.
 *
 * BUG FIX (2026-08-31, roster/gear-kit ID-link fix): renamed from
 * listUncoveredKitPersonNames, now returns {participantId, personName}
 * pairs and joins by participant_id, not just person_name — see this
 * file's header. "Covered" for a given kit's participant means EITHER (a)
 * that participant has their own signed waiver_signatures row (the normal
 * adult-attendee/owner case), OR (b) that participant is a minor whose
 * guardian has certified them (booking_participants.guardian_verified_at
 * IS NOT NULL — set by lib/waiver-service.js's applyGuardianCertification,
 * since a minor never signs their own waiver). The LEFT JOIN + COALESCE
 * guards against a NULL-participant_id row (should not occur post-fix, but
 * would otherwise make the whole WHERE clause evaluate to SQL NULL and
 * silently drop that row from the result instead of correctly flagging it
 * as uncovered) — and the waiver-signed check falls back to the OLD
 * name-matched comparison only for that same NULL-participant_id case, a
 * narrow safety net rather than the primary path.
 */
async function listUncoveredKitParticipants(bookingId) {
  const rows = await query(
    `SELECT DISTINCT gcl.participant_id, gcl.person_name
     FROM gear_check_log gcl
     LEFT JOIN booking_participants bp ON bp.participant_id = gcl.participant_id
     WHERE gcl.booking_id = $1
       AND gcl.checked_out_at IS NULL
       AND gcl.kit_number IS NOT NULL
       AND COALESCE(bp.guardian_verified_at IS NOT NULL, false) = false
       AND NOT EXISTS (
         SELECT 1 FROM waiver_signatures ws
         WHERE ws.booking_id = $1 AND ws.status = 'signed'
           AND (
             (gcl.participant_id IS NOT NULL AND ws.participant_id = gcl.participant_id)
             OR (gcl.participant_id IS NULL AND ws.signer_name = gcl.person_name)
           )
       )`,
    [bookingId]
  );
  return rows
    .map((r) => ({ participantId: r.participant_id || null, personName: r.person_name }))
    .filter((r) => r.participantId || r.personName);
}

/**
 * Postgres equivalent of t3Cutoff_getProcessingContext. waiverTrack
 * matches the .gs version's own three-state logic exactly (zero/partial/
 * complete), computed from the same underlying signal
 * (adventure_prep.all_waivers_complete, and whether any waiver_signatures
 * row for this booking has status='signed') rather than re-deriving
 * "who's required" independently.
 */
async function getProcessingContext(bookingId) {
  const rows = await sql`
    SELECT eb.booking_id, eb.booking_status, eb.date, eb.contact_email, eb.contact_name, eb.gear_kit_count,
           ap.booking_id AS ap_booking_id, ap.assigned_at, ap.delivery_address_line1, ap.delivery_address_raw,
           ap.pending_kit_count, ap.confirmed_kit_count, ap.selected_trail_id, ap.ride_with_gps_experience_access,
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

  // ap_booking_id is the LEFT JOIN's own existence marker — NULL iff no
  // adventure_prep row exists yet for this booking, distinguishing that
  // case from "a row exists but confirmed_kit_count itself happens to be
  // blank," which the .gs version's own ternary (`ap ? ap.confirmedKitCount
  // : booking.gearKitCount`) does NOT fall back on.
  const hasAdventurePrepRow = r.ap_booking_id !== null;

  return {
    bookingId: r.booking_id,
    bookingStatus: r.booking_status || 'active',
    tripDate: r.date ? (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date)) : '',
    contactEmail: r.contact_email,
    contactName: r.contact_name,
    assignedAt: r.assigned_at ? new Date(r.assigned_at).toISOString() : '',
    waiverTrack,
    deliveryAddressLine1: r.delivery_address_line1 || '',
    deliveryAddressRaw: r.delivery_address_raw || '',
    pendingKitCount: r.pending_kit_count != null ? r.pending_kit_count : '',
    confirmedKitCount: hasAdventurePrepRow && r.confirmed_kit_count != null ? r.confirmed_kit_count : r.gear_kit_count,
    selectedTrailId: r.selected_trail_id || '',
    rideWithGpsExperienceAccess: r.ride_with_gps_experience_access || '',
    // Replaces the .gs version's reconfirmedRosterJson + waiverRows pair —
    // see this file's header. Only meaningful (and only read by the
    // caller) when waiverTrack === 'partial'; computed unconditionally
    // here anyway, matching the .gs context's own always-populate shape.
    uncoveredKitParticipants: await listUncoveredKitParticipants(bookingId),
  };
}

/**
 * Postgres equivalent of t3Cutoff_markProcessed. Writes
 * experience_bookings.t3_cutoff_processed_at — the same column
 * t3Cutoff_listActiveBookings itself filters on — NOT
 * adventure_prep.t3_cutoff_processed_at, a same-named column that also
 * exists on that table but isn't the one the .gs source's own candidate
 * list reads (a pre-existing, apparently vestigial duplicate; left alone,
 * not this subsystem's to clean up).
 */
async function markProcessed(bookingId) {
  const rows = await query(
    `UPDATE experience_bookings SET t3_cutoff_processed_at = NOW() WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId]
  );
  if (!rows.length) return { ok: false, error: 'Booking not found' };
  return { ok: true };
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
 * Postgres equivalent of t3Cutoff_removeUncoveredKit. Deletes every
 * still-unclaimed gear_check_log row for this person on this booking,
 * decrements adventure_prep.confirmed_kit_count by exactly one (floored at
 * 0), and appends a `changeType: 'kit_count'` audit_log row — matching the
 * BUG FIX already documented in the .gs version: a genuine no-op (no
 * decrement, no audit-log row) when nothing is left to remove, so a cron
 * retry after a mid-sequence failure can't double-decrement a kit that a
 * previous tick already removed.
 *
 * The decrement UPDATE derives its own "old" value as new+1 rather than a
 * separate SELECT beforehand — a single atomic UPDATE...RETURNING is
 * already race-free (matches this codebase's CAS-single-UPDATE
 * convention), where a read-then-write two-step would open a window a
 * concurrent kit-count change could land in between.
 *
 * BUG FIX (2026-08-31, roster/gear-kit ID-link fix): now deletes by
 * participant_id when the caller has one (the normal case, post-fix) —
 * an exact match, immune to the name-collision risk of matching by
 * person_name alone in a group booking with two same-named attendees.
 * Falls back to the old person_name match, scoped to rows with a NULL
 * participant_id, ONLY when no participantId is given — this scoping
 * means the fallback can never accidentally delete a different,
 * properly-ID'd participant's kit just because it shares a display name.
 */
async function removeUncoveredKit({ bookingId, participantId, personName }) {
  const deleted = participantId
    ? await query(
        `DELETE FROM gear_check_log
         WHERE booking_id = $1 AND participant_id = $2 AND checked_out_at IS NULL
         RETURNING item_row_id`,
        [bookingId, participantId]
      )
    : await query(
        `DELETE FROM gear_check_log
         WHERE booking_id = $1 AND person_name = $2 AND participant_id IS NULL AND checked_out_at IS NULL
         RETURNING item_row_id`,
        [bookingId, personName]
      );
  if (!deleted.length) {
    return { ok: true, removedRowCount: 0, alreadyRemoved: true };
  }

  const updated = await query(
    `UPDATE adventure_prep
     SET confirmed_kit_count = GREATEST(0, COALESCE(confirmed_kit_count, 0) - 1)
     WHERE booking_id = $1
     RETURNING confirmed_kit_count`,
    [bookingId]
  );
  const newConfirmed = updated.length ? updated[0].confirmed_kit_count : 0;
  const oldConfirmed = newConfirmed + 1; // exact: we just confirmed a row existed to remove, so the decrement genuinely happened (floor at 0 only affects an already-0 count, which never reaches here since a deletable row implies a kit was still assigned).

  await appendAuditLog({
    bookingId,
    changeType: 'kit_count',
    beforeT3Cutoff: false,
    oldValueJson: { confirmedKitCount: oldConfirmed },
    newValueJson: { confirmedKitCount: newConfirmed },
    delta: -1,
    staffNotes: 'kit removed T-3, unsigned waiver (' + personName + ')',
  });

  return { ok: true, removedRowCount: deleted.length, newConfirmedKitCount: newConfirmed };
}

/**
 * Postgres equivalent of t3Cutoff_writeRideWithGpsAccess. Still a
 * PLACEHOLDER, not a real RideWithGPS integration — see this subsystem's
 * source .gs file for why (no confirmed API surface to build against).
 */
async function writeRideWithGpsAccess({ bookingId, trailId }) {
  const placeholder = 'PENDING_REAL_INTEGRATION:' + trailId + ':' + new Date().toISOString();
  const rows = await query(
    `UPDATE adventure_prep SET ride_with_gps_experience_access = $2 WHERE booking_id = $1 RETURNING ride_with_gps_experience_access`,
    [bookingId, placeholder]
  );
  if (!rows.length) return { ok: false, error: 'Adventure Prep row not found — run confirmRoster/selectTrail first' };
  return { ok: true, rideWithGpsExperienceAccess: placeholder, isPlaceholder: true };
}

/**
 * Postgres equivalent of t3Cutoff_acquireRunLock/t3Cutoff_releaseRunLock,
 * against the `job_locks` table (db/schema.sql's own "Section 8.5 —
 * replaces PropertiesService run-lock", built for exactly this and unused
 * until now). One INSERT ... ON CONFLICT ... WHERE — a single atomic
 * statement replaces the .gs version's LockService-wrapped read-then-write
 * against PropertiesService, same CAS convention as every other lock/guard
 * built in this migration. The WHERE clause on the DO UPDATE branch is
 * what makes this a real mutex: it only fires (and only then does
 * RETURNING produce a row) when the existing lock is either absent
 * (NULL locked_at) or older than staleMs — a lock held by a still-running
 * previous tick makes the WHERE false, the UPDATE a no-op, and RETURNING
 * empty, exactly like the .gs version's own "still running" branch.
 */
async function acquireRunLock(jobName, lockedBy, staleMs) {
  const stale = staleMs != null ? staleMs : T3_CUTOFF_RUN_LOCK_STALE_MS;
  const rows = await query(
    `INSERT INTO job_locks (job_name, locked_at, locked_by)
     VALUES ($1, NOW(), $2)
     ON CONFLICT (job_name) DO UPDATE
       SET locked_at = NOW(), locked_by = $2
       WHERE job_locks.locked_at IS NULL
          OR job_locks.locked_at < NOW() - ($3 || ' milliseconds')::interval
     RETURNING job_name, locked_at`,
    [jobName, lockedBy || '', stale]
  );
  if (!rows.length) {
    const existing = await query(`SELECT locked_at FROM job_locks WHERE job_name = $1`, [jobName]);
    const lockAgeMs = existing.length && existing[0].locked_at
      ? Date.now() - new Date(existing[0].locked_at).getTime()
      : null;
    return { ok: false, reason: 'run_in_progress', lockAgeMs };
  }
  return { ok: true };
}

async function releaseRunLock(jobName) {
  await query(`UPDATE job_locks SET locked_at = NULL, locked_by = NULL WHERE job_name = $1`, [jobName]);
  return { ok: true };
}

module.exports = {
  listActiveBookings,
  getProcessingContext,
  markProcessed,
  removeUncoveredKit,
  writeRideWithGpsAccess,
  acquireRunLock,
  releaseRunLock,
  T3_CUTOFF_RUN_LOCK_STALE_MS,
};
