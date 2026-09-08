/**
 * lib/feedback-service.js
 *
 * Post-Adventure Check-in feedback (2026-09-08). See
 * claude/psac-post-adventure-phase3-final-spec-2026-09-08.md (the Claude
 * Project doc), sections 4-6, for the full design. One shared engine
 * behind every surface that can reach it -- Surface A (the booker,
 * api/adventure-prep.js) and every Surface B variant (a plain attending
 * participant, a participant who's also a guardian, and a non-attending
 * guardian, all via api/waiver.js) -- each surface's own API layer
 * resolves its own token/session down to a bookingId (and, for Surface
 * B, a participantId/role) first, then calls straight into the
 * functions here. Nothing here is duplicated per surface.
 *
 * Per-signer, not per-booking: the booker and each participant/guardian
 * who submits their own Check-in card each get their own row, and each
 * can only submit once. The booker has no booking_participants row of
 * their own, so their identity for this table is booking_id + a NULL
 * participant_id + reported_by_role = 'booker' -- every Surface B signer
 * (participant, participant_guardian, AND guardian_only; a guardian_only
 * signer DOES have their own booking_participants row, role_on_booking =
 * 'guardian_only', same as lib/waiver-service.js's
 * resolveSignerForCheckin() already relies on) is identified by their
 * own participant_id instead.
 *
 * Storage only, per the Operations UX PRD's own locked decision -- no
 * dashboard, no routing-quality analysis layer, no read path back into
 * any guest-facing surface. Ratings are 1-5; which rating columns are
 * populated depends on reportedByRole and is left to the caller (each
 * surface's Check-in card only ever sends the fields its own persona
 * variant collects) -- this service doesn't enforce a per-role shape
 * beyond requiring overallRating and a recognized role, matching how
 * lib/trail-checkin-incident-service.js leaves per-category payload
 * shape to its own callers too.
 */

'use strict';

const { sql } = require('./db');
const { genId } = require('./ids');

const VALID_ROLES = ['booker', 'participant', 'participant_guardian', 'guardian_only'];

/**
 * @param {string} bookingId
 * @param {string|null} participantId - null identifies the booker
 * @returns {Promise<boolean>}
 */
async function hasSubmittedFeedback(bookingId, participantId) {
  const rows = participantId
    ? await sql`SELECT feedback_id FROM feedback WHERE booking_id = ${bookingId} AND participant_id = ${participantId} LIMIT 1`
    : await sql`SELECT feedback_id FROM feedback WHERE booking_id = ${bookingId} AND participant_id IS NULL AND reported_by_role = 'booker' LIMIT 1`;
  return rows.length > 0;
}

/**
 * @param {string} bookingId
 * @param {{participantId?: string, reportedByRole: string, overallRating: number, trailRating?: number, gearRating?: number, bookingRating?: number, checkinRating?: number, note?: string}} payload
 * @returns {Promise<{ok: boolean, feedbackId?: string, error?: string}>}
 */
async function submitFeedback(bookingId, payload) {
  payload = payload || {};

  if (VALID_ROLES.indexOf(payload.reportedByRole) === -1) {
    return { ok: false, error: 'invalid_role' };
  }

  const overallRating = Number(payload.overallRating);
  if (!overallRating || overallRating < 1 || overallRating > 5) {
    return { ok: false, error: 'invalid_overall_rating' };
  }

  const participantId = payload.participantId || null;

  // One Check-in per signer per booking -- the card's own trigger
  // (this signer hasn't submitted feedback yet) should already keep a
  // signer from reaching this twice, but this is the actual guarantee,
  // not the UI gate.
  const already = await hasSubmittedFeedback(bookingId, participantId);
  if (already) return { ok: false, error: 'already_submitted' };

  const feedbackId = genId('FB');
  await sql`
    INSERT INTO feedback (
      feedback_id, booking_id, participant_id, reported_by_role,
      overall_rating, trail_rating, gear_rating, booking_rating, checkin_rating, note
    ) VALUES (
      ${feedbackId}, ${bookingId}, ${participantId}, ${payload.reportedByRole},
      ${overallRating}, ${payload.trailRating || null}, ${payload.gearRating || null},
      ${payload.bookingRating || null}, ${payload.checkinRating || null}, ${payload.note || null}
    )
  `;

  return { ok: true, feedbackId };
}

module.exports = {
  hasSubmittedFeedback,
  submitFeedback,
};
