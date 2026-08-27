/**
 * api/trigger-gear-reconciliation.js
 *
 * Gear Inventory PRD Section 7: closes the trigger gap found during the
 * 2026-08-25 live verification pass — gearReconcile_run (the handler this
 * file drives, api/reconcile-gear-deposit.js) had zero call sites anywhere
 * in the codebase. No cron, no button, nothing. Every reconciliation
 * scenario was silently defaulting to "the hold expires on its own after
 * ~5-7 days," which only happens to be an acceptable outcome for Scenario
 * 1 (itemized === 0, nothing owed) — for Scenarios 2-4, letting the hold
 * lapse means Stripe releases it uncaptured and PSAC collects nothing for
 * damaged/missing gear it is owed for. This cron actively drives all four
 * scenarios through the same reconciliation endpoint the Reconciliation
 * Review page already calls for manual re-runs, rather than leaving any of
 * them to passive expiry.
 *
 * Candidate list: reuses gearOps_listHoldRenewalCandidates unchanged (the
 * same "active bookings, depositStatus='held', not yet reconciled" set
 * api/renew-deposit-hold.js already relies on) — confirmed during this
 * build that it's exactly the right candidate set for reconciliation too,
 * no new Apps Script function needed.
 *
 * Runs continuously every 15 minutes (offset from every other 15-minute
 * cron's minutes to avoid a collision), same posture as
 * api/process-t3-cutoff.js — reconciliation should happen as soon as a
 * booking's gear settles, not wait for a fixed hour, and
 * api/reconcile-gear-deposit.js's own idempotency (ALREADY_RECONCILED_
 * STATUSES fast-path, self-heal against Stripe's real PI status) makes a
 * frequent, blind re-check across every candidate safe to run over and
 * over with no dedup logic needed here.
 *
 * A candidate whose items aren't all settled yet is the expected, common
 * case (409 not_settled from api/reconcile-gear-deposit.js) — not an
 * error, no alert, just skipped until a later run. Anything else that
 * fails raises an Ops Alert (gear_reconciliation_trigger_failed) so staff
 * know a specific booking's hold needs a manual look before it's at risk
 * of expiring uncaptured.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const reconcileHandler = require('./reconcile-gear-deposit');

function checkCronAuth(req) {
  // BUG FIX (payment-review, Aug 2026, Medium #44): fail closed if
  // CRON_SECRET is unset, instead of matching the literal string
  // 'Bearer undefined'.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + secret;
}

// BUG FIX (payment-review, Aug 2026, Medium #31): this loop had no
// time-budget/batching — as candidate volume grows, a sequential
// per-candidate Stripe-plus-Apps-Script round trip risks running past
// Vercel's function execution limit (this project is on the Hobby plan,
// per process-pending-kit-changes.js's own header, and no maxDuration is
// configured anywhere in this repo) and getting killed mid-loop with no
// response at all — silently dropping whatever candidates hadn't been
// reached yet that tick, with no error and no Ops Alert anywhere. This
// cron re-runs every 15 minutes and reconciliation isn't time-critical to
// the minute (api/reconcile-gear-deposit.js's own idempotency already
// makes a blind re-check safe), so deferring the remainder to the next
// tick costs nothing — bailing out explicitly and reporting `truncated`
// is strictly better than an unannounced kill mid-request. 8s leaves
// headroom under a 10s Hobby-plan default even including this function's
// own cold-start/response overhead.
const TIME_BUDGET_MS = 8000;

function captureResponse() {
  const result = { statusCode: 200, body: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
  };
  return { res, result };
}

async function processOneCandidate(candidate) {
  const { res: innerRes, result } = captureResponse();
  await reconcileHandler({
    method: 'POST',
    body: { bookingId: candidate.bookingId, secret: process.env.GEAR_OPS_SHARED_SECRET },
  }, innerRes);

  const body = result.body || {};

  if (result.statusCode === 200 && body.alreadyReconciled) {
    return { bookingId: candidate.bookingId, outcome: 'already_reconciled', depositStatus: body.depositStatus };
  }

  if (result.statusCode === 200 && body.ok) {
    return {
      bookingId: candidate.bookingId,
      outcome: body.selfHealed ? 'self_healed' : 'reconciled',
      scenario: body.scenario,
      depositStatus: body.depositStatus,
    };
  }

  if (result.statusCode === 409 && body.reason === 'not_settled') {
    // Expected, common case — one or more items still Missing with the
    // grace period open. Not an error, nothing to alert on.
    return { bookingId: candidate.bookingId, outcome: 'not_settled' };
  }

  // Anything else (no_valid_hold, unexpected_deposit_status, a Stripe
  // error, an engineering_error) is unexpected for a candidate this list
  // already filtered to depositStatus='held' — surface it to staff rather
  // than silently retrying forever every 15 minutes.
  const detail = body.detail || body.error || `unexpected status ${result.statusCode}`;
  // eslint-disable-next-line no-console
  console.error('trigger-gear-reconciliation: reconciliation attempt did not succeed', candidate.bookingId, detail);
  try {
    await callBookingsWebApp('opsAlerts_recordAlert', {
      bookingId: candidate.bookingId,
      alertType: 'gear_reconciliation_trigger_failed',
      stripeErrorDetail: typeof detail === 'string' ? detail : JSON.stringify(detail),
      urgency: 'urgent_same_day',
      notes: `The automated reconciliation trigger attempted to resolve this booking's gear deposit hold and did not succeed (${typeof detail === 'string' ? detail : JSON.stringify(detail)}). The hold is still live — needs a manual look via the Reconciliation Review page before it's at risk of expiring uncaptured.`,
    }, { retries: 2 });
  } catch (alertErr) {
    // eslint-disable-next-line no-console
    console.error('trigger-gear-reconciliation: also failed to write the trigger-failed Ops Alert', candidate.bookingId, alertErr);
  }
  return { bookingId: candidate.bookingId, outcome: 'failed', detail };
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const startedAt = Date.now();
    const listRes = await callBookingsWebApp('gearOps_listHoldRenewalCandidates', {});
    const candidates = (listRes && listRes.bookings) || [];

    const results = [];
    let truncated = false;
    for (const candidate of candidates) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        truncated = true;
        // eslint-disable-next-line no-console
        console.error(`trigger-gear-reconciliation: time budget exceeded, truncating run — processed ${results.length}/${candidates.length} candidates; the rest will be picked up on the next tick`);
        break;
      }
      try {
        results.push(await processOneCandidate(candidate));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('trigger-gear-reconciliation: candidate failed', candidate.bookingId, err);
        results.push({ bookingId: candidate.bookingId, outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({ ok: true, candidateCount: candidates.length, processedCount: results.length, truncated, results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('trigger-gear-reconciliation failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
