/**
 * lib/adventure-prep-service.js
 *
 * Postgres replacement for adventure-prep-actions.gs's token-scoped Surface
 * A functions: adventurePrep_getContextByToken, adventurePrep_saveFields,
 * adventurePrep_selectTrail. Called by api/adventure-prep.js (the guest-
 * facing endpoint those actions sit behind) instead of going through
 * lib/apps-script-client.js.
 *
 * NOT covered here (separate, still-unbuilt pieces — see the migration
 * progress doc): adventurePrep_saveWaiverSignature/saveSignerDetails/
 * sendSignerLinks/getSignerContext (Surface B + the guardian hybrid model,
 * PRD Section 6), the gear-kit debounce actions (getKitContext/
 * setPendingKitChange/finalizeKitChange — lib/finalize-kit-change.js's own
 * rewrite), and trail assignment itself (lib/run-trail-assignment.js's own
 * rewrite writes the rows this file's selectTrail() reads).
 *
 * ============================================================================
 * WHAT CHANGED FROM THE APPS SCRIPT VERSION, AND WHY
 * ============================================================================
 *
 * 1. ROSTER CONFIRMATION IS ITS OWN FUNCTION (confirmRoster), NOT PART OF
 *    THE GENERIC saveFields.
 *    The old system treated 'isParticipating'/'participatingRosterRef'/
 *    'reconfirmedRosterJson' as three more entries in
 *    ADVENTURE_PREP_WRITABLE_FIELDS — three independent single-cell writes
 *    with no relationship enforced between them. That's exactly the design
 *    CONFIRMED WRONG by Airey (2026-08-31): "the booker may not be
 *    attending the adventure. during the adventure prep experience (after
 *    payment), the roster gets confirmed and the booker has to say if
 *    they are on the adventure or not. if they are, they must identify
 *    themselves." Identifying themselves means pointing at (or creating)
 *    one specific booking_participants row and marking it role_on_booking
 *    = 'owner' — a genuinely different, multi-row, transactional
 *    operation from "set one column on one row," which is all saveFields
 *    is built to do. See confirmRoster()'s own comment for the full
 *    contract. 'isParticipating'/'participatingRosterRef'/
 *    'reconfirmedRosterJson' are REMOVED from the writable-fields list
 *    entirely — confirmRoster is now the only path that can touch
 *    ownership or per-person attendance.
 *
 * 2. ROSTER LIVES IN booking_participants, NOT A JSON BLOB COLUMN.
 *    getContextByToken returns real booking_participants rows instead of
 *    booking.fullPayloadJson.roster / ap.reconfirmedRosterJson — there's
 *    no fullPayloadJson column in the new schema at all (see schema.sql's
 *    own comment on experience_bookings, and the migration progress doc's
 *    Finding on this).
 *
 * 3. CANDIDATE TRAILS ARE ROWS IN candidate_trails, NOT A JSON COLUMN.
 *    selectTrail() queries the candidate_trails table (rank/source/
 *    trail_id) instead of parsing ap.candidateTrails. Whatever rewrites
 *    lib/run-trail-assignment.js needs to write into that same table, not
 *    a column, for this to have anything to select from.
 *
 * 4. "GET OR CREATE" IS ONE ATOMIC UPSERT, NOT A LOCKED READ-THEN-APPEND.
 *    adventure_prep.booking_id is a real PRIMARY KEY, so ensuring the row
 *    exists is one `INSERT ... ON CONFLICT (booking_id) DO NOTHING`, no
 *    LockService needed.
 */

'use strict';

const { sql, query, transaction } = require('./db');
const { genId } = require('./ids');
// See this file's header point 3 -- candidate trails are rows in
// candidate_trails, not a JSON column. getContextByToken below reuses
// booking-detail-service.js's exact JOIN + row mapper instead of a
// second copy, so the guest-facing shape can never drift from the
// ops-facing one.
const { mapCandidateTrailRow } = require('./booking-detail-service');

// Matches lib/booking-service.js's AGE_BUCKET_MAP exactly — kept as its
// own copy here rather than a shared import, matching this codebase's
// existing convention of each file declaring the small lookup tables it
// needs (see lib/finalize-kit-change.js's own header comment on the same
// convention for its TIERS map).
const AGE_BUCKET_MAP = {
  'Under 14': 'under_14',
  '14–17': '14_17',
  '18–24': '18_24',
  '25–34': '25_34',
  '35–44': '35_44',
  '45–54': '45_54',
  '55–64': '55_64',
  '65+': '65_plus',
};

// Matches lib/trail-selection-engine.js's own MINOR_AGE_BUCKETS constant
// (there keyed by raw label, here by the Postgres enum value) — used to
// know which roster entries can even carry a guardian assignment (Section
// 6's hybrid model, below).
const MINOR_AGE_BUCKETS = new Set(['under_14', '14_17']);

/**
 * Conflict-safe person upsert that NEVER touches sms_consent — unlike
 * lib/booking-service.js's own findOrCreatePerson (built for the booking
 * flow, where an explicit smsConsent value is always supplied by the
 * caller and safe to write on every call, including a conflict). Reused
 * here for a genuinely different situation: resolving a person_id for
 * someone this call is NOT collecting SMS consent from at all (a
 * pre-assigned guardian at roster-confirmation time). Calling
 * findOrCreatePerson here instead would silently overwrite an existing
 * person's real sms_consent value back to false on every call (since
 * `!!undefined` is false) — a real bug this avoids with its own
 * `DO UPDATE SET email = people.email` no-op, which still returns a row
 * via RETURNING on conflict without writing over any other column.
 */
async function findOrCreatePersonMinimal(name, email) {
  const emailNorm = String(email || '').trim().toLowerCase();
  const rows = await sql`
    INSERT INTO people (person_id, name, email)
    VALUES (${genId('PER')}, ${name || 'Guardian'}, ${emailNorm})
    ON CONFLICT (email) DO UPDATE SET email = people.email
    RETURNING person_id
  `;
  return rows[0].person_id;
}

// ADVENTURE_PREP_WRITABLE_FIELDS from adventure-prep-actions.gs, minus
// 'isParticipating'/'participatingRosterRef'/'reconfirmedRosterJson' (see
// this file's header comment, point 1) — those three now go through
// confirmRoster() only. camelCase key -> {column, type}. type drives how
// the value is coerced before going into the parameterized query; 'array'
// is for best_for_attributes (TEXT[] in the new schema — the old Sheet
// stored it JSON-stringified in one cell, Postgres gets a real array).
const WRITABLE_FIELDS = {
  technicalComfort: { column: 'technical_comfort', type: 'text' },
  heatComfort: { column: 'heat_comfort', type: 'text' },
  bestForAttributes: { column: 'best_for_attributes', type: 'array' },
  propertyType: { column: 'property_type', type: 'text' },
  deliveryAddressLine1: { column: 'delivery_address_line1', type: 'text' },
  deliveryAddressLine2: { column: 'delivery_address_line2', type: 'text' },
  deliveryCity: { column: 'delivery_city', type: 'text' },
  deliveryState: { column: 'delivery_state', type: 'text' },
  deliveryZip: { column: 'delivery_zip', type: 'text' },
  deliveryAddressRaw: { column: 'delivery_address_raw', type: 'text' },
  deliveryAddressValidated: { column: 'delivery_address_validated', type: 'bool' },
  deliveryLat: { column: 'delivery_lat', type: 'number' },
  deliveryLng: { column: 'delivery_lng', type: 'number' },
  deliveryWindow: { column: 'delivery_window', type: 'text' },
  returnPreference: { column: 'return_preference', type: 'text' },
  deliveryNote: { column: 'delivery_note', type: 'text' },
  returnSameAsDelivery: { column: 'return_same_as_delivery', type: 'bool' },
  returnAddressLine1: { column: 'return_address_line1', type: 'text' },
  returnLocation: { column: 'return_location', type: 'text' },
  returnWindow: { column: 'return_window', type: 'text' },
  returnNote: { column: 'return_note', type: 'text' },
};

function coerce(value, type) {
  if (value === undefined) return null;
  if (type === 'array') return Array.isArray(value) ? value : (value == null ? null : [value]);
  if (type === 'bool') return !!value;
  if (type === 'number') return value === '' || value == null ? null : Number(value);
  return value;
}

/**
 * NEW (Task 11 follow-up, 2026-08-31, found while reviewing
 * adventure-prep-form.js against this file's real response shape):
 * getContextByToken used to return apRows[0] straight from Postgres —
 * a raw, untransformed row (is_participating, technical_comfort,
 * delivery_address_line1, ...) — as `adventurePrep`, unlike every
 * sibling service in this migration (lib/booking-detail-service.js,
 * lib/kit-sync-service.js), which all map their Postgres rows to
 * camelCase before returning them. adventure-prep-form.js reads
 * exclusively camelCase field names off this object (ap.isParticipating,
 * ap.technicalComfort, ap.deliveryAddressLine1, ...) — every single one
 * of those reads was silently `undefined` against the real snake_case
 * response. This maps every adventure_prep column (db/schema.sql) to the
 * camelCase name the frontend already expects, closing that gap at the
 * source rather than patching every read site in a 2000+ line frontend
 * file. Built from WRITABLE_FIELDS above (the same key/column pairing
 * saveFields already uses) plus every column WRITABLE_FIELDS doesn't
 * cover (read-only/derived fields: is_participating, kit-count/waiver/
 * trail-assignment state, the cadence/stall flags, the RideWithGPS
 * placeholder).
 */
function mapAdventurePrepRow(ap) {
  if (!ap) return null;
  const mapped = { bookingId: ap.booking_id };
  Object.keys(WRITABLE_FIELDS).forEach((camelKey) => {
    mapped[camelKey] = ap[WRITABLE_FIELDS[camelKey].column];
  });
  return Object.assign(mapped, {
    isParticipating: ap.is_participating,
    confirmedKitCount: ap.confirmed_kit_count,
    pendingKitCount: ap.pending_kit_count,
    pendingSince: ap.pending_since,
    selectedTrailId: ap.selected_trail_id,
    assignedAt: ap.assigned_at,
    assignmentMethod: ap.assignment_method,
    allWaiversComplete: ap.all_waivers_complete,
    adventurePrepStalledFlag: ap.adventure_prep_stalled_flag,
    phoneFallbackDue: ap.phone_fallback_due,
    t3CutoffProcessedAt: ap.t3_cutoff_processed_at,
    rideWithGpsExperienceAccess: ap.ride_with_gps_experience_access,
  });
}

/**
 * Reverse of AGE_BUCKET_MAP (Postgres enum value -> the human-readable
 * label adventure-form.js/adventure-prep-form.js's own <select> options
 * use) — needed because getContextByToken's roster rows come back with
 * the enum value (age_bucket), but the frontend's roster editor works in
 * terms of the same label strings it collects at booking time.
 */
const AGE_BUCKET_LABELS = Object.keys(AGE_BUCKET_MAP).reduce((acc, label) => {
  acc[AGE_BUCKET_MAP[label]] = label;
  return acc;
}, {});

/**
 * NEW (Task 11 follow-up, 2026-08-31) — same problem as
 * mapAdventurePrepRow above, for getContextByToken's `roster` array:
 * these used to come back as raw booking_participants rows
 * (participant_id, display_name, age_bucket, ...). adventure-prep-
 * form.js's roster editor works in its own established working-state
 * shape ({participantId, name, age, fitness, email, isParticipating}),
 * with `age` as the human-readable label (matching the <select> options
 * it renders), not the Postgres enum value — so this both camelCases
 * and reverse-maps age_bucket through AGE_BUCKET_LABELS. `roleOnBooking`/
 * `guardianPersonId`/`guardianVerifiedAt`/`packSizePreference` are
 * carried through too (camelCased, not translated) so nothing already on
 * a row is silently dropped for a future caller that needs it.
 */
function mapRosterRowForContext(r) {
  return {
    participantId: r.participant_id,
    rosterIndex: r.roster_index,
    name: r.display_name,
    email: r.email || '',
    age: AGE_BUCKET_LABELS[r.age_bucket] || '',
    fitness: r.fitness_level || '',
    // NEW (Task 15, 2026-08-31, found while rewriting adventure-prep-
    // form.js's Gear Kits screen against this file's real response shape):
    // gear_kit has been a real, written-at-booking-time column since the
    // booking+payment core rewrite (see db/schema.sql's own comment on
    // booking_participants.gear_kit), but getContextByToken never read it
    // back -- every per-person gear-kit toggle on the Adventure Prep Gear
    // Kits screen was reading `undefined` off a snake_case row that was
    // never mapped in the first place. Read side of the same class of gap
    // as `email` (Task 14): now mapped here, and setRosterGearKits() below
    // closes the write side (confirmRoster is deliberately NOT reused for
    // this -- see that function's own write path, which unconditionally
    // overwrites name/email/age/fitness on every call; reusing it for a
    // kit-only toggle would blank those fields on any call that didn't
    // resupply them).
    gearKit: r.gear_kit,
    roleOnBooking: r.role_on_booking,
    isParticipating: r.is_participating,
    guardianPersonId: r.guardian_person_id,
    guardianVerifiedAt: r.guardian_verified_at,
    packSizePreference: r.pack_size_preference,
  };
}

async function findBookingByToken(token) {
  const rows = await sql`
    SELECT booking_id, person_id, contact_name, contact_email, tier, date,
           gear_kit_count, booking_status, cancelled_at, refund_amount, cancellation_reasons
    FROM experience_bookings
    WHERE adventure_prep_token = ${token}
  `;
  return rows[0] || null;
}

/**
 * Postgres equivalent of adventurePrep_getContextByToken — Surface A's
 * one load-everything call. Ensures the adventure_prep row exists (fresh
 * bookings never have one until first visit here, same as the old
 * system), then gathers the whole picture: adventure_prep fields, the
 * confirmed roster (booking_participants — replaces fullPayloadJson.roster
 * / reconfirmedRosterJson), waiver signatures, emergency contacts, and the
 * currently-live waiver text/version (waiver_versions, replacing Script
 * Properties).
 */
async function getContextByToken(token) {
  const booking = await findBookingByToken(token);
  if (!booking) return { notFound: true };

  await sql`
    INSERT INTO adventure_prep (booking_id) VALUES (${booking.booking_id})
    ON CONFLICT (booking_id) DO NOTHING
  `;

  const [apRows, roster, waivers, contacts, waiverVersionRows, candidateTrailRows] = await Promise.all([
    sql`SELECT * FROM adventure_prep WHERE booking_id = ${booking.booking_id}`,
    sql`
      SELECT participant_id, roster_index, display_name, email, age_bucket, fitness_level,
             role_on_booking, is_participating, guardian_person_id, guardian_verified_at,
             pack_size_preference, gear_kit
      FROM booking_participants
      WHERE experience_booking_id = ${booking.booking_id}
      ORDER BY roster_index
    `,
    sql`SELECT * FROM waiver_signatures WHERE booking_id = ${booking.booking_id}`,
    sql`SELECT * FROM emergency_contact WHERE booking_id = ${booking.booking_id}`,
    sql`SELECT version, status_tag, body_html FROM waiver_versions WHERE is_current = true LIMIT 1`,
    // BUG FIX (Sept 2026): this call never queried candidate_trails at
    // all, so adventurePrep.candidateTrails was always undefined on a
    // fresh page load (only ever populated in-memory, client-side, for
    // the rest of the same browser session that actually called
    // runTrailAssignment/selectTrail) -- the hub's trail card, the Trail
    // Recommendation re-entry, and the Change Your Trail screens all
    // rely on this to show distance/elevation/description, and silently
    // fell back to placeholder '--' values without it. Same JOIN/columns
    // as booking-detail-service.js's getBookingDetail, whose
    // mapCandidateTrailRow this reuses below.
    sql`
      SELECT ct.rank, ct.source, ct.trail_id, ct.matched_attributes, ct.difficulty_rating,
             ct.technical_rating, ct.distance, ct.elevation,
             t.trail_name, t.opening_description, t.photo_references, t.park,
             t.trailhead_name, t.trail_day_tip
      FROM candidate_trails ct
      JOIN trails t ON t.trail_id = ct.trail_id
      WHERE ct.experience_booking_id = ${booking.booking_id}
      ORDER BY ct.rank
    `,
  ]);

  return {
    bookingId: booking.booking_id,
    experienceBooking: {
      bookingId: booking.booking_id,
      contactName: booking.contact_name,
      contactEmail: booking.contact_email,
      tier: booking.tier,
      date: booking.date,
      gearKitCount: booking.gear_kit_count,
      bookingStatus: booking.booking_status || 'active',
      cancelledAt: booking.cancelled_at || null,
      refundAmount: booking.refund_amount || null,
      cancellationReasons: booking.cancellation_reasons || null,
    },
    adventurePrep: Object.assign(mapAdventurePrepRow(apRows[0]) || {}, {
      candidateTrails: candidateTrailRows.map(mapCandidateTrailRow),
    }),
    roster: roster.map(mapRosterRowForContext),
    waiverSignatures: waivers,
    emergencyContacts: contacts,
    waiverContent: waiverVersionRows[0]
      ? { version: waiverVersionRows[0].version, statusTag: waiverVersionRows[0].status_tag, bodyHtml: waiverVersionRows[0].body_html }
      : null,
  };
}

/**
 * Postgres equivalent of adventurePrep_saveFields, restricted to
 * WRITABLE_FIELDS above (roster/ownership fields excluded — see this
 * file's header comment). Builds one dynamic UPDATE from an allowlisted
 * camelCase-key -> column map, same "never trust a caller-supplied column
 * name" posture the old function's WRITABLE_FIELDS allowlist already had
 * — the difference here is Postgres enforces real column TYPES too
 * (`array`/`bool`/`number` coercion below), where the old Sheet cell just
 * silently accepted whatever was written to it.
 */
async function saveFields(token, fields) {
  const booking = await findBookingByToken(token);
  if (!booking) return { ok: false, error: 'Invalid or expired link' };

  await sql`
    INSERT INTO adventure_prep (booking_id) VALUES (${booking.booking_id})
    ON CONFLICT (booking_id) DO NOTHING
  `;

  const rejected = [];
  const setClauses = [];
  const params = [];
  Object.keys(fields || {}).forEach((key) => {
    const spec = WRITABLE_FIELDS[key];
    if (!spec) {
      rejected.push(key);
      return;
    }
    params.push(coerce(fields[key], spec.type));
    setClauses.push(`${spec.column} = $${params.length}`);
  });

  if (setClauses.length) {
    params.push(booking.booking_id);
    await query(
      `UPDATE adventure_prep SET ${setClauses.join(', ')} WHERE booking_id = $${params.length}`,
      params
    );
  }

  return { ok: true, bookingId: booking.booking_id, rejectedFields: rejected };
}

/**
 * Postgres equivalent of adventurePrep_selectTrail — reads from
 * candidate_trails (rows) instead of ap.candidateTrails (JSON column).
 */
async function selectTrail(token, trailId) {
  const booking = await findBookingByToken(token);
  if (!booking) return { ok: false, error: 'Invalid or expired link' };

  const candidates = await sql`
    SELECT trail_id, source FROM candidate_trails
    WHERE experience_booking_id = ${booking.booking_id} AND trail_id = ${trailId}
  `;
  const match = candidates[0];
  if (!match) return { ok: false, error: "trailId is not one of this booking's current candidates" };

  const assignmentMethod = match.source || 'rules_v1';
  await sql`
    UPDATE adventure_prep
    SET selected_trail_id = ${match.trail_id}, assignment_method = ${assignmentMethod}
    WHERE booking_id = ${booking.booking_id}
  `;
  return { ok: true, selectedTrailId: match.trail_id, assignmentMethod };
}

/**
 * NEW — the Postgres-native answer to Airey's correction (2026-08-31, see
 * this file's header comment, point 1). Replaces the old system's generic
 * 'isParticipating'/'participatingRosterRef'/'reconfirmedRosterJson'
 * field writes with one transactional operation that keeps booking
 * ownership and per-person attendance consistent with each other, instead
 * of three independently-writable cells that could disagree.
 *
 * Contract (this is the server-side design this function commits to —
 * task 11's frontend request-shape check, not yet done, needs to build
 * adventure-prep-form.js's roster-confirmation screen to match this, not
 * the other way around):
 *
 * @param {string} token
 * @param {object} payload
 * @param {boolean} payload.isParticipating - is the booker personally
 *   attending. Required.
 * @param {string} [payload.ownerParticipantId] - REQUIRED when
 *   isParticipating is true AND the booker is already one of the existing
 *   booking_participants rows (the common case: they were in the
 *   original booking-time roster). Must be one of this booking's own
 *   participant_ids. Mutually exclusive with ownerNewEntry.
 * @param {object} [payload.ownerNewEntry] - REQUIRED instead of
 *   ownerParticipantId when isParticipating is true AND the booker was
 *   NOT part of the original booking-time roster (they booked purely for
 *   others and are now deciding to join too) — {name, age, fitness,
 *   gearKit}, same shape as a roster entry. A new booking_participants row
 *   is created for them.
 * @param {Array<object>} [payload.roster] - the reconfirmed attendee list
 *   for everyone else. Each entry either carries a `participantId`
 *   (updates that existing row's display_name/email/age_bucket/
 *   fitness_level/is_participating) or omits it (inserts a brand new row
 *   — someone added during reconfirmation who wasn't on the original
 *   roster). `entry.email` (NEW, Task 11 follow-up, 2026-08-31) is the
 *   non-owner adult's own contact email, collected on the roster-
 *   reconfirmation screen itself (adventure-prep-form.js's own header
 *   comment already decided this was the right place for it) — this is
 *   what lib/waiver-service.js's sendSignerLinksForBooking reads
 *   (`p.email`) to actually deliver that person's waiver-invite link.
 *   Optional; omitted/blank clears it, same as every other plain-text
 *   field this function writes.
 *   Entries are never deleted here, only marked is_participating = false
 *   — booking_participants keeps a full history of who was ever on the
 *   roster, matching this codebase's general "don't destroy data, mark it
 *   instead" posture (e.g. gear_units.retired_at over a DELETE).
 *
 *   NEW, 2026-08-31, per PRD Section 6's resolved guardian hybrid model:
 *   any roster entry may also carry `guardianAssignment`, the booker
 *   NAMING (not yet certifying) who's responsible for that entry if it's
 *   a minor —
 *     - `{participantId}` — an existing attending adult already on this
 *       booking's roster (including the owner). If that participant
 *       doesn't already have a `person_id` on file, pass `email` too
 *       (their own email isn't otherwise collected anywhere before this)
 *       so one can be resolved and backfilled onto their own row.
 *     - `{name, email}` — a non-attending external adult, never
 *       physically on the trip. Gets their own new `booking_participants`
 *       row (`role_on_booking = 'guardian_only'`, `is_participating =
 *       false`) so the one-canonical-roster design holds even for a
 *       guardian who never sets foot on the trail.
 *   Either shape only sets `guardian_person_id` — an INVITATION, per
 *   Section 6, not yet a certified fact. `guardian_verified_at` is set
 *   later, only when that person actually confirms the relationship at
 *   their own waiver-signing link (lib/waiver-service.js's
 *   saveWaiverSignature) — the self-declare certification Model 1
 *   already built, preserved exactly as Section 6 requires ("the
 *   assigned guardian must still affirmatively confirm the relationship
 *   at their own link"). This function never sets guardian_verified_at
 *   itself.
 *
 *   KNOWN ORDERING LIMITATION: `guardianAssignment.participantId` must
 *   reference a participant row that already exists AT THE START of this
 *   call — it cannot reference the booker's own brand-new row in the same
 *   call that creates it via `ownerNewEntry` (that row's participant_id
 *   isn't known to the caller until after this call returns, and
 *   `byParticipantId` below is built from a pre-transaction read, before
 *   `ownerNewEntry`'s INSERT runs). A booker who both joins the roster for
 *   the first time AND wants to name themselves guardian for their own
 *   child needs two calls: this one to establish `ownerNewEntry`, a
 *   follow-up passing that returned participant back as
 *   `guardianAssignment.participantId` — safe, since confirmRoster is
 *   already designed to be idempotent and re-callable.
 * @returns {Promise<{ok: boolean, error?: string, bookingId?: string}>}
 */
async function confirmRoster(token, payload) {
  const booking = await findBookingByToken(token);
  if (!booking) return { ok: false, error: 'Invalid or expired link' };

  const isParticipating = !!payload.isParticipating;
  if (isParticipating && !payload.ownerParticipantId && !payload.ownerNewEntry) {
    return { ok: false, error: 'ownerParticipantId or ownerNewEntry is required when isParticipating is true' };
  }
  if (!isParticipating && (payload.ownerParticipantId || payload.ownerNewEntry)) {
    return { ok: false, error: 'ownerParticipantId/ownerNewEntry must not be set when isParticipating is false' };
  }

  if (payload.ownerParticipantId) {
    const ownerRows = await sql`
      SELECT participant_id FROM booking_participants
      WHERE participant_id = ${payload.ownerParticipantId} AND experience_booking_id = ${booking.booking_id}
    `;
    if (!ownerRows.length) {
      return { ok: false, error: 'ownerParticipantId is not one of this booking\'s roster rows' };
    }
  }

  const existingRows = await sql`
    SELECT participant_id, roster_index, display_name, person_id, email, role_on_booking
    FROM booking_participants
    WHERE experience_booking_id = ${booking.booking_id}
    ORDER BY roster_index
  `;
  let nextRosterIndex = existingRows.length
    ? Math.max(...existingRows.map((r) => r.roster_index)) + 1
    : 0;
  const byParticipantId = {};
  existingRows.forEach((r) => { byParticipantId[r.participant_id] = r; });
  // Existing non-attending external guardians already on this booking
  // (from a PRIOR confirmRoster call), keyed by lowercased email — checked
  // before ever creating a new guardian_only row, so naming the same
  // external guardian again in a LATER call (not just within one call)
  // reuses their existing row instead of duplicating it.
  const existingGuardianByEmail = {};
  existingRows
    .filter((r) => r.role_on_booking === 'guardian_only' && r.email)
    .forEach((r) => { existingGuardianByEmail[r.email.trim().toLowerCase()] = r; });

  // Resolve every roster entry's guardianAssignment (if any) to a real
  // person_id BEFORE opening the transaction below — lib/db.js's
  // transaction() fires its whole query batch via Promise.all with no
  // sequencing, so a value produced by one query (a newly upserted
  // person_id) can never be read back by another query in that same
  // batch. Same "do the interdependent reads first, then batch the
  // atomic writes" split lib/booking-service.js's saveBooking already
  // uses for its own findOrCreatePerson call.
  const roster = payload.roster || [];
  const resolvedGuardians = []; // parallel to `roster`, null where n/a
  const newGuardianParticipantsByEmail = {}; // dedupe: one guardian_only row per unique external email per call
  for (const entry of roster) {
    const ga = entry.guardianAssignment;
    if (!ga) {
      resolvedGuardians.push(null);
      continue;
    }
    if (ga.participantId) {
      const existing = byParticipantId[ga.participantId];
      if (!existing) {
        return { ok: false, error: `guardianAssignment.participantId ${ga.participantId} is not one of this booking's roster rows` };
      }
      if (existing.person_id) {
        resolvedGuardians.push({ personId: existing.person_id, backfillParticipantId: null });
      } else if (ga.email) {
        // eslint-disable-next-line no-await-in-loop
        const personId = await findOrCreatePersonMinimal(existing.display_name, ga.email);
        resolvedGuardians.push({ personId, backfillParticipantId: existing.participant_id, backfillEmail: ga.email });
      } else {
        return { ok: false, error: `guardianAssignment for an existing participant with no person_id on file requires an email (participantId ${ga.participantId})` };
      }
    } else if (ga.name && ga.email) {
      const emailNorm = String(ga.email).trim().toLowerCase();
      if (existingGuardianByEmail[emailNorm]) {
        // Already has a guardian_only row on this booking from a prior
        // confirmRoster call — reuse it, no new row, no new person.
        resolvedGuardians.push({ personId: existingGuardianByEmail[emailNorm].person_id, backfillParticipantId: null });
      } else {
        if (!newGuardianParticipantsByEmail[emailNorm]) {
          // eslint-disable-next-line no-await-in-loop
          const personId = await findOrCreatePersonMinimal(ga.name, ga.email);
          newGuardianParticipantsByEmail[emailNorm] = {
            personId,
            participantId: genId('PART'),
            name: ga.name,
            email: ga.email,
            rosterIndex: nextRosterIndex++,
          };
        }
        resolvedGuardians.push({ personId: newGuardianParticipantsByEmail[emailNorm].personId, newGuardianEmail: emailNorm });
      }
    } else {
      return { ok: false, error: 'guardianAssignment must include either participantId or {name, email}' };
    }
  }

  await transaction((txSql) => {
    const queries = [];

    // 1. Booker's own attendance — the one adventure_prep-level flag.
    queries.push(txSql`
      INSERT INTO adventure_prep (booking_id, is_participating) VALUES (${booking.booking_id}, ${isParticipating})
      ON CONFLICT (booking_id) DO UPDATE SET is_participating = EXCLUDED.is_participating
    `);

    // 2. Reset any previously-designated owner back to attendee first, so
    // this is idempotent no matter how many times reconfirmation runs
    // (e.g. the booker changes their mind between two saves) — never more
    // than one 'owner' row per booking afterward.
    queries.push(txSql`
      UPDATE booking_participants SET role_on_booking = 'attendee', person_id = NULL
      WHERE experience_booking_id = ${booking.booking_id} AND role_on_booking = 'owner'
    `);

    // 3. Re-point ownership at whichever row (existing or brand new) the
    // booker identified as themselves.
    if (payload.ownerParticipantId) {
      queries.push(txSql`
        UPDATE booking_participants
        SET role_on_booking = 'owner', person_id = ${booking.person_id}, is_participating = true
        WHERE participant_id = ${payload.ownerParticipantId} AND experience_booking_id = ${booking.booking_id}
      `);
    } else if (payload.ownerNewEntry) {
      const entry = payload.ownerNewEntry;
      queries.push(txSql`
        INSERT INTO booking_participants (
          participant_id, experience_booking_id, person_id, roster_index,
          display_name, age_bucket, fitness_level, role_on_booking, is_participating
        ) VALUES (
          ${genId('PART')}, ${booking.booking_id}, ${booking.person_id}, ${nextRosterIndex},
          ${entry.name || 'Booker'}, ${AGE_BUCKET_MAP[entry.age] || null}, ${entry.fitness || null}, 'owner', true
        )
      `);
      nextRosterIndex += 1;
    }

    // 4. Everyone else's reconfirmed roster entries. `resolvedGuardians[i]`
    // (resolved above, before this transaction opened) carries the
    // `guardian_person_id` to write for that same-index roster entry, if
    // any — see this function's own header comment on the hybrid model.
    roster.forEach((entry, i) => {
      const guardian = resolvedGuardians[i];
      const guardianPersonId = guardian ? guardian.personId : undefined;
      if (entry.participantId) {
        queries.push(txSql`
          UPDATE booking_participants
          SET display_name = ${entry.name || ''},
              email = ${entry.email || null},
              age_bucket = ${AGE_BUCKET_MAP[entry.age] || null},
              fitness_level = ${entry.fitness || null},
              is_participating = ${entry.isParticipating !== false},
              guardian_person_id = COALESCE(${guardianPersonId || null}, guardian_person_id),
              updated_at = now()
          WHERE participant_id = ${entry.participantId} AND experience_booking_id = ${booking.booking_id}
            AND role_on_booking != 'owner'
        `);
      } else {
        queries.push(txSql`
          INSERT INTO booking_participants (
            participant_id, experience_booking_id, roster_index,
            display_name, email, age_bucket, fitness_level, role_on_booking, is_participating,
            guardian_person_id
          ) VALUES (
            ${genId('PART')}, ${booking.booking_id}, ${nextRosterIndex},
            ${entry.name || `Guest ${nextRosterIndex + 1}`}, ${entry.email || null}, ${AGE_BUCKET_MAP[entry.age] || null}, ${entry.fitness || null},
            'attendee', ${entry.isParticipating !== false},
            ${guardianPersonId || null}
          )
        `);
        nextRosterIndex += 1;
      }
      // Backfilling the ASSIGNED GUARDIAN's own roster row with a
      // person_id/email they didn't have on file before — see
      // findOrCreatePersonMinimal's call above. Distinct from the minor's
      // own row update/insert directly above.
      if (guardian && guardian.backfillParticipantId) {
        queries.push(txSql`
          UPDATE booking_participants
          SET person_id = ${guardian.personId}, email = ${guardian.backfillEmail}, updated_at = now()
          WHERE participant_id = ${guardian.backfillParticipantId} AND experience_booking_id = ${booking.booking_id}
            AND person_id IS NULL
        `);
      }
    });

    // Non-attending external guardians named for the first time in this
    // call each get their own new booking_participants row — see this
    // function's own header comment. One row per unique email, even if
    // that same person was named as guardian for more than one minor in
    // this same call.
    Object.values(newGuardianParticipantsByEmail).forEach((g) => {
      queries.push(txSql`
        INSERT INTO booking_participants (
          participant_id, experience_booking_id, person_id, roster_index,
          display_name, email, role_on_booking, is_participating
        ) VALUES (
          ${g.participantId}, ${booking.booking_id}, ${g.personId}, ${g.rosterIndex},
          ${g.name}, ${g.email}, 'guardian_only', false
        )
      `);
    });

    return queries;
  });

  return { ok: true, bookingId: booking.booking_id };
}

/**
 * NEW (Task 15, 2026-08-31) -- the narrow, purpose-built write path for
 * the Adventure Prep Gear Kits screen's per-person kit toggle. Explicitly
 * NOT folded into confirmRoster: that function's per-entry UPDATE always
 * overwrites display_name/email/age_bucket/fitness_level from whatever
 * the caller supplies (correct for the roster-reconfirmation screen,
 * which always resubmits a person's full row) -- but the Gear Kits screen
 * only ever knows about `gearKit`, so reusing confirmRoster there would
 * blank every other column back to its default/empty value on every kit
 * toggle. Same "each screen owns its own narrow write" split saveFields/
 * confirmRoster already established.
 *
 * UPDATED (2026-09-02, Airey's direct request): also persists each
 * roster member's backpack size preference (pack_size_t: 'standard' |
 * 'plus'), collected alongside the kit toggle on the same screen.
 * gear-service.js's allocation logic already reads pack_size_preference
 * and falls back to backpack_standard for anything that isn't exactly
 * 'plus', so any unrecognized value is coerced to 'standard' here too.
 *
 * @param {string} token
 * @param {Array<{participantId: string, gearKit: boolean, packSizePreference?: string}>} updates
 * @returns {Promise<{ok: boolean, error?: string, bookingId?: string}>}
 */
async function setRosterGearKits(token, updates) {
  const booking = await findBookingByToken(token);
  if (!booking) return { ok: false, error: 'Invalid or expired link' };

  const list = Array.isArray(updates) ? updates : [];
  if (!list.length) return { ok: true, bookingId: booking.booking_id };

  const existingRows = await sql`
    SELECT participant_id FROM booking_participants WHERE experience_booking_id = ${booking.booking_id}
  `;
  const knownIds = new Set(existingRows.map((r) => r.participant_id));
  for (const u of list) {
    if (!u || !knownIds.has(u.participantId)) {
      return { ok: false, error: `participantId ${u && u.participantId} is not one of this booking's roster rows` };
    }
  }

  await transaction(list.map((u) => {
    const packSize = u.packSizePreference === 'plus' ? 'plus' : 'standard';
    return sql`
      UPDATE booking_participants SET gear_kit = ${!!u.gearKit}, pack_size_preference = ${packSize}, updated_at = now()
      WHERE participant_id = ${u.participantId} AND experience_booking_id = ${booking.booking_id}
    `;
  }));

  return { ok: true, bookingId: booking.booking_id };
}

module.exports = {
  getContextByToken,
  saveFields,
  selectTrail,
  confirmRoster,
  setRosterGearKits,
  findOrCreatePersonMinimal,
  MINOR_AGE_BUCKETS,
  // Exported for api/validate-delivery-address.js (Task 18) — reuses this
  // exact token->booking lookup as its auth check rather than a third,
  // potentially-drifting copy of it.
  findBookingByToken,
};
