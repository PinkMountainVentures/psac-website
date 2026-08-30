/**
 * api/waiver.js
 *
 * CONSOLIDATED, build-review Aug 2026, same reason and same treatment as
 * api/adventure-prep.js (see that file's header for the full "why one file
 * now instead of many" explanation) — this merges get-signer.js,
 * save-waiver-signature.js, and save-emergency-contact.js. These three
 * were already conceptually one family (Surface B's own load/save calls,
 * plus the two save endpoints Surface A's owner flow shares with Surface
 * B), so they get their own file separate from api/adventure-prep.js's
 * Surface-A-primary actions rather than being folded into one single
 * mega-dispatcher.
 *
 * Every action below is a byte-for-byte-behavior port of its original
 * file — same auth, same validation order, same response shapes and status
 * codes. Only the URL and the need to say which action changed.
 *
 * Request shapes:
 *   GET  /api/waiver?signerToken=...
 *     -> was GET /api/get-signer
 *   POST /api/waiver { action: 'saveWaiverSignature', token?, signerToken?, ... }
 *     -> was POST /api/save-waiver-signature
 *   POST /api/waiver { action: 'saveSignerDetails', signerToken, signerEmail?, signerPhone?, smsConsent?, ... }
 *     -> new, Round 2 (mockup-07): Surface B's "Confirm Your Details" hub
 *        tile. signerToken only (non-owner action) — see this file's own
 *        saveSignerDetails() and adventurePrep_saveSignerDetails_'s own
 *        comment for why this is deliberately NOT folded into
 *        saveWaiverSignature.
 *   POST /api/waiver { action: 'saveEmergencyContact', token?, signerToken?, ... }
 *     -> was POST /api/save-emergency-contact
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

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
  const ctx = await callBookingsWebApp('adventurePrep_getSignerContext', { signerToken });
  if (!ctx || ctx.notFound) {
    res.status(404).json({ error: 'invalid_signer_token' });
    return;
  }
  try {
    await callBookingsWebApp('adventurePrep_markSignerOpened', { signerToken });
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
    rosterRef: body.rosterRef,
    signerName: body.signerName,
    signerEmail: body.signerEmail,
    signerPhone: body.signerPhone,
    smsConsent: body.smsConsent,
    smsConsentAt: body.smsConsentAt,
    smsConsentText: body.smsConsentText,
    isGuardian: body.isGuardian,
    guardianForChildren: body.guardianForChildren,
    participantsCovered: body.participantsCovered,
    ipAddress: clientIp(req),
  };
  const result = await callBookingsWebApp('adventurePrep_saveWaiverSignature', payload);
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
  const result = await callBookingsWebApp('adventurePrep_saveSignerDetails', payload);
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
  const result = await callBookingsWebApp('adventurePrep_saveEmergencyContact', payload);
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
