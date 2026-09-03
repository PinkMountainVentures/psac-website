/**
 * api/manage-trails-parks.js
 *
 * Consolidated dispatcher for the Ops UX Trails & Parks dashboard (New
 * asks, 2026-09-02, folded into one build 2026-09-03): CRUD for the
 * `trails` table and the `park_access` table, plus trail photo upload.
 * Server-to-server only (api/ops-proxy.js), TRAILS_PARKS_SHARED_SECRET —
 * same fail-closed checkSecret() pattern as every other gear-ops-era
 * endpoint (payment-review Critical #8), and consolidated into one
 * function for the same Vercel-function-cap reasoning as manage-gear-
 * units.js / checkout-gear.js / check-in-gear-item.js.
 */

'use strict';

const trailsParksService = require('../lib/trails-parks-service');
const { uploadTrailPhoto } = require('../lib/trail-photo-upload');

function checkSecret(body) {
  if (!process.env.TRAILS_PARKS_SHARED_SECRET) return false;
  return !!(body && body.secret && body.secret === process.env.TRAILS_PARKS_SHARED_SECRET);
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

    // ---- Trails ----
    if (action === 'trailsList') {
      const result = await trailsParksService.listTrails({ q: body.q || '' });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }
    if (action === 'trailsGet') {
      if (!body.trailId) { res.status(400).json({ error: 'bad_request', detail: 'trailId is required' }); return; }
      const result = await trailsParksService.getTrail({ trailId: body.trailId });
      res.status(result.ok === false ? 404 : 200).json(result);
      return;
    }
    if (action === 'trailsSuggestNextId') {
      const nextTrailId = await trailsParksService.suggestNextTrailId();
      res.status(200).json({ ok: true, nextTrailId });
      return;
    }
    if (action === 'trailsCreate') {
      const result = await trailsParksService.createTrail({ trailId: body.trailId, fields: body.fields || {} });
      res.status(result.ok === false ? 400 : 200).json(result);
      return;
    }
    if (action === 'trailsUpdate') {
      if (!body.trailId) { res.status(400).json({ error: 'bad_request', detail: 'trailId is required' }); return; }
      const result = await trailsParksService.updateTrail({ trailId: body.trailId, fields: body.fields || {} });
      res.status(result.ok === false ? 400 : 200).json(result);
      return;
    }
    if (action === 'trailsDelete') {
      if (!body.trailId) { res.status(400).json({ error: 'bad_request', detail: 'trailId is required' }); return; }
      const result = await trailsParksService.deleteTrail({ trailId: body.trailId });
      res.status(result.ok === false ? 400 : 200).json(result);
      return;
    }
    if (action === 'trailsUploadPhoto') {
      if (!body.trailId || !body.dataUrl) { res.status(400).json({ error: 'bad_request', detail: 'trailId and dataUrl are required' }); return; }
      try {
        const photoUrl = await uploadTrailPhoto({ dataUrl: body.dataUrl, trailId: body.trailId });
        res.status(200).json({ ok: true, photoUrl });
      } catch (uploadErr) {
        console.error('trailsUploadPhoto failed', body.trailId, uploadErr);
        res.status(500).json({ ok: false, error: uploadErr.message });
      }
      return;
    }

    // ---- Parks (park_access) ----
    if (action === 'parksList') {
      const result = await trailsParksService.listParks({ q: body.q || '' });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }
    if (action === 'parksGet') {
      if (!body.parkAccessId) { res.status(400).json({ error: 'bad_request', detail: 'parkAccessId is required' }); return; }
      const result = await trailsParksService.getPark({ parkAccessId: body.parkAccessId });
      res.status(result.ok === false ? 404 : 200).json(result);
      return;
    }
    if (action === 'parksListNames') {
      const result = await trailsParksService.listParkNames();
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }
    if (action === 'parksNameMismatches') {
      const result = await trailsParksService.getParkNameMismatches();
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }
    if (action === 'parksCreate') {
      const result = await trailsParksService.createPark({ fields: body.fields || {} });
      res.status(result.ok === false ? 400 : 200).json(result);
      return;
    }
    if (action === 'parksUpdate') {
      if (!body.parkAccessId) { res.status(400).json({ error: 'bad_request', detail: 'parkAccessId is required' }); return; }
      const result = await trailsParksService.updatePark({ parkAccessId: body.parkAccessId, fields: body.fields || {} });
      res.status(result.ok === false ? 400 : 200).json(result);
      return;
    }
    if (action === 'parksDelete') {
      if (!body.parkAccessId) { res.status(400).json({ error: 'bad_request', detail: 'parkAccessId is required' }); return; }
      const result = await trailsParksService.deletePark({ parkAccessId: body.parkAccessId });
      res.status(result.ok === false ? 400 : 200).json(result);
      return;
    }

    res.status(400).json({ error: 'unknown_action', detail: action });
  } catch (err) {
    console.error('manage-trails-parks failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
