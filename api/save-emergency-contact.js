/**
 * api/save-emergency-contact.js
 *
 * Thin wrapper over adventurePrep_saveEmergencyContact. Same owner/signer
 * dual-identifier pattern as save-waiver-signature.js — `token` for the
 * booking owner (Surface A), `signerToken` for a non-owner signer
 * (Surface B step 3, optional). Each person's emergency contact is their
 * own, not the group's (per Surface B mockup: "Not the group's, yours
 * specifically").
 *
 * Request:  POST /api/save-emergency-contact
 *           {
 *             token?: string,
 *             signerToken?: string,
 *             contactName, contactPhone, contactEmail?,
 *           }
 *
 * Response:
 *   200 { ok: true }
 *   400 { error: 'missing_identifier' }
 *   404 { error: 'invalid_token' }
 *   500 { error: 'engineering_error', detail }
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

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
    contactName: body.contactName,
    contactPhone: body.contactPhone,
    contactEmail: body.contactEmail,
  };

  try {
    const result = await callBookingsWebApp('adventurePrep_saveEmergencyContact', payload);
    if (!result || result.ok === false) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('save-emergency-contact failed', body.token || body.signerToken, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
