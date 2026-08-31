/**
 * api/manage-gear-units.js
 *
 * MIGRATED (2026-08-31, gear-ops build session): now calls lib/gear-
 * service.js (Postgres) instead of lib/apps-script-client.js's
 * callBookingsWebApp(). See lib/gear-service.js's own header for the full
 * scope of this migration.
 *
 * Gear Inventory PRD Section 2/11: consolidated dispatcher for the Gear
 * Units page — the standing inventory list, Add Unit, Retire Unit, Mark
 * Clean, and Mark Deep-Cleaned. Server-to-server only (api/ops-proxy.js),
 * GEAR_OPS_SHARED_SECRET.
 */

'use strict';

const gearService = require('../lib/gear-service');

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
      const result = await gearService.listUnits({ itemType: body.itemType || '' });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'addUnit') {
      if (!body.unitId || !String(body.unitId).trim() || VALID_ITEM_TYPES.indexOf(body.itemType) === -1) {
        res.status(400).json({ error: 'bad_request', detail: `unitId is required and itemType must be one of: ${VALID_ITEM_TYPES.join(', ')}` });
        return;
      }
      const result = await gearService.addUnit({
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
      const result = await gearService.retireUnit({ unitId: body.unitId, retiredReason: body.retiredReason });
      res.status(200).json(result);
      return;
    }

    if (action === 'markClean') {
      if (!body.unitId) {
        res.status(400).json({ error: 'bad_request', detail: 'unitId is required' });
        return;
      }
      const result = await gearService.markClean({ unitId: body.unitId });
      res.status(200).json(result);
      return;
    }

    if (action === 'markDeepCleaned') {
      if (!body.unitId) {
        res.status(400).json({ error: 'bad_request', detail: 'unitId is required' });
        return;
      }
      const result = await gearService.markDeepCleaned({ unitId: body.unitId });
      res.status(200).json(result);
      return;
    }

    // Ops App Redesign (Aug 2026) — Gear Units item 7. Confirmed decision
    // (claude/psac-ops-redesign-open-items-confirmed.md item 3): a repaired
    // unit returns straight to Available, matching Mark Clean/Mark Deep-
    // Cleaned, NOT routed through Needs Cleaning first — so this reuses
    // markClean directly rather than a new gear-service function.
    if (action === 'markRepaired') {
      if (!body.unitId) {
        res.status(400).json({ error: 'bad_request', detail: 'unitId is required' });
        return;
      }
      const result = await gearService.markClean({ unitId: body.unitId });
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
