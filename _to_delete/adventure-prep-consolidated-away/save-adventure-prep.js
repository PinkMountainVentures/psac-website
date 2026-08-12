/**
 * api/save-adventure-prep.js
 *
 * Thin wrapper over adventurePrep_saveFields — Surface A's generic
 * "write these fields to my Adventure Prep row" endpoint, used for every
 * 1.2a input (roster reconfirmation, technical/heat comfort,
 * bestForAttributes) and the delivery-address fields. Deliberately CANNOT
 * write candidateTrails, selectedTrailId, assignedAt, assignmentMethod,
 * or confirmedKitCount — those go through their own dedicated endpoints
 * (api/run-trail-assignment.js, api/select-trail.js,
 * api/adjust-gear-kit-count.js) so a client can never bypass the engine,
 * the debounce window, or the Stripe path by just POSTing here. The
 * whitelist that enforces this lives Apps Script-side
 * (ADVENTURE_PREP_WRITABLE_FIELDS in adventure-prep-actions.gs), not
 * duplicated here, so there's exactly one place it can drift out of date.
 *
 * Request:  POST /api/save-adventure-prep
 *           { token: string, fields: { [fieldName]: any } }
 *
 * Response:
 *   200 { ok: true, bookingId, rejectedFields: string[] }
 *     rejectedFields lists any keys Apps Script refused to write (not on
 *     the whitelist, or not a recognized column) — Surface A should treat
 *     a non-empty rejectedFields as a bug to report, not something to
 *     silently ignore, since it means the client sent a field name this
 *     endpoint doesn't actually support.
 *   400 { error: 'missing_token' | 'missing_fields' }
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

  try {
    const result = await callBookingsWebApp('adventurePrep_saveFields', { token, fields });
    if (!result || result.ok === false) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('save-adventure-prep failed', token, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
