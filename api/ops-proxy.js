/**
 * api/ops-proxy.js
 *
 * The internal ops app's ONE backend-for-frontend endpoint. Every ops page
 * (Trail Swap Requests, Ops Alerts, Manual Adjustment) talks to this single
 * URL with an `action` field, never directly to api/resolve-ops-alert.js,
 * api/apply-manual-adjustment.js, or api/write-manual-trail-override.js —
 * those three hold real shared secrets (OPS_ALERT_SHARED_SECRET,
 * MANUAL_ADJUSTMENT_SHARED_SECRET, TRAIL_OVERRIDE_SHARED_SECRET) that must
 * never reach the browser. This file:
 *
 *   1. Checks the staff Google-Sign-In session cookie (lib/ops-session.js)
 *      on every single call, rejecting with 401 if absent/expired/tampered
 *      — Section 13's "checked server-side, on every request."
 *   2. For read-only list/lookup actions, calls the Apps Script backend
 *      directly (it already holds BOOKINGS_WEBAPP_SECRET via
 *      lib/apps-script-client.js).
 *   3. For the write actions that already have fully-validated,
 *      already-smoke-tested handlers, REUSES those handler functions
 *      directly (in-process, not another HTTP hop) rather than
 *      reimplementing their validation here — each handler is invoked with
 *      a synthetic request carrying the real secret injected server-side,
 *      and a synthetic response object that captures the result to relay
 *      back. This keeps one source of truth for each action's validation
 *      logic instead of two copies that could drift.
 *
 * Consolidated as a single function (same Vercel-function-cap reasoning as
 * every other consolidated file in this project).
 */

'use strict';

const { requireStaffSession } = require('../lib/ops-session');
const { callBookingsWebApp } = require('../lib/apps-script-client');
const resolveOpsAlertHandler = require('./resolve-ops-alert');
const applyManualAdjustmentHandler = require('./apply-manual-adjustment');
const writeManualTrailOverrideHandler = require('./write-manual-trail-override');
// Gear Inventory, Checkout & Deposit Reconciliation build (Aug 2026) — same
// in-process reuse pattern as the three handlers above: each of these
// holds its own real GEAR_OPS_SHARED_SECRET, injected server-side below,
// never exposed to the browser.
const manageGearUnitsHandler = require('./manage-gear-units');
const allocateGearUnitsHandler = require('./allocate-gear-units');
const checkoutGearHandler = require('./checkout-gear');
const checkInGearItemHandler = require('./check-in-gear-item');
const reconcileGearDepositHandler = require('./reconcile-gear-deposit');
const chargeGearShortfallHandler = require('./charge-gear-shortfall');
const refundGearChargeHandler = require('./refund-gear-charge');
const checkGearAvailabilityHandler = require('./check-gear-availability');

function captureResponse() {
  const result = { statusCode: 200, body: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
  };
  return { res, result };
}

const READ_ACTIONS = {
  listOpsAlerts: () => callBookingsWebApp('opsAlerts_listAll', {}),
  listTrailSwapRequests: () => callBookingsWebApp('trailSwap_listAll', {}),
  listChangeLogRecent: () => callBookingsWebApp('changeLog_listRecent', {}),
  getTrailSwapDropdownOptions: (body) => callBookingsWebApp('trailSwap_getDropdownOptions', { bookingId: body.bookingId }),
  getTrailSwapRequestContext: (body) => callBookingsWebApp('trailSwap_getRequestContext', { swapRequestId: body.swapRequestId }),
  // Ops App Redesign (Aug 2026) — apps-script/ops-redesign-round1-actions.gs.
  listAllBookings: () => callBookingsWebApp('allBookings_listAll', {}),
  listOpsAlertsExpanded: () => callBookingsWebApp('opsAlerts_listExpanded', { nowIso: new Date().toISOString() }),
  listStalledBookings: () => callBookingsWebApp('stalled_listAll', {}),
  listCancellations: () => callBookingsWebApp('cancellations_listAll', {}),
};

// Aug 2026: added 'update_delivery_address' — staff correcting/entering a
// guest's delivery address after a phone/SMS/email interaction, per
// Airey's direct request. Same fixed-type, no-open-ended-edit posture as
// the original four; see api/apply-manual-adjustment.js's own header.
// Ops App Redesign (Aug 2026) — Round 2 item 8: added 'trail_day_change',
// 'swap_allocated_unit', and 'post_delivery_cancellation'. Must be kept in
// sync with api/apply-manual-adjustment.js's own VALID_TYPES array — these
// are two independent allowlists in two separate files, both required for
// a type to actually work end-to-end through the proxy.
const MANUAL_ADJUSTMENT_TYPES = [
  'kit_count_correction',
  'gear_check_log_adjustment',
  'change_log_note',
  'gear_returned_uncleaned',
  'update_delivery_address',
  'trail_day_change',
  'swap_allocated_unit',
  'post_delivery_cancellation',
];

// Gear Inventory build: each entry proxies straight through to its handler
// with GEAR_OPS_SHARED_SECRET injected — these handlers already do their
// own action-specific validation (see each file's own header), this proxy
// only adds the staff-session gate and the real secret.
const GEAR_OPS_PROXY_ACTIONS = {
  // api/manage-gear-units.js
  gearUnits_list: manageGearUnitsHandler,
  gearUnits_add: manageGearUnitsHandler,
  gearUnits_retire: manageGearUnitsHandler,
  gearUnits_markClean: manageGearUnitsHandler,
  gearUnits_markDeepCleaned: manageGearUnitsHandler,
  gearUnits_markRepaired: manageGearUnitsHandler,
  // api/allocate-gear-units.js
  gearAllocation_allocate: allocateGearUnitsHandler,
  gearAllocation_get: allocateGearUnitsHandler,
  gearAllocation_recordShortageResolution: allocateGearUnitsHandler,
  // api/checkout-gear.js
  gearCheckout_getQueue: checkoutGearHandler,
  gearCheckout_confirmScan: checkoutGearHandler,
  gearCheckout_markDelivered: checkoutGearHandler,
  gearCheckout_markReadyForDelivery: checkoutGearHandler,
  gearCheckout_scheduleDelivery: checkoutGearHandler,
  gearCheckout_markDeliveredFinal: checkoutGearHandler,
  gearCheckout_getDeliveryContext: checkoutGearHandler,
  // api/check-in-gear-item.js
  gearCheckin_getQueue: checkInGearItemHandler,
  gearCheckin_getContext: checkInGearItemHandler,
  gearCheckin_uploadPhoto: checkInGearItemHandler,
  gearCheckin_checkIn: checkInGearItemHandler,
  gearCheckin_getQueueV2: checkInGearItemHandler,
  gearCheckin_getReturnContext: checkInGearItemHandler,
  gearCheckin_schedulePickup: checkInGearItemHandler,
  gearCheckin_markPickedUp: checkInGearItemHandler,
  gearCheckin_markReturned: checkInGearItemHandler,
  // api/reconcile-gear-deposit.js
  gearReconcile_run: reconcileGearDepositHandler,
  gearReconcile_list: reconcileGearDepositHandler,
  gearReconcile_getContext: reconcileGearDepositHandler,
  // api/charge-gear-shortfall.js (single action)
  gearShortfall_charge: chargeGearShortfallHandler,
  // api/refund-gear-charge.js (single action)
  gearRefund_issue: refundGearChargeHandler,
  // api/check-gear-availability.js (single action)
  gearAvailability_check: checkGearAvailabilityHandler,
};

// BUG FIX (payment-review, Aug 2026, Plausible finding): gearAvailability_
// check gets its own secret (GEAR_AVAILABILITY_SHARED_SECRET) instead of
// the shared GEAR_OPS_SHARED_SECRET every other entry below uses — see
// check-gear-availability.js's own header for why. Every action not
// listed here still falls back to GEAR_OPS_SHARED_SECRET.
const GEAR_OPS_ACTION_SECRET_ENV = {
  gearAvailability_check: 'GEAR_AVAILABILITY_SHARED_SECRET',
};

// Maps this proxy's own action name back to the inner handler's own
// `action` field, for the handful of files that are themselves small
// dispatchers (manage-gear-units.js, allocate-gear-units.js,
// checkout-gear.js, check-in-gear-item.js). Single-action files
// (reconcile/charge/refund/availability) need no mapping — the inner
// handler doesn't read body.action at all.
const GEAR_OPS_INNER_ACTION = {
  gearUnits_list: 'listUnits', gearUnits_add: 'addUnit', gearUnits_retire: 'retireUnit',
  gearUnits_markClean: 'markClean', gearUnits_markDeepCleaned: 'markDeepCleaned', gearUnits_markRepaired: 'markRepaired',
  gearAllocation_allocate: 'allocate', gearAllocation_get: 'getAllocation',
  gearAllocation_recordShortageResolution: 'recordShortageResolution',
  gearCheckout_getQueue: 'getQueue', gearCheckout_confirmScan: 'confirmScan', gearCheckout_markDelivered: 'markDelivered',
  gearCheckout_markReadyForDelivery: 'markReadyForDelivery', gearCheckout_scheduleDelivery: 'scheduleDelivery', gearCheckout_markDeliveredFinal: 'markDeliveredFinal',
  gearCheckout_getDeliveryContext: 'getDeliveryContext',
  gearCheckin_getQueue: 'getQueue', gearCheckin_getContext: 'getContext',
  gearCheckin_uploadPhoto: 'uploadPhoto', gearCheckin_checkIn: 'checkIn',
  gearCheckin_getQueueV2: 'getQueueV2', gearCheckin_getReturnContext: 'getReturnContext',
  gearCheckin_schedulePickup: 'schedulePickup', gearCheckin_markPickedUp: 'markPickedUp', gearCheckin_markReturned: 'markReturned',
  gearReconcile_list: 'list', gearReconcile_getContext: 'context',
};

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const session = requireStaffSession(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized', detail: 'sign in required' });
      return;
    }

    const body = req.body || {};
    const action = body.action;

    if (READ_ACTIONS[action]) {
      const data = await READ_ACTIONS[action](body);
      res.status(200).json(Object.assign({ ok: true }, data));
      return;
    }

    if (action === 'resolveOpsAlert') {
      const { res: innerRes, result } = captureResponse();
      await resolveOpsAlertHandler({
        method: 'POST',
        body: Object.assign({}, body, {
          secret: process.env.OPS_ALERT_SHARED_SECRET,
          resolvedBy: session.email,
        }),
      }, innerRes);
      res.status(result.statusCode).json(result.body);
      return;
    }

    if (action === 'markStalledCalled') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const data = await callBookingsWebApp('stalled_markCalled', { bookingId: body.bookingId, calledBy: session.email });
      res.status(200).json(Object.assign({ ok: true }, data));
      return;
    }

    if (action === 'applyManualAdjustment') {
      if (MANUAL_ADJUSTMENT_TYPES.indexOf(body.type) === -1) {
        res.status(400).json({ error: 'bad_request', detail: `type must be one of: ${MANUAL_ADJUSTMENT_TYPES.join(', ')}` });
        return;
      }
      const { res: innerRes, result } = captureResponse();
      await applyManualAdjustmentHandler({
        method: 'POST',
        // BUG FIX (payment-review, Aug 2026, Medium #46): unlike the
        // resolveOpsAlert/trail-override branches above, this never
        // injected the authenticated staff identity at all — who
        // authorized a kit-count correction (which can resize a live
        // deposit hold) existed nowhere except an optional, unverified
        // free-text `staffNotes` field the caller could leave blank or
        // fill with anything. Now forced from the session the same way,
        // never accepted from the client. apply-manual-adjustment.js
        // prepends it to the Change Log entry it already writes.
        body: Object.assign({}, body, { secret: process.env.MANUAL_ADJUSTMENT_SHARED_SECRET, staffEmail: session.email }),
      }, innerRes);
      res.status(result.statusCode).json(result.body);
      return;
    }

    if (action === 'logTrailSwapIntake' || action === 'applyTrailSwapOverride') {
      const innerAction = action === 'logTrailSwapIntake' ? 'logIntake' : 'applyOverride';
      const { res: innerRes, result } = captureResponse();
      await writeManualTrailOverrideHandler({
        method: 'POST',
        // BUG FIX (independent bug pass, Aug 2026): this used to let a
        // caller-supplied body.reviewedBy win over the session email
        // (`body.reviewedBy || session.email` only falls back to the
        // session when the client sends nothing at all) — unlike the
        // resolveOpsAlert branch just above, which already forces
        // `resolvedBy: session.email` unconditionally. Since this is a
        // browser POST body, any signed-in staff member could set
        // reviewedBy to any string, attributing a trail-swap override to
        // someone else. Now forced to the authenticated session's email,
        // matching resolveOpsAlert's own pattern; the field is no longer
        // accepted from the client at all.
        body: Object.assign({}, body, {
          secret: process.env.TRAIL_OVERRIDE_SHARED_SECRET,
          action: innerAction,
          reviewedBy: session.email,
        }),
      }, innerRes);
      res.status(result.statusCode).json(result.body);
      return;
    }

    if (GEAR_OPS_PROXY_ACTIONS[action]) {
      const innerHandler = GEAR_OPS_PROXY_ACTIONS[action];
      const innerAction = GEAR_OPS_INNER_ACTION[action]; // undefined for single-action files, which is fine — they never read body.action
      const secretEnvVar = GEAR_OPS_ACTION_SECRET_ENV[action] || 'GEAR_OPS_SHARED_SECRET';
      const { res: innerRes, result } = captureResponse();
      await innerHandler({
        method: 'POST',
        body: Object.assign({}, body, {
          secret: process.env[secretEnvVar],
          action: innerAction,
          // BUG FIX (payment-review, Aug 2026, Medium #45): forced here,
          // generically, for every gear-ops action — not just the one
          // finding named (checkout-gear.js's markDelivered, which used to
          // trust a client-supplied `deliveredBy` string instead of the
          // authenticated session). A handler that doesn't use this field
          // simply ignores it; any handler that records "who did this" now
          // gets a real, server-verified identity instead of whatever the
          // browser happened to send, for free.
          staffEmail: session.email,
        }),
      }, innerRes);
      res.status(result.statusCode).json(result.body);
      return;
    }

    res.status(400).json({ error: 'unknown_action', detail: action });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('ops-proxy failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
