/**
 * api/reconcile-gear-deposit.js
 *
 * Gear Inventory PRD Section 7: the deposit-hold resolution step, run once
 * a booking's every trackable item is settled (zero items still sitting in
 * Missing-with-grace-period-open). Server-to-server only (api/ops-proxy.js
 * or a future cron trigger for auto-eligible bookings — this file doesn't
 * care which), GEAR_OPS_SHARED_SECRET.
 *
 * Computation, checked directly against psac-gear-deposit-reconciliation-
 * logic.md and confirmed a match: sums replacementCostCents across every
 * item that ended Damaged or is still Missing (never Good or Recovered)
 * and resolves into exactly one of four scenarios against the hold amount
 * — which is always read back from Stripe's own PaymentIntent, never
 * trusted from a stored figure, same "never trust a caller-supplied or
 * stale money value" posture as every other endpoint in this stack:
 *
 *   1. itemized === 0            -> cancel the hold in full.
 *   2. 0 < itemized < hold       -> capture exactly itemized; Stripe
 *                                    auto-releases the remainder.
 *   3. itemized === hold         -> capture the entire hold, no shortfall.
 *   4. itemized > hold           -> capture the entire hold AND flag the
 *                                    shortfall for manual review (Section
 *                                    10) — never auto-charge further.
 *
 * Idempotent: a booking whose depositStatus has already left 'held' is a
 * no-op success (this endpoint is the only thing that ever moves it off
 * 'held'). If a *previous* call's Stripe action succeeded but the
 * write-back then threw (Sheet lock timeout, transient Apps Script error),
 * a retry here detects Stripe's own "already captured"/"already canceled"
 * error and self-heals by reading the real outcome back from Stripe rather
 * than either erroring out a second time or attempting a second capture —
 * the exact template api/cancel-and-refund-booking.js already established
 * for this bug class.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { sendEmail } = require('../lib/send-email');
const { summarizeItems } = require('../lib/gear-item-summary');
const { renderDepositFullReleaseEmail } = require('../lib/email-templates/deposit-full-release-email');
const { renderDepositPartialCaptureEmail } = require('../lib/email-templates/deposit-partial-capture-email');
const { renderDepositFullHoldNoChargeEmail } = require('../lib/email-templates/deposit-full-hold-no-charge-email');

// 'refunded' added (payment-review, Aug 2026, Medium #35): the new terminal
// status apps-script/gear-inventory-actions.gs's gearOps_recordRefund now
// writes once every dollar captured/charged against a booking has been
// fully refunded. Without it here, a stray reconciliation retry against an
// already-fully-refunded booking fell through to the generic
// 'unexpected_deposit_status' 400 below instead of this clean idempotent
// no-op.
const ALREADY_RECONCILED_STATUSES = ['released', 'partial_capture', 'full_capture', 'full_capture_pending_review', 'shortfall_charged', 'refunded'];
const NO_VALID_HOLD_STATUSES = ['requires_action', 'unavailable', 'failed', 'skipped', 'scheduled_t1', ''];

// Settle buffer (added 2026-08-25, post-incident): confirmed live that a
// booking can read as fully settled ($0 itemized, since every item was
// still "Good") the moment before a staff member corrects one item's
// condition to Damaged/Missing — and the reconciliation cron (every ~15
// min) can land in exactly that gap, canceling/capturing the hold against
// the pre-correction state a full hour before the correction ever lands.
// Once that happens the Stripe action is done and cannot be reopened. This
// buffer requires a booking to have sat settled, with no check-in edit at
// all (first entry or correction), for this long before reconciliation is
// allowed to actually touch Stripe — giving staff a real window to correct
// a condition before it becomes irreversible. Mirrors the debounce pattern
// already used elsewhere in this codebase (T-3 cutoff, kit-count changes).
const SETTLE_BUFFER_MS = 15 * 60 * 1000;

function checkSecret(body) {
  // Fail closed: require both a configured secret and a non-empty
  // caller-supplied one, so an unset env var never matches an absent
  // payload.secret (undefined === undefined would otherwise pass).
  if (!process.env.GEAR_OPS_SHARED_SECRET) return false;
  return !!(body && body.secret && body.secret === process.env.GEAR_OPS_SHARED_SECRET);
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  return body || {};
}

function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

async function stripeGet(path) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: stripeAuthHeader() },
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function stripePost(path, params, idempotencyKey) {
  const headers = {
    Authorization: stripeAuthHeader(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

function centsToDollarsStr(cents) {
  return (Math.round(cents) / 100).toFixed(2);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const body = parseBody(req);
    if (!checkSecret(body)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // Section 10: the Reconciliation Review page's own queue (Scenario-4-
    // only bookings) reads through this same endpoint rather than a
    // separate file — one small added branch, not a new dispatcher pattern,
    // since every other action here is the single "run reconciliation for
    // this booking" verb.
    if (body.action === 'list') {
      const result = await callBookingsWebApp('gearOps_listReconciliationQueue', {});
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    // The Reconciliation Review detail panel's own read — hold amount,
    // itemized breakdown with photos, computed shortfall. Read-only, no
    // Stripe call, safe to call as often as the page needs.
    if (body.action === 'context') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const ctxOnly = await callBookingsWebApp('gearOps_getReconciliationContext', { bookingId: body.bookingId });
      res.status(200).json(Object.assign({ ok: true }, ctxOnly));
      return;
    }

    if (!body.bookingId) {
      res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
      return;
    }

    const nowIso = new Date().toISOString();
    const ctx = await callBookingsWebApp('gearOps_getReconciliationContext', { bookingId: body.bookingId, nowIso });
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'booking_not_found' });
      return;
    }

    // Idempotent no-op: already reconciled by an earlier call.
    if (ALREADY_RECONCILED_STATUSES.indexOf(ctx.depositStatus) !== -1) {
      res.status(200).json({ ok: true, alreadyReconciled: true, bookingId: ctx.bookingId, depositStatus: ctx.depositStatus });
      return;
    }

    if (NO_VALID_HOLD_STATUSES.indexOf(ctx.depositStatus) !== -1) {
      res.status(400).json({ error: 'no_valid_hold', detail: `depositStatus is '${ctx.depositStatus}' — there is no live hold to reconcile against.` });
      return;
    }

    if (ctx.depositStatus !== 'held') {
      res.status(400).json({ error: 'unexpected_deposit_status', detail: ctx.depositStatus });
      return;
    }

    if (!ctx.settled) {
      // Section 5/7: hard Stripe constraint (one capture per PaymentIntent),
      // not just a fairness nicety — never partially reconcile.
      res.status(409).json({ ok: false, ready: false, reason: 'not_settled', detail: 'One or more items are still Missing with the grace period open. Reconciliation cannot run until every trackable item is settled.' });
      return;
    }

    // Settle buffer — see SETTLE_BUFFER_MS's own comment above for the
    // incident this closes. Applies uniformly to the cron and to a direct/
    // manual call like this one, since either path could otherwise race a
    // staff correction the exact same way.
    if (ctx.lastItemUpdateIso) {
      const msSinceLastUpdate = Date.now() - new Date(ctx.lastItemUpdateIso).getTime();
      if (msSinceLastUpdate < SETTLE_BUFFER_MS) {
        const readyAt = new Date(new Date(ctx.lastItemUpdateIso).getTime() + SETTLE_BUFFER_MS).toISOString();
        res.status(409).json({
          ok: false,
          ready: false,
          reason: 'settle_buffer',
          detail: `Every item is checked in, but the most recent check-in edit was only ${Math.max(0, Math.round(msSinceLastUpdate / 60000))} minute(s) ago. Reconciliation waits ${SETTLE_BUFFER_MS / 60000} minutes after the last check-in edit before resolving the deposit hold, in case a condition still needs correcting. Try again after ${readyAt}.`,
          readyAt,
        });
        return;
      }
    }

    if (!ctx.depositPaymentIntentId) {
      res.status(500).json({ error: 'engineering_error', detail: 'booking has depositStatus=held but no depositPaymentIntentId on file' });
      return;
    }

    const settledItems = ctx.items.filter((i) => i.unitId);
    const chargeableItems = settledItems.filter((i) => i.condition === 'Damaged' || i.condition === 'Missing');
    const itemizedCents = chargeableItems.reduce((sum, i) => sum + (Number(i.replacementCostCents) || 0), 0);

    // Read the real, current, authoritative hold amount from Stripe —
    // never trust a stored figure.
    const piRes = await stripeGet('payment_intents/' + encodeURIComponent(ctx.depositPaymentIntentId));
    if (!piRes.ok) {
      res.status(502).json({ error: 'stripe_error', detail: 'Could not retrieve the deposit PaymentIntent.' });
      return;
    }
    const pi = piRes.data;

    // Self-heal: a previous call's Stripe action already succeeded, but its
    // write-back never landed (depositStatus is still 'held' in the Sheet).
    // Recognize the PI's own terminal state and recover from it rather than
    // attempting a second capture/cancel, which Stripe would reject anyway.
    if (pi.status === 'canceled') {
      const writeBackResult = await writeBackAndNotify({ ctx, depositStatus: 'released', reconciledAmountCents: 0, holdCents: pi.amount, gearShortfallCents: null, chargeableItems, stripeTransactionId: pi.id, nowIso, expectedPaymentIntentId: pi.id });
      if (writeBackResult && writeBackResult.stale) {
        res.status(200).json({ ok: true, bookingId: ctx.bookingId, scenario: 1, depositStatus: 'released', selfHealed: true, staleSkipped: true });
        return;
      }
      res.status(200).json({ ok: true, bookingId: ctx.bookingId, scenario: 1, depositStatus: 'released', selfHealed: true });
      return;
    }
    if (pi.status === 'succeeded') {
      const capturedCents = pi.amount_received != null ? pi.amount_received : pi.amount;
      const holdCentsHealed = pi.amount;
      const depositStatus = capturedCents >= holdCentsHealed && itemizedCents > holdCentsHealed ? 'full_capture_pending_review'
        : capturedCents >= holdCentsHealed ? 'full_capture' : 'partial_capture';
      const gearShortfallCents = depositStatus === 'full_capture_pending_review' ? (itemizedCents - holdCentsHealed) : null;

      // BUG FIX (payment-review, Aug 2026, High #15): this self-heal path
      // recomputes itemizedCents/depositStatus from CURRENT item
      // conditions — but the capture on Stripe (capturedCents) already
      // happened, at whatever itemized total was in effect at that earlier
      // moment, and can't be un-captured. If a staff correction landed in
      // the gap between that earlier capture and this retry (the exact
      // write-back-failure recovery window this self-heal path exists for),
      // the CURRENT itemizedCents can be lower than what was actually
      // captured — e.g. captured $100 against a $150 itemized total
      // (scenario 4, shortfall to be charged separately), then corrected
      // down to $80 before the write-back retry: this recomputes as a clean
      // 'full_capture' with no gearShortfallCents, silently absorbing a $20
      // overcharge with no alert and no record that a refund review is
      // owed. The SETTLE_BUFFER_MS check above only guards the normal path
      // (from ctx.lastItemUpdateIso at THIS read) — it was never in a
      // position to protect a capture that already happened before this
      // retry began. Alert instead of silently absorbing it; the Stripe
      // capture itself is irreversible from here, so this is flagged for a
      // manual refund/adjustment decision rather than auto-corrected.
      const possibleOverchargeCents = capturedCents - itemizedCents;
      if (possibleOverchargeCents > 0) {
        try {
          await callBookingsWebApp('opsAlerts_recordAlert', {
            bookingId: ctx.bookingId,
            alertType: 'gear_reconciliation_self_heal_possible_overcharge',
            amount: possibleOverchargeCents / 100,
            stripeErrorDetail: `Self-healed a previously-successful capture of $${centsToDollarsStr(capturedCents)} on PaymentIntent ${pi.id}, but the CURRENT itemized total is only $${centsToDollarsStr(itemizedCents)} — a $${centsToDollarsStr(possibleOverchargeCents)} gap. This likely means an item condition was corrected after the original capture ran but before its write-back retried. The capture already happened and cannot be reversed from here; a manual refund of the difference (or confirmation the correction was itself wrong) needs staff review.`,
            urgency: 'urgent_same_day',
            notes: `Reconciled as '${depositStatus}', reconciledAmountCents=${capturedCents}, but current itemizedCents=${itemizedCents}.`,
          }, { retries: 2 });
        } catch (alertErr) {
          // eslint-disable-next-line no-console
          console.error('reconcile-gear-deposit: also failed to write the self-heal-overcharge Ops Alert', ctx.bookingId, alertErr);
        }
      }

      const writeBackResult = await writeBackAndNotify({ ctx, depositStatus, reconciledAmountCents: capturedCents, holdCents: holdCentsHealed, gearShortfallCents, chargeableItems, stripeTransactionId: pi.id, nowIso, expectedPaymentIntentId: pi.id });
      if (writeBackResult && writeBackResult.stale) {
        res.status(200).json({ ok: true, bookingId: ctx.bookingId, depositStatus, selfHealed: true, staleSkipped: true });
        return;
      }
      res.status(200).json({ ok: true, bookingId: ctx.bookingId, depositStatus, selfHealed: true });
      return;
    }
    if (pi.status !== 'requires_capture') {
      res.status(500).json({ error: 'engineering_error', detail: `Deposit PaymentIntent is in an unexpected state: ${pi.status}` });
      return;
    }

    const holdCents = pi.amount;
    let scenario;
    let stripeAction;
    let depositStatus;
    let reconciledAmountCents;
    let gearShortfallCents = null;

    if (itemizedCents === 0) {
      scenario = 1;
      depositStatus = 'released';
      reconciledAmountCents = 0;
      stripeAction = () => stripePost('payment_intents/' + encodeURIComponent(pi.id) + '/cancel', new URLSearchParams(), 'gearrecon_cancel_' + ctx.bookingId + '_' + pi.id);
    } else if (itemizedCents < holdCents) {
      scenario = 2;
      depositStatus = 'partial_capture';
      reconciledAmountCents = itemizedCents;
      const params = new URLSearchParams();
      params.append('amount_to_capture', String(itemizedCents));
      stripeAction = () => stripePost('payment_intents/' + encodeURIComponent(pi.id) + '/capture', params, 'gearrecon_capture_' + ctx.bookingId + '_' + pi.id + '_' + itemizedCents);
    } else if (itemizedCents === holdCents) {
      scenario = 3;
      depositStatus = 'full_capture';
      reconciledAmountCents = holdCents;
      stripeAction = () => stripePost('payment_intents/' + encodeURIComponent(pi.id) + '/capture', new URLSearchParams(), 'gearrecon_capture_' + ctx.bookingId + '_' + pi.id + '_' + holdCents);
    } else {
      scenario = 4;
      depositStatus = 'full_capture_pending_review';
      reconciledAmountCents = holdCents;
      gearShortfallCents = itemizedCents - holdCents;
      stripeAction = () => stripePost('payment_intents/' + encodeURIComponent(pi.id) + '/capture', new URLSearchParams(), 'gearrecon_capture_' + ctx.bookingId + '_' + pi.id + '_' + holdCents);
    }

    const stripeRes = await stripeAction();
    if (!stripeRes.ok) {
      const stripeErr = stripeRes.data && stripeRes.data.error;
      // eslint-disable-next-line no-console
      console.error('reconcile-gear-deposit: Stripe action failed', ctx.bookingId, stripeErr);
      res.status(502).json({ error: 'stripe_error', detail: (stripeErr && stripeErr.message) || 'Stripe API error resolving the deposit hold.' });
      return;
    }

    const writeBackResult = await writeBackAndNotify({ ctx, depositStatus, reconciledAmountCents, holdCents, gearShortfallCents, chargeableItems, stripeTransactionId: pi.id, nowIso, expectedPaymentIntentId: pi.id });

    res.status(200).json({
      ok: true,
      bookingId: ctx.bookingId,
      scenario,
      depositStatus,
      reconciledAmountCents,
      gearShortfallCents,
      itemizedCents,
      holdCents,
      staleSkipped: !!(writeBackResult && writeBackResult.stale),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('reconcile-gear-deposit failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};

// Shared write-back + best-effort guest email for every scenario/self-heal
// path above. Mirrors lib/finalize-kit-change.js's own posture: the money
// action (or its self-healed recovery) already happened before this runs,
// so a write-back failure here is caught, alerted, and rethrown rather than
// silently losing track of a real Stripe outcome.
async function writeBackAndNotify({ ctx, depositStatus, reconciledAmountCents, holdCents, gearShortfallCents, chargeableItems, stripeTransactionId, nowIso, expectedPaymentIntentId }) {
  let writeResult;
  try {
    writeResult = await callBookingsWebApp('gearOps_writeReconciliation', {
      bookingId: ctx.bookingId,
      depositStatus,
      reconciledAt: nowIso,
      reconciledAmountCents,
      gearShortfallCents,
      stripeTransactionId,
      itemizedItems: chargeableItems.map((i) => ({ itemName: i.itemName, unitId: i.unitId, condition: i.condition, replacementCostCents: i.replacementCostCents })),
      expectedPaymentIntentId,
    }, { retries: 2 });
  } catch (writeBackErr) {
    // eslint-disable-next-line no-console
    console.error('reconcile-gear-deposit: Stripe action succeeded but the booking write-back failed', ctx.bookingId, stripeTransactionId, writeBackErr);
    try {
      await callBookingsWebApp('opsAlerts_recordAlert', {
        bookingId: ctx.bookingId,
        alertType: 'gear_reconciliation_writeback_failed',
        amount: reconciledAmountCents != null ? reconciledAmountCents / 100 : 0,
        stripeErrorDetail: writeBackErr.message,
        urgency: 'urgent_same_day',
        notes: `Deposit reconciliation (${depositStatus}) for PaymentIntent ${stripeTransactionId} succeeded on Stripe, but the booking record could not be updated. A retry of this same reconciliation call should self-heal automatically (this endpoint reads the PaymentIntent's real Stripe status back on retry); if this alert is still Open, it did not.`,
      }, { retries: 2 });
    } catch (alertErr) {
      // eslint-disable-next-line no-console
      console.error('reconcile-gear-deposit: also failed to write the write-back-failed Ops Alert', ctx.bookingId, alertErr);
    }
    throw writeBackErr;
  }

  // BUG FIX (payment-review, Aug 2026, High #14): gearOps_writeReconciliation
  // now refuses the write (and returns {stale:true}) when
  // depositPaymentIntentId on the Sheet no longer matches the PaymentIntent
  // this Stripe action actually ran against — meaning a renewal
  // (create-deposit-hold.js, purpose:'renewal') swapped in a NEW live hold
  // for this booking sometime between when this endpoint read the old PI and
  // when it finished acting on it. The Stripe action above already happened
  // for real (a real capture/cancel on the OLD PaymentIntent), but writing
  // depositStatus/reconciledAmountCents now would silently clobber the
  // Sheet's record of the NEW hold with stale figures describing the old
  // one. Alert instead of writing, and skip the guest email below — the
  // guest's deposit situation is not actually what depositStatus/
  // reconciledAmountCents here would claim (see checklist for the reverse-
  // direction race this does not cover).
  if (writeResult && writeResult.stale) {
    // eslint-disable-next-line no-console
    console.error('reconcile-gear-deposit: write-back skipped, stale PaymentIntent (renewal race)', ctx.bookingId, stripeTransactionId, writeResult.currentPaymentIntentId);
    try {
      await callBookingsWebApp('opsAlerts_recordAlert', {
        bookingId: ctx.bookingId,
        alertType: 'gear_reconciliation_race_with_renewal',
        amount: reconciledAmountCents != null ? reconciledAmountCents / 100 : 0,
        stripeErrorDetail: `Reconciled PaymentIntent ${stripeTransactionId}, but the Sheet's current depositPaymentIntentId is ${writeResult.currentPaymentIntentId} — a deposit hold renewal ran in between and put a NEW live hold in place. The Stripe action (${depositStatus}) already happened for real on the OLD PaymentIntent (${stripeTransactionId}), but the Sheet write was skipped to avoid overwriting the record of the new hold.`,
        urgency: 'urgent_same_day',
        notes: 'Needs manual review: confirm the old PaymentIntent\'s resolution is correct, and reconcile the new hold (depositPaymentIntentId currently on file) separately once this booking is ready again.',
      }, { retries: 2 });
    } catch (alertErr) {
      // eslint-disable-next-line no-console
      console.error('reconcile-gear-deposit: also failed to write the race-with-renewal Ops Alert', ctx.bookingId, alertErr);
    }
    return { stale: true, currentPaymentIntentId: writeResult.currentPaymentIntentId };
  }

  if (depositStatus === 'full_capture_pending_review') {
    // Scenario 4 sends no guest email at reconciliation time — the guest
    // hasn't actually been charged the shortfall yet, only the hold was
    // captured. deposit-capture-exceeding-hold-email.js's copy is written
    // in the past tense ("we've charged an additional $X") and is only
    // correct to send once api/charge-gear-shortfall.js's charge actually
    // succeeds.
    return;
  }

  if (!ctx.contactEmail) {
    // eslint-disable-next-line no-console
    console.error('reconcile-gear-deposit: no contactEmail on file, guest not notified of deposit outcome', ctx.bookingId);
    return;
  }

  try {
    const logoUrl = process.env.BOOKING_CONFIRMATION_LOGO_URL || '';
    if (depositStatus === 'released') {
      await sendEmail({ to: ctx.contactEmail, subject: 'Your gear deposit has been released', html: renderDepositFullReleaseEmail({ logoUrl }) });
    } else if (depositStatus === 'partial_capture') {
      const { itemsLabel, conditionNote } = summarizeItems(chargeableItems);
      await sendEmail({
        to: ctx.contactEmail,
        subject: 'An update on your gear deposit',
        html: renderDepositPartialCaptureEmail({
          logoUrl, item: itemsLabel, conditionNote,
          capturedAmount: centsToDollarsStr(reconciledAmountCents),
          releasedAmount: centsToDollarsStr(Math.max(0, holdCents - reconciledAmountCents)),
        }),
      });
    } else if (depositStatus === 'full_capture') {
      const { itemsLabel, conditionNote } = summarizeItems(chargeableItems);
      await sendEmail({
        to: ctx.contactEmail,
        subject: 'An update on your gear deposit',
        html: renderDepositFullHoldNoChargeEmail({ logoUrl, item: itemsLabel, conditionNote, holdAmount: centsToDollarsStr(reconciledAmountCents) }),
      });
    }
  } catch (emailErr) {
    // eslint-disable-next-line no-console
    console.error('reconcile-gear-deposit: failed to send deposit-outcome email', ctx.bookingId, emailErr);
  }
}
