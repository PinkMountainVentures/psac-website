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
 * WIRED UP, Aug 2026, with one deliberate compromise from the PRD's original
 * 10-15 minute polling suggestion:
 *
 *   1. `vercel.json` now has a `crons` entry: "15 5 * * *" (05:15 UTC =
 *      10:15pm Pacific during PDT). This project is confirmed on the Vercel
 *      Hobby plan (same plan that hit the 12-serverless-function cap during
 *      the Adventure Prep deploy), and Hobby only allows once-daily cron
 *      invocations — 10-15 minute polling needs a Pro plan. 10:15pm Pacific
 *      was chosen because it's shortly after the fixed 10pm Pacific T-3
 *      cutoff every booking's `computeT3CutoffUtc` resolves to, so one run
 *      per day still catches every booking whose cutoff landed that day,
 *      just later than the original design intended.
 *
 *      Real consequence of once-daily instead of every 10-15 minutes: a
 *      guest's kit-count change now sits in `pending` for up to ~24 hours
 *      before the Stripe charge/refund and Gear Check Log regen actually
 *      happen, not the ~1 hour debounce window the PRD assumed, unless it
 *      also happens to cross a T-3 cutoff. Nothing breaks (each row is
 *      still evaluated correctly whenever the cron does run), it's just
 *      slower than designed. Worth revisiting if that delay ever becomes a
 *      real guest-facing problem — upgrading to Pro is the fix, not more
 *      code here. Also note: this fixed UTC time is not DST-aware, so it
 *      drifts to 9:15pm Pacific during PST (Nov-Mar), a day-level slop this
 *      system already tolerates, not a new risk.
 *
 *   2. CRON_SECRET is now confirmed set in Vercel (Production) and the app
 *      redeployed to pick it up.
 *
 * BUG FIX (independent bug pass, Aug 2026): this handler used to wrap its
 * auth check in `if (process.env.CRON_SECRET) { ... }`, unlike its four
 * sibling cron endpoints (process-t3-cutoff.js, check-adventure-prep-
 * cadence.js, trigger-deposit-holds.js, check-hold-clearance-deadline.js),
 * which all check unconditionally (`header === 'Bearer ' + process.env.
 * CRON_SECRET`, which is also false — and therefore also rejects — when the
 * env var is unset, since no real caller ever sends the literal string
 * "Bearer undefined"). That meant THIS endpoint — the one of the five that
 * moves real money via Stripe — was the only one that failed OPEN (no auth
 * check ran at all) rather than failed CLOSED if CRON_SECRET were ever
 * unset (a misconfigured redeploy, an accidentally-removed env var, a new
 * environment without it copied over). Now matches its siblings' fail-
 * closed pattern.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { finalizePendingKitChange } = require('../lib/finalize-kit-change');
const { computeT3CutoffUtc } = require('../lib/t3-cutoff');

const DEBOUNCE_WINDOW_MS = 60 * 60 * 1000; // 1 hour, per PRD Section 1

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
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
