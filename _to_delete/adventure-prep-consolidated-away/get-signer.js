/**
 * api/get-signer.js
 *
 * Surface B's one load-everything call, thin wrapper over
 * adventurePrep_getSignerContext. Also marks the link as opened (first
 * visit only — adventurePrep_markSignerOpened is a no-op past the first
 * 'sent' -> 'opened' transition) so Operations UX can distinguish a link
 * that was never opened from one that's mid-task, per Operations UX PRD's
 * own per-signer status tracking. Best-effort: a failure marking it opened
 * never fails the whole request — but it IS awaited before responding
 * (not fired-and-forgotten), since a serverless function's execution can
 * be frozen the instant its response is sent, which would silently drop
 * an un-awaited background call far more often than a request-scoped one.
 *
 * Request:  GET /api/get-signer?signerToken=...
 *
 * Response:
 *   200 { bookingId, ownerName, tripDate, minors, signer }
 *   404 { error: 'invalid_signer_token' }
 *   400 { error: 'missing_signer_token' }
 *   500 { error: 'engineering_error', detail }
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const signerToken = (req.query && req.query.signerToken) || '';
  if (!signerToken) {
    res.status(400).json({ error: 'missing_signer_token' });
    return;
  }

  try {
    const ctx = await callBookingsWebApp('adventurePrep_getSignerContext', { signerToken });
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'invalid_signer_token' });
      return;
    }

    try {
      await callBookingsWebApp('adventurePrep_markSignerOpened', { signerToken });
    } catch (markErr) {
      // eslint-disable-next-line no-console
      console.error('get-signer: markSignerOpened failed (non-fatal)', signerToken, markErr);
    }

    res.status(200).json(ctx);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('get-signer failed', signerToken, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
