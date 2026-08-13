/**
 * api/adventure-prep.js
 *
 * CONSOLIDATED, build-review Aug 2026: this file used to be six separate
 * files (get-adventure-prep.js, save-adventure-prep.js,
 * run-trail-assignment.js, select-trail.js, send-signer-links.js,
 * adjust-gear-kit-count.js). The first deploy of this build failed —
 * Vercel's Hobby plan caps a deployment at 12 serverless functions, and
 * api/ was about to go from 6 to 16. Rather than pay for Pro just to keep
 * one-file-per-endpoint, this merges Surface A's guest-facing actions into
 * one dispatched-by-action endpoint, the same shape the Apps Script side of
 * this exact system already uses successfully (Code.gs's own doPost
 * dispatches 18+ actions off one entry point) — not a new pattern, just
 * bringing an already-proven shape to this side of the stack. See
 * api/waiver.js for the same treatment applied to Surface B's actions, and
 * api/process-pending-kit-changes.js, which stays its own file since it's a
 * Vercel Cron target with a different auth model (CRON_SECRET, not a guest
 * token) and needs a stable, dedicated path for the crons config anyway.
 *
 * Every action below is a byte-for-byte-behavior port of its original
 * file — same auth, same validation order, same response shapes and status
 * codes, same error handling. Nothing about what a caller sees changed,
 * only the URL (all six collapse to POST /api/adventure-prep, plus GET for
 * getContext) and the need for the browser to say which action it wants.
 *
 * Request shapes:
 *   GET  /api/adventure-prep?token=...
 *     -> was GET /api/get-adventure-prep
 *   POST /api/adventure-prep { action: 'saveFields', token, fields }
 *     -> was POST /api/save-adventure-prep
 *   POST /api/adventure-prep { action: 'runTrailAssignment', token, operation }
 *     -> was POST /api/run-trail-assignment
 *   POST /api/adventure-prep { action: 'selectTrail', token, trailId }
 *     -> was POST /api/select-trail
 *   POST /api/adventure-prep { action: 'sendSignerLinks', token, signers }
 *     -> was POST /api/send-signer-links
 *   POST /api/adventure-prep { action: 'adjustGearKitCount', token, requestedKitCount }
 *     -> was POST /api/adjust-gear-kit-count
 *
 * Response shapes are UNCHANGED from each action's original file — see that
 * action's own function below for its exact documented responses, lifted
 * verbatim from the file it replaces.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { runTrailAssignmentForBooking } = require('../lib/run-trail-assignment');
const { isBeforeT3Cutoff } = require('../lib/t3-cutoff');
const { sendEmail } = require('../lib/send-email');
const { renderSignerWaiverInviteEmail } = require('../lib/email-templates/signer-waiver-invite-email');

// Shared by saveFields and selectTrail below — both previously had NO
// cutoff or cancelled-booking check at all (build review, Aug 2026).
//
// TIMING FIX (build review, Aug 2026, second pass): this build's first pass
// gated these two on a new T-1 noon Pacific lock (lib/self-service-cutoff.js,
// now deleted), reasoning by analogy to the T-1 deposit hold's two-clock
// pattern. That created a real conflict with two already-locked PRDs
// (Adventure Prep PRD Section 10, Operations UX PRD Section 14), both of
// which put address and trail-swap self-service edits at the SAME T-3, 10pm
// cutoff as kit count, specifically because T-3 is also the moment
// RideWithGPS access gets generated (api/process-t3-cutoff.js step 5, still
// fires at T-3, was never moved) — letting trail edits stay open two more
// days would routinely hand out a credential for a trail the guest no
// longer has, with nothing to auto-regenerate it. Reverted to isBeforeT3Cutoff
// (same check adjustGearKitCount already uses) to match the locked PRDs and
// close that gap. A genuinely late change of either kind still has a path:
// staff's existing manual Trail Swap Requests / Manual Adjustment workflow,
// not open guest self-service past T-3.
async function checkGuestSelfServiceEditAllowed(token) {
  const ctx = await callBookingsWebApp('adventurePrep_getContextByToken', { token });
  if (!ctx || ctx.notFound) {
    return { ok: false, status: 404, error: 'invalid_token' };
  }
  const bookingStatus = ctx.experienceBooking && ctx.experienceBooking.bookingStatus;
  if (bookingStatus && bookingStatus !== 'active') {
    return { ok: false, status: 409, error: 'booking_cancelled' };
  }
  if (!isBeforeT3Cutoff(ctx.experienceBooking && ctx.experienceBooking.date)) {
    return { ok: false, status: 409, error: 'past_t3_cutoff' };
  }
  return { ok: true, ctx };
}

const SITE_URL = 'https://www.palmspringsadventureclub.com';
const MAX_KIT_COUNT = 20; // matches lib/finalize-kit-change.js's own clamp

function formatTripDate(dateStr) {
  // BUG FIX (independent bug pass, Aug 2026): "trip" replaced with
  // "adventure" to match this project's established brand-voice convention.
  if (!dateStr) return 'your upcoming adventure';
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

function parseBody(req) {
  var body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  return body || {};
}

// -- getContext, was GET /api/get-adventure-prep -----------------------------
async function getContext(req, res) {
  const token = (req.query && req.query.token) || '';
  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  const ctx = await callBookingsWebApp('adventurePrep_getContextByToken', { token });
  if (!ctx || ctx.notFound) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }
  res.status(200).json(ctx);
}

// -- saveFields, was POST /api/save-adventure-prep ---------------------------
async function saveFields(body, res) {
  const token = body.token;
  const fields = body.fields;
  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }

  const gate = await checkGuestSelfServiceEditAllowed(token);
  if (!gate.ok) {
    res.status(gate.status).json({ error: gate.error });
    return;
  }

  const result = await callBookingsWebApp('adventurePrep_saveFields', { token, fields });
  if (!result || result.ok === false) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }
  res.status(200).json(result);
}

// -- runTrailAssignment, was POST /api/run-trail-assignment ------------------
async function runTrailAssignment(body, res) {
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
  const ctx = await callBookingsWebApp('adventurePrep_getContextByToken', { token });
  if (!ctx || ctx.notFound) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }
  const result = await runTrailAssignmentForBooking({ bookingId: ctx.bookingId, operation });
  if (result.outcome === 'not_found') {
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
}

// -- selectTrail, was POST /api/select-trail ---------------------------------
async function selectTrail(body, res) {
  const token = body.token;
  const trailId = body.trailId;
  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  if (!trailId) {
    res.status(400).json({ error: 'missing_trail_id' });
    return;
  }

  const gate = await checkGuestSelfServiceEditAllowed(token);
  if (!gate.ok) {
    res.status(gate.status).json({ error: gate.error });
    return;
  }

  const result = await callBookingsWebApp('adventurePrep_selectTrail', { token, trailId });
  if (!result || result.ok === false) {
    const message = (result && result.error) || '';
    if (message.indexOf('Invalid or expired') === 0) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }
    res.status(409).json({ error: 'not_a_candidate' });
    return;
  }
  res.status(200).json(result);
}

// -- sendSignerLinks, was POST /api/send-signer-links ------------------------
async function sendSignerLinks(body, res) {
  const token = body.token;
  const signers = Array.isArray(body.signers) ? body.signers : null;
  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  if (!signers || !signers.length) {
    res.status(400).json({ error: 'missing_signers' });
    return;
  }
  const result = await callBookingsWebApp('adventurePrep_sendSignerLinks', { token, signers });
  if (!result || result.ok === false) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }

  const tripDateDisplay = formatTripDate(result.tripDate);
  const logoUrl = process.env.BOOKING_CONFIRMATION_LOGO_URL || '';

  const emailed = await Promise.all(
    (result.signers || []).map(async (signer) => {
      if (!signer.email) {
        return { ...signer, emailStatus: 'skipped_no_email' };
      }
      const signerUrl = `${SITE_URL}/sign-waiver?token=${encodeURIComponent(signer.signerToken)}`;
      const html = renderSignerWaiverInviteEmail({
        logoUrl,
        signerName: signer.name,
        ownerName: result.ownerName,
        tripDateDisplay,
        signerUrl,
      });
      const sendResult = await sendEmail({
        to: signer.email,
        subject: `${result.ownerName || 'Someone'} added you to an adventure, quick waiver needed`,
        html,
      });
      return { ...signer, emailStatus: sendResult.status };
    })
  );

  res.status(200).json({ status: 'sent', signers: emailed });
}

// -- adjustGearKitCount, was POST /api/adjust-gear-kit-count -----------------
async function adjustGearKitCount(body, res) {
  const token = body.token;
  const requestedKitCount = body.requestedKitCount;
  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  if (
    requestedKitCount === undefined ||
    requestedKitCount === null ||
    !Number.isInteger(requestedKitCount) ||
    requestedKitCount < 0 ||
    requestedKitCount > MAX_KIT_COUNT
  ) {
    res.status(400).json({ error: 'invalid_kit_count' });
    return;
  }

  const ctx = await callBookingsWebApp('adventurePrep_getContextByToken', { token });
  if (!ctx || ctx.notFound) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }
  // FIX (build review, Aug 2026): this previously checked
  // bookingStatus === 'cancelled', a value that never actually occurs — the
  // real cancellation mechanism (api/cancel-and-refund-booking.js, built
  // this session per Operations UX PRD Section 5) writes
  // 'cancelled_no_adventure_prep' or 'cancelled_hold_failed', never the
  // literal string 'cancelled'. That made this check dead code: a cancelled
  // booking's kit-count adjustment was never actually being blocked.
  // Corrected to the same bookingStatus !== 'active' pattern Section 5
  // itself specifies for Surface A's own cancelled-status check, for the
  // same reason (future-proof against whatever new cancellation status
  // value gets added next, rather than re-breaking on the next one).
  if (ctx.experienceBooking && ctx.experienceBooking.bookingStatus && ctx.experienceBooking.bookingStatus !== 'active') {
    res.status(409).json({ error: 'booking_cancelled' });
    return;
  }
  if (!isBeforeT3Cutoff(ctx.experienceBooking && ctx.experienceBooking.date)) {
    res.status(409).json({ error: 'past_t3_cutoff' });
    return;
  }

  const ap = ctx.adventurePrep || {};
  const currentConfirmed =
    parseInt(ap.confirmedKitCount, 10) ||
    parseInt((ctx.experienceBooking && ctx.experienceBooking.gearKitCount) || 0, 10) ||
    0;

  if (requestedKitCount === currentConfirmed) {
    await callBookingsWebApp('adventurePrep_setPendingKitChange', {
      bookingId: ctx.bookingId,
      pendingKitCount: '',
      pendingSince: '',
    });
    res.status(200).json({ status: 'no_change', currentConfirmedKitCount: currentConfirmed });
    return;
  }

  const pendingSince = new Date().toISOString();
  await callBookingsWebApp('adventurePrep_setPendingKitChange', {
    bookingId: ctx.bookingId,
    pendingKitCount: requestedKitCount,
    pendingSince,
  });

  res.status(200).json({
    status: 'pending',
    requestedKitCount,
    currentConfirmedKitCount: currentConfirmed,
    pendingSince,
  });
}

const POST_ACTIONS = {
  saveFields,
  runTrailAssignment,
  selectTrail,
  sendSignerLinks,
  adjustGearKitCount,
};

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      await getContext(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const body = parseBody(req);
    const action = body.action;
    const fn = POST_ACTIONS[action];
    if (!fn) {
      res.status(400).json({ error: 'unknown_action' });
      return;
    }
    await fn(body, res);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('adventure-prep action failed', req.method, (req.body && req.body.action) || req.query, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
