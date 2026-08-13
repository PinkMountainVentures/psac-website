/**
 * lib/cadence.js
 *
 * Date-math helpers for api/check-adventure-prep-cadence.js (Operations UX
 * PRD Sections 3-4: the daily stall-detection/escalation cadence, and its
 * compressed-cadence variant for T-7-to-T-3 bookings).
 *
 * Deliberately self-contained rather than importing lib/t3-cutoff.js: this
 * module needs its own T-3, 10pm Pacific cutoff INSTANT (for the
 * compressed-cadence midpoint math below), and duplicating the ~15-line
 * Intl-based Pacific-offset detector here is safer than guessing at an
 * unseen file's export shape. lib/t3-cutoff.js's actual exports were never
 * reviewed in this session (only its `isBeforeT3Cutoff` name is known, from
 * its use in api/process-t3-cutoff.js) — importing something else from it
 * that turns out not to exist would fail at runtime, not at review time.
 * (A short-lived lib/self-service-cutoff.js used to exist with the same
 * technique, for a T-1 noon lock this build later reverted — deleted, not
 * referenced here or anywhere else.)
 *
 * All "days before trip" reasoning here is calendar-date arithmetic in
 * Pacific time (does today's Pacific date equal tripDate minus N days),
 * matching Section 3's own framing ("T-7, 9am Pacific", "T-5, 9am Pacific",
 * "T-3, 9am Pacific" — all day-level marks, not instant-level ones). Only
 * the compressed-cadence midpoint calculation needs a real instant, since
 * "more than 48 hours remain" is explicitly an hours-based test (Section 4).
 */

'use strict';

/** Same technique as lib/self-service-cutoff.js's pacificOffsetMinutesAt. */
function pacificOffsetMinutesAt(probeUtcDate) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = dtf.formatToParts(probeUtcDate).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const localAsUtcMs = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute)
  );
  return Math.round((localAsUtcMs - probeUtcDate.getTime()) / 60000);
}

/** 'YYYY-MM-DD' calendar date, in Pacific time, for a given instant. */
function pacificDateString(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseDateStr_(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

/** Calendar-day arithmetic — 'YYYY-MM-DD' in, N days added/subtracted, 'YYYY-MM-DD' out. */
function addDaysToDateString(dateStr, days) {
  const p = parseDateStr_(dateStr);
  if (!p) return null;
  const ms = Date.UTC(p.y, p.mo - 1, p.d) + days * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Whole-day difference, dateStrB - dateStrA (positive if B is later). */
function daysBetweenDateStrings(dateStrA, dateStrB) {
  const a = parseDateStr_(dateStrA);
  const b = parseDateStr_(dateStrB);
  if (!a || !b) return null;
  const msA = Date.UTC(a.y, a.mo - 1, a.d);
  const msB = Date.UTC(b.y, b.mo - 1, b.d);
  return Math.round((msB - msA) / (24 * 60 * 60 * 1000));
}

/**
 * The T-3, 10pm Pacific cutoff instant for a given trip date — same "10pm
 * Pacific on T-3" deadline the rest of this project's T-3 mechanics use
 * (lib/t3-cutoff.js owns the canonical version this cadence job doesn't
 * import; see this file's header). Only used here for the compressed-
 * cadence "more than 48 hours remain" hours-based test (Section 4).
 */
function t3CutoffInstantUtc(tripDateStr) {
  const t3DateStr = addDaysToDateString(tripDateStr, -3);
  const p = parseDateStr_(t3DateStr);
  if (!p) return null;
  const t3UtcMidnightMs = Date.UTC(p.y, p.mo - 1, p.d);
  const probe = new Date(t3UtcMidnightMs + 22 * 60 * 60 * 1000); // 10pm UTC of T-3, offset-detection only
  const offsetMin = pacificOffsetMinutesAt(probe);
  return new Date(t3UtcMidnightMs + 22 * 60 * 60 * 1000 - offsetMin * 60 * 1000);
}

/**
 * The heart of Sections 3-4: for one booking (trip date + when it was
 * confirmed), decides whether it's on normal or compressed cadence and
 * whether TODAY is one of its escalation marks.
 *
 * @param {object} booking
 * @param {string} booking.tripDate - 'YYYY-MM-DD...'
 * @param {string} booking.createdAt - ISO instant, booking confirmation time
 * @param {Date} now - injected rather than read internally (Date.now() is
 *   unavailable in this project's workflow-script contexts; callers pass a
 *   real Date in production)
 * @returns {{ isCompressed: boolean, stage: string|null, daysToTrip: number|null }}
 *   stage is one of: null, 't7', 't5', 't3' (normal cadence),
 *   or 'midwindow', 't3' (compressed cadence — no 't7', no 't5', per
 *   Section 4: the booking-confirmation email itself substitutes for the
 *   T-7 nudge, and that send is the booking flow's job, not this cadence
 *   job's — see api/check-adventure-prep-cadence.js's header).
 */
function determineCadenceStage(booking, now) {
  const tripDateStr = String(booking.tripDate || '').match(/^\d{4}-\d{2}-\d{2}/);
  if (!tripDateStr) return { isCompressed: false, stage: null, daysToTrip: null };
  const tripDate = tripDateStr[0];
  const today = pacificDateString(now);
  const daysToTrip = daysBetweenDateStrings(today, tripDate);

  const t7Date = addDaysToDateString(tripDate, -7);
  const t5Date = addDaysToDateString(tripDate, -5);
  const t3Date = addDaysToDateString(tripDate, -3);

  const createdAtDateStr = booking.createdAt ? pacificDateString(new Date(booking.createdAt)) : null;
  // Compressed: booking was confirmed strictly after its own T-7 mark, i.e.
  // it never had a real T-7 day to nudge at (Section 4's whole premise).
  const isCompressed = !!createdAtDateStr && createdAtDateStr > t7Date;

  if (!isCompressed) {
    let stage = null;
    if (today === t7Date) stage = 't7';
    else if (today === t5Date) stage = 't5';
    else if (today === t3Date) stage = 't3';
    return { isCompressed: false, stage, daysToTrip };
  }

  // Compressed cadence: one optional midpoint touch, only if there's room
  // for it (Section 4: "If more than 48 hours remain between booking
  // confirmation and the T-3, 10pm cutoff, run one mid-window check at the
  // midpoint ... If 48 hours or less remain, skip it").
  let stage = null;
  if (today === t3Date) {
    stage = 't3';
  } else if (booking.createdAt) {
    const createdAtMs = new Date(booking.createdAt).getTime();
    const t3CutoffMs = t3CutoffInstantUtc(tripDate).getTime();
    const hoursRemaining = (t3CutoffMs - createdAtMs) / (60 * 60 * 1000);
    if (hoursRemaining > 48) {
      const midpointMs = createdAtMs + (t3CutoffMs - createdAtMs) / 2;
      const midpointDateStr = pacificDateString(new Date(midpointMs));
      if (today === midpointDateStr) stage = 'midwindow';
    }
  }
  return { isCompressed: true, stage, daysToTrip };
}

/**
 * BUG FIX (independent bug pass, Aug 2026): true once the current instant is
 * at or after `targetHour`:`targetMinute` Pacific time on today's Pacific
 * calendar date. Added because api/trigger-deposit-holds.js and
 * api/check-hold-clearance-deadline.js had NO in-code time gate at all —
 * they relied entirely on their vercel.json cron window to approximate
 * "9am Pacific" / "noon Pacific," and acted on the very first tick of that
 * window. The windows themselves were deliberately widened to bracket both
 * PDT and PST (see vercel.json), which means the first tick lands at 8am
 * Pacific during PDT but 7am during PST for the deposit-hold trigger, and
 * 11am during PDT but 10am during PST for the noon hold-clearance check —
 * a full hour (or more) before the guest's own communicated deadline during
 * PST specifically. This closes that gap the same way lib/t3-cutoff.js and
 * determineCadenceStage above already handle their own Pacific-instant math:
 * compute the real Pacific-local target instant via Intl offset detection,
 * not a fixed UTC assumption.
 */
function pacificClockTimeReached(targetHour, targetMinute, now) {
  const today = pacificDateString(now);
  const p = parseDateStr_(today);
  const utcMidnightMs = Date.UTC(p.y, p.mo - 1, p.d);
  const targetOffsetMs = targetHour * 60 * 60 * 1000 + targetMinute * 60 * 1000;
  const probe = new Date(utcMidnightMs + targetOffsetMs); // offset-detection only
  const offsetMin = pacificOffsetMinutesAt(probe);
  const targetInstantMs = utcMidnightMs + targetOffsetMs - offsetMin * 60 * 1000;
  return now.getTime() >= targetInstantMs;
}

module.exports = {
  pacificDateString,
  addDaysToDateString,
  daysBetweenDateStrings,
  t3CutoffInstantUtc,
  determineCadenceStage,
  pacificClockTimeReached,
};
