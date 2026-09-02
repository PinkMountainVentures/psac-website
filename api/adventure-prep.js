/**
 * api/adventure-prep.js
 *
 * FULLY MIGRATED (2026-08-31 build session, completed across several
 * updates): every action now calls Postgres-native code —
 * lib/adventure-prep-service.js, lib/run-trail-assignment.js,
 * lib/finalize-kit-change.js, and (this update) lib/waiver-service.js —
 * all rewritten against lib/db.js directly, no Apps Script involved. This
 * closes the SECOND, and final, launch-blocking gap flagged earlier this
 * session (the first, adjustGearKitCount, was closed in the previous
 * update). Neither this file nor api/waiver.js (also migrated this
 * update) calls lib/apps-script-client.js anywhere anymore.
 *
 * 'sendSignerLinks' is the PRD Section 6 guardian hybrid model action —
 * genuinely new design, not a mechanical port (the pre-migration system
 * only ever implemented self-declare). See lib/waiver-service.js's own
 * header comment for the full design: the booker pre-assigns/names a
 * guardian for each minor at roster-confirmation time
 * (lib/adventure-prep-service.js's confirmRoster, also updated this
 * session), and this action now derives its own signer list directly from
 * booking_participants — sending links to ordinary attending adults AND
 * any non-attending assigned guardian — rather than trusting a
 * client-supplied `signers` array. The request shape simplified
 * accordingly (see below).
 *
 * adjustGearKitCount's Postgres rewrite only sets/clears the
 * pending-kit-count debounce fields — same split as the pre-migration
 * design, where the actual Stripe charge/refund happens later via
 * lib/finalize-kit-change.js's finalizePendingKitChange(), called by the
 * cron job once the debounce window closes. See that file's own header
 * comment for a bug found and fixed in that finalize step (a missing
 * first-aid-kit item on kit-count increases) — flagged there for Airey's
 * explicit confirmation.
 *
 * 'confirmRoster' backs the roster-reconfirmation screen (Adventure Prep
 * step 2/3 — the booker declares whether they're attending and, if so,
 * identifies themselves; PRD Section 6/Section 8 concern, corrected by
 * Airey 2026-08-31 — see lib/adventure-prep-service.js's own header
 * comment for the full design, now including guardian pre-assignment).
 * This REPLACES what used to be a generic saveFields() call carrying
 * isParticipating/participatingRosterRef/reconfirmedRosterJson —
 * lib/adventure-prep-service.js's saveFields() now actively REJECTS those
 * three keys (rejectedFields in its response), so any caller still using
 * the old shape needs to move to this new action. Frontend request-shape
 * reconciliation (adventure-prep-form.js's roster-confirmation screen,
 * and waiver-signer-form.js for the guardian-certification screen) is
 * still a pending task — see the migration progress doc.
 *
 * Original consolidation note (still accurate): this file used to be six
 * separate files (get-adventure-prep.js, save-adventure-prep.js,
 * run-trail-assignment.js, select-trail.js, send-signer-links.js,
 * adjust-gear-kit-count.js) — merged into one dispatched-by-action
 * endpoint to stay under Vercel Hobby's 12-function cap, mirroring
 * Code.gs's own one-entry-point/many-actions shape.
 *
 * Request shapes:
 *   GET  /api/adventure-prep?token=...
 *   POST /api/adventure-prep { action: 'saveFields', token, fields }
 *   POST /api/adventure-prep { action: 'confirmRoster', token, isParticipating, ownerParticipantId?, ownerNewEntry?, roster? }
 *   POST /api/adventure-prep { action: 'runTrailAssignment', token, operation }
 *   POST /api/adventure-prep { action: 'selectTrail', token, trailId }
 *   POST /api/adventure-prep { action: 'sendSignerLinks', token }  -- shape simplified this update, no `signers` array needed anymore
 *   POST /api/adventure-prep { action: 'adjustGearKitCount', token, requestedKitCount }
 *   POST /api/adventure-prep { action: 'setRosterGearKits', token, updates: [{participantId, gearKit}] }  -- NEW (Task 15): backs the Gear Kits screen's per-person kit toggle; see lib/adventure-prep-service.js's own header comment on why this is deliberately separate from confirmRoster
 */

'use strict';

const adventurePrepService = require('../lib/adventure-prep-service');
const waiverService = require('../lib/waiver-service');
const { runTrailAssignmentForBooking } = require('../lib/run-trail-assignment');
const { getKitAdjustContextByToken, setPendingKitChange } = require('../lib/finalize-kit-change');
const { isBeforeT3Cutoff } = require('../lib/t3-cutoff');
const { getSiteUrl } = require('../lib/site-url');
const { sendEmail } = require('../lib/send-email');
const { renderSignerWaiverInviteEmail } = require('../lib/email-templates/signer-waiver-invite-email');

const SITE_URL = getSiteUrl();
const MAX_KIT_COUNT = 20; // matches lib/finalize-kit-change.js's own clamp

// BUG FIX (2026-09-02, same root cause caught and fixed in
// api/send-help-message.js's own formatTripDate): experience_bookings.date
// comes back from @neondatabase/serverless as a native JS Date object, not
// a "YYYY-MM-DD" string, so this function's regex-only match silently fell
// through to the Date's own toString() -- e.g. "Sat Sep 05 2026 00:00:00
// GMT+0000 (Coordinated Universal Time)" -- anywhere a signer invite email
// used tripDateDisplay. Handles both shapes now, always reading UTC
// calendar fields so it can't drift a day either direction.
function formatTripDate(dateInput) {
  if (!dateInput) return 'your upcoming trip';
  var year, month, day;
  if (dateInput instanceof Date) {
    year = dateInput.getUTCFullYear();
    month = dateInput.getUTCMonth();
    day = dateInput.getUTCDate();
  } else {
    const m = String(dateInput).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(dateInput);
    year = Number(m[1]);
    month = Number(m[2]) - 1;
    day = Number(m[3]);
  }
  const d = new Date(Date.UTC(year, month, day));
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
// MIGRATED to lib/adventure-prep-service.js (Postgres). Same request/
// response contract as before.
async function getContext(req, res) {
  const token = (req.query && req.query.token) || '';
  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  const ctx = await adventurePrepService.getContextByToken(token);
  if (!ctx || ctx.notFound) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }
  res.status(200).json(ctx);
}

// -- saveFields, was POST /api/save-adventure-prep ---------------------------
// MIGRATED to lib/adventure-prep-service.js (Postgres). Same request/
// response contract, EXCEPT isParticipating/participatingRosterRef/
// reconfirmedRosterJson are no longer accepted here (see this file's
// header comment) — they now always land in `rejectedFields`, same as any
// other unrecognized key. Callers still sending them need to move to the
// new confirmRoster action below.
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
  const result = await adventurePrepService.saveFields(token, fields);
  if (!result || result.ok === false) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }
  res.status(200).json(result);
}

// -- confirmRoster, NEW ------------------------------------------------------
// Backs the Adventure Prep roster-reconfirmation screen. See
// lib/adventure-prep-service.js's confirmRoster() for the full contract —
// this is a thin validation + status-code layer over it, same pattern as
// every other action in this file.
async function confirmRoster(body, res) {
  const token = body.token;
  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  if (typeof body.isParticipating !== 'boolean') {
    res.status(400).json({ error: 'missing_is_participating' });
    return;
  }
  const result = await adventurePrepService.confirmRoster(token, {
    isParticipating: body.isParticipating,
    ownerParticipantId: body.ownerParticipantId || null,
    ownerNewEntry: body.ownerNewEntry || null,
    roster: Array.isArray(body.roster) ? body.roster : [],
  });
  if (!result || result.ok === false) {
    const message = (result && result.error) || '';
    if (message.indexOf('Invalid or expired') === 0) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }
    res.status(400).json({ error: 'invalid_request', message });
    return;
  }
  res.status(200).json(result);
}

// -- runTrailAssignment, was POST /api/run-trail-assignment ------------------
// MIGRATED to lib/run-trail-assignment.js (Postgres). Same request/
// response contract as before.
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
  const ctx = await adventurePrepService.getContextByToken(token);
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
// MIGRATED to lib/adventure-prep-service.js (Postgres). Same request/
// response contract as before.
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
  const result = await adventurePrepService.selectTrail(token, trailId);
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
// MIGRATED to lib/waiver-service.js (Postgres) — closes the LAST launch-
// blocking gap in this file. Implements PRD Section 6's resolved guardian
// hybrid model: the server now derives its own signer list directly from
// booking_participants (see lib/waiver-service.js's own header comment,
// point 2) instead of trusting a client-supplied `signers` array — the
// request shape simplifies to just `{token}`, no `signers` payload needed
// anymore. Sends to both ordinary attending-adult signers AND any
// non-attending assigned guardian (role_on_booking = 'guardian_only').
//
// FLAG FOR AIREY / task 11 (frontend + copy review, already pending):
// renderSignerWaiverInviteEmail's copy ("added you to an upcoming day on
// the trail... your own signed Release of Liability") was written only
// for the ordinary attending-signer case and doesn't quite fit a
// non-attending external guardian, who isn't personally on the trail at
// all. Sent as-is for now (a working link to the right person, which is a
// large improvement over every such request failing outright pre-
// migration) rather than blocking this gap's closure on new copy — but
// the guardian_only case (`signer.isGuardianOnly` below) should get its
// own copy variant in the frontend/copy pass, not before.
async function sendSignerLinks(body, res) {
  const token = body.token;
  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  const result = await waiverService.sendSignerLinksForBooking(token);
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
// MIGRATED to lib/finalize-kit-change.js (Postgres) — this handler only
// SETS the pending kit-count debounce fields (a guest moving the stepper
// on Surface A); the actual Stripe charge/refund happens later, once the
// debounce window closes, via finalizePendingKitChange (called by the
// cron job — see lib/finalize-kit-change.js's own header comment). Same
// request/response contract as the pre-migration version, same
// booking_status/T-3-cutoff guard checks (unchanged from the Apps Script
// version — not something this session revisited).
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

  const ctx = await getKitAdjustContextByToken(token);
  if (!ctx) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }
  if (ctx.booking_status === 'cancelled') {
    res.status(409).json({ error: 'booking_cancelled' });
    return;
  }
  if (!isBeforeT3Cutoff(ctx.date)) {
    res.status(409).json({ error: 'past_t3_cutoff' });
    return;
  }

  const currentConfirmed =
    parseInt(ctx.confirmed_kit_count, 10) ||
    parseInt(ctx.gear_kit_count || 0, 10) ||
    0;

  if (requestedKitCount === currentConfirmed) {
    await setPendingKitChange({ bookingId: ctx.booking_id, pendingKitCount: null, pendingSince: null });
    res.status(200).json({ status: 'no_change', currentConfirmedKitCount: currentConfirmed });
    return;
  }

  const pendingSince = new Date().toISOString();
  await setPendingKitChange({ bookingId: ctx.booking_id, pendingKitCount: requestedKitCount, pendingSince });

  res.status(200).json({
    status: 'pending',
    requestedKitCount,
    currentConfirmedKitCount: currentConfirmed,
    pendingSince,
  });
}

// -- setRosterGearKits, NEW ---------------------------------------------
// Backs the Adventure Prep Gear Kits screen's per-person kit toggle. See
// lib/adventure-prep-service.js's setRosterGearKits() for why this is a
// separate action from confirmRoster.
async function setRosterGearKits(body, res) {
  const token = body.token;
  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  if (!Array.isArray(body.updates) || !body.updates.length) {
    res.status(400).json({ error: 'missing_updates' });
    return;
  }
  const result = await adventurePrepService.setRosterGearKits(token, body.updates);
  if (!result || result.ok === false) {
    const message = (result && result.error) || '';
    if (message.indexOf('Invalid or expired') === 0) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }
    res.status(400).json({ error: 'invalid_request', message });
    return;
  }
  res.status(200).json(result);
}

const POST_ACTIONS = {
  saveFields,
  confirmRoster,
  runTrailAssignment,
  selectTrail,
  sendSignerLinks,
  adjustGearKitCount,
  setRosterGearKits,
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
