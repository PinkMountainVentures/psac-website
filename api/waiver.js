/**
 * api/waiver.js
 *
 * MIGRATED (2026-08-31 build session): every action now calls
 * lib/waiver-service.js (Postgres) instead of
 * lib/apps-script-client.js's callBookingsWebApp() — this was the other
 * half of the guardian hybrid model gap alongside api/adventure-prep.js's
 * sendSignerLinks, since Surface B (the non-owner signer hub) is entirely
 * served by this file's getSigner action, and neither Surface A's own
 * waiver step nor Surface B could have worked for any real post-cutover
 * booking (no row in the old Sheet for callBookingsWebApp to find) until
 * this moved too.
 *
 * Request/response shapes are the same as the pre-migration version, with
 * one change: saveWaiverSignature's `guardianForChildren` becomes
 * `guardianForChildrenParticipantIds` (an array of
 * booking_participants.participant_id, not child names) — see
 * lib/waiver-service.js's own header comment, point 1, for why. Frontend
 * request-shape reconciliation (waiver-signer-form.js) is a pending task,
 * same as adventure-prep-form.js's roster screen — see the migration
 * progress doc.
 *
 * Request shapes:
 *   GET  /api/waiver?signerToken=...
 *   POST /api/waiver { action: 'saveWaiverSignature', token?, signerToken?, signerName, signerEmail?, signerPhone?, smsConsent?, isGuardian?, guardianForChildrenParticipantIds?, participantsCovered? }
 *   POST /api/waiver { action: 'saveSignerDetails', signerToken, signerEmail?, signerPhone?, smsConsent?, ... }
 *   POST /api/waiver { action: 'saveEmergencyContact', token?, signerToken?, contactName, contactPhone, contactEmail }
 *   POST /api/waiver { action: 'confirmTrailReturnRoster', signerToken, presentParticipantIds? }  -- NEW (full roster return + SAR experience, 2026-09-08): Surface B's half of the "Everyone back from [trail]?" roster-confirm sheet, see lib/trail-checkin-incident-service.js's confirmTrailReturnRoster(). Resolves signerToken via waiverService.resolveSignerForCheckin() to the bookingId Surface A's own adventure-prep.js action also resolves to, so both surfaces write the same roster snapshot.
 *   POST /api/waiver { action: 'reportTrailCheckinIncident', signerToken, category, categoryDetail?, affectedParticipantIds?, personalDescription?, medicalNote?, vehicleDescription?, reportedNewFinishEstimate?, reportedRemainingDistance?, otherNotes? }  -- NEW (full roster return + SAR experience, 2026-09-08): Surface B's half of the six-option "What's going on?" triage, see lib/trail-checkin-incident-service.js's reportTrailCheckinIncident(). reportedByRole is derived server-side from the signer's own role (participant / participant_guardian / guardian_only), never trusted from the client.
 *   POST /api/waiver { action: 'submitFeedback', signerToken, overallRating, gearRating?, checkinRating?, note? }  -- NEW (Post-Adventure Check-in, 2026-09-08): Surface B's half of the Check-in card (participant/participant_guardian 2-field set, or guardian_only's own "staying in the loop" 2-field set), see lib/feedback-service.js's submitFeedback(). reportedByRole and participantId are both derived server-side from the signer's own role via waiverService.resolveSignerForCheckin(), same as reportTrailCheckinIncident above.
 *   POST /api/waiver { action: 'confirmHeadingOut', signerToken, absentParticipantIds? }  -- NEW (Surface B trail-day arc, 2026-09-08): Surface B's half of the Heading Out roster-confirm sheet, see lib/adventure-prep-service.js's confirmHeadingOutByBookingId(). Idempotent, same as Surface A's own action.
 *   POST /api/waiver { action: 'markGuideOpened', signerToken }  -- NEW (Surface B trail-day arc, 2026-09-08): fires on every Get Guide tap, first-tap-wins server-side, same as Surface A's own action.
 */

'use strict';

const waiverService = require('../lib/waiver-service');
const trailCheckinIncidentService = require('../lib/trail-checkin-incident-service');
const feedbackService = require('../lib/feedback-service');
const adventurePrepService = require('../lib/adventure-prep-service');

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

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

// -- getSigner, was GET /api/get-signer --------------------------------------
async function getSigner(req, res) {
  const signerToken = (req.query && req.query.signerToken) || '';
  if (!signerToken) {
    res.status(400).json({ error: 'missing_signer_token' });
    return;
  }
  const ctx = await waiverService.getSignerContext(signerToken);
  if (!ctx || ctx.notFound) {
    res.status(404).json({ error: 'invalid_signer_token' });
    return;
  }
  try {
    await waiverService.markSignerOpened(signerToken);
  } catch (markErr) {
    // eslint-disable-next-line no-console
    console.error('waiver/getSigner: markSignerOpened failed (non-fatal)', signerToken, markErr);
  }
  res.status(200).json(ctx);
}

// -- saveWaiverSignature, was POST /api/save-waiver-signature ----------------
async function saveWaiverSignature(body, req, res) {
  if (!body.token && !body.signerToken) {
    res.status(400).json({ error: 'missing_identifier' });
    return;
  }
  const payload = {
    token: body.token,
    signerToken: body.signerToken,
    signerName: body.signerName,
    signerEmail: body.signerEmail,
    signerPhone: body.signerPhone,
    smsConsent: body.smsConsent,
    smsConsentAt: body.smsConsentAt,
    smsConsentText: body.smsConsentText,
    isGuardian: body.isGuardian,
    guardianForChildrenParticipantIds: body.guardianForChildrenParticipantIds,
    participantsCovered: body.participantsCovered,
    ipAddress: clientIp(req),
  };
  const result = await waiverService.saveWaiverSignature(payload);
  if (!result || result.ok === false) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }
  res.status(200).json(result);
}

// -- saveSignerDetails, Surface B "Confirm Your Details" (Round 2, mockup-07)
async function saveSignerDetails(body, req, res) {
  if (!body.signerToken) {
    res.status(400).json({ error: 'missing_identifier' });
    return;
  }
  const payload = {
    signerToken: body.signerToken,
    signerEmail: body.signerEmail,
    signerPhone: body.signerPhone,
    smsConsent: body.smsConsent,
    smsConsentAt: body.smsConsentAt,
    smsConsentText: body.smsConsentText,
  };
  const result = await waiverService.saveSignerDetails(payload);
  if (!result || result.ok === false) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }
  res.status(200).json(result);
}

// -- saveEmergencyContact, was POST /api/save-emergency-contact -------------
async function saveEmergencyContact(body, req, res) {
  if (!body.token && !body.signerToken) {
    res.status(400).json({ error: 'missing_identifier' });
    return;
  }
  const payload = {
    token: body.token,
    signerToken: body.signerToken,
    contactName: body.contactName,
    contactPhone: body.contactPhone,
    contactEmail: body.contactEmail,
  };
  const result = await waiverService.saveEmergencyContact(payload);
  if (!result || result.ok === false) {
    res.status(404).json({ error: 'invalid_token' });
    return;
  }
  res.status(200).json(result);
}

// -- confirmTrailReturnRoster / reportTrailCheckinIncident, NEW (full
// roster return + SAR experience, 2026-09-08) ------------------------
// Surface B's half of the shared engine -- see api/adventure-prep.js's
// own copy of this same comment for the full contract (one-way tier
// rule, revision-count backstop, etc., all in
// lib/trail-checkin-incident-service.js). The one real difference from
// Surface A: reportedByRole here isn't a fixed 'booker' constant, it's
// resolved per-signer by waiverService.resolveSignerForCheckin() into
// one of 'participant' / 'participant_guardian' / 'guardian_only', per
// Airey's explicit call that every Surface B variant needs access to
// this, with framing that differs by role -- the framing itself lives
// in waiver-signer-form.js, this just makes sure the right role lands
// on the incident/roster record no matter which signer reports it.
async function confirmTrailReturnRoster(body, res) {
  if (!body.signerToken) {
    res.status(400).json({ error: 'missing_identifier' });
    return;
  }
  const signer = await waiverService.resolveSignerForCheckin(body.signerToken);
  if (!signer || signer.notFound) {
    res.status(404).json({ error: 'invalid_signer_token' });
    return;
  }
  const result = await trailCheckinIncidentService.confirmTrailReturnRoster(signer.bookingId, {
    presentParticipantIds: Array.isArray(body.presentParticipantIds) ? body.presentParticipantIds : [],
    reportedByParticipantId: signer.participantId,
    reportedByRole: signer.reportedByRole,
  });
  if (!result || result.ok === false) {
    res.status(400).json({ error: 'invalid_request', message: (result && result.error) || '' });
    return;
  }
  res.status(200).json(result);
}

async function reportTrailCheckinIncident(body, res) {
  if (!body.signerToken) {
    res.status(400).json({ error: 'missing_identifier' });
    return;
  }
  const signer = await waiverService.resolveSignerForCheckin(body.signerToken);
  if (!signer || signer.notFound) {
    res.status(404).json({ error: 'invalid_signer_token' });
    return;
  }
  const result = await trailCheckinIncidentService.reportTrailCheckinIncident(signer.bookingId, {
    category: body.category,
    categoryDetail: body.categoryDetail,
    affectedParticipantIds: Array.isArray(body.affectedParticipantIds) ? body.affectedParticipantIds : [],
    personalDescription: body.personalDescription,
    medicalNote: body.medicalNote,
    vehicleDescription: body.vehicleDescription,
    reportedNewFinishEstimate: body.reportedNewFinishEstimate,
    reportedRemainingDistance: body.reportedRemainingDistance,
    otherNotes: body.otherNotes,
    reportedByParticipantId: signer.participantId,
    reportedByRole: signer.reportedByRole,
  });
  if (!result || result.ok === false) {
    res.status(400).json({ error: 'invalid_request', message: (result && result.error) || '' });
    return;
  }
  res.status(200).json(result);
}

// -- submitFeedback, NEW (Post-Adventure Check-in, 2026-09-08) --------
// Backs every Surface B Check-in variant -- participant and
// participant_guardian share the same 2-field set (overall + optional
// gear), guardian_only gets its own genuinely-different 2-field set
// (overall + optional "staying in the loop" checkinRating) -- see the
// Post-Adventure Phase 3 spec, sections 4-5. Which fields actually carry
// a value is left to waiver-signer-form.js's own per-role Check-in card;
// this just forwards whatever the client sent into
// lib/feedback-service.js, the same shared table/insert path
// api/adventure-prep.js's own submitFeedback uses for the booker.
async function submitFeedback(body, res) {
  if (!body.signerToken) {
    res.status(400).json({ error: 'missing_identifier' });
    return;
  }
  const signer = await waiverService.resolveSignerForCheckin(body.signerToken);
  if (!signer || signer.notFound) {
    res.status(404).json({ error: 'invalid_signer_token' });
    return;
  }
  const result = await feedbackService.submitFeedback(signer.bookingId, {
    participantId: signer.participantId,
    reportedByRole: signer.reportedByRole,
    overallRating: body.overallRating,
    gearRating: body.gearRating,
    checkinRating: body.checkinRating,
    note: body.note,
  });
  if (!result || result.ok === false) {
    res.status(400).json({ error: 'invalid_request', message: (result && result.error) || '' });
    return;
  }
  res.status(200).json(result);
}

// -- confirmHeadingOut / markGuideOpened, NEW (Surface B trail-day arc,
// 2026-09-08) ----------------------------------------------------------
// Backs Surface B's own Heading Out button and Get Guide tap -- same
// core logic as Surface A's identically-named actions
// (lib/adventure-prep-service.js's confirmHeadingOutByBookingId/
// markGuideOpenedByBookingId, split out from the token-coupled originals
// this week for exactly this reason), resolved to a bookingId via
// waiverService.resolveSignerBookingId() instead of a booker token.
async function confirmHeadingOut(body, res) {
  if (!body.signerToken) {
    res.status(400).json({ error: 'missing_identifier' });
    return;
  }
  const signer = await waiverService.resolveSignerBookingId(body.signerToken);
  if (!signer || signer.notFound) {
    res.status(404).json({ error: 'invalid_signer_token' });
    return;
  }
  const result = await adventurePrepService.confirmHeadingOutByBookingId(signer.bookingId, {
    absentParticipantIds: Array.isArray(body.absentParticipantIds) ? body.absentParticipantIds : [],
  });
  if (!result || result.ok === false) {
    res.status(400).json({ error: 'invalid_request', message: (result && result.error) || '' });
    return;
  }
  res.status(200).json(result);
}

async function markGuideOpened(body, res) {
  if (!body.signerToken) {
    res.status(400).json({ error: 'missing_identifier' });
    return;
  }
  const signer = await waiverService.resolveSignerBookingId(body.signerToken);
  if (!signer || signer.notFound) {
    res.status(404).json({ error: 'invalid_signer_token' });
    return;
  }
  const result = await adventurePrepService.markGuideOpenedByBookingId(signer.bookingId);
  if (!result || result.ok === false) {
    res.status(400).json({ error: 'invalid_request', message: (result && result.error) || '' });
    return;
  }
  res.status(200).json(result);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      await getSigner(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const body = parseBody(req);
    if (body.action === 'saveWaiverSignature') {
      await saveWaiverSignature(body, req, res);
      return;
    }
    if (body.action === 'saveSignerDetails') {
      await saveSignerDetails(body, req, res);
      return;
    }
    if (body.action === 'saveEmergencyContact') {
      await saveEmergencyContact(body, req, res);
      return;
    }
    if (body.action === 'confirmTrailReturnRoster') {
      await confirmTrailReturnRoster(body, res);
      return;
    }
    if (body.action === 'reportTrailCheckinIncident') {
      await reportTrailCheckinIncident(body, res);
      return;
    }
    if (body.action === 'confirmHeadingOut') {
      await confirmHeadingOut(body, res);
      return;
    }
    if (body.action === 'markGuideOpened') {
      await markGuideOpened(body, res);
      return;
    }
    if (body.action === 'submitFeedback') {
      await submitFeedback(body, res);
      return;
    }
    res.status(400).json({ error: 'unknown_action' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('waiver action failed', req.method, (req.body && req.body.action) || req.query, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
