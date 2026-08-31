/**
 * api/checkout-gear.js
 *
 * MIGRATED (2026-08-31, gear-ops build session): now calls lib/gear-
 * service.js (Postgres) instead of lib/apps-script-client.js's
 * callBookingsWebApp(). See lib/gear-service.js's own header for the full
 * scope of this migration.
 *
 * Gear Inventory PRD Section 4: consolidated dispatcher for the gear
 * assembly & checkout screen's server actions. Server-to-server only
 * (api/ops-proxy.js), GEAR_OPS_SHARED_SECRET.
 *
 *   - 'getQueue'      -> getCheckoutQueue (T-1 checkout list)
 *   - 'confirmScan'    -> confirmCheckoutScan. QR scan or the equally-
 *     weighted manual unit-ID entry fallback both land here the same way —
 *     this endpoint doesn't know or care which one the client used.
 *     Returns a structured `mismatch` reason rather than a bare error on a
 *     scanned/entered unit that isn't actually this booking's — Section
 *     4/6's real-and-expected-but-previously-undesigned case — so the
 *     client can render a clear explanation instead of a generic failure.
 *     Deliberately always 200, even on a mismatch: a mismatch is an
 *     expected, structured outcome the checkout screen renders inline, not
 *     a request error.
 *   - 'markDelivered'  -> markDelivered (V1, superseded by markDeliveredFinal
 *     below for pages built against the Round 2 delivery state machine —
 *     kept for backward compatibility, not removed)
 *   - 'markReadyForDelivery' / 'scheduleDelivery' / 'getDeliveryContext' /
 *     'markDeliveredFinal' -> the Round 2 outbound-leg state machine
 *     (Ready for Delivery / Delivery Scheduled / Delivered)
 */

'use strict';

const gearService = require('../lib/gear-service');

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
      const result = await gearService.getCheckoutQueue({ tripDate: body.tripDate });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'confirmScan') {
      if (!body.bookingId || !body.unitId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId and unitId are required' });
        return;
      }
      const result = await gearService.confirmCheckoutScan({
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
      // BUG FIX (payment-review, Aug 2026, Medium #45): used to trust a
      // client-supplied `deliveredBy` string outright. ops-proxy.js now
      // forces `staffEmail` from the authenticated session on every
      // gear-ops call; use that instead of anything the browser sends.
      const result = await gearService.markDelivered({
        bookingId: body.bookingId,
        deliveredBy: body.staffEmail || '',
      });
      res.status(200).json(result);
      return;
    }

    // Ops App Redesign (Aug 2026) — Gear Assembly & Checkout item 5. The
    // single Mark Delivered button becomes three sequential, timestamped
    // states. These three supersede the plain 'markDelivered' branch above
    // for pages built against this round — that branch stays for backward
    // compatibility, not removed.
    if (action === 'markReadyForDelivery') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await gearService.markReadyForDelivery({ bookingId: body.bookingId });
      res.status(200).json(result);
      return;
    }

    if (action === 'scheduleDelivery') {
      if (!body.bookingId || !body.deliveryServiceType || !body.deliveryTimeSlot) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId, deliveryServiceType, and deliveryTimeSlot are required' });
        return;
      }
      const result = await gearService.scheduleDelivery({
        bookingId: body.bookingId,
        deliveryServiceType: body.deliveryServiceType,
        deliveryTimeSlot: body.deliveryTimeSlot,
      });
      res.status(200).json(result);
      return;
    }

    // Round 2 item 5's Delivery Scheduled mini-form needs the guest's own
    // deliveryWindow (Adventure Prep) to constrain the Delivery Time
    // dropdown to valid slots only. Reuses getReturnContext rather than a
    // second near-identical read — see that function's own header.
    if (action === 'getDeliveryContext') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await gearService.getReturnContext({ bookingId: body.bookingId });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'markDeliveredFinal') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      // BUG FIX (payment-review, Aug 2026, Medium #45): same fix as
      // markDelivered above — use the session-forced staffEmail, not a
      // client-supplied deliveredBy.
      const result = await gearService.markDeliveredFinal({
        bookingId: body.bookingId,
        deliveredBy: body.staffEmail || '',
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
