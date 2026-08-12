/**
 * api/select-trail.js
 *
 * Thin wrapper over adventurePrep_selectTrail — the self-service
 * re-selection mechanic (PRD Section 4: "re-selecting among the current
 * candidates is self-service, instant"). The guest can only pick a
 * trailId already present in their own candidateTrails list; Apps
 * Script-side validation of that (not this file) is what actually
 * prevents picking an arbitrary trail.
 *
 * Request:  POST /api/select-trail
 *           { token: string, trailId: string }
 *
 * Response:
 *   200 { ok: true, selectedTrailId, assignmentMethod }
 *   400 { error: 'missing_token' | 'missing_trail_id' }
 *   404 { error: 'invalid_token' }
 *   409 { error: 'not_a_candidate' }
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
  const trailId = body.trailId;

  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  if (!trailId) {
    res.status(400).json({ error: 'missing_trail_id' });
    return;
  }

  try {
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
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('select-trail failed', token, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
