/**
 * lib/normalize.js
 *
 * Converts raw, header-keyed rows (exactly what the Apps Script webapp hands
 * back — a plain object per row, keyed by the live Trail Database / Park
 * Access column headers) into the clean shapes trail-selection-engine.js
 * consumes. Keeping this as its own module means a header rename on the
 * Sheet only ever needs a one-line fix here, not a hunt through the engine.
 *
 * Column names below are copied verbatim from the live "PSAC_Trail_Database"
 * spreadsheet's Trails tab (read directly, Aug 2026) and the live
 * "PSAC Bookings & Operations" spreadsheet's Park Access tab headers.
 */

'use strict';

const {
  parseCommaList,
  parseMinAge,
  parseYesNo,
  parseEstTimeHours,
} = require('./trail-selection-engine');

function toNumberOrNull(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** First URL/reference in a "Photo References" cell, however it's delimited. */
function firstPhotoRef(raw) {
  if (!raw) return null;
  const first = String(raw).split(/[\n,;]/)[0];
  return first ? first.trim() : null;
}

/**
 * @param {object} row - one raw row from the Trails tab, keyed by header
 * @returns {object} normalized trail row, the shape trail-selection-engine.js expects
 */
function normalizeTrailRow(row) {
  return {
    trailId: row['Trail ID'],
    trailName: row['Trail Name'],
    bookable: parseYesNo(row['Bookable?']),
    park: (row['Park'] || '').trim(),
    trailheadLocation: row['Trailhead Name'],
    easyPaceHours: parseEstTimeHours(row['Est. Time — Easy Pace']),
    strongPaceHours: parseEstTimeHours(row['Est. Time — Strong Pace']),
    difficulty: toNumberOrNull(row['Difficulty (1–5)']),
    technicalRating: toNumberOrNull(row['Technical Rating (1–5)']),
    // NEW (Round 2 build, Section 9 item 2 — "trail-matching API gap"): the
    // handoff doc confirms Distance/Elevation already exist as real Trail
    // Database columns, just never read into the normalized shape or
    // surfaced through candidateTrails. Column names confirmed directly
    // against the live "PSAC_Trail_Database" sheet (Trails tab, header row,
    // STATS section), Aug 2026 — same standard as every other column in
    // this function.
    distance: toNumberOrNull(row['Distance (mi)']),
    elevation: toNumberOrNull(row['Elevation Gain (ft)']),
    activityType: parseCommaList(row['Activity Type']),
    optimalSeason: row['Optimal Season'],
    viableSeason: row['Viable Season'],
    avoidSeason: row['Avoid Season'],
    kidFriendly: parseYesNo(row['Kid Friendly']),
    minAgeRec: parseMinAge(row['Min Age Rec.']),
    bestForAttributes: parseCommaList(row['Best For Attributes']),
    oneTripTip: row['Trail Day Tip'] || null,
    overviewCopy: row['Opening Description'] || '',
    photoUrl: firstPhotoRef(row['Photo References']),
    // NOT a real column yet — see README "Open questions, #3". Left
    // undefined unless Airey adds a column by this exact name, in which
    // case heatAlignmentScore() in the engine starts reading it for real.
    fullSunExposure:
      row['Full Sun Exposure'] !== undefined ? parseYesNo(row['Full Sun Exposure']) : undefined,
  };
}

/**
 * @param {object} row - one raw row from the Park Access tab, keyed by header
 * @returns {object} normalized Park Access row
 */
function normalizeParkAccessRow(row) {
  return {
    park: (row['Park'] || '').trim(),
    season: row['Season'],
    applicableDays: row['Applicable Days'],
    openingTime: row['Opening Time'],
    closingTime: row['Closing Time'],
    adultFee: row['Adult Fee'],
    childFee: row['Child Fee'],
  };
}

/**
 * Builds the engine's `booking` input from the pieces that live in two
 * different places on the live Sheet today — see README "Where roster data
 * actually lives" for why this reaches into Experience Bookings at all
 * rather than reading everything off the Adventure Prep tab.
 *
 * @param {object} adventurePrepRow - the Adventure Prep tab row for this booking
 * @param {object} experienceBookingRow - the Experience Bookings row for this booking
 * @param {Array<{name:string, age:string, fitness:string, gearKit:boolean}>} bookingTimeRoster
 *   - parsed from experienceBookingRow.fullPayloadJson.roster
 */
function normalizeBookingContext(adventurePrepRow, experienceBookingRow, bookingTimeRoster) {
  return {
    bookingId: experienceBookingRow.bookingId,
    tier: experienceBookingRow.tier,
    confirmedDate: experienceBookingRow.date,
    activityType: experienceBookingRow.q5_activity || experienceBookingRow.activityType,
    duration: experienceBookingRow.q6_duration || experienceBookingRow.duration,
    // Attending roster only. Today this is the full booking-time roster,
    // since there is nowhere on the live Adventure Prep tab that stores a
    // reconfirmed roster distinct from it — see README.
    roster: (bookingTimeRoster || []).map((p) => ({
      name: p.name,
      ageRange: p.age,
      fitness: p.fitness,
    })),
    technicalComfort: adventurePrepRow.technicalComfort,
    heatComfort: adventurePrepRow.heatComfort,
    bestForAttributes: parseCommaList(adventurePrepRow.bestForAttributes),
  };
}

module.exports = {
  normalizeTrailRow,
  normalizeParkAccessRow,
  normalizeBookingContext,
};
