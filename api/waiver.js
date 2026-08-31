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
 */

'use strict';

const waiverService = require('../lib/waiver-service');

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
    res.status(400).json({ error: 'unknown_action' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('waiver action failed', req.method, (req.body && req.body.action) || req.query, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
