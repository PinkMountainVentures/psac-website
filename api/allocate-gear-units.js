/**
 * api/allocate-gear-units.js
 *
 * Gear Inventory PRD Section 3/4: consolidated dispatcher for the
 * allocation step of gear assembly — pick specific Gear Units for a
 * booking's already-existing Gear Check Log rows, size-matched where
 * possible, shortage-flagged where not. Server-to-server only, called by
 * api/ops-proxy.js (staff session already checked there) with the real
 * secret injected — never called directly from a browser.
 *
 * Three actions, matching the three Sheet-side functions this build added
 * in apps-script/gear-inventory-actions.gs:
 *   - 'allocate'      -> gearOps_allocateUnits (idempotent/incremental —
 *     safe to call again if staff reopens a checkout record)
 *   - 'getAllocation' -> gearOps_getAllocation (reopen without re-running)
 *   - 'recordShortageResolution' -> gearOps_recordShortageResolution
 *     (Section 3/16's confirmed-sufficient oversell handling: one staff
 *     pick from reassign/expedite/contact-guest, logged, nothing more —
 *     no reassignment engine, no PO form, no message composer)
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

const SHORTAGE_RESOLUTIONS = ['reassign', 'expedite', 'contact-guest'];

function checkSecret(body) {
  // Fail closed: require both a configured secret and a non-empty
  // caller-supplied one, so an unset env var never matches an absent
  // payload.secret (undefined === undefined would otherwise pass).
  if (!process.env.GEAR_OPS_SHARED_SECRET) return false;
  return !!(body && body.secret && body.secret === process.env.GEAR_OPS_SHARED_SECRET);
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  return body || {};
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const body = parseBody(req);
    if (!checkSecret(body)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!body.bookingId) {
      res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
      return;
    }

    const action = body.action || 'allocate';

    if (action === 'allocate') {
      const result = await callBookingsWebApp('gearOps_allocateUnits', { bookingId: body.bookingId });
      res.status(200).json(result);
      return;
    }

    if (action === 'getAllocation') {
      const result = await callBookingsWebApp('gearOps_getAllocation', { bookingId: body.bookingId });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'recordShortageResolution') {
      if (SHORTAGE_RESOLUTIONS.indexOf(body.resolution) === -1) {
        res.status(400).json({ error: 'bad_request', detail: `resolution must be one of: ${SHORTAGE_RESOLUTIONS.join(', ')}` });
        return;
      }
      const result = await callBookingsWebApp('gearOps_recordShortageResolution', {
        bookingId: body.bookingId,
        itemType: body.itemType || '',
        resolution: body.resolution,
        note: body.note || '',
      });
      res.status(200).json(result);
      return;
    }

    res.status(400).json({ error: 'unknown_action', detail: action });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('allocate-gear-units failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
