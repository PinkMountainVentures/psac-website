/**
 * lib/booking-service.js
 *
 * Postgres replacement for the booking-related handlers in
 * apps-script/bookings-code.gs: handleSaveBooking, handleGetBooking,
 * handleGetBookingByPaymentIntentId, handleUpdateDepositStatus,
 * findBookingRow, findOrCreatePerson, buildGearLogRows/gearRow, and the
 * inline adventurePrep_ensureToken() call handleSaveBooking made. Called
 * directly by api/save-booking.js and api/create-deposit-hold.js instead
 * of going through lib/apps-script-client.js's callBookingsWebApp().
 *
 * ============================================================================
 * WHAT CHANGED FROM THE APPS SCRIPT VERSION, AND WHY
 * ============================================================================
 *
 * 1. DEDUP IS NOW ATOMIC, NOT A SEPARATE PRE-CHECK + POST-FAILURE RECOVERY.
 *    The old dance (api/save-booking.js's pre-check via
 *    getBookingByPaymentIntentId, then a post-failure recovery lookup using
 *    the same function) existed entirely to work around two Apps Script
 *    facts that no longer apply once writes go straight to Postgres: (a)
 *    the confirmed-transient "Web App serves a Google interstitial page
 *    instead of JSON even though the write succeeded" failure mode, and
 *    (b) appendRow() has no unique-constraint concept, so there was no way
 *    to make the write itself refuse a duplicate — only detect one
 *    separately, before or after the fact. PRD Section 7 anticipated this
 *    exact simplification ("becomes moot once calling Postgres directly").
 *    Here, `experience_bookings.main_payment_intent_id` has a real partial
 *    UNIQUE index (schema.sql), so saveBooking() below does a single
 *    `INSERT ... ON CONFLICT (main_payment_intent_id) ... DO NOTHING
 *    RETURNING *` — one round trip that atomically tells us whether this
 *    is a brand new booking or an exact retry of one that already landed.
 *    No separate pre-check call, no separate garbled-response recovery
 *    path — a real network/DB error here is just a real error, not a
 *    "might have secretly succeeded" ambiguity.
 *
 * 2. ROSTER IS NOW ROWS IN booking_participants, NOT A JSON BLOB.
 *    The old fullPayloadJson column doesn't exist in the new schema
 *    (Section 4.2) — payload.roster is written as real
 *    booking_participants rows instead. See mapRosterEntry() below for the
 *    field-by-field mapping and the judgment calls it had to make; those
 *    are flagged there AND in the migration progress doc for Airey to
 *    confirm, not just buried in a comment here.
 *
 * 3. PERSON DEDUP BY EMAIL IS NOW A REAL DB CONSTRAINT, NOT A SHEET SCAN.
 *    people.email is NOT NULL UNIQUE (schema.sql) instead of the old
 *    linear scan-for-matching-email-then-append/update. That constraint is
 *    case-sensitive, but the OLD dedup was case-INsensitive
 *    (`.toLowerCase()` on both sides) — to preserve that exact behavior
 *    (so "John@Example.com" and "john@example.com" across two bookings
 *    still resolve to the same Person, not two), the email is normalized
 *    to lowercase before every write/lookup against `people`. The guest's
 *    original, as-typed casing is NOT lost — it's preserved verbatim on
 *    that booking's own experience_bookings.contact_email, exactly like
 *    the old Sheet's per-booking contact_email column already did
 *    alongside the separately-normalized People tab.
 *
 * 4. NO LockService — Postgres's own constraints/atomicity replace it.
 *    The old global LockService.getScriptLock() around handleSaveBooking
 *    existed because Sheets has no row-level locking or constraints of its
 *    own. Here, the person upsert is a single atomic statement (ON
 *    CONFLICT (email) DO UPDATE), and the booking + participants + gear
 *    rows are one atomic transaction() batch — Postgres already guarantees
 *    both are all-or-nothing, no application-level mutex needed.
 *
 * 5. BUG FIX (2026-08-31, roster/gear-kit ID-link fix): booking_participants.
 *    gear_kit and gear_check_log.participant_id both now actually get
 *    written. Neither ever did before this fix — mapRosterEntry() computed
 *    gear_kit but the INSERT never wrote it (no column existed until this
 *    turn's schema.sql change), and buildGearCheckLogRows() had no way to
 *    know which participant_id a given kit belonged to at all, so every
 *    downstream consumer that needed to know "which roster member does
 *    this specific gear kit belong to" (lib/t3-cutoff-service.js's
 *    partial-waiver kit removal, lib/gear-service.js's pack-size-preference
 *    resolution) had no choice but to match on the denormalized
 *    person_name string — exactly the name-collision fragility flagged in
 *    both the .gs source's own comments and this migration's progress doc.
 *    Both are now populated at booking-save time (see buildGearCheckLogRows
 *    below), closing the gap at its source rather than only downstream.
 */

'use strict';

const crypto = require('crypto');
const { sql, query, transaction } = require('./db');
const { genId } = require('./ids');

// Matches apps-script/bookings-code.gs's ITEM_COSTS exactly (dollars, not
// cents — gear_check_log.item_cost is NUMERIC(10,2), same unit the old
// Sheet column used).
const ITEM_COSTS = {
  'Gregory Miko 20L Backpack': 159,
  'Hydro Flask Big Mouth 32oz Bottle': 42,
  'Leki Khumbu Lite Trekking Poles': 129,
  'REI Pack Mule 90L Duffel': 159,
  'Hard-Shell First Aid Kit': 9.99,
};

// Matches the exact age-range labels adventure-form.js's roster step
// renders (including the literal en-dash character, not a hyphen) ->
// age_bucket_t enum values. Unrecognized/blank maps to NULL (nullable
// column) rather than throwing, since this is guest-typed-adjacent select
// text, not something worth failing the whole booking save over.
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

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Upsert-by-email, matching bookings-code.gs's findOrCreatePerson exactly:
 * first write wins for name/phone, sms_consent/_at/_text always overwritten
 * to the latest value passed in. One atomic statement, no separate
 * find-then-branch needed the way the old Sheet scan required.
 */
async function findOrCreatePerson({ name, email, phone, smsConsent, smsConsentAt, smsConsentText }) {
  const emailNorm = normalizeEmail(email);
  const rows = await sql`
    INSERT INTO people (person_id, name, email, phone, sms_consent, sms_consent_at, sms_consent_text)
    VALUES (${genId('PER')}, ${name || ''}, ${emailNorm}, ${phone || ''}, ${!!smsConsent}, ${smsConsentAt || null}, ${smsConsentText || null})
    ON CONFLICT (email) DO UPDATE SET
      sms_consent = EXCLUDED.sms_consent,
      sms_consent_at = EXCLUDED.sms_consent_at,
      sms_consent_text = EXCLUDED.sms_consent_text
    RETURNING person_id
  `;
  return rows[0].person_id;
}

/**
 * Maps one adventure-form.js roster entry ({name, age, fitness, gearKit})
 * to a booking_participants row.
 *
 * CONFIRMED BY AIREY (2026-08-31, correcting this file's first draft): the
 * booker/contact may not be attending the adventure at all. adventure-
 * form.js collects "contact" (name/email/phone) entirely separately from
 * the roster list, with no flag at booking time saying which roster row
 * (if any) is the booker. That's genuinely not decided yet at booking
 * time — it's decided later, during the Adventure Prep roster-
 * confirmation step (Section 1.2a — reconfirmedRosterJson in the old
 * system), where the booker is explicitly asked whether they're on the
 * adventure and, if so, must identify themselves among the confirmed
 * roster. So: every roster row inserted here at booking time is
 * role_on_booking = 'attendee' and person_id = NULL (nobody is 'owner' or
 * linked to a Person yet — the live form never collects a per-roster-
 * member email to link one to anyway). Whichever booking_participants row
 * the booker identifies as themselves during that later reconfirmation
 * step is what should get UPDATEd to role_on_booking = 'owner' and
 * person_id = the booking's own person_id at that point — this is a TODO
 * for the Adventure Prep roster-reconfirmation rewrite (not yet done; see
 * the migration progress doc's "Not started yet" section), not something
 * resolved here.
 *
 * age_bucket and fitness_level (see schema.sql's own comment on the
 * latter column) are both saved regardless of the above — confirmed by
 * Airey: trail selection logic should eventually use both, even though it
 * doesn't yet ("a project for later"). Nothing here should silently drop
 * either value.
 */
function mapRosterEntry({ rosterIndex, entry }) {
  return {
    participant_id: genId('PART'),
    roster_index: rosterIndex,
    display_name: (entry && entry.name) || `Guest ${rosterIndex + 1}`,
    age_bucket: (entry && AGE_BUCKET_MAP[entry.age]) || null,
    fitness_level: (entry && entry.fitness) || null,
    role_on_booking: 'attendee',
    person_id: null,
    gear_kit: !!(entry && entry.gearKit),
  };
}

/**
 * One row per physical item — matches bookings-code.gs's
 * buildGearLogRows/gearRow exactly, PLUS (2026-08-31, roster/gear-kit
 * ID-link fix) now also carrying the real participant_id each kit belongs
 * to. `participantRows` is mapRosterEntry's output for the SAME roster
 * array, in the SAME order, so filtering it by the identical `gear_kit`
 * predicate `kitRoster` already uses yields the exact same subsequence,
 * 1:1, as `kitRoster` itself — this is what lets each physical gear-kit
 * row carry the roster entry's real participant_id instead of only ever
 * a denormalized person_name string. personName's own derivation is
 * UNCHANGED (still sourced from the raw roster entry's .name, with the
 * same `Kit ${k+1}` fallback) — only the new participant_id lookup is
 * added alongside it.
 */
function buildGearCheckLogRows({ bookingId, gearKitsSelected, duffelCount, roster, participantRows }) {
  const rows = [];
  const gearCount = Math.max(0, parseInt(gearKitsSelected, 10) || 0);
  const duffels = Math.max(0, parseInt(duffelCount, 10) || 0);
  const kitRoster = (roster || []).filter((p) => p && p.gearKit);
  const kitParticipants = (participantRows || []).filter((p) => p.gear_kit);

  const gearRow = (kitNumber, personName, itemName, participantId) => ({
    item_row_id: crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(),
    booking_id: bookingId,
    kit_number: kitNumber,
    person_name: personName,
    participant_id: participantId || null,
    item_name: itemName,
    item_cost: ITEM_COSTS[itemName] != null ? ITEM_COSTS[itemName] : null,
  });

  for (let k = 0; k < gearCount; k++) {
    const personName = (kitRoster[k] && kitRoster[k].name) ? kitRoster[k].name : `Kit ${k + 1}`;
    const participantId = kitParticipants[k] ? kitParticipants[k].participant_id : null;
    rows.push(gearRow(k + 1, personName, 'Gregory Miko 20L Backpack', participantId));
    rows.push(gearRow(k + 1, personName, 'Hydro Flask Big Mouth 32oz Bottle', participantId));
    rows.push(gearRow(k + 1, personName, 'Hydro Flask Big Mouth 32oz Bottle', participantId));
    rows.push(gearRow(k + 1, personName, 'Leki Khumbu Lite Trekking Poles', participantId));
    rows.push(gearRow(k + 1, personName, 'Hard-Shell First Aid Kit', participantId));
  }
  for (let d = 0; d < duffels; d++) {
    rows.push(gearRow(null, 'Shared', 'REI Pack Mule 90L Duffel'));
  }
  return rows;
}

/**
 * Postgres equivalent of handleSaveBooking + the inline
 * adventurePrep_ensureToken() call it made. Same overall contract:
 * returns { ok, personId, bookingId, gearLogRowsCreated, adventurePrepToken }
 * either way, so api/save-booking.js's downstream email/SMS-sending code
 * doesn't need to know whether this was a fresh save or a deduped retry.
 *
 * @param {object} payload - same shape api/save-booking.js already builds
 *   after verifyChargeAgainstStripe(): { contact: {name,email,phone,
 *   smsConsent,smsConsentAt,smsConsentText}, tier, date, timePreference,
 *   gearKitsSelected, duffelCount, total, paymentIntentId,
 *   depositPaymentIntentId, depositStatus, roster, taxAmount,
 *   policiesAgreed, policyVersionsAgreed, ...pre-launch intake fields }
 */
async function saveBooking(payload) {
  const contact = payload.contact || {};
  const personId = await findOrCreatePerson(contact);

  const mainPaymentIntentId = payload.paymentIntentId ? String(payload.paymentIntentId).trim() : null;
  const bookingId = genId('BK');
  const adventurePrepToken = crypto.randomUUID();

  const roster = Array.isArray(payload.roster) ? payload.roster : [];
  const gearKitsSelected = payload.gearKitsSelected || 0;
  const duffelCount = payload.duffelCount || 0;

  // Everything from here on the intake side that isn't a named column yet
  // (pre-launch Peaks to Pools/Custom intake — see schema.sql's own
  // comment on experience_bookings.intake_json for the full list and
  // reasoning).
  const INTAKE_KEYS = [
    'q1', 'q5_activity', 'q6_duration', 'q8_draws', 'q12', 'q13_recovery',
    'q14_taste', 'dietary_preferences', 'includeAfterTrail',
  ];
  const intake = {};
  INTAKE_KEYS.forEach((k) => {
    if (payload[k] !== undefined) intake[k] = payload[k];
  });
  const intakeJson = Object.keys(intake).length ? JSON.stringify(intake) : null;
  const policyVersionsAgreed = payload.policyVersionsAgreed ? JSON.stringify(payload.policyVersionsAgreed) : null;
  // NEW (2026-08-31, bookingDetail_get rewrite): verifyChargeAgainstStripe()
  // (api/save-booking.js) sets payload.paymentStatus to the verified
  // Stripe PaymentIntent's real status ('succeeded'/'processing') for
  // every trail/p2p booking. Custom tier skips Stripe verification
  // entirely, so payload.paymentStatus was ASSUMED never set for it —
  // defaulting to 'succeeded' here, the same fallback the .gs-era bucket
  // helper already used for rows that simply predated this field.
  //
  // BUG FIX (Task 11 follow-up, 2026-08-31, found while reviewing
  // adventure-form.js against this file): that assumption was wrong.
  // adventure-form.js's buildPayload() ALWAYS sends a paymentStatus —
  // for Custom tier specifically, it sends the literal string
  // 'not_charged_custom_quote' (never empty/undefined), so the `|| ...`
  // fallback above never actually fired for a single Custom booking.
  // 'not_charged_custom_quote' was written verbatim into
  // experience_bookings.payment_status, and
  // lib/ops-status-helpers.js's paymentStatusBucket() only recognizes
  // 'succeeded'/'processing' — anything else falls through to 'failed'.
  // Net effect: every Custom-tier booking would show Payment Status:
  // Failed on the Booking Detail / All Bookings ops pages, even though
  // nothing failed — Custom bookings are a personal follow-up quote that
  // was never supposed to go through Stripe verification at all. Fixed
  // at the source: Custom tier forces the real intended value
  // ('succeeded') regardless of what the frontend's own descriptive
  // paymentStatus string says, since that string was never meant to be
  // read as a literal payment_status column value.
  const paymentStatus = payload.tier === 'custom' ? 'succeeded' : (payload.paymentStatus || 'succeeded');

  // Step 1: atomic dedup-or-insert. A brand new bookingId can never itself
  // collide (fresh UUID-derived PK) — the only possible conflict is on
  // main_payment_intent_id, meaning this exact PaymentIntent already has a
  // booking on file. See this file's header comment for why this replaces
  // the old separate pre-check + recovery-lookup dance.
  const inserted = await sql`
    INSERT INTO experience_bookings (
      booking_id, person_id, contact_name, contact_email, contact_phone,
      tier, date, time_preference, gear_kit_count, duffel_count, total,
      main_payment_intent_id, deposit_payment_intent_id, deposit_status,
      sms_consent, sms_consent_at, sms_consent_text, adventure_prep_token,
      booking_status, tax_amount, policies_agreed, policy_versions_agreed,
      intake_json, payment_status
    ) VALUES (
      ${bookingId}, ${personId}, ${contact.name || ''}, ${contact.email || ''}, ${contact.phone || ''},
      ${payload.tier || ''}, ${payload.date || null}, ${payload.timePreference || ''}, ${gearKitsSelected}, ${duffelCount}, ${payload.total || 0},
      ${mainPaymentIntentId}, ${payload.depositPaymentIntentId || ''}, ${payload.depositStatus || null},
      ${!!contact.smsConsent}, ${contact.smsConsentAt || null}, ${contact.smsConsentText || null}, ${adventurePrepToken},
      'active', ${payload.taxAmount != null ? payload.taxAmount : null}, ${payload.policiesAgreed != null ? !!payload.policiesAgreed : null}, ${policyVersionsAgreed},
      ${intakeJson}, ${paymentStatus}
    )
    ON CONFLICT (main_payment_intent_id) WHERE main_payment_intent_id IS NOT NULL DO NOTHING
    RETURNING *
  `;

  if (inserted.length === 0) {
    // Exact retry of an already-saved PaymentIntent (Custom tier can never
    // land here — mainPaymentIntentId is NULL for it, and NULL never
    // conflicts). Recover the existing row instead of erroring or
    // duplicating, matching the old getBookingByPaymentIntentId recovery
    // contract api/save-booking.js already expects.
    const existingRows = await sql`
      SELECT booking_id, person_id, adventure_prep_token
      FROM experience_bookings
      WHERE main_payment_intent_id = ${mainPaymentIntentId}
    `;
    const existing = existingRows[0];
    const countRows = await sql`
      SELECT count(*)::int AS n FROM gear_check_log WHERE booking_id = ${existing.booking_id}
    `;
    return {
      ok: true,
      deduped: true,
      personId: existing.person_id,
      bookingId: existing.booking_id,
      gearLogRowsCreated: countRows[0].n,
      adventurePrepToken: existing.adventure_prep_token || '',
    };
  }

  // Step 2: participants + gear check log, one atomic batch. All IDs are
  // pre-generated in JS above/below, so this satisfies lib/db.js's
  // "every query must be buildable before any of them execute" constraint
  // — nothing here needs to read back a result mid-transaction.
  const participantRows = roster.map((entry, i) => mapRosterEntry({ rosterIndex: i, entry }));
  const gearRows = buildGearCheckLogRows({ bookingId, gearKitsSelected, duffelCount, roster, participantRows });

  if (participantRows.length || gearRows.length) {
    await transaction((txSql) => {
      const queries = [];
      participantRows.forEach((p) => {
        queries.push(txSql`
          INSERT INTO booking_participants (
            participant_id, experience_booking_id, person_id, roster_index,
            display_name, age_bucket, fitness_level, role_on_booking, is_participating, gear_kit
          ) VALUES (
            ${p.participant_id}, ${bookingId}, ${p.person_id}, ${p.roster_index},
            ${p.display_name}, ${p.age_bucket}, ${p.fitness_level}, ${p.role_on_booking}, true, ${p.gear_kit}
          )
        `);
      });
      gearRows.forEach((g) => {
        queries.push(txSql`
          INSERT INTO gear_check_log (
            item_row_id, booking_id, kit_number, person_name, participant_id, item_name, item_cost
          ) VALUES (
            ${g.item_row_id}, ${g.booking_id}, ${g.kit_number}, ${g.person_name}, ${g.participant_id}, ${g.item_name}, ${g.item_cost}
          )
        `);
      });
      return queries;
    });
  }

  return {
    ok: true,
    deduped: false,
    personId,
    bookingId,
    gearLogRowsCreated: gearRows.length,
    adventurePrepToken,
  };
}

/**
 * Postgres equivalent of handleGetBooking — same "prefer Adventure Prep's
 * confirmedKitCount over the booking-time count, when it exists" fix,
 * ported forward rather than re-litigated.
 */
async function getBooking(bookingId) {
  const rows = await sql`
    SELECT eb.booking_id, eb.tier, eb.gear_kit_count, eb.main_payment_intent_id,
           eb.deposit_payment_intent_id, eb.deposit_status, ap.confirmed_kit_count
    FROM experience_bookings eb
    LEFT JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
    WHERE eb.booking_id = ${bookingId}
  `;
  if (!rows.length) return { ok: false, error: 'Booking not found' };
  const row = rows[0];
  const hasConfirmedCount = row.confirmed_kit_count !== null && row.confirmed_kit_count !== undefined;
  return {
    ok: true,
    bookingId: row.booking_id,
    tier: row.tier,
    gearKitCount: hasConfirmedCount ? row.confirmed_kit_count : row.gear_kit_count,
    mainPaymentIntentId: row.main_payment_intent_id,
    depositPaymentIntentId: row.deposit_payment_intent_id,
    depositStatus: row.deposit_status,
  };
}

/**
 * Postgres equivalent of handleGetBookingByPaymentIntentId. Kept as a
 * standalone export (not just inlined into saveBooking's own dedup branch
 * above) since api/create-deposit-hold.js and other callers may still
 * want a read-only lookup by PaymentIntent independent of a save attempt.
 */
async function getBookingByPaymentIntentId(paymentIntentId) {
  const pid = String(paymentIntentId || '').trim();
  if (!pid) return { ok: false, error: 'Missing paymentIntentId' };
  const rows = await sql`
    SELECT booking_id, person_id, adventure_prep_token
    FROM experience_bookings
    WHERE main_payment_intent_id = ${pid}
  `;
  if (!rows.length) return { ok: false, error: 'No booking found for that PaymentIntent.' };
  const row = rows[0];
  const countRows = await sql`SELECT count(*)::int AS n FROM gear_check_log WHERE booking_id = ${row.booking_id}`;
  return {
    ok: true,
    personId: row.person_id,
    bookingId: row.booking_id,
    gearLogRowsCreated: countRows[0].n,
    adventurePrepToken: row.adventure_prep_token || '',
  };
}

/**
 * Postgres equivalent of handleUpdateDepositStatus, including the
 * guardReconciled compare-and-swap check. A single guarded UPDATE is
 * already atomic in Postgres (see lib/db.js's own header comment) — no
 * LockService/transaction needed, matching every other CAS pattern in
 * this migration.
 */
async function updateDepositStatus({ bookingId, depositPaymentIntentId, depositStatus, guardReconciled }) {
  if (guardReconciled) {
    // BUG FIX (2026-08-31, deposit-hold engine build session): 'refunded'
    // was missing from this list. It's exactly as terminal/reconciled as
    // the five statuses already here (lib/gear-service.js's own
    // ALREADY_RECONCILED_STATUSES, used by api/reconcile-gear-deposit.js's
    // idempotent-no-op check, already includes it — payment-review Medium
    // #35) — a booking whose deposit/shortfall has been fully refunded is
    // just as "already resolved, don't let a renewal clobber it" as one
    // sitting at 'full_capture' or 'shortfall_charged'. Without this, a
    // hold renewal landing after a full refund would have overwritten
    // deposit_status back to whatever the renewal produced (typically
    // 'held'), silently reviving a fully-settled booking's deposit state
    // and placing a brand-new live Stripe hold on a guest's card weeks
    // after their refund. Same class of bug this whole guardReconciled
    // mechanism (Follow-up A) exists to prevent — just one status short.
    const RECONCILED_DEPOSIT_STATUSES = [
      'released', 'partial_capture', 'full_capture', 'full_capture_pending_review', 'shortfall_charged', 'refunded',
    ];
    const rows = await sql`
      UPDATE experience_bookings
      SET deposit_payment_intent_id = ${depositPaymentIntentId || ''},
          deposit_status = ${depositStatus || null}
      WHERE booking_id = ${bookingId}
        AND (deposit_status IS NULL OR NOT (deposit_status::text = ANY(${RECONCILED_DEPOSIT_STATUSES})))
      RETURNING deposit_status
    `;
    if (rows.length === 0) {
      const currentRows = await sql`SELECT deposit_status FROM experience_bookings WHERE booking_id = ${bookingId}`;
      if (!currentRows.length) return { ok: false, error: 'Booking not found' };
      return { ok: false, stale: true, bookingId, currentDepositStatus: currentRows[0].deposit_status };
    }
    return { ok: true };
  }

  const rows = await sql`
    UPDATE experience_bookings
    SET deposit_payment_intent_id = ${depositPaymentIntentId || ''},
        deposit_status = ${depositStatus || null}
    WHERE booking_id = ${bookingId}
    RETURNING booking_id
  `;
  if (!rows.length) return { ok: false, error: 'Booking not found' };
  return { ok: true };
}

module.exports = {
  ITEM_COSTS,
  findOrCreatePerson,
  saveBooking,
  getBooking,
  getBookingByPaymentIntentId,
  updateDepositStatus,
};
