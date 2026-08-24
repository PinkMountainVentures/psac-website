/**
 * api/renew-deposit-hold.js
 *
 * Gear Inventory PRD Section 8: the hold-renewal safety net. Stripe
 * authorization holds expire on their own after roughly 5-7 days (Visa
 * specifically caps online holds at 5 days) — a booking sitting
 * unreconciled that long (a stalled reconciliation, a Missing item's grace
 * period running long, staff backlog) risks the hold silently releasing
 * with nothing captured, even though real loss/damage may still need to
 * be charged for. This cron re-places a fresh hold before that happens.
 *
 * Threshold: 3 days since the hold was placed (or since it was last
 * renewed) — corrected down from the PRD's original ~3.5-day suggestion,
 * given this project's own history of cron-timing precision bugs
 * (api/check-hold-clearance-deadline.js's header documents two of them);
 * a firmer, earlier buffer costs nothing and leaves more runway.
 *
 * Vercel Cron, gated to a fixed 1pm Pacific instant (pacificClockTimeReached,
 * same convention as every other time-gated cron in this stack) — runs
 * once daily, after both the 9am hold-trigger and the noon hold-clearance
 * check, so it never races either of those over the SAME day's T-1 hold.
 *
 * Reuses api/create-deposit-hold.js's own hold-placement logic IN-PROCESS,
 * with ZERO changes to that file — the explicit constraint this build was
 * given. Calling its exported handler directly with a synthetic req/res
 * (same technique api/ops-proxy.js already uses to reuse
 * api/resolve-ops-alert.js etc.) means every safeguard already inside that
 * file (Custom-tier skip, Customer default-payment-method preference, the
 * requires_action/unavailable/failed response shapes) applies here too,
 * automatically, with no duplicated logic to drift out of sync.
 *
 * Order of operations matters: place the NEW hold first, and only cancel
 * the OLD one after the new one succeeds. If the new hold fails, the old
 * (soon-to-expire, but still currently live) hold is left untouched rather
 * than leaving the booking with no hold at all while staff sort out a
 * declined card.
 *
 * A renewal failure raises an Ops Alert (`alertType: 'hold_renewal_failed'`)
 * via the existing Ops Alerts mechanism — confirmed during this build that
 * `opsAlerts_recordAlert` does not validate `alertType` against a fixed
 * enum, so this slots in with zero schema changes.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { pacificDateString, addDaysToDateString, daysBetweenDateStrings, pacificClockTimeReached } = require('../lib/cadence');
const createDepositHoldHandler = require('./create-deposit-hold');

const RENEWAL_THRESHOLD_DAYS = 3;
const TARGET_HOUR_PACIFIC = 13; // 1pm — after the 9am hold trigger and noon clearance check

function checkCronAuth(req) {
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + process.env.CRON_SECRET;
}

function captureResponse() {
  const result = { statusCode: 200, body: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
  };
  return { res, result };
}

function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

async function cancelOldHold(paymentIntentId) {
  try {
    const res = await fetch('https://api.stripe.com/v1/payment_intents/' + encodeURIComponent(paymentIntentId) + '/cancel', {
      method: 'POST',
      headers: { Authorization: stripeAuthHeader() },
    });
    const data = await res.json();
    if (!res.ok) {
      const err = data && data.error;
      const alreadyDone = err && (err.code === 'payment_intent_unexpected_state' || /already|cannot be canceled/i.test(err.message || ''));
      if (alreadyDone) {
        // The old hold already expired/was captured/was canceled on its
        // own by the time we got here — fine, that's exactly the situation
        // this renewal was trying to get ahead of. Not a failure.
        return { ok: true, alreadyResolved: true };
      }
      // eslint-disable-next-line no-console
      console.error('renew-deposit-hold: failed to cancel old hold', paymentIntentId, err);
      return { ok: false, detail: (err && err.message) || 'unknown' };
    }
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('renew-deposit-hold: exception canceling old hold', paymentIntentId, err);
    return { ok: false, detail: err.message };
  }
}

async function processOneCandidate(candidate, today) {
  const referenceDateStr = candidate.depositHoldRenewedAt
    ? pacificDateString(new Date(candidate.depositHoldRenewedAt))
    : addDaysToDateString(candidate.tripDate, -1); // the original T-1 hold-placement day

  const daysSince = daysBetweenDateStrings(referenceDateStr, today);
  if (daysSince == null || daysSince < RENEWAL_THRESHOLD_DAYS) {
    return { bookingId: candidate.bookingId, outcome: 'not_due', daysSince };
  }

  const oldPaymentIntentId = candidate.depositPaymentIntentId;
  const { res: innerRes, result } = captureResponse();
  await createDepositHoldHandler({
    method: 'POST',
    body: { bookingId: candidate.bookingId, secret: process.env.DEPOSIT_HOLD_SHARED_SECRET },
  }, innerRes);

  if (result.statusCode !== 200 || !result.body || result.body.status !== 'succeeded') {
    const detail = (result.body && (result.body.error || result.body.status)) || `unexpected status ${result.statusCode}`;
    // eslint-disable-next-line no-console
    console.error('renew-deposit-hold: renewal attempt did not succeed', candidate.bookingId, detail);
    try {
      await callBookingsWebApp('opsAlerts_recordAlert', {
        bookingId: candidate.bookingId,
        alertType: 'hold_renewal_failed',
        stripeErrorDetail: typeof detail === 'string' ? detail : JSON.stringify(detail),
        urgency: 'urgent_same_day',
        notes: `The deposit hold has been open ${daysSince} days without reconciliation and the automated renewal attempt did not succeed (status: ${result.body && result.body.status}). The old hold (${oldPaymentIntentId}) has been left untouched. Reconcile this booking's gear check-in or follow up on the card on file before the original hold's own ~5-7 day expiry.`,
      }, { retries: 2 });
    } catch (alertErr) {
      // eslint-disable-next-line no-console
      console.error('renew-deposit-hold: also failed to write the hold_renewal_failed Ops Alert', candidate.bookingId, alertErr);
    }
    return { bookingId: candidate.bookingId, outcome: 'renewal_failed', detail };
  }

  const newPaymentIntentId = result.body.paymentIntentId;
  const cancelResult = oldPaymentIntentId ? await cancelOldHold(oldPaymentIntentId) : { ok: true, skipped: true };

  const renewedAt = new Date().toISOString();
  try {
    await callBookingsWebApp('gearOps_recordHoldRenewed', {
      bookingId: candidate.bookingId,
      renewedAt,
      oldPaymentIntentId: oldPaymentIntentId || '',
      newPaymentIntentId,
    }, { retries: 2 });
  } catch (writeBackErr) {
    // eslint-disable-next-line no-console
    console.error('renew-deposit-hold: new hold placed but write-back failed', candidate.bookingId, newPaymentIntentId, writeBackErr);
    try {
      await callBookingsWebApp('opsAlerts_recordAlert', {
        bookingId: candidate.bookingId,
        alertType: 'hold_renewal_writeback_failed',
        stripeErrorDetail: writeBackErr.message,
        urgency: 'urgent_same_day',
        notes: `A new deposit hold (${newPaymentIntentId}) was placed to renew the safety net, but the booking record could not be updated with depositHoldRenewedAt. The next daily run will likely attempt to renew again using the same stale reference point — flagged in case that happens more than once.`,
      }, { retries: 2 });
    } catch (alertErr) {
      // eslint-disable-next-line no-console
      console.error('renew-deposit-hold: also failed to write the writeback-failed Ops Alert', candidate.bookingId, alertErr);
    }
    return { bookingId: candidate.bookingId, outcome: 'renewed_writeback_failed', newPaymentIntentId, cancelResult };
  }

  return { bookingId: candidate.bookingId, outcome: 'renewed', oldPaymentIntentId, newPaymentIntentId, cancelResult };
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const now = new Date();
    if (!pacificClockTimeReached(TARGET_HOUR_PACIFIC, 0, now)) {
      res.status(200).json({ ok: true, skipped: 'before_target_hour_pacific' });
      return;
    }

    const today = pacificDateString(now);
    const listRes = await callBookingsWebApp('gearOps_listHoldRenewalCandidates', {});
    const candidates = (listRes && listRes.bookings) || [];

    const results = [];
    for (const candidate of candidates) {
      try {
        results.push(await processOneCandidate(candidate, today));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('renew-deposit-hold: candidate failed', candidate.bookingId, err);
        results.push({ bookingId: candidate.bookingId, outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({ ok: true, candidateCount: candidates.length, results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('renew-deposit-hold failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
