/**
 * api/save-waiver-signature.js
 *
 * Thin wrapper over adventurePrep_saveWaiverSignature — handles BOTH the
 * booking owner's own waiver (Surface A step 9, identified by `token`)
 * and a non-owner signer's waiver (Surface B, identified by
 * `signerToken`). Exactly one of the two must be present; Apps
 * Script-side branches on which one it got.
 *
 * Request:  POST /api/save-waiver-signature
 *           {
 *             token?: string,          // owner path
 *             signerToken?: string,    // non-owner path
 *             rosterRef?: string,
 *             signerName, signerEmail, signerPhone?,
 *             smsConsent?, smsConsentAt?, smsConsentText?,
 *             isGuardian?: boolean,
 *             guardianForChildren?: array,
 *             participantsCovered?: array,
 *             ipAddress?: string,
 *           }
 *
 * ipAddress is read server-side from the request, never trusted from the
 * client body (a caller-supplied IP on a legal signature record would be
 * trivially spoofable) — see below.
 *
 * Response:
 *   200 { ok: true, bookingId, signedAt }
 *   400 { error: 'missing_identifier' }
 *   404 { error: 'invalid_token' }
 *   500 { error: 'engineering_error', detail }
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

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

  try {
    const result = await callBookingsWebApp('adventurePrep_saveWaiverSignature', payload);
    if (!result || result.ok === false) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('save-waiver-signature failed', body.token || body.signerToken, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
