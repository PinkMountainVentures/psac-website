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
  const [trailRows, parkAccessRows, blackoutRows] = await Promise.all([
    sql`SELECT trail_id, park, bookable FROM trails WHERE bookable = true`,
    sql`SELECT * FROM park_access`,
    sql`SELECT start_date, end_date FROM booking_blackout_dates`,
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

  // Airey's out-of-town blackout windows (2026-09-09) -- an entirely
  // separate, orthogonal reason a date can be unbookable from
  // isAnyBookableTrailOpen's park/ecological-hours check just below: this
  // is operator availability (can PSAC actually deliver/collect gear that
  // day), not park hours. Both gates run independently; a date needs to
  // clear both to ever reach openDates. See db/2026-09-09_add_booking_
  // blackout_dates.sql and lib/blackout-dates-service.js for the full
  // feature. Date columns can come back from the driver as JS Date
  // objects or plain strings depending on query shape -- normalize to
  // 'YYYY-MM-DD' before the string comparison below.
  function toDateStr(v) {
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  }
  const blackoutRanges = blackoutRows.map((r) => ({
    start: toDateStr(r.start_date),
    end: toDateStr(r.end_date),
  }));
  function isBlackedOut(dateStr) {
    return blackoutRanges.some((r) => dateStr >= r.start && dateStr <= r.end);
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const openDates = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(Date.UTC(year, month - 1, day));
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isAnyBookableTrailOpen(trails, parkAccess, date) && !isBlackedOut(dateStr)) {
      openDates.push(dateStr);
    }
  }
  return { openDates };
}

module.exports = { getOpenDaysForMonth };
