/**
 * api/manage-gear-units.js
 *
 * Gear Inventory PRD Section 2/11: consolidated dispatcher for the Gear
 * Units page — the standing inventory list, Add Unit, Retire Unit, Mark
 * Clean, and Mark Deep-Cleaned. Server-to-server only (api/ops-proxy.js),
 * GEAR_OPS_SHARED_SECRET.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

const VALID_ITEM_TYPES = ['backpack_standard', 'backpack_plus', 'poles', 'bottle', 'first_aid_kit', 'duffel'];

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

    const action = body.action;

    if (action === 'listUnits') {
      const result = await callBookingsWebApp('gearOps_listUnits', { itemType: body.itemType || '' });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'addUnit') {
      if (!body.unitId || !String(body.unitId).trim() || VALID_ITEM_TYPES.indexOf(body.itemType) === -1) {
        res.status(400).json({ error: 'bad_request', detail: `unitId is required and itemType must be one of: ${VALID_ITEM_TYPES.join(', ')}` });
        return;
      }
      const result = await callBookingsWebApp('gearOps_addUnit', {
        unitId: String(body.unitId).trim(),
        itemType: body.itemType,
        replacementCostCents: body.replacementCostCents != null ? Number(body.replacementCostCents) : undefined,
        acquiredAt: body.acquiredAt || '',
      });
      res.status(200).json(result);
      return;
    }

    if (action === 'retireUnit') {
      if (!body.unitId || !body.retiredReason || !String(body.retiredReason).trim()) {
        res.status(400).json({ error: 'bad_request', detail: 'unitId and retiredReason are required' });
        return;
      }
      const result = await callBookingsWebApp('gearOps_retireUnit', { unitId: body.unitId, retiredReason: body.retiredReason });
      res.status(200).json(result);
      return;
    }

    if (action === 'markClean') {
      if (!body.unitId) {
        res.status(400).json({ error: 'bad_request', detail: 'unitId is required' });
        return;
      }
      const result = await callBookingsWebApp('gearOps_markClean', { unitId: body.unitId });
      res.status(200).json(result);
      return;
    }

    if (action === 'markDeepCleaned') {
      if (!body.unitId) {
        res.status(400).json({ error: 'bad_request', detail: 'unitId is required' });
        return;
      }
      const result = await callBookingsWebApp('gearOps_markDeepCleaned', { unitId: body.unitId });
      res.status(200).json(result);
      return;
    }

    res.status(400).json({ error: 'unknown_action', detail: action });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('manage-gear-units failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
