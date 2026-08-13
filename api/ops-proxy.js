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
 *   3. For the three write actions that already have fully-validated,
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
};

const MANUAL_ADJUSTMENT_TYPES = ['kit_count_correction', 'gear_check_log_adjustment', 'change_log_note', 'gear_returned_uncleaned'];

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

    if (action === 'applyManualAdjustment') {
      if (MANUAL_ADJUSTMENT_TYPES.indexOf(body.type) === -1) {
        res.status(400).json({ error: 'bad_request', detail: `type must be one of: ${MANUAL_ADJUSTMENT_TYPES.join(', ')}` });
        return;
      }
      const { res: innerRes, result } = captureResponse();
      await applyManualAdjustmentHandler({
        method: 'POST',
        body: Object.assign({}, body, { secret: process.env.MANUAL_ADJUSTMENT_SHARED_SECRET }),
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

    res.status(400).json({ error: 'unknown_action', detail: action });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('ops-proxy failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
