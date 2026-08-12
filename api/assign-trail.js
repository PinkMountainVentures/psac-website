/**
 * api/assign-trail.js
 *
 * Bucket 2.2's two operations in one endpoint: the initial run (called once
 * 1.2a's inputs are complete) and the refresh (called when the guest edits
 * a 1.2a input before T-3). Both run the identical sequence per Trail
 * Selection Logic PRD Section 10's closing paragraph — the only difference
 * is which candidateTrails entries get replaced, which lib/trail-selection-
 * engine.js's runTrailSelection() already handles internally.
 *
 * Request:  POST /api/assign-trail
 *           { bookingId: string, secret: string, operation: 'initial' | 'refresh' }
 *
 * Response shapes (mirrors this repo's existing convention — explicit
 * outcomes to branch on, never a bare throw):
 *   200 { status: 'assigned', bookingId, candidateTrails, assignedAt,
 *         assignmentMethod, qualifyingCandidateCount, swapRequestOpened }
 *   409 { status: 'refused', reason: 'custom_tier', message }
 *   401 { error: 'unauthorized' }                 — secret mismatch
 *   404 { error: 'booking_not_found' }             — bad bookingId
 *   400 { error: 'missing_bookingId' | 'invalid_operation' | 'missing_1_2a_inputs' }
 *   500 { error: 'engineering_error', detail }      — never guest-facing
 *
 * Auth: shared secret, `{ bookingId, secret, ... }`, matching
 * api/create-deposit-hold.js's own convention exactly. Env var name is new
 * (TRAIL_SELECTION_SHARED_SECRET) since this is a new capability, not a
 * reuse of DEPOSIT_HOLD_SHARED_SECRET or BOOKINGS_WEBAPP_SECRET — see the
 * accompanying README, "Why a separate secret."
 */

'use strict';

const { runTrailAssignmentForBooking } = require('../lib/run-trail-assignment');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { bookingId, secret, operation } = req.body || {};

  if (secret !== process.env.TRAIL_SELECTION_SHARED_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!bookingId) {
    res.status(400).json({ error: 'missing_bookingId' });
    return;
  }
  if (operation !== 'initial' && operation !== 'refresh') {
    res.status(400).json({ error: 'invalid_operation' });
    return;
  }

  // The actual fetch/normalize/engine/write-back sequence lives in
  // lib/run-trail-assignment.js so this exact secret-authenticated contract
  // (already live in production, verified end to end at the auth/routing
  // level) and the guest-facing api/run-trail-assignment.js wrapper Surface
  // A calls both go through one implementation, never two that could drift
  // apart. This refactor changes nothing about this endpoint's request or
  // response shape.
  try {
    const result = await runTrailAssignmentForBooking({ bookingId, operation });

    if (result.outcome === 'not_found') {
      res.status(404).json({ error: 'booking_not_found' });
      return;
    }
    if (result.outcome === 'missing_1_2a_inputs') {
      res.status(400).json({ error: 'missing_1_2a_inputs' });
      return;
    }
    if (result.outcome === 'refused') {
      res.status(409).json({ status: 'refused', reason: result.reason, message: result.message });
      return;
    }

    res.status(200).json({
      status: 'assigned',
      bookingId: result.bookingId,
      candidateTrails: result.candidateTrails,
      assignedAt: result.assignedAt,
      assignmentMethod: result.assignmentMethod,
      qualifyingCandidateCount: result.qualifyingCandidateCount,
      swapRequestOpened: result.swapRequestOpened,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('assign-trail failed', bookingId, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
