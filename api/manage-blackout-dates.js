/**
 * api/manage-blackout-dates.js
 *
 * NEW (2026-09-09). Dispatcher for the Availability ops page's blackout-
 * dates CRUD (list / create / delete) -- Airey's calendar-blackout feature,
 * see lib/blackout-dates-service.js's own header for the full design.
 * Server-to-server only (api/ops-proxy.js), BLACKOUT_DATES_SHARED_SECRET
 * -- same fail-closed checkSecret() pattern as every other ops-CRUD
 * endpoint (api/manage-trails-parks.js, api/manage-gear-units.js).
 */

'use strict';

const blackoutDatesService = require('../lib/blackout-dates-service');

function checkSecret(body) {
  if (!process.env.BLACKOUT_DATES_SHARED_SECRET) return false;
  return !!(body && body.secret && body.secret === process.env.BLACKOUT_DATES_SHARED_SECRET);
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

    const action = body.action;

    if (action === 'blackoutList') {
      const result = await blackoutDatesService.listBlackoutDates();
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'blackoutCreate') {
      if (!body.startDate || !body.endDate) {
        res.status(400).json({ error: 'bad_request', detail: 'startDate and endDate are required' });
        return;
      }
      const result = await blackoutDatesService.createBlackoutDate({
        startDate: body.startDate,
        endDate: body.endDate,
        note: body.note || '',
        // Forced from the authenticated ops session by api/ops-proxy.js,
        // never accepted from the client -- same posture as every other
        // staffEmail/reviewedBy/resolvedBy field this proxy injects.
        createdBy: body.staffEmail || '',
      });
      res.status(result.ok === false ? 400 : 200).json(result);
      return;
    }

    if (action === 'blackoutDelete') {
      if (!body.blackoutId) {
        res.status(400).json({ error: 'bad_request', detail: 'blackoutId is required' });
        return;
      }
      const result = await blackoutDatesService.deleteBlackoutDate({ blackoutId: body.blackoutId });
      res.status(result.ok === false ? 400 : 200).json(result);
      return;
    }

    res.status(400).json({ error: 'unknown_action', detail: action });
  } catch (err) {
    console.error('manage-blackout-dates failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
