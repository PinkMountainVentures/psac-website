/**
 * lib/booking-detail-service.js
 *
 * MIGRATED (2026-08-31): Postgres replacement for apps-script/booking-
 * detail-actions.gs's one action, `bookingDetail_get` — the single-call
 * aggregator backing the (not-yet-built) Booking Detail page, gathering
 * everything known about ONE booking across every domain this app tracks.
 *
 * ============================================================================
 * WHY THIS CALLS INTO lib/gear-service.js's FUNCTIONS DIRECTLY, RATHER THAN
 * RE-DERIVING THEIR LOGIC — same reasoning as the .gs source's own header
 * ============================================================================
 *
 * Gear allocation, gear delivery/return, gear check-in, and reconciliation
 * are each already correctly computed by an existing, already-migrated,
 * already-tested function in lib/gear-service.js (`getAllocation`,
 * `getReturnContext`, `getCheckinContext`, `getReconciliationContext`).
 * This file calls those directly rather than re-reading gear_check_log/
 * gear_units itself — re-deriving any of that logic here would risk
 * silently drifting from behavior that's already been fixed multiple times
 * (see gear-service.js's own header for its bug-fix history). Each call is
 * wrapped in its own try/catch, same defensive posture as the .gs source,
 * so one subsystem being unavailable for a given booking (e.g. gear-ops
 * context for a booking that never reached Adventure Prep) can't blank out
 * the rest of the page.
 *
 * Payment/hold/booking-status/delivery-return bucketing reuses
 * lib/ops-status-helpers.js — pulled out of this file into its own module
 * specifically so that when All Bookings/Ops Alerts Expanded (Task 8) get
 * migrated off Apps Script, they import the SAME functions rather than
 * re-deriving them, matching the .gs source's own explicit "must never
 * disagree" reasoning for sharing these helpers.
 *
 * ============================================================================
 * WHAT'S DIFFERENT FROM THE .gs VERSION, AND WHY
 * ============================================================================
 *
 * 1. Roster has no "reconfirmed vs booking-time" duality anymore. The .gs
 *    version fell back from Adventure Prep's `reconfirmedRosterJson` to
 *    the original booking's `fullPayloadJson.roster` because a booking
 *    that hadn't reached Adventure Prep yet had nowhere else to keep a
 *    roster. In Postgres, `booking_participants` is the ONE canonical
 *    roster table from the moment a booking is saved — schema.sql's own
 *    comment on `adventure_prep` already establishes this ("is_participating
 *    is now the one canonical roster signal... deliberately DROPPED [the]
 *    parallel-roster-representation"). So `roster` here is simply every
 *    booking_participants row for this booking, ordered by roster_index —
 *    always current, no `rosterSource`/`bookingTimeRoster` fields needed.
 * 2. `candidateTrails` is a real join (`candidate_trails JOIN trails`), not
 *    a parsed JSON blob — see lib/run-trail-assignment.js's own header,
 *    point 2, which already flagged this file as the reason the join
 *    fields (trailName/overviewCopy/photoUrl/park/trailheadLocation/
 *    oneTripTip) needed to exist somewhere. Field names match
 *    lib/run-trail-assignment.js's `normalizeTrailRow` exactly, so a
 *    future frontend sees one consistent trail-object shape everywhere.
 * 3. `payment.paymentStatusBucket` reads the real
 *    `experience_bookings.payment_status` column (new this turn — see
 *    schema.sql's own comment and lib/booking-service.js's `saveBooking`)
 *    instead of parsing a `fullPayloadJson` blob this schema doesn't have
 *    (Finding #8).
 * 4. Trail swap requests and the change log are read directly off their
 *    own real tables (`trail_swap_requests`, `audit_log`) by `booking_id`
 *    — both already indexed on that column — replacing the .gs version's
 *    generic sheet-row reader. `audit_log` is this migration's Adventure
 *    Prep Change Log equivalent (every subsystem's write path already
 *    appends to it via `appendAuditLog`).
 */

'use strict';

const { sql } = require('./db');
const gearService = require('./gear-service');
const { holdStatusBucket, paymentStatusBucket, bookingStatusInfo, deliveryReturnStatus } = require('./ops-status-helpers');

function mapWaiverRow(r) {
  return {
    signatureId: r.signature_id,
    bookingId: r.booking_id,
    personId: r.person_id,
    participantId: r.participant_id,
    role: r.role,
    signerName: r.signer_name,
    signerEmail: r.signer_email,
    signerPhone: r.signer_phone,
    isGuardian: r.is_guardian,
    guardianForChildrenJson: r.guardian_for_children_json,
    waiverVersion: r.waiver_version,
    status: r.status,
    sentAt: r.sent_at,
    openedAt: r.opened_at,
    signedAt: r.signed_at,
    detailsConfirmedAt: r.details_confirmed_at,
  };
}

function mapRosterRow(r) {
  return {
    participantId: r.participant_id,
    rosterIndex: r.roster_index,
    displayName: r.display_name,
    email: r.email,
    phone: r.phone,
    ageBucket: r.age_bucket,
    fitnessLevel: r.fitness_level,
    roleOnBooking: r.role_on_booking,
    isParticipating: r.is_participating,
    gearKit: r.gear_kit,
    guardianPersonId: r.guardian_person_id,
    guardianVerifiedAt: r.guardian_verified_at,
    packSizePreference: r.pack_size_preference,
  };
}

function mapCandidateTrailRow(r) {
  return {
    rank: r.rank,
    source: r.source,
    trailId: r.trail_id,
    matchedAttributes: r.matched_attributes || [],
    difficultyRating: r.difficulty_rating,
    technicalRating: r.technical_rating,
    distance: r.distance != null ? Number(r.distance) : null,
    elevation: r.elevation,
    // Display fields, joined from `trails` — same field names as
    // lib/run-trail-assignment.js's normalizeTrailRow, per this file's
    // header point 2.
    trailName: r.trail_name,
    overviewCopy: r.opening_description || '',
    photoUrl: r.photo_references ? String(r.photo_references).split(/[\n,;]/)[0].trim() : null,
    park: (r.park || '').trim(),
    trailheadLocation: r.trailhead_name,
    oneTripTip: r.trail_day_tip || null,
  };
}

function mapTrailSwapRow(r) {
  return {
    swapRequestId: r.swap_request_id,
    bookingId: r.booking_id,
    guestConcernSummary: r.guest_concern_summary,
    receivedAt: r.received_at,
    status: r.status,
    reviewedBy: r.reviewed_by,
    newTrailId: r.new_trail_id,
    staffNotes: r.staff_notes,
    resolvedAt: r.resolved_at,
    tierASafetyFiltersOverridden: r.tier_a_safety_filters_overridden,
    safetyOverrideReason: r.safety_override_reason,
  };
}

function mapChangeLogRow(r) {
  return {
    auditId: r.audit_id,
    bookingId: r.booking_id,
    changeType: r.change_type,
    timestamp: r.timestamp,
    beforeT3Cutoff: r.before_t3_cutoff,
    oldValueJson: r.old_value_json,
    newValueJson: r.new_value_json,
    delta: r.delta,
    refundOrChargeAmount: r.refund_or_charge_amount,
    stripeTransactionId: r.stripe_transaction_id,
    staffNotes: r.staff_notes,
    triggeringInput: r.triggering_input,
    tierASafetyFiltersOverridden: r.tier_a_safety_filters_overridden,
    safetyOverrideReason: r.safety_override_reason,
  };
}

/**
 * @param {object} params
 * @param {string} params.bookingId
 * @returns one object with a section per area of the app, or { notFound: true }
 */
async function getBookingDetail({ bookingId }) {
  const bookingRows = await sql`SELECT * FROM experience_bookings WHERE booking_id = ${bookingId}`;
  if (!bookingRows.length) return { notFound: true };
  const booking = bookingRows[0];

  const apRows = await sql`SELECT * FROM adventure_prep WHERE booking_id = ${bookingId}`;
  const ap = apRows[0] || null;

  const candidateTrailRows = await sql`
    SELECT ct.rank, ct.source, ct.trail_id, ct.matched_attributes, ct.difficulty_rating,
           ct.technical_rating, ct.distance, ct.elevation,
           t.trail_name, t.opening_description, t.photo_references, t.park,
           t.trailhead_name, t.trail_day_tip
    FROM candidate_trails ct
    JOIN trails t ON t.trail_id = ct.trail_id
    WHERE ct.experience_booking_id = ${bookingId}
    ORDER BY ct.rank
  `;
  const candidateTrails = candidateTrailRows.map(mapCandidateTrailRow);

  // See this file's header point 1 — booking_participants is the one
  // canonical roster, no reconfirmed-vs-booking-time fallback needed.
  const rosterRows = await sql`
    SELECT * FROM booking_participants
    WHERE experience_booking_id = ${bookingId}
    ORDER BY roster_index
  `;
  const roster = rosterRows.map(mapRosterRow);

  const waiverRows = await sql`SELECT * FROM waiver_signatures WHERE booking_id = ${bookingId}`;
  const waivers = waiverRows.map(mapWaiverRow);

  const trailSwapRows = await sql`SELECT * FROM trail_swap_requests WHERE booking_id = ${bookingId}`;
  const trailSwaps = trailSwapRows.map(mapTrailSwapRow);

  const changeLogRows = await sql`
    SELECT * FROM audit_log WHERE booking_id = ${bookingId} ORDER BY "timestamp" DESC
  `;
  const changeLog = changeLogRows.map(mapChangeLogRow);

  let allocation = [];
  try {
    allocation = (await gearService.getAllocation({ bookingId })).allocation || [];
  } catch (e) { allocation = []; }

  let deliveryContext = null;
  try { deliveryContext = await gearService.getReturnContext({ bookingId }); } catch (e) { deliveryContext = null; }

  let checkinContext = null;
  try { checkinContext = await gearService.getCheckinContext({ bookingId }); } catch (e) { checkinContext = null; }

  let reconciliation = null;
  try {
    reconciliation = await gearService.getReconciliationContext({ bookingId, nowIso: new Date().toISOString() });
  } catch (e) { reconciliation = null; }

  const bookingInfo = bookingStatusInfo(booking);
  const deliveryReturn = deliveryReturnStatus(booking);

  return {
    booking: {
      bookingId: booking.booking_id,
      createdAt: booking.created_at,
      contactName: booking.contact_name,
      contactEmail: booking.contact_email,
      contactPhone: booking.contact_phone,
      tier: booking.tier,
      tripDate: booking.date,
      timePreference: booking.time_preference,
      gearKitCount: booking.gear_kit_count,
      duffelCount: booking.duffel_count,
      bookingStatusBucket: bookingInfo.bucket,
      cancellationReasons: bookingInfo.reasons,
      cancelledAt: booking.cancelled_at || '',
      refundAmount: booking.refund_amount || '',
      smsConsent: booking.sms_consent,
      deliveryStatus: deliveryReturn.deliveryStatus,
      returnStatus: deliveryReturn.returnStatus,
    },
    payment: {
      total: booking.total,
      mainPaymentIntentId: booking.main_payment_intent_id,
      paymentStatusBucket: paymentStatusBucket(booking.payment_status),
      depositPaymentIntentId: booking.deposit_payment_intent_id,
      depositStatus: booking.deposit_status,
      holdStatusBucket: holdStatusBucket(booking.deposit_status),
    },
    adventurePrep: {
      exists: !!ap,
      isParticipating: ap ? ap.is_participating : '',
      technicalComfort: ap ? ap.technical_comfort : '',
      heatComfort: ap ? ap.heat_comfort : '',
      bestForAttributes: ap ? (ap.best_for_attributes || []) : [],
      candidateTrails,
      selectedTrailId: ap ? ap.selected_trail_id : '',
      assignedAt: ap ? ap.assigned_at : '',
      assignmentMethod: ap ? ap.assignment_method : '',
      roster,
      confirmedKitCount: ap ? ap.confirmed_kit_count : '',
      pendingKitCount: ap ? ap.pending_kit_count : '',
      allWaiversComplete: ap ? ap.all_waivers_complete : '',
      deliveryAddressLine1: ap ? ap.delivery_address_line1 : '',
      deliveryAddressLine2: ap ? ap.delivery_address_line2 : '',
      deliveryCity: ap ? ap.delivery_city : '',
      deliveryState: ap ? ap.delivery_state : '',
      deliveryZip: ap ? ap.delivery_zip : '',
      deliveryWindow: ap ? ap.delivery_window : '',
      returnPreference: ap ? ap.return_preference : '',
    },
    waivers,
    gearAllocation: allocation,
    deliveryContext,
    checkinContext,
    trailSwaps,
    changeLog,
    reconciliation,
  };
}

module.exports = {
  getBookingDetail,
  // Exported for lib/adventure-prep-service.js's getContextByToken,
  // which needs the identical candidate_trails/trails JOIN shape (Sept
  // 2026 bug fix: the guest-facing context call was never returning
  // candidateTrails at all, only the ops-facing getBookingDetail was --
  // reused rather than a second copy that could silently drift from
  // this one, same reasoning as run-trail-assignment.js's own exports).
  mapCandidateTrailRow,
};

