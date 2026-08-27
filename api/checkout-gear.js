/**
 * api/checkout-gear.js
 *
 * Gear Inventory PRD Section 4: consolidated dispatcher for the gear
 * assembly & checkout screen's three server actions. Server-to-server only
 * (api/ops-proxy.js), GEAR_OPS_SHARED_SECRET.
 *
 *   - 'getQueue'      -> gearOps_getCheckoutQueue (T-1 checkout list)
 *   - 'confirmScan'    -> gearOps_confirmCheckoutScan. QR scan or the
 *     equally-weighted manual unit-ID entry fallback both land here the
 *     same way — this endpoint doesn't know or care which one the client
 *     used. Returns a structured `mismatch` reason rather than a bare
 *     error on a scanned/entered unit that isn't actually this booking's —
 *     Section 4/6's real-and-expected-but-previously-undesigned case — so
 *     the client can render a clear explanation instead of a generic
 *     failure. Deliberately always 200, even on a mismatch: a mismatch is
 *     an expected, structured outcome the checkout screen renders inline,
 *     not a request error.
 *   - 'markDelivered'  -> gearOps_markDelivered (the deliberate manual
 *     Uber Direct stand-in, Section 4 — Post-MVP replaces this action, not
 *     this endpoint's contract)
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

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

    if (action === 'getQueue') {
      if (!body.tripDate) {
        res.status(400).json({ error: 'bad_request', detail: 'tripDate is required' });
        return;
      }
      const result = await callBookingsWebApp('gearOps_getCheckoutQueue', { tripDate: body.tripDate });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'confirmScan') {
      if (!body.bookingId || !body.unitId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId and unitId are required' });
        return;
      }
      const result = await callBookingsWebApp('gearOps_confirmCheckoutScan', {
        bookingId: body.bookingId,
        unitId: String(body.unitId).trim(),
      });
      res.status(200).json(result);
      return;
    }

    if (action === 'markDelivered') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await callBookingsWebApp('gearOps_markDelivered', {
        bookingId: body.bookingId,
        deliveredBy: body.deliveredBy || '',
      });
      res.status(200).json(result);
      return;
    }

    // Ops App Redesign (Aug 2026) — Gear Assembly & Checkout item 5. The
    // single Mark Delivered button becomes three sequential, timestamped
    // states (apps-script/ops-redesign-round2-actions.gs). These three
    // supersede the plain 'markDelivered' branch above for pages built
    // against this round — that branch stays for backward compatibility,
    // not removed.
    if (action === 'markReadyForDelivery') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await callBookingsWebApp('gearOps_markReadyForDelivery', { bookingId: body.bookingId });
      res.status(200).json(result);
      return;
    }

    if (action === 'scheduleDelivery') {
      if (!body.bookingId || !body.deliveryServiceType || !body.deliveryTimeSlot) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId, deliveryServiceType, and deliveryTimeSlot are required' });
        return;
      }
      const result = await callBookingsWebApp('gearOps_scheduleDelivery', {
        bookingId: body.bookingId,
        deliveryServiceType: body.deliveryServiceType,
        deliveryTimeSlot: body.deliveryTimeSlot,
      });
      res.status(200).json(result);
      return;
    }

    // Round 2 item 5's Delivery Scheduled mini-form needs the guest's own
    // deliveryWindow (Adventure Prep) to constrain the Delivery Time
    // dropdown to valid slots only. Reuses gearOps_getReturnContext
    // (apps-script/ops-redesign-round2-actions.gs) rather than a second
    // near-identical Apps Script read — see that function's own header.
    if (action === 'getDeliveryContext') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await callBookingsWebApp('gearOps_getReturnContext', { bookingId: body.bookingId });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'markDeliveredFinal') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await callBookingsWebApp('gearOps_markDeliveredFinal', {
        bookingId: body.bookingId,
        deliveredBy: body.deliveredBy || '',
      });
      res.status(200).json(result);
      return;
    }

    res.status(400).json({ error: 'unknown_action', detail: action });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('checkout-gear failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
