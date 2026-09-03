'use strict';

const { sql } = require('./db');
const { normalizeTrailRow, normalizeParkAccessRow } = require('./run-trail-assignment');
const { isAnyBookableTrailOpen } = require('./trail-selection-engine');

/**
 * lib/booking-open-days-service.js
 *
 * NEW (2026-09-03). Postgres I/O backing api/booking-open-days.js — the
 * booking flow's date picker needs to know which days it can actually let
 * a guest pick, per the build checklist's long-open P0 item: "Date picker:
 * restrict to open days only ... an 'open day' is defined generically by
 * whichever trail's hours/days apply, not hardcoded to Agua Caliente."
 *
 * A day only makes sense to offer if AT LEAST ONE currently-bookable
 * trail's park is actually open that day — otherwise Trail Selection's
 * Tier A pool comes back empty for every candidate at assignment time,
 * with nowhere to send the guest. This is why the decision lives in
 * lib/trail-selection-engine.js's own isAnyBookableTrailOpen /
 * checkParkDateAvailability (also used by checkTrailSafety and
 * getTrailSafetyOptions) rather than a second copy here — the exact
 * concern this project has flagged repeatedly (duplicated source-of-truth
 * logic silently drifting apart, e.g. the Batch 12 ITEM_COSTS/
 * GEAR_ITEM_TYPE_CONFIG consistency tripwire). This file is I/O only: load
 * the bookable trails + Park Access rows, hand them to the pure engine
 * function per candidate date.
 */
async function getOpenDaysForMonth({ year, month }) {
  const [trailRows, parkAccessRows] = await Promise.all([
    sql`SELECT trail_id, park, bookable FROM trails WHERE bookable = true`,
    sql`SELECT * FROM park_access`,
  ]);

  // Fail loudly rather than silently treat an empty result as "every day
  // is closed" — same posture as lib/run-trail-assignment.js and
  // lib/trail-safety-options-service.js use for the identical tables.
  if (!trailRows.length) {
    throw new Error(
      'getOpenDaysForMonth: trails table returned zero bookable rows — seed data missing or DATABASE_URL points at the wrong database'
    );
  }
  if (!parkAccessRows.length) {
    throw new Error(
      'getOpenDaysForMonth: park_access table returned zero rows — seed data missing or DATABASE_URL points at the wrong database'
    );
  }

  const trails = trailRows.map(normalizeTrailRow);
  const parkAccess = parkAccessRows.map(normalizeParkAccessRow);

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const openDates = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (isAnyBookableTrailOpen(trails, parkAccess, date)) {
      openDates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
  return { openDates };
}

module.exports = { getOpenDaysForMonth };
