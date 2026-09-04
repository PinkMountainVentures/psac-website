/**
 * lib/people-service.js
 *
 * NEW (Ops App Redesign, 2026-09-04 — Airey's direct request): backs the
 * new People list + Person Detail pages in the Ops UX. First real reader
 * of the `people` table's own membership_tier/member_since/renewal_date
 * columns anywhere in this codebase (grepped before writing this file —
 * nothing else reads or writes them yet, so "member status" below is a
 * fresh derivation, not a port of existing logic) and of
 * email_list_status/kit_subscriber_id outside lib/kit-sync-service.js's
 * own writer.
 *
 * ============================================================================
 * "# EVENTS BOOKED" vs "# EVENTS PARTICIPATED IN (BOOKED + PARTICIPATED)"
 * ============================================================================
 * Per Airey's own parenthetical in the request, these are two different
 * counts, not a typo:
 *   - bookedCount    = distinct bookings this person is the BOOKER
 *                       (owner) of — experience_bookings.person_id = X
 *                       (plus the schema's marquee/social/membership
 *                       booking tables, defensively — see note below).
 *   - combinedCount  = distinct bookings touching this person in EITHER
 *                       capacity: the ones they booked, UNION the ones
 *                       where they show up as an attending roster member
 *                       (booking_participants.person_id = X AND
 *                       is_participating = true) — e.g. a guest who
 *                       attended a trip a friend booked shows up here
 *                       even though they never booked anything
 *                       themselves. Always >= bookedCount.
 *
 * MARQUEE/SOCIAL/MEMBERSHIP BOOKINGS: schema.sql's own header calls these
 * "sketched, not built" — no live writer anywhere in this codebase touches
 * them today (confirmed by grep). They're included defensively in the
 * booked/combined UNIONs below anyway (same person_id/booking_id shape as
 * experience_bookings, and booking_participants already polymorphically
 * FKs to all four per its chk_exactly_one_booking constraint) purely so
 * this file doesn't silently under-count the day those features launch —
 * today every one of those branches returns zero rows in practice.
 *
 * "Adventures where they were a participant/guardian" on the Person Detail
 * page, by contrast, join ONLY against experience_bookings — the one live
 * booking type — same reasoning applied elsewhere in this project (e.g.
 * lib/trail-swap-service.js) of not building real UI plumbing for a
 * feature nothing else in the app has launched yet. Flagged here for
 * Airey: worth a second pass once Marquee/Social/Membership actually ship.
 *
 * ============================================================================
 * "MEMBER STATUS"
 * ============================================================================
 * Derived from people.membership_tier + renewal_date, the exact columns
 * schema.sql already carries for this purpose:
 *   - no membership_tier                          -> 'non_member'
 *   - membership_tier set, renewal_date in the past -> 'expired'
 *   - membership_tier set, renewal_date blank or in the future -> 'active'
 * Every person will show 'non_member' today, same as trials-parks-
 * service.js's park_access rows read as "always open" before Airey adds
 * real day restrictions — the columns exist and this reads them
 * correctly the moment something starts writing them.
 *
 * ============================================================================
 * "KIT EMAIL LIST STATUS"
 * ============================================================================
 * Read verbatim off people.email_list_status (lib/kit-sync-service.js's
 * own sync target) — 'active'/'cancelled'/'bounced'/'complained'/
 * 'inactive'/'unknown', or NULL for a person the Kit sync has never seen
 * (rendered as 'not_synced' here, distinct from the real 'unknown' enum
 * value Kit itself can report).
 */

'use strict';

const { sql } = require('./db');
const { bookingStatusInfo, paymentStatusBucket } = require('./ops-status-helpers');

function toDateStr(v) {
  if (!v) return '';
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}
function toIso(v) {
  if (!v) return '';
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function deriveMemberStatus(p) {
  if (!p.membership_tier) return 'non_member';
  if (p.renewal_date && new Date(p.renewal_date).getTime() < Date.now()) return 'expired';
  return 'active';
}

// ---------------------------------------------------------------------------
// People list
// ---------------------------------------------------------------------------

async function listPeople() {
  const rows = await sql`
    WITH booked AS (
      SELECT person_id, booking_id FROM experience_bookings
      UNION ALL
      SELECT person_id, booking_id FROM marquee_bookings
      UNION ALL
      SELECT person_id, booking_id FROM social_bookings
      UNION ALL
      SELECT person_id, booking_id FROM membership_bookings
    ),
    participated AS (
      SELECT person_id,
             COALESCE(experience_booking_id, marquee_booking_id, social_booking_id, membership_booking_id) AS booking_id
      FROM booking_participants
      WHERE person_id IS NOT NULL AND is_participating = true
    ),
    combined AS (
      SELECT person_id, booking_id FROM booked
      UNION
      SELECT person_id, booking_id FROM participated
    ),
    booked_agg AS (
      SELECT person_id, COUNT(DISTINCT booking_id) AS booked_count
      FROM booked
      GROUP BY person_id
    ),
    combined_agg AS (
      SELECT person_id, COUNT(DISTINCT booking_id) AS combined_count,
             array_agg(DISTINCT booking_id) AS booking_ids
      FROM combined
      GROUP BY person_id
    )
    SELECT p.person_id, p.name, p.email, p.phone, p.membership_tier, p.member_since,
           p.renewal_date, p.created_at, p.email_list_status, p.kit_subscriber_id,
           COALESCE(ba.booked_count, 0) AS booked_count,
           COALESCE(ca.combined_count, 0) AS combined_count,
           COALESCE(ca.booking_ids, ARRAY[]::text[]) AS booking_ids
    FROM people p
    LEFT JOIN booked_agg ba ON ba.person_id = p.person_id
    LEFT JOIN combined_agg ca ON ca.person_id = p.person_id
    ORDER BY p.name
  `;

  const people = rows.map((r) => ({
    personId: r.person_id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    membershipTier: r.membership_tier,
    memberSince: toDateStr(r.member_since),
    renewalDate: toDateStr(r.renewal_date),
    memberStatus: deriveMemberStatus(r),
    emailListStatus: r.email_list_status || 'not_synced',
    kitSubscriberId: r.kit_subscriber_id,
    createdAt: toIso(r.created_at),
    bookedCount: Number(r.booked_count) || 0,
    combinedCount: Number(r.combined_count) || 0,
    bookingIds: r.booking_ids || [],
  }));

  // Sanity backstop, same posture as listAllBookings's own 500 cap — not a
  // real pagination scheme, just a guard against ever shipping an
  // unbounded response.
  return { people: people.slice(0, 3000), truncated: people.length > 3000 };
}

// ---------------------------------------------------------------------------
// Person detail
// ---------------------------------------------------------------------------

async function getPersonDetail({ personId }) {
  const personRows = await sql`SELECT * FROM people WHERE person_id = ${personId}`;
  if (!personRows.length) return { notFound: true };
  const person = personRows[0];

  const bookingsMadeRows = await sql`
    SELECT booking_id, created_at, date, tier, booking_status, cancellation_reasons,
           payment_status, deposit_status, total
    FROM experience_bookings
    WHERE person_id = ${personId}
    ORDER BY date DESC NULLS LAST
  `;

  // "Adventures where they were a participant" — see this file's header
  // for why this joins experience_bookings only.
  const participantRows = await sql`
    SELECT bp.participant_id, bp.role_on_booking, bp.is_participating, bp.display_name,
           eb.booking_id, eb.date, eb.tier, eb.booking_status, eb.cancellation_reasons
    FROM booking_participants bp
    JOIN experience_bookings eb ON eb.booking_id = bp.experience_booking_id
    WHERE bp.person_id = ${personId} AND bp.is_participating = true
    ORDER BY eb.date DESC NULLS LAST
  `;

  // "Adventures where they were a guardian (either participant or
  // non-participant)" — every booking_participants row where THIS person
  // is named as the guardian for the roster row (i.e. for a child/other
  // attendee), regardless of whether the child attended.
  const guardianRows = await sql`
    SELECT bp.participant_id, bp.person_id AS child_person_id, bp.display_name AS child_display_name,
           bp.is_participating AS child_is_participating, bp.guardian_verified_at,
           eb.booking_id, eb.date, eb.tier, eb.booking_status, eb.cancellation_reasons
    FROM booking_participants bp
    JOIN experience_bookings eb ON eb.booking_id = bp.experience_booking_id
    WHERE bp.guardian_person_id = ${personId}
    ORDER BY eb.date DESC NULLS LAST
  `;

  const participatingBookingIds = new Set(participantRows.map((r) => r.booking_id));

  const bookingsMade = bookingsMadeRows.map((r) => {
    const info = bookingStatusInfo(r);
    return {
      bookingId: r.booking_id,
      createdAt: toIso(r.created_at),
      tripDate: toDateStr(r.date),
      tier: r.tier,
      bookingStatusBucket: info.bucket,
      cancellationReasons: info.reasons,
      paymentStatusBucket: paymentStatusBucket(r.payment_status),
      depositStatus: r.deposit_status,
      total: r.total,
    };
  });

  const participatedIn = participantRows.map((r) => {
    const info = bookingStatusInfo(r);
    return {
      participantId: r.participant_id,
      roleOnBooking: r.role_on_booking,
      displayName: r.display_name,
      bookingId: r.booking_id,
      tripDate: toDateStr(r.date),
      tier: r.tier,
      bookingStatusBucket: info.bucket,
    };
  });

  const guardianFor = guardianRows.map((r) => {
    const info = bookingStatusInfo(r);
    return {
      participantId: r.participant_id,
      childPersonId: r.child_person_id,
      childDisplayName: r.child_display_name,
      childIsParticipating: r.child_is_participating,
      guardianVerifiedAt: toIso(r.guardian_verified_at),
      bookingId: r.booking_id,
      tripDate: toDateStr(r.date),
      tier: r.tier,
      bookingStatusBucket: info.bucket,
      // Was THIS person (the guardian) themselves attending this same
      // adventure, or were they a drop-off/non-attending guardian only —
      // derived from whether they have their own attending roster row on
      // the same booking (participantRows above), not from role_on_booking
      // alone (that field describes the CHILD's row, not the guardian's).
      guardianWasAttending: participatingBookingIds.has(r.booking_id),
    };
  });

  // "Who they are a guardian for" — unique children across every
  // guardianFor row, linkable when the child already has a real person_id
  // (set once a waiver/guardian-certification flow has resolved one — see
  // lib/waiver-service.js/lib/adventure-prep-service.js); shown name-only,
  // unlinked, otherwise.
  const seenChildren = {};
  const children = [];
  guardianFor.forEach((g) => {
    const key = g.childPersonId || ('name:' + g.childDisplayName);
    if (!seenChildren[key]) {
      seenChildren[key] = true;
      children.push({ personId: g.childPersonId || null, displayName: g.childDisplayName });
    }
  });

  let daysSinceLastParticipated = null;
  let lastParticipatedDate = null;
  participantRows.forEach((r) => {
    if (!r.date) return;
    const d = new Date(r.date);
    if (!lastParticipatedDate || d > lastParticipatedDate) lastParticipatedDate = d;
  });
  if (lastParticipatedDate) {
    daysSinceLastParticipated = Math.floor((Date.now() - lastParticipatedDate.getTime()) / 86400000);
  }

  return {
    person: {
      personId: person.person_id,
      name: person.name,
      email: person.email,
      phone: person.phone,
      membershipTier: person.membership_tier,
      memberSince: toDateStr(person.member_since),
      renewalDate: toDateStr(person.renewal_date),
      memberStatus: deriveMemberStatus(person),
      emailListStatus: person.email_list_status || 'not_synced',
      kitSubscriberId: person.kit_subscriber_id,
      createdAt: toIso(person.created_at),
    },
    lastParticipatedDate: lastParticipatedDate ? toDateStr(lastParticipatedDate) : '',
    daysSinceLastParticipated,
    bookingsMade,
    participatedIn,
    guardianFor,
    children,
  };
}

module.exports = {
  listPeople,
  getPersonDetail,
};
