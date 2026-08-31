'use strict';

const { sql } = require('./db');
const { getTrailSafetyOptions, computeGroupCeilings, toDate } = require('./trail-selection-engine');
const { normalizeTrailRow, normalizeParkAccessRow, AGE_BUCKET_LABELS } = require('./run-trail-assignment');

/**
 * lib/trail-safety-options-service.js
 *
 * MIGRATED (Task 18, 2026-08-31): Postgres I/O for api/trail-safety-
 * options.js — Operations UX's per-booking "which trails could this guest
 * be swapped onto" dropdown (Operations UX PRD Section 7, Section 13).
 * lib/trail-selection-engine.js's getTrailSafetyOptions/computeGroupCeilings/
 * toDate are UNCHANGED, pure functions (no I/O) — this file only builds the
 * same booking-context shape lib/run-trail-assignment.js's
 * runTrailAssignmentForBooking already builds and tests for the same
 * engine, reusing its exact normalizeTrailRow/normalizeParkAccessRow/
 * AGE_BUCKET_LABELS rather than a second, potentially-drifting copy — this
 * file's own original header explicitly warned against building that ctx
 * any other way.
 *
 * Roster comes from booking_participants (attending rows only) — no
 * fullPayloadJson/reconfirmedRosterJson fallback needed, same reasoning
 * already applied throughout this migration (Finding #29): this schema's
 * booking_participants table is a complete, always-current roster on its
 * own.
 */
async function getSafetyOptionsForBooking({ bookingId }) {
  const bookingRows = await sql`SELECT booking_id, date, intake_json FROM experience_bookings WHERE booking_id = ${bookingId}`;
  if (!bookingRows.length) return { notFound: true };
  const booking = bookingRows[0];

  const apRows = await sql`SELECT * FROM adventure_prep WHERE booking_id = ${bookingId}`;
  const ap = apRows[0];

  const participantRows = await sql`
    SELECT display_name, age_bucket, fitness_level
    FROM booking_participants
    WHERE experience_booking_id = ${bookingId} AND is_participating = true
    ORDER BY roster_index
  `;

  // Same "missing_1_2a_inputs" content check as runTrailAssignmentForBooking
  // (lib/run-trail-assignment.js) — a row existing on adventure_prep isn't
  // itself a signal that 1.2a's roster/technical-comfort inputs are done.
  if (!ap || ap.technical_comfort == null || participantRows.length === 0) {
    return { missingInputs: true };
  }

  const [trailRows, parkAccessRows] = await Promise.all([
    sql`SELECT * FROM trails`,
    sql`SELECT * FROM park_access`,
  ]);

  // Fail loudly rather than silently treat an empty result as "zero trails
  // qualify" — same posture as lib/run-trail-assignment.js and the .gs
  // version's own documented Apps-Script-error-swallowing bug fix.
  if (!trailRows.length) {
    throw new Error('getSafetyOptionsForBooking: trails table returned zero rows — seed data missing or DATABASE_URL points at the wrong database');
  }
  if (!parkAccessRows.length) {
    throw new Error('getSafetyOptionsForBooking: park_access table returned zero rows — seed data missing or DATABASE_URL points at the wrong database');
  }

  const trails = trailRows.map(normalizeTrailRow);
  const parkAccess = parkAccessRows.map(normalizeParkAccessRow);
  const roster = participantRows.map((p) => ({
    name: p.display_name,
    ageRange: AGE_BUCKET_LABELS[p.age_bucket] || null,
    fitness: p.fitness_level,
  }));

  const intake = booking.intake_json || {};
  const groupCeilings = computeGroupCeilings(roster, ap.technical_comfort);
  const safetyCtx = {
    roster,
    groupCeilings,
    bestForAttributes: ap.best_for_attributes || [],
    heatComfort: ap.heat_comfort,
    duration: intake.q6_duration || null,
    activityType: intake.q5_activity || null,
  };
  const referenceDate = toDate(booking.date);

  const options = getTrailSafetyOptions(safetyCtx, trails, parkAccess, referenceDate);
  return { options };
}

module.exports = { getSafetyOptionsForBooking };
