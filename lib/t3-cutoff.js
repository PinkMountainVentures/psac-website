/**
 * lib/t3-cutoff.js
 *
 * Computes "T-3, 10pm Pacific" — the unified cutoff referenced across the
 * Adventure Prep, Trail Selection Logic, and Operations UX PRDs (self-
 * service edits stop being accepted 3 calendar days before the trip date,
 * at 10:00pm America/Los_Angeles).
 *
 * FLAGGED FOR AIREY: no canonical helper for this cutoff existed anywhere
 * in the repo as of this build, even though Operations UX's own PRD
 * (Sections 4/7/10) refers to the exact same cutoff for its own separate
 * locking/cron work (api/process-t3-cutoff.js, not built in this chat).
 * This file is this chat's own answer, built only because
 * api/adjust-gear-kit-count.js and api/process-pending-kit-changes.js
 * can't function without knowing it. If/when the Operations UX chat ships
 * its own version, one of the two should be deleted in favor of the other
 * — two independent implementations of the same cutoff math WILL drift
 * apart eventually (leap years, DST rule changes, off-by-one convention
 * differences) if both stay alive. Not a design decision to silently
 * duplicate, just the least-bad option available without blocking on a
 * cross-chat dependency this chat was told not to build.
 */

'use strict';

/**
 * Offset (in minutes) of America/Los_Angeles from UTC at a given instant,
 * DST-aware, using Node's built-in ICU data (available on Vercel's Node
 * runtime without any extra dependency). Positive/negative sign matches
 * the standard convention: local = utc + offset.
 */
function pacificOffsetMinutes(utcInstant) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(utcInstant).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  // Treat "what Pacific clocks read" as if it were itself a UTC timestamp,
  // then diff against the real UTC instant — the difference is the offset.
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asIfUtc - utcInstant.getTime()) / 60000;
}

/**
 * @param {string} tripDateStr - the Experience Bookings 'date' column
 *   value for this booking (a calendar date, e.g. "2026-08-20..."; only
 *   the leading YYYY-MM-DD is read, any time-of-day component on the
 *   string is ignored since the trip date is a calendar concept, not a
 *   moment in time).
 * @returns {Date|null} the exact UTC instant of 10:00pm Pacific, 3
 *   calendar days before the trip date, or null if tripDateStr can't be
 *   parsed as a date.
 */
function computeT3CutoffUtc(tripDateStr) {
  const m = String(tripDateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  // Step back 3 calendar days first, purely as calendar math (UTC fields
  // only, so this never gets tangled up with the timezone conversion done
  // afterward).
  const threeDaysBack = new Date(Date.UTC(y, mo - 1, d) - 3 * 86400000);
  const cy = threeDaysBack.getUTCFullYear();
  const cm = threeDaysBack.getUTCMonth();
  const cd = threeDaysBack.getUTCDate();

  // Guess PST (UTC-8) to get a rough instant, read the ACTUAL Pacific
  // offset Intl reports for that instant (correct for PST vs PDT on this
  // specific date), then compute the real UTC instant for 22:00 Pacific
  // wall-clock on (cy, cm, cd) using that offset. This is exact except in
  // the vanishingly narrow case where the DST transition itself falls
  // exactly on this cutoff's own calendar day (a one-hour error in that
  // single edge case) — accepted here rather than pulling in a timezone
  // library this repo doesn't otherwise depend on.
  const guessUtc = new Date(Date.UTC(cy, cm, cd, 22, 0, 0) + 8 * 3600000);
  const offsetMinutes = pacificOffsetMinutes(guessUtc);
  const utcMillis = Date.UTC(cy, cm, cd, 22, 0, 0) - offsetMinutes * 60000;
  return new Date(utcMillis);
}

/**
 * @param {string} tripDateStr
 * @param {Date} [now]
 * @returns {boolean} true if `now` is strictly before the T-3 cutoff, OR
 *   if tripDateStr couldn't be parsed at all (fails OPEN — an unparseable
 *   trip date is a data problem for staff to catch elsewhere, not a reason
 *   to silently lock a guest out of editing their own Adventure Prep).
 */
function isBeforeT3Cutoff(tripDateStr, now) {
  const cutoff = computeT3CutoffUtc(tripDateStr);
  if (!cutoff) return true;
  return (now || new Date()).getTime() < cutoff.getTime();
}

module.exports = { computeT3CutoffUtc, isBeforeT3Cutoff, pacificOffsetMinutes };
