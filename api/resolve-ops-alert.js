/**
 * api/resolve-ops-alert.js
 *
 * Operations UX PRD Section 6/13: the Ops Alerts page's "Resolve" action —
 * "a button plus a note field, that calls a small resolution endpoint, not
 * a status cell a human edits directly."
 *
 * Server-to-server (called by the internal ops app's own backend, which
 * gates staff access via Google sign-in + the explicit allowlist Section 13
 * specifies — not called directly from a browser the way
 * api/validate-delivery-address.js is), so this uses the standard shared-
 * secret pattern, its own dedicated env var (OPS_ALERT_SHARED_SECRET),
 * matching every other server-to-server endpoint in this stack.
 *
 * Deliberately minimal: this is a status-and-note write, nothing financial,
 * nothing that touches Stripe or cancels anything. Section 6's own
 * "Resolution path" describes staff doing the actual fix (contacting the
 * guest, re-running a failed Stripe action, confirming payment updated)
 * through other channels entirely, then just marking the alert Resolved
 * here as the final bookkeeping step — this endpoint doesn't verify that
 * the underlying charge/hold actually cleared, it trusts staff's own
 * judgment that it did, same as the PRD's own framing.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

function checkSecret(payload) {
  return payload && payload.secret === process.env.OPS_ALERT_SHARED_SECRET;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const body = req.body || {};
    if (!checkSecret(body)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const { alertId, resolvedBy } = body;
    if (!alertId || !resolvedBy) {
      res.status(400).json({ error: 'bad_request', detail: 'alertId and resolvedBy are required' });
      return;
    }

    const result = await callBookingsWebApp('opsAlerts_resolveAlert', {
      alertId,
      resolvedBy,
      notes: body.notes || '',
    });

    if (!result || result.ok !== true) {
      res.status(404).json({ error: 'not_found', detail: result });
      return;
    }

    res.status(200).json({ ok: true, alertId });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('resolve-ops-alert failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
