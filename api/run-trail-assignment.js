/**
 * api/run-trail-assignment.js
 *
 * Surface A's guest-facing trigger for bucket 2.2's trail assignment.
 * Calls the exact same engine sequence as api/assign-trail.js (via
 * lib/run-trail-assignment.js's shared runTrailAssignmentForBooking), but
 * authenticated by the guest's own adventurePrepToken instead of
 * TRAIL_SELECTION_SHARED_SECRET — the browser never holds that secret or
 * a raw bookingId, so this resolves both server-side before calling the
 * shared engine sequence.
 *
 * Called with operation:'initial' the moment 1.2a's full input set
 * (roster reconfirmation, technical/heat comfort, up to 3
 * bestForAttributes picks) is complete, and operation:'refresh' if the
 * guest edits any of those inputs again before the T-3 cutoff (PRD
 * Section 4). Surface A itself decides which operation to send; this
 * endpoint doesn't infer it.
 *
 * Request:  POST /api/run-trail-assignment
 *           { token: string, operation: 'initial' | 'refresh' }
 *
 * Response (same shapes as api/assign-trail.js, minus the secret/bookingId
 * specifics, which don't apply to a guest caller):
 *   200 { status: 'assigned', candidateTrails, assignedAt, assignmentMethod, qualifyingCandidateCount, swapRequestOpened }
 *   409 { status: 'refused', reason: 'custom_tier', message }
 *   404 { error: 'invalid_token' }
 *   400 { error: 'missing_token' | 'invalid_operation' | 'missing_1_2a_inputs' }
 *   500 { error: 'engineering_error', detail }
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { runTrailAssignmentForBooking } = require('../lib/run-trail-assignment');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  var body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  body = body || {};

  const token = body.token;
  const operation = body.operation;

  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  if (operation !== 'initial' && operation !== 'refresh') {
    res.status(400).json({ error: 'invalid_operation' });
    return;
  }

  try {
    const ctx = await callBookingsWebApp('adventurePrep_getContextByToken', { token });
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }

    const result = await runTrailAssignmentForBooking({ bookingId: ctx.bookingId, operation });

    if (result.outcome === 'not_found') {
      // Shouldn't happen — the token just resolved a bookingId above — but
      // handled explicitly rather than falling through to the 500 branch.
      res.status(404).json({ error: 'invalid_token' });
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
      candidateTrails: result.candidateTrails,
      assignedAt: result.assignedAt,
      assignmentMethod: result.assignmentMethod,
      qualifyingCandidateCount: result.qualifyingCandidateCount,
      swapRequestOpened: result.swapRequestOpened,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('run-trail-assignment failed', token, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
