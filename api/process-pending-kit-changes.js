/**
 * api/process-pending-kit-changes.js
 *
 * Vercel Cron target. Closes debounce windows opened by
 * api/adventure-prep.js's adjustGearKitCount action: lists every Adventure
 * Prep row with a pending kit-count change, decides which ones have
 * actually closed (1 hour since the latest edit, OR the trip's own T-3
 * 10pm Pacific cutoff, whichever comes first), and finalizes exactly those
 * via lib/finalize-kit-change.js's finalizePendingKitChange — the only
 * place the Stripe charge/refund and Gear Check Log regeneration actually
 * happen. Rows still inside their debounce window are left untouched.
 *
 * MIGRATED (2026-08-31 build session): both the listing/discovery step and
 * the finalize step now go through lib/finalize-kit-change.js's Postgres-
 * native functions (listPendingKitChanges/finalizePendingKitChange)
 * instead of lib/apps-script-client.js's callBookingsWebApp(). This
 * closes the other half of the adjustGearKitCount launch-blocking gap —
 * the finalize step alone wasn't enough, since a Postgres-only booking's
 * pending change would never have been found by a listing call still
 * aimed at the old Apps Script backend. See lib/finalize-kit-change.js's
 * own header comment (point 5) for the full reasoning.
 *
 * WIRED UP, Aug 2026. `vercel.json`'s actual `crons` entry —
 * `"10,25,40,55 * * * *"` — runs this every 15 minutes, all day, matching
 * the PRD's original 10-15 minute polling suggestion.
 *
 * BUG FIX (payment-review, Aug 2026, Medium #39): this header used to
 * claim a deliberate once-daily-at-10:15pm-Pacific compromise, justified
 * by a Vercel Hobby-plan once-daily-cron-invocation limit — directly
 * contradicted by the live `vercel.json` above (confirmed against the
 * actual file, not just this comment) and by CRON_SECRET being live in
 * Production, which the once-daily claim's own text said hadn't happened
 * yet either. Whatever Hobby-plan constraint prompted that compromise,
 * it's not reflected in the deployed config today — this cron already
 * runs at the PRD's intended cadence, no code or config change needed
 * here, just a stale comment that risked leading a future change the
 * wrong direction (e.g. "restoring" a once-daily schedule that was never
 * actually in effect). CRON_SECRET is confirmed set in Vercel (Production)
 * and the app redeployed to pick it up.
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

const { finalizePendingKitChange, listPendingKitChanges } = require('../lib/finalize-kit-change');
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
    const rows = await listPendingKitChanges();

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
