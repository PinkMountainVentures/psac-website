/**
 * lib/trails-parks-service.js
 *
 * Postgres CRUD for the `trails` and `park_access` tables, backing the
 * new Ops UX Trails & Parks dashboard (2026-09-03). Two "New asks,
 * 2026-09-02" from psac-build-checklist.md folded into one build: a real
 * staff-facing CRUD UI for trail content (19 bookable trails now exist,
 * several still missing content) and for park hours/season/fee schedules
 * (the same `park_access` rows lib/trail-selection-engine.js's
 * checkParkDateAvailability() reads for both trail assignment and the
 * guest-facing open-days date picker).
 *
 * Deliberately NOT in scope (confirmed with Airey): trail_landmarks and
 * trail_waypoints, the two per-trail sub-tables. This file and its UI
 * only manage the two flat tables named — a fast follow, not forgotten,
 * if landmarks/waypoints need their own editor later.
 *
 * WHY A DROPDOWN, NOT FREE TEXT, FOR trails.park: the exact bug fixed
 * earlier this session (TRAIL-051/052 seeded with a `park` value that
 * didn't match any real park_access row, so those trails could never
 * pass the Tier A safety check) is a direct consequence of `trails.park`
 * and `park_access.park` being two independently-typed free-text columns
 * with no foreign key between them (park_access has no natural key to
 * reference — see db/schema.sql, it's a flat schedule table, not a parks
 * dimension table). listParkNames() below exists specifically so the
 * Trails form's Park field can be populated from real park_access.park
 * values instead of hand-typed, and getParkNameMismatches() lets the
 * Parks page proactively surface any trail whose `park` doesn't match —
 * catching this bug class before it silently ships again, rather than
 * only after a trail can never be assigned.
 *
 * Field-list convention matches lib/adventure-prep-service.js's
 * WRITABLE_FIELDS/coerce() pattern exactly (camelCase key -> {column,
 * type}, dynamic parameterized SET clause) — same reasoning: one
 * allowlist doubles as validation (an unknown key is silently rejected,
 * never reaches SQL) and as the type-coercion table.
 */

'use strict';

const { query } = require('./db');

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

const TRAIL_WRITABLE_FIELDS = {
  trailName: { column: 'trail_name', type: 'text' },
  alternateNames: { column: 'alternate_names', type: 'text' },
  desertRidersTrail: { column: 'desert_riders_trail', type: 'bool' },
  bookable: { column: 'bookable', type: 'bool' },
  area: { column: 'area', type: 'text' },
  park: { column: 'park', type: 'text' },
  trailheadName: { column: 'trailhead_name', type: 'text' },
  trailheadGps: { column: 'trailhead_gps', type: 'text' },
  parkingNotes: { column: 'parking_notes', type: 'text' },
  distanceMi: { column: 'distance_mi', type: 'number' },
  elevationGainFt: { column: 'elevation_gain_ft', type: 'number' },
  highestPointFt: { column: 'highest_point_ft', type: 'number' },
  estTimeEasyPace: { column: 'est_time_easy_pace', type: 'text' },
  estTimeStrongPace: { column: 'est_time_strong_pace', type: 'text' },
  difficulty: { column: 'difficulty', type: 'number' },
  activityType: { column: 'activity_type', type: 'text' },
  routeType: { column: 'route_type', type: 'text' },
  technicalRating: { column: 'technical_rating', type: 'number' },
  optimalSeason: { column: 'optimal_season', type: 'array' },
  viableSeason: { column: 'viable_season', type: 'array' },
  avoidSeason: { column: 'avoid_season', type: 'array' },
  heatConsiderations: { column: 'heat_considerations', type: 'text' },
  waterSourcesOnTrail: { column: 'water_sources_on_trail', type: 'text' },
  kidFriendly: { column: 'kid_friendly', type: 'bool' },
  minAgeRec: { column: 'min_age_rec', type: 'text' },
  dogFriendly: { column: 'dog_friendly', type: 'text' }, // real column type is TEXT, not boolean (db/schema.sql) — e.g. "No", "Yes, leashed"
  goodForBeginners: { column: 'good_for_beginners', type: 'bool' },
  goodForAthletes: { column: 'good_for_athletes', type: 'bool' },
  openingDescription: { column: 'opening_description', type: 'text' },
  whatMakesItSpecial: { column: 'what_makes_it_special', type: 'text' },
  bestForAttributes: { column: 'best_for_attributes', type: 'array' },
  trailDayTip: { column: 'trail_day_tip', type: 'text' },
  ridewithgpsLink: { column: 'ridewithgps_link', type: 'text' },
  stravaLink: { column: 'strava_link', type: 'text' },
  garminConnectLink: { column: 'garmin_connect_link', type: 'text' },
  gpxFileLocation: { column: 'gpx_file_location', type: 'text' },
  photoReferences: { column: 'photo_references', type: 'text' },
  knownHazards: { column: 'known_hazards', type: 'text' },
  cellCoverage: { column: 'cell_coverage', type: 'text' },
  emergencyEgressNotes: { column: 'emergency_egress_notes', type: 'text' },
  nearestNeighborhood: { column: 'nearest_neighborhood', type: 'text' },
  nearestTown: { column: 'nearest_town', type: 'text' },
  driveTimeFromDowntownPs: { column: 'drive_time_from_downtown_ps', type: 'text' },
  entryFeeRequired: { column: 'entry_fee_required', type: 'bool' },
  guidedEligible: { column: 'guided_eligible', type: 'bool' },
};

function coerce(value, type) {
  if (value === undefined) return null;
  if (type === 'array') {
    if (value == null) return null;
    const arr = Array.isArray(value) ? value : [value];
    const cleaned = arr.map((v) => String(v).trim()).filter(Boolean);
    return cleaned.length ? cleaned : null;
  }
  if (type === 'bool') return value == null ? null : !!value;
  if (type === 'number') return value === '' || value == null ? null : Number(value);
  return value === '' ? null : value;
}

function trailRowToWire(row) {
  if (!row) return null;
  const out = { trailId: row.trail_id };
  Object.keys(TRAIL_WRITABLE_FIELDS).forEach((key) => {
    out[key] = row[TRAIL_WRITABLE_FIELDS[key].column];
  });
  return out;
}

async function listTrails({ q } = {}) {
  const rows = q
    ? await query(
        `SELECT * FROM trails WHERE trail_id ILIKE $1 OR trail_name ILIKE $1 OR park ILIKE $1 ORDER BY trail_id`,
        [`%${q}%`]
      )
    : await query(`SELECT * FROM trails ORDER BY trail_id`);
  return { trails: rows.map(trailRowToWire) };
}

async function getTrail({ trailId }) {
  const rows = await query(`SELECT * FROM trails WHERE trail_id = $1`, [trailId]);
  if (!rows.length) return { ok: false, error: 'Trail not found' };
  return { ok: true, trail: trailRowToWire(rows[0]) };
}

// Suggests the next unused TRAIL-0XX id (staff can still override it in
// the Add Trail form) — not enforced server-side beyond uniqueness, since
// nothing in the schema itself requires the TRAIL-### shape.
async function suggestNextTrailId() {
  const rows = await query(`SELECT trail_id FROM trails WHERE trail_id ~ '^TRAIL-[0-9]+$' ORDER BY trail_id DESC LIMIT 1`);
  if (!rows.length) return 'TRAIL-001';
  const n = parseInt(rows[0].trail_id.replace('TRAIL-', ''), 10) || 0;
  return 'TRAIL-' + String(n + 1).padStart(3, '0');
}

async function createTrail({ trailId, fields }) {
  const id = String(trailId || '').trim();
  if (!id) return { ok: false, error: 'A trail ID is required' };
  if (!fields || !fields.trailName || !String(fields.trailName).trim()) {
    return { ok: false, error: 'Trail name is required' };
  }

  const columns = ['trail_id'];
  const placeholders = ['$1'];
  const params = [id];
  Object.keys(fields).forEach((key) => {
    const spec = TRAIL_WRITABLE_FIELDS[key];
    if (!spec) return;
    params.push(coerce(fields[key], spec.type));
    columns.push(spec.column);
    placeholders.push(`$${params.length}`);
  });
  if (!columns.includes('bookable')) {
    // Match the schema's own default explicitly rather than relying on it
    // implicitly, so a new trail never accidentally goes live unreviewed.
    columns.push('bookable');
    params.push(false);
    placeholders.push(`$${params.length}`);
  }

  try {
    await query(`INSERT INTO trails (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, params);
  } catch (err) {
    if (err && err.code === '23505') return { ok: false, error: 'A trail with this ID already exists' };
    throw err;
  }
  return { ok: true, trailId: id };
}

async function updateTrail({ trailId, fields }) {
  const setClauses = [];
  const params = [];
  const rejected = [];
  Object.keys(fields || {}).forEach((key) => {
    const spec = TRAIL_WRITABLE_FIELDS[key];
    if (!spec) { rejected.push(key); return; }
    params.push(coerce(fields[key], spec.type));
    setClauses.push(`${spec.column} = $${params.length}`);
  });
  if (!setClauses.length) return { ok: false, error: 'No recognized fields to update' };

  params.push(trailId);
  const rows = await query(
    `UPDATE trails SET ${setClauses.join(', ')} WHERE trail_id = $${params.length} RETURNING trail_id`,
    params
  );
  if (!rows.length) return { ok: false, error: 'Trail not found' };
  return { ok: true, trailId, rejectedFields: rejected };
}

async function deleteTrail({ trailId }) {
  try {
    const rows = await query(`DELETE FROM trails WHERE trail_id = $1 RETURNING trail_id`, [trailId]);
    if (!rows.length) return { ok: false, error: 'Trail not found' };
    return { ok: true, trailId };
  } catch (err) {
    // 23503 = foreign_key_violation: this trail has real history (an
    // Adventure Prep selection, a candidate-trails row, a past trail-swap
    // target) — deleting it would silently orphan that history. Never
    // silently no-op or cascade here; tell staff the real, safe lever.
    if (err && err.code === '23503') {
      return { ok: false, error: 'This trail has booking history and can’t be deleted. Set Bookable to No instead to take it out of rotation.' };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Parks (park_access)
// ---------------------------------------------------------------------------

const PARK_WRITABLE_FIELDS = {
  park: { column: 'park', type: 'text' },
  season: { column: 'season', type: 'text' },
  applicableDays: { column: 'applicable_days', type: 'array' },
  openingTime: { column: 'opening_time', type: 'text' },
  closingTime: { column: 'closing_time', type: 'text' },
  adultFee: { column: 'adult_fee', type: 'text' },
  childFee: { column: 'child_fee', type: 'text' },
  discountEligibilityNotes: { column: 'discount_eligibility_notes', type: 'text' },
  paymentMethod: { column: 'payment_method', type: 'text' },
};

function parkRowToWire(row) {
  if (!row) return null;
  const out = { parkAccessId: String(row.park_access_id) };
  Object.keys(PARK_WRITABLE_FIELDS).forEach((key) => {
    out[key] = row[PARK_WRITABLE_FIELDS[key].column];
  });
  return out;
}

async function listParks({ q } = {}) {
  const rows = q
    ? await query(`SELECT * FROM park_access WHERE park ILIKE $1 ORDER BY park, season`, [`%${q}%`])
    : await query(`SELECT * FROM park_access ORDER BY park, season`);
  return { parks: rows.map(parkRowToWire) };
}

async function getPark({ parkAccessId }) {
  const rows = await query(`SELECT * FROM park_access WHERE park_access_id = $1`, [parkAccessId]);
  if (!rows.length) return { ok: false, error: 'Park Access row not found' };
  return { ok: true, park: parkRowToWire(rows[0]) };
}

// Distinct real park names, for the Trails form's Park dropdown — see this
// file's header for why a dropdown sourced from here (not free text)
// exists at all.
async function listParkNames() {
  const rows = await query(`SELECT DISTINCT park FROM park_access ORDER BY park`);
  return { parkNames: rows.map((r) => r.park) };
}

// Proactive detector for exactly the bug class fixed this session
// (TRAIL-051/052): any trail whose `park` value has zero matching
// park_access rows can never pass checkParkDateAvailability() on any
// date, so it can never actually be assigned or show real hours on the
// date picker. Surfaced on the Parks page rather than left to be found
// again by accident.
async function getParkNameMismatches() {
  const rows = await query(`
    SELECT DISTINCT t.trail_id, t.trail_name, t.park
    FROM trails t
    WHERE t.park IS NOT NULL AND t.bookable = true
      AND NOT EXISTS (
        SELECT 1 FROM park_access pa WHERE lower(trim(pa.park)) = lower(trim(t.park))
      )
    ORDER BY t.trail_id
  `);
  return {
    mismatches: rows.map((r) => ({ trailId: r.trail_id, trailName: r.trail_name, park: r.park })),
  };
}

async function createPark({ fields }) {
  if (!fields || !fields.park || !String(fields.park).trim()) {
    return { ok: false, error: 'Park name is required' };
  }
  const columns = [];
  const placeholders = [];
  const params = [];
  Object.keys(fields).forEach((key) => {
    const spec = PARK_WRITABLE_FIELDS[key];
    if (!spec) return;
    params.push(coerce(fields[key], spec.type));
    columns.push(spec.column);
    placeholders.push(`$${params.length}`);
  });
  const rows = await query(
    `INSERT INTO park_access (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING park_access_id`,
    params
  );
  return { ok: true, parkAccessId: String(rows[0].park_access_id) };
}

async function updatePark({ parkAccessId, fields }) {
  const setClauses = [];
  const params = [];
  const rejected = [];
  Object.keys(fields || {}).forEach((key) => {
    const spec = PARK_WRITABLE_FIELDS[key];
    if (!spec) { rejected.push(key); return; }
    params.push(coerce(fields[key], spec.type));
    setClauses.push(`${spec.column} = $${params.length}`);
  });
  if (!setClauses.length) return { ok: false, error: 'No recognized fields to update' };

  params.push(parkAccessId);
  const rows = await query(
    `UPDATE park_access SET ${setClauses.join(', ')} WHERE park_access_id = $${params.length} RETURNING park_access_id`,
    params
  );
  if (!rows.length) return { ok: false, error: 'Park Access row not found' };
  return { ok: true, parkAccessId, rejectedFields: rejected };
}

async function deletePark({ parkAccessId }) {
  // No FK references park_access_id anywhere in the schema (trails.park
  // matches by string, not by id) — a real, unconditional delete is safe.
  const rows = await query(`DELETE FROM park_access WHERE park_access_id = $1 RETURNING park_access_id`, [parkAccessId]);
  if (!rows.length) return { ok: false, error: 'Park Access row not found' };
  return { ok: true, parkAccessId };
}

module.exports = {
  TRAIL_WRITABLE_FIELDS,
  PARK_WRITABLE_FIELDS,
  listTrails,
  getTrail,
  suggestNextTrailId,
  createTrail,
  updateTrail,
  deleteTrail,
  listParks,
  getPark,
  listParkNames,
  getParkNameMismatches,
  createPark,
  updatePark,
  deletePark,
};
