/**
 * api/sync-kit-subscribers.js
 *
 * Task 10 (Relational Database Migration PRD, Section 4.1 / Section 10
 * item 7) — Vercel Cron target, the periodic Kit subscriber sync job. See
 * lib/kit-sync-service.js's own header for the full webhook-vs-poll design
 * writeup and the state-mapping decision; this file is just the thin
 * CRON_SECRET-gated wrapper, same shape as every other cron target in this
 * repo (api/check-adventure-prep-cadence.js, api/process-t3-cutoff.js,
 * etc.).
 *
 * Schedule: not launch-time-critical — email-list membership isn't read by
 * anything else this migration builds, it's a staff-facing "who's also on
 * the list" cached fact, not a gate on any booking flow — so this runs a
 * handful of times a day rather than every 15 minutes like the
 * money/booking-state jobs. See vercel.json's own crons entry for the
 * actual schedule.
 */

'use strict';

const { syncKitSubscribers } = require('../lib/kit-sync-service');

function checkCronAuth(req) {
  // Same fail-closed fix as every other cron file in this migration
  // (payment-review Medium #44) — an unset CRON_SECRET must never make
  // 'Bearer undefined' a valid, guessable bypass.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + secret;
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const result = await syncKitSubscribers();
    res.status(200).json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('sync-kit-subscribers failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
