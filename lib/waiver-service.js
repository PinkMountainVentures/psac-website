/**
 * lib/waiver-service.js
 *
 * NEW. Postgres replacement for adventure-prep-actions.gs's Waiver
 * Signatures / Emergency Contact / signer-link functions —
 * adventurePrep_getSignerContext / saveWaiverSignature / saveSignerDetails
 * / saveEmergencyContact / markSignerOpened / sendSignerLinks — called by
 * api/waiver.js (Surface B, the non-owner signer flow, plus the owner's
 * own waiver-signing action) and by api/adventure-prep.js's
 * sendSignerLinks action. This closes the LAST launch-blocking gap
 * flagged in api/adventure-prep.js's own header comment.
 *
 * ============================================================================
 * THE GUARDIAN HYBRID MODEL (PRD Section 6, resolved by Airey 2026-08-31)
 * ============================================================================
 *
 * This is genuinely new logic, not a mechanical port — the pre-migration
 * system only ever implemented Model 1 (self-declare: a signer is asked
 * directly whether they're a guardian, "never inferred from the roster").
 * Airey's resolution is a hybrid, not a pure pick of either model:
 *
 *   - ASSIGNMENT (new): the booker names a guardian for each minor at
 *     roster-confirmation time — lib/adventure-prep-service.js's
 *     confirmRoster() now does this (see that file's own header comment),
 *     writing booking_participants.guardian_person_id as an INVITATION,
 *     not yet a certified fact.
 *   - VERIFICATION (preserved from Model 1): the assigned guardian must
 *     still affirmatively confirm the relationship at their own link —
 *     the same self-declare certification Model 1 already built
 *     (isGuardian / guardianForChildrenJson on Waiver Signatures). THIS
 *     FILE is where that confirmation actually lands: saveWaiverSignature
 *     below sets booking_participants.guardian_verified_at for every
 *     minor a signer certifies for, regardless of whether that signer was
 *     pre-assigned by the booker or is self-declaring with no prior
 *     assignment at all (Model 1 fallback — a real guardian relationship
 *     the booker never thought to name ahead of time still gets certified
 *     correctly; guardian_person_id gets backfilled in that case too, not
 *     just guardian_verified_at).
 *
 * ============================================================================
 * WHAT ELSE CHANGED FROM THE APPS SCRIPT VERSION, AND WHY
 * ============================================================================
 *
 * 1. `participant_id` REPLACES THE FREE-TEXT `rosterRef` ENTIRELY (PRD
 *    Section 4.6). Every waiver_signatures row created by
 *    sendSignerLinksForBooking below is keyed to a real
 *    booking_participants.participant_id from the moment it's created,
 *    not a positional/string rosterRef resolved by scanning JSON later.
 *    `guardianForChildren` in saveWaiverSignature's payload is now
 *    `guardianForChildrenParticipantIds` (an array of participant_ids),
 *    for the same reason — the old name-based/ageRange-based matching
 *    (and its own en-dash bug, fixed independently in the pre-migration
 *    version) is structurally impossible to have anymore once minors are
 *    real rows with real IDs instead of JSON entries. FLAG FOR AIREY /
 *    task 11 (frontend request-shape check, already a listed pending
 *    task): the frontend (waiver-signer-form.js) needs to send participant
 *    IDs, not names, once it's updated to call this contract — same
 *    "backend commits to the sensible new shape, frontend catches up"
 *    pattern already used for confirmRoster.
 * 2. sendSignerLinksForBooking DERIVES ITS OWN SIGNER LIST FROM
 *    booking_participants SERVER-SIDE, rather than trusting a
 *    client-supplied `signers` array (the old payload.signers). Now that
 *    booking_participants is the one canonical roster with real
 *    participant_ids, there's no reason to have the client rebuild that
 *    same list and pass it back in — and trusting a client-supplied list
 *    for something that grants a signing link is exactly the kind of
 *    thing that should be server-derived. Two groups get links: ordinary
 *    adult attendees (role_on_booking = 'attendee', is_participating,
 *    NOT a minor age_bucket) and non-attending assigned guardians
 *    (role_on_booking = 'guardian_only') — per Section 6's explicit
 *    instruction that sendSignerLinks "needs to read guardian_person_id
 *    assignments off Booking Participants and send a distinct link to any
 *    assigned guardian who isn't already an attending roster member."
 *    An attending adult who was ALSO assigned as a guardian does NOT get
 *    a second link — their ordinary signer link already carries the
 *    self-declare guardian checklist (getSignerContext's `minors` below),
 *    exactly as Model 1 already worked; only a genuinely separate,
 *    non-attending guardian needs a link that wouldn't otherwise exist.
 * 3. Idempotent per participant_id, not per rosterRef string match — same
 *    "re-running Confirm & Send updates the same row, never duplicates or
 *    silently resets an already-signed one back to 'sent'" guarantee the
 *    pre-migration version's own bug-fix comment already established,
 *    now backed by a real FK instead of a scanned string comparison.
 * 4. recomputeAllWaiversComplete's REQUIRED-SIGNER SET now ALSO INCLUDES
 *    guardian_only rows, not just the owner + non-owner attendees — a
 *    non-attending assigned guardian's certification is just as required
 *    as an attending signer's before a booking's waivers can be complete,
 *    since Section 6 makes their record just as real as an attendee's.
 */

'use strict';

const { sql, query, transaction } = require('./db');
const { genId } = require('./ids');
const { findOrCreatePersonMinimal, MINOR_AGE_BUCKETS } = require('./adventure-prep-service');
const { mapCandidateTrailRow } = require('./booking-detail-service');

function nowIso() {
  return new Date().toISOString();
}

async function findBookingByToken(token) {
  const rows = await sql`
    SELECT booking_id, person_id, contact_name, contact_email, tier, date
    FROM experience_bookings
    WHERE adventure_prep_token = ${token}
  `;
  return rows[0] || null;
}

async function findBookingById(bookingId) {
  const rows = await sql`
    SELECT booking_id, person_id, contact_name, contact_email, tier, date, time_preference
    FROM experience_bookings
    WHERE booking_id = ${bookingId}
  `;
  return rows[0] || null;
}

async function getCurrentWaiverContent() {
  const rows = await sql`SELECT version, status_tag, body_html FROM waiver_versions WHERE is_current = true LIMIT 1`;
  return rows[0] ? { version: rows[0].version, statusTag: rows[0].status_tag, bodyHtml: rows[0].body_html } : null;
}

/**
 * Recomputes adventure_prep.all_waivers_complete — mirrors the
 * pre-migration adventurePrep_recomputeAllWaiversComplete_'s required-
 * signer logic, extended per this file's header comment, point 4:
 * required signers = the owner (if adventure_prep.is_participating isn't
 * explicitly false) + every 'non_owner' Waiver Signatures row this
 * booking has sent (one per required attendee/guardian_only signer,
 * written by sendSignerLinksForBooking below). Complete only when every
 * required row's status is 'signed'.
 */
async function recomputeAllWaiversComplete(bookingId) {
  const [sigRows, apRows] = await Promise.all([
    sql`SELECT role, status FROM waiver_signatures WHERE booking_id = ${bookingId}`,
    sql`SELECT is_participating FROM adventure_prep WHERE booking_id = ${bookingId}`,
  ]);
  const ownerRequired = !apRows[0] || apRows[0].is_participating !== false;
  const ownerRow = sigRows.find((r) => r.role === 'owner');
  const nonOwnerRows = sigRows.filter((r) => r.role === 'non_owner');

  let allComplete = true;
  if (ownerRequired && (!ownerRow || ownerRow.status !== 'signed')) allComplete = false;
  nonOwnerRows.forEach((r) => { if (r.status !== 'signed') allComplete = false; });

  await sql`
    INSERT INTO adventure_prep (booking_id, all_waivers_complete) VALUES (${bookingId}, ${allComplete})
    ON CONFLICT (booking_id) DO UPDATE SET all_waivers_complete = EXCLUDED.all_waivers_complete
  `;
  return allComplete;
}

/**
 * Applies a signer's guardian certification to booking_participants —
 * the VERIFICATION half of Section 6's hybrid model (see this file's
 * header comment). For every minor participant_id this signer certifies
 * for: sets guardian_verified_at = now(), and backfills
 * guardian_person_id to this signer's resolved person_id if it wasn't
 * already assigned (the Model 1 self-declare fallback — a guardian
 * relationship the booker never pre-named still gets certified
 * correctly). Never un-certifies a minor not present in this call — this
 * only adds certifications, consistent with booking_participants' general
 * "don't destroy data" posture elsewhere in this migration.
 */
async function applyGuardianCertification({ bookingId, signerPersonId, participantIds }) {
  if (!signerPersonId || !participantIds || !participantIds.length) return;
  const now = nowIso();
  await transaction((txSql) => participantIds.map((pid) => txSql`
    UPDATE booking_participants
    SET guardian_person_id = COALESCE(guardian_person_id, ${signerPersonId}),
        guardian_verified_at = ${now},
        updated_at = now()
    WHERE participant_id = ${pid} AND experience_booking_id = ${bookingId}
  `));
}

/**
 * Postgres equivalent of adventurePrep_saveWaiverSignature — handles BOTH
 * the booking owner (`token`, role='owner') and a non-owner signer
 * (`signerToken`, role='non_owner'). Upserts: visiting the same link
 * twice updates the same row, never creates a duplicate — the row is
 * found either by `signer_token` (non-owner) or by (booking_id,
 * role='owner') (owner), same lookup shape as the pre-migration version.
 */
async function saveWaiverSignature(payload) {
  let bookingId, role, signatureId, participantId, resolvedPersonId;

  if (payload.signerToken) {
    const rows = await sql`SELECT signature_id, booking_id, participant_id FROM waiver_signatures WHERE signer_token = ${payload.signerToken}`;
    if (!rows.length) return { ok: false, error: 'Invalid or expired signer link' };
    bookingId = rows[0].booking_id;
    role = 'non_owner';
    signatureId = rows[0].signature_id;
    participantId = rows[0].participant_id;
  } else if (payload.token) {
    const booking = await findBookingByToken(payload.token);
    if (!booking) return { ok: false, error: 'Invalid or expired link' };
    bookingId = booking.booking_id;
    role = 'owner';
    const existingOwnerRows = await sql`SELECT signature_id FROM waiver_signatures WHERE booking_id = ${bookingId} AND role = 'owner'`;
    signatureId = existingOwnerRows[0] ? existingOwnerRows[0].signature_id : genId('SIG');
    resolvedPersonId = booking.person_id; // the owner already has a real person_id from booking time
  } else {
    return { ok: false, error: 'Missing token or signerToken' };
  }

  // Resolve a real person_id for a non-owner signer from their own
  // submitted name/email — the same moment a previously-anonymous
  // attendee's booking_participants row gets linked to a real person, not
  // just this signature row. Uses the SMS-consent-safe minimal upsert
  // (see adventure-prep-service.js's own comment on why) since SMS
  // consent, when given, is captured by this same call and applied
  // directly to the People row below via a real findOrCreatePerson-style
  // write is unnecessary here — sms_consent on `people` is only ever set
  // by the booking flow itself; this signer-side smsConsent value is
  // preserved on the Waiver Signature row exactly as the pre-migration
  // version did (WAIVER_SIGNATURES_HEADERS carries its own smsConsent
  // columns) and never propagated onto `people`.
  if (role === 'non_owner' && payload.signerEmail) {
    resolvedPersonId = await findOrCreatePersonMinimal(payload.signerName, payload.signerEmail);
  }

  const waiverContent = await getCurrentWaiverContent();
  const now = nowIso();
  const guardianForChildrenParticipantIds = Array.isArray(payload.guardianForChildrenParticipantIds)
    ? payload.guardianForChildrenParticipantIds
    : [];

  const queries = [
    sql`
      INSERT INTO waiver_signatures (
        signature_id, booking_id, person_id, participant_id, signer_token, role,
        signer_name, signer_email, signer_phone, sms_consent, sms_consent_at, sms_consent_text,
        is_guardian, guardian_for_children_json, waiver_version, participants_covered_json,
        ip_address, status, signed_at, created_at
      ) VALUES (
        ${signatureId}, ${bookingId}, ${resolvedPersonId || null}, ${participantId || null}, ${payload.signerToken || null}, ${role},
        ${payload.signerName || ''}, ${payload.signerEmail || ''}, ${payload.signerPhone || ''},
        ${payload.smsConsent !== undefined ? !!payload.smsConsent : null},
        ${payload.smsConsent !== undefined ? (payload.smsConsentAt || now) : null},
        ${payload.smsConsent !== undefined ? (payload.smsConsentText || '') : null},
        ${!!payload.isGuardian}, ${JSON.stringify(guardianForChildrenParticipantIds)},
        ${waiverContent ? waiverContent.version : null}, ${JSON.stringify(payload.participantsCovered || [])},
        ${payload.ipAddress || ''}, 'signed', ${now}, ${now}
      )
      ON CONFLICT (signature_id) DO UPDATE SET
        person_id = EXCLUDED.person_id,
        signer_name = EXCLUDED.signer_name,
        signer_email = EXCLUDED.signer_email,
        signer_phone = EXCLUDED.signer_phone,
        sms_consent = COALESCE(EXCLUDED.sms_consent, waiver_signatures.sms_consent),
        sms_consent_at = COALESCE(EXCLUDED.sms_consent_at, waiver_signatures.sms_consent_at),
        sms_consent_text = COALESCE(EXCLUDED.sms_consent_text, waiver_signatures.sms_consent_text),
        is_guardian = EXCLUDED.is_guardian,
        guardian_for_children_json = EXCLUDED.guardian_for_children_json,
        waiver_version = EXCLUDED.waiver_version,
        participants_covered_json = EXCLUDED.participants_covered_json,
        ip_address = EXCLUDED.ip_address,
        status = 'signed',
        signed_at = EXCLUDED.signed_at
    `,
  ];
  await Promise.all(queries);

  // Backfill this signer's OWN booking_participants row with a resolved
  // person_id, same "signing is a natural moment to resolve identity"
  // reasoning as confirmRoster's guardian backfill.
  if (role === 'non_owner' && participantId && resolvedPersonId) {
    await sql`
      UPDATE booking_participants SET person_id = ${resolvedPersonId}, email = COALESCE(email, ${payload.signerEmail || null}), updated_at = now()
      WHERE participant_id = ${participantId} AND experience_booking_id = ${bookingId} AND person_id IS NULL
    `;
  }

  if (payload.isGuardian && guardianForChildrenParticipantIds.length && resolvedPersonId) {
    await applyGuardianCertification({ bookingId, signerPersonId: resolvedPersonId, participantIds: guardianForChildrenParticipantIds });
  }

  await recomputeAllWaiversComplete(bookingId);

  return { ok: true, bookingId, signedAt: now };
}

/**
 * Postgres equivalent of adventurePrep_saveSignerDetails — Surface B's
 * "Confirm Your Details" hub tile. Deliberately separate from
 * saveWaiverSignature above: that function unconditionally marks
 * status='signed' every time it runs, which would incorrectly mark an
 * unsigned waiver as signed if this were reused for contact-details-only
 * saves in the hub's free (non-linear) ordering. signerToken only — the
 * booking owner's own contact info is edited in the booking flow, not
 * here.
 */
async function saveSignerDetails(payload) {
  if (!payload.signerToken) return { ok: false, error: 'Missing signerToken' };
  const rows = await sql`SELECT signature_id FROM waiver_signatures WHERE signer_token = ${payload.signerToken}`;
  if (!rows.length) return { ok: false, error: 'Invalid or expired signer link' };
  const now = nowIso();

  const setClauses = [];
  const params = [];
  function set(column, value) {
    params.push(value);
    setClauses.push(`${column} = $${params.length}`);
  }
  if (payload.signerEmail !== undefined) set('signer_email', payload.signerEmail || '');
  if (payload.signerPhone !== undefined) set('signer_phone', payload.signerPhone || '');
  if (payload.smsConsent !== undefined) {
    set('sms_consent', !!payload.smsConsent);
    set('sms_consent_at', payload.smsConsentAt || now);
    set('sms_consent_text', payload.smsConsentText || '');
  }
  set('details_confirmed_at', now);
  params.push(payload.signerToken);
  await query(`UPDATE waiver_signatures SET ${setClauses.join(', ')} WHERE signer_token = $${params.length}`, params);

  return { ok: true, detailsConfirmedAt: now };
}

/**
 * Postgres equivalent of adventurePrep_saveEmergencyContact.
 * `participant_id` replaces the old free-text `personRef` — resolved from
 * either `signerToken` (that signer's own participant row) or `token`
 * (null — the owner isn't necessarily a booking_participants row at all
 * unless confirmRoster has already run, same as the pre-migration
 * version's own 'owner' string sentinel carried no participant reference
 * either).
 */
async function saveEmergencyContact(payload) {
  let bookingId, participantId, personId;
  if (payload.signerToken) {
    const rows = await sql`SELECT booking_id, participant_id, person_id FROM waiver_signatures WHERE signer_token = ${payload.signerToken}`;
    if (!rows.length) return { ok: false, error: 'Invalid or expired signer link' };
    bookingId = rows[0].booking_id;
    participantId = rows[0].participant_id;
    personId = rows[0].person_id;
  } else if (payload.token) {
    const booking = await findBookingByToken(payload.token);
    if (!booking) return { ok: false, error: 'Invalid or expired link' };
    bookingId = booking.booking_id;
    personId = booking.person_id;
  } else {
    return { ok: false, error: 'Missing token or signerToken' };
  }

  await sql`
    INSERT INTO emergency_contact (contact_id, booking_id, person_id, participant_id, contact_name, contact_phone, contact_email)
    VALUES (${genId('EC')}, ${bookingId}, ${personId || null}, ${participantId || null}, ${payload.contactName || ''}, ${payload.contactPhone || ''}, ${payload.contactEmail || ''})
  `;
  return { ok: true };
}

/**
 * Postgres equivalent of adventurePrep_sendSignerLinks — see this file's
 * header comment, point 2, for the server-derives-its-own-signer-list
 * design change. Returns the same shape the pre-migration version did
 * ({ok, signers: [{name, email, signerToken, participantId}], ownerName,
 * tripDate}) so api/adventure-prep.js's sendSignerLinks action (which
 * still owns the actual emailing, unchanged) needs only a small update to
 * call this instead of callBookingsWebApp.
 */
async function sendSignerLinksForBooking(token) {
  const booking = await findBookingByToken(token);
  if (!booking) return { ok: false, error: 'Invalid or expired link' };

  const eligibleRows = await sql`
    SELECT participant_id, display_name, email, role_on_booking, age_bucket, person_id
    FROM booking_participants
    WHERE experience_booking_id = ${booking.booking_id}
      AND (
        (role_on_booking = 'attendee' AND is_participating = true AND (age_bucket IS NULL OR age_bucket NOT IN ('under_14', '14_17')))
        OR role_on_booking = 'guardian_only'
      )
    ORDER BY roster_index
  `;
  if (!eligibleRows.length) {
    return { ok: true, signers: [], ownerName: booking.contact_name, tripDate: booking.date };
  }

  // NEW (copy pass, 2026-09-03): the invite email needs the same
  // pre-assigned-guardian signal getSignerContext already resolves for
  // the hub (booking_participants.guardian_person_id, set at Surface A
  // roster confirmation). Resolved here as its own small query rather
  // than folded into eligibleRows above, since minors themselves are
  // excluded from that query's WHERE clause and don't need the rest of
  // its shape (email/signerToken bookkeeping) at all.
  const minorRows = await sql`
    SELECT display_name, age_bucket, guardian_person_id
    FROM booking_participants
    WHERE experience_booking_id = ${booking.booking_id}
      AND is_participating = true
      AND age_bucket IN ('under_14', '14_17')
      AND guardian_person_id IS NOT NULL
  `;
  const guardianChildNamesByPersonId = {};
  minorRows.forEach((m) => {
    if (!guardianChildNamesByPersonId[m.guardian_person_id]) guardianChildNamesByPersonId[m.guardian_person_id] = [];
    guardianChildNamesByPersonId[m.guardian_person_id].push(m.display_name);
  });

  const existingSigRows = await sql`
    SELECT signature_id, participant_id, signer_token, status FROM waiver_signatures
    WHERE booking_id = ${booking.booking_id} AND participant_id IS NOT NULL
  `;
  const existingByParticipantId = {};
  existingSigRows.forEach((r) => { existingByParticipantId[r.participant_id] = r; });

  const now = nowIso();
  const results = [];
  const queries = [];

  eligibleRows.forEach((p) => {
    const existing = existingByParticipantId[p.participant_id];
    // Idempotent per participant_id (see this file's header comment, point
    // 3): re-running "Confirm & Send" for a participant who already has a
    // link updates that same row (keeping their token and, crucially,
    // their 'signed' status if they've already completed it) rather than
    // duplicating it or resetting a completed signature back to 'sent'.
    const signatureId = existing ? existing.signature_id : genId('SIG');
    const signerToken = existing && existing.signer_token ? existing.signer_token : genId();
    const status = existing && existing.status === 'signed' ? 'signed' : 'sent';

    queries.push(sql`
      INSERT INTO waiver_signatures (signature_id, booking_id, person_id, participant_id, signer_token, role, signer_name, signer_email, status, sent_at, created_at)
      VALUES (${signatureId}, ${booking.booking_id}, ${p.person_id || null}, ${p.participant_id}, ${signerToken}, 'non_owner', ${p.display_name || ''}, ${p.email || ''}, ${status}, ${now}, ${now})
      ON CONFLICT (signature_id) DO UPDATE SET
        person_id = COALESCE(waiver_signatures.person_id, EXCLUDED.person_id),
        signer_name = EXCLUDED.signer_name,
        signer_email = EXCLUDED.signer_email,
        status = ${status},
        sent_at = EXCLUDED.sent_at
    `);

    var attendingGuardianChildNames = (p.person_id && guardianChildNamesByPersonId[p.person_id]) || [];
    results.push({
      name: p.display_name,
      email: p.email,
      signerToken,
      participantId: p.participant_id,
      isGuardianOnly: p.role_on_booking === 'guardian_only',
      // NEW (copy pass, 2026-09-03): true for an attending adult (3.3's
      // case) the booker pre-assigned as a minor's guardian at roster
      // time -- distinct from isGuardianOnly above, which is Part 5's
      // non-attending case. Lets the invite email greet a guardian by
      // name before they ever open the hub, same signal getSignerContext
      // already surfaces there as preAssignedToThisSigner.
      isAttendingGuardian: attendingGuardianChildNames.length > 0,
      guardianForChildNames: attendingGuardianChildNames,
    });
  });

  await Promise.all(queries);
  await recomputeAllWaiversComplete(booking.booking_id);

  return { ok: true, signers: results, ownerName: booking.contact_name, tripDate: booking.date };
}

/**
 * Postgres equivalent of adventurePrep_getSignerContext — Surface B's
 * one load-everything call. Returns the roster's minor rows (for the
 * guardian self-declare certification checklist — Model 1's UI,
 * preserved per Section 6) and this signer's own current row state, plus
 * candidateTrails/selectedTrailId/waiverContent for the Adventure Home
 * hub tiles (Round 2), same shape as the pre-migration version.
 */
async function getSignerContext(signerToken) {
  const sigRows = await sql`SELECT * FROM waiver_signatures WHERE signer_token = ${signerToken}`;
  if (!sigRows.length) return { notFound: true };
  const signer = sigRows[0];

  const booking = await findBookingById(signer.booking_id);
  if (!booking) return { notFound: true };

  const [apRows, rosterRows, ownRows, waiverContent] = await Promise.all([
    // BUG FIX (Sept 2026, Attendees walkthrough follow-up): this used to
    // select only trail_name/opening_description, so computeStatus()'s
    // candidateTrails-matching lookup (which needs distance/elevation/
    // difficulty/technical ratings, not just a name) could never find a
    // match -- Surface B's "Your Trail" tile silently rendered a blank
    // second line, and there was no trail card at all, even once the
    // booker had already picked a trail. Same candidate_trails JOIN
    // booking-detail-service.js's own getBookingDetail already uses, via
    // its shared mapCandidateTrailRow, scoped to just the one selected
    // trail (Surface B never needs the other candidates).
    //
    // est_time_easy_pace added (non-attending guardian branch, 2026-09-03):
    // the only real duration data anywhere in this schema, used for Part
    // 5's "The Day" tile expected-return estimate below -- deliberately
    // the conservative (longer) pace, never the strong-pace number, since
    // this is shown to a guardian who isn't there to see it run long.
    sql`
      SELECT ap.selected_trail_id, ap.assignment_method,
             ap.property_type, ap.delivery_window, ap.ride_with_gps_experience_access,
             ct.rank, ct.source, ct.matched_attributes, ct.difficulty_rating,
             ct.technical_rating, ct.distance, ct.elevation,
             t.trail_name, t.opening_description, t.photo_references, t.park,
             t.trailhead_name, t.trail_day_tip, t.est_time_easy_pace
      FROM adventure_prep ap
      LEFT JOIN trails t ON t.trail_id = ap.selected_trail_id
      LEFT JOIN candidate_trails ct ON ct.trail_id = ap.selected_trail_id AND ct.experience_booking_id = ap.booking_id
      WHERE ap.booking_id = ${signer.booking_id}
    `,
    sql`
      SELECT participant_id, display_name, age_bucket, guardian_person_id, guardian_verified_at
      FROM booking_participants
      WHERE experience_booking_id = ${signer.booking_id} AND is_participating = true
      ORDER BY roster_index
    `,
    // NEW (non-attending guardian branch, 2026-09-03): this signer's own
    // booking_participants row -- role_on_booking isn't on waiver_signatures
    // itself, and this signer is deliberately excluded from rosterRows
    // above (is_participating = false for a guardian_only row, same as
    // every other non-attending person), so it needs its own lookup.
    signer.participant_id
      ? sql`SELECT role_on_booking FROM booking_participants WHERE participant_id = ${signer.participant_id}`
      : Promise.resolve([]),
    getCurrentWaiverContent(),
  ]);
  const ap = apRows[0] || null;
  const isGuardianOnly = !!(ownRows[0] && ownRows[0].role_on_booking === 'guardian_only');

  const minors = rosterRows
    .filter((p) => MINOR_AGE_BUCKETS.has(p.age_bucket))
    .map((p) => ({
      participantId: p.participant_id,
      name: p.display_name,
      ageBucket: p.age_bucket,
      // Surfaces whether THIS specific signer is the pre-assigned guardian
      // for this child (Section 6's assignment half) so the frontend can
      // pre-check the certification box for an assignment the booker
      // already made, while still requiring the affirmative click —
      // never auto-certifying without it.
      preAssignedToThisSigner: p.guardian_person_id === signer.person_id && !!signer.person_id,
      alreadyVerified: !!p.guardian_verified_at,
    }));

  // NEW (non-attending guardian branch, 2026-09-03): the adults actually
  // on the trail, for Part 5's "Who's Going" tile -- same rosterRows
  // source as minors above, just the complementary filter. Only meaningful
  // for a guardian_only signer (an attending signer already sees these
  // people on their own roster elsewhere), but harmless to compute either
  // way since it's already-fetched data, not a new query.
  const attendingAdults = rosterRows
    .filter((p) => !MINOR_AGE_BUCKETS.has(p.age_bucket))
    .map((p) => ({ participantId: p.participant_id, name: p.display_name }));

  return {
    bookingId: signer.booking_id,
    ownerName: booking.contact_name,
    tripDate: booking.date,
    timePreference: booking.time_preference,
    minors,
    attendingAdults,
    isGuardianOnly,
    selectedTrailId: ap ? ap.selected_trail_id : null,
    selectedTrail: ap && ap.selected_trail_id ? mapCandidateTrailRow(Object.assign({}, ap, { trail_id: ap.selected_trail_id })) : null,
    // NEW (Phase 1/2 escalating hub arc, 2026-09-03): the hub-lifecycle-
    // alerts-proposal's Phase 2 states (delivery-day, guide-unlocked) need
    // the same fields Surface A's own hub already reads off its
    // adventurePrep row -- these were never selected here before because
    // nothing on Surface B needed them until this arc.
    propertyType: ap ? ap.property_type : null,
    deliveryWindow: ap ? ap.delivery_window : null,
    rideWithGpsExperienceAccess: ap ? ap.ride_with_gps_experience_access : null,
    waiverContent,
    signer: {
      signatureId: signer.signature_id,
      participantId: signer.participant_id,
      signerToken: signer.signer_token,
      role: signer.role,
      signerName: signer.signer_name,
      signerEmail: signer.signer_email,
      signerPhone: signer.signer_phone,
      status: signer.status,
      isGuardian: signer.is_guardian,
      // NEW (Task 16, 2026-08-31, found while rewriting waiver-signer-
      // form.js against this function's real response shape):
      // saveWaiverSignature has written guardian_for_children_json (a
      // real JSONB column — the Neon driver returns it already parsed as
      // a JS array of participant_ids, NOT a JSON string, despite the
      // column's own _json name; naming this key ...ParticipantIds rather
      // than ...Json avoids the double-JSON.parse() bug that name would
      // invite) since this file was built, but getSignerContext never
      // read it back at all — waiver-signer-form.js's own computeStatus()
      // had nothing to read, so the hub's "Signed — includes ___"
      // sub-label and Adventure Summary's "Also covers" line were
      // silently always blank, even for a signer who did certify for a
      // child.
      guardianForChildrenParticipantIds: signer.guardian_for_children_json || [],
      detailsConfirmedAt: signer.details_confirmed_at,
      signedAt: signer.signed_at,
    },
  };
}

/** Postgres equivalent of adventurePrep_markSignerOpened. */
async function markSignerOpened(signerToken) {
  const rows = await sql`SELECT status FROM waiver_signatures WHERE signer_token = ${signerToken}`;
  if (!rows.length) return { ok: false, error: 'Invalid or expired signer link' };
  if (rows[0].status === 'sent') {
    await sql`UPDATE waiver_signatures SET status = 'opened', opened_at = ${nowIso()} WHERE signer_token = ${signerToken}`;
  }
  return { ok: true };
}

module.exports = {
  getSignerContext,
  markSignerOpened,
  saveWaiverSignature,
  saveSignerDetails,
  saveEmergencyContact,
  sendSignerLinksForBooking,
  recomputeAllWaiversComplete,
};
