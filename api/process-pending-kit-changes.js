/**
 * api/process-pending-kit-changes.js
 *
 * Vercel Cron target. Closes debounce windows opened by
 * api/adjust-gear-kit-count.js: lists every Adventure Prep row with a
 * pending kit-count change, decides which ones have actually closed (1
 * hour since the latest edit, OR the trip's own T-3 10pm Pacific cutoff,
 * whichever comes first), and finalizes exactly those via
 * lib/finalize-kit-change.js's finalizePendingKitChange — the only place
 * the Stripe charge/refund and Gear Check Log regeneration actually
 * happen. Rows still inside their debounce window are left untouched.
 *
 * NOT WIRED UP YET — flagged for Airey, two things still need doing
 * outside this chat's reach (no Vercel/GitHub access from here):
 *
 *   1. Add a `crons` entry to vercel.json pointing at this path. PRD
 *      Section 1 suggests checking every 10-15 minutes; NOTE Vercel's
 *      Hobby plan only allows once-daily cron invocations, a paid plan is
 *      required for anything more frequent. Confirm which plan this
 *      project is on before assuming a 10-15 minute schedule will actually
 *      run that often. Example entry once confirmed:
 *        "crons": [{ "path": "/api/process-pending-kit-changes", "schedule": "(every 15 min cron expression)" }]
 *
 *   2. Set a CRON_SECRET env var in Vercel (Production). Vercel
 *      automatically attaches `Authorization: Bearer $CRON_SECRET` to its
 *      own cron-triggered requests when that env var exists, which this
 *      handler checks below. No such env var exists yet as of this build.
 *      Until it's set, this endpoint has no auth at all beyond being an
 *      unguessable-ish path — acceptable to leave open just long enough to
 *      hand-test it, not to leave live in production.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { finalizePendingKitChange } = require('../lib/finalize-kit-change');
const { computeT3CutoffUtc } = require('../lib/t3-cutoff');

const DEBOUNCE_WINDOW_MS = 60 * 60 * 1000; // 1 hour, per PRD Section 1

module.exports = async function handler(req, res) {
  // See header comment #2 — fails OPEN (no check at all) until CRON_SECRET
  // is actually set in Vercel, so this can still be hand-tested with a
  // plain curl before that's configured. Once CRON_SECRET exists, every
  // request without the matching bearer token is rejected, including
  // Vercel's own cron invocations if the secret is ever misconfigured —
  // that fails safe (a missed tick is recoverable next tick; an
  // unauthenticated money-moving endpoint left open is not).
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  const now = new Date();
  const finalized = [];
  const skipped = [];
  const failed = [];

  try {
    const listRes = await callBookingsWebApp('adventurePrep_listPendingKitChanges', {});
    const rows = (listRes && listRes.rows) || [];

    for (const row of rows) {
      const bookingId = row.bookingId;
      try {
        const pendingSince = row.pendingSince ? new Date(row.pendingSince) : null;
        const debounceElapsed = !!(pendingSince && now.getTime() - pendingSince.getTime() >= DEBOUNCE_WINDOW_MS);

        const t3Cutoff = computeT3CutoffUtc(row.date);
        const pastCutoff = !!(t3Cutoff && now.getTime() >= t3Cutoff.getTime());

        if (!debounceElapsed && !pastCutoff) {
          skipped.push({ bookingId, reason: 'debounce_window_open' });
          continue;
        }

        const outcome = await finalizePendingKitChange({ bookingId, beforeT3Cutoff: !pastCutoff });
        if (outcome.outcome === 'failed') {
          failed.push({ bookingId, detail: outcome.detail });
        } else {
          finalized.push({ bookingId, outcome: outcome.outcome });
        }
      } catch (rowErr) {
        // One row's failure (a bad Stripe response, a malformed date, etc.)
        // never stops the rest of the batch from being processed.
        // eslint-disable-next-line no-console
        console.error('process-pending-kit-changes: row failed', bookingId, rowErr);
        failed.push({ bookingId, detail: rowErr.message });
      }
    }

    res.status(200).json({ ok: true, checked: rows.length, finalized, skipped, failed });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('process-pending-kit-changes failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
