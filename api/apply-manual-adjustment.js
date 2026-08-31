/**
 * api/apply-manual-adjustment.js
 *
 * Operations UX PRD Section 8/13: "a constrained form for the three
 * off-system playbooks, a fixed set of adjustment types ... each calling
 * the new api/apply-manual-adjustment.js endpoint below, not an open-ended
 * cell edit." Consolidated action-dispatched file, one of eight fixed
 * `type` values:
 *
 *   - 'kit_count_correction'      (Section 8a)
 *   - 'gear_check_log_adjustment' (Section 8a)
 *   - 'change_log_note'           (Section 8a)
 *   - 'gear_returned_uncleaned'   (Section 8c)
 *   - 'update_delivery_address'   (Aug 2026, Airey's direct request)
 *   - 'trail_day_change'          (Ops App Redesign, Round 2 item 8)
 *   - 'swap_allocated_unit'       (Ops App Redesign, Round 2 item 8)
 *   - 'post_delivery_cancellation' (Ops App Redesign, Round 2 item 8)
 *
 * Note Section 8b (post-T-3 trail re-issuance) is deliberately NOT one of
 * these — that playbook reuses api/write-manual-trail-override.js directly.
 *
 * `staffNotes` is required on every type — this is inherently an audit-
 * trail action, so an adjustment with no explanation defeats the purpose
 * of the endpoint existing at all.
 *
 * MIGRATED (2026-08-31, Task 8 ops-proxy migration): all 8
 * `manualAdjustment_*` calls now go to lib/manual-adjustment-service.js
 * in-process. Everything else — the deposit-hold-resize flow around
 * kit_count_correction (still calling api/create-deposit-hold.js in-process
 * and Stripe directly), the trail_day_change re-run of
 * lib/run-trail-assignment.js, and every validation branch — is unchanged;
 * only the calls that used to hit Apps Script now hit Postgres directly.
 * The two other former callBookingsWebApp call sites this file made
 * (cancelRefund_getBookingContext, gearOps_recordHoldRenewed/
 * opsAlerts_recordAlert) now call their already-migrated Postgres
 * equivalents: lib/cancel-refund-service.js's getBookingContext and
 * lib/gear-service.js's recordHoldRenewed/recordOpsAlert (exact signature
 * matches, confirmed before this rewrite).
 *
 * Shared-secret pattern (server-to-server, called by the internal ops
 * app's own backend, same as api/resolve-ops-alert.js), its own dedicated
 * env var: MANUAL_ADJUSTMENT_SHARED_SECRET.
 */

'use strict';

const { getBookingContext } = require('../lib/cancel-refund-service');
const { recordHoldRenewed, recordOpsAlert } = require('../lib/gear-service');
const manualAdjustmentService = require('../lib/manual-adjustment-service');
const { validateAddress } = require('../lib/validate-address');
const createDepositHoldHandler = require('./create-deposit-hold');
// Ops App Redesign (Aug 2026) — Manual Adjustment item 8's "Trail day /
// adventure date change" type reuses this exact `trail_refresh` mechanism
// (Trail Selection Logic PRD Section 2 Amendment 2), the same lib the
// guest-facing self-service edit path already calls — per this build's own
// instruction not to invent a second recompute path.
const { runTrailAssignmentForBooking } = require('../lib/run-trail-assignment');

// ADDED (2026-08-25, gear-ops live verification pass): kit_count_correction
// used to write the new confirmedKitCount with zero awareness of a live T-1
// deposit hold — a correction applied after the hold already succeeded left
// a stale-sized hold in place with nothing resizing it. Same "place the new
// hold first, only cancel the old one after the new one succeeds" ordering
// api/renew-deposit-hold.js already established, and the same in-process
// reuse technique (a synthetic req/res calling create-deposit-hold.js's
// exported handler directly, purpose: 'renewal', so every safeguard already
// inside that file applies here automatically).
function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

function captureResponse() {
  const result = { statusCode: 200, body: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
  };
  return { res, result };
}

async function cancelOldDepositHold(paymentIntentId, bookingId) {
  try {
    // Fixed Idempotency-Key per paymentIntentId (not a fresh key each
    // call) so a true retry of the same cancel reuses Stripe's cached
    // response instead of being treated as a new request.
    const res = await fetch('https://api.stripe.com/v1/payment_intents/' + encodeURIComponent(paymentIntentId) + '/cancel', {
      method: 'POST',
      headers: { Authorization: stripeAuthHeader(), 'Idempotency-Key': 'cancel_old_hold_' + paymentIntentId },
    });
    const data = await res.json();
    if (!res.ok) {
      const err = data && data.error;
      const alreadyDone = err && (err.code === 'payment_intent_unexpected_state' || /already|cannot be canceled/i.test(err.message || ''));
      if (alreadyDone) return { ok: true, alreadyResolved: true };
      // eslint-disable-next-line no-console
      console.error('apply-manual-adjustment: failed to cancel the old deposit hold', bookingId, paymentIntentId, err);
      return { ok: false, detail: (err && err.message) || 'unknown' };
    }
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('apply-manual-adjustment: exception cancelling the old deposit hold', bookingId, paymentIntentId, err);
    return { ok: false, detail: err.message };
  }
}

// Resizes a live deposit hold to match a just-applied kit_count_correction.
// Called AFTER adventure_prep.confirmed_kit_count has already been updated,
// so create-deposit-hold.js's own getBooking lookup picks up the corrected
// count automatically — no amount is computed or passed here.
async function resizeDepositHoldForCorrection(bookingId, oldPaymentIntentId) {
  const { res: innerRes, result } = captureResponse();
  await createDepositHoldHandler({
    method: 'POST',
    body: { bookingId, secret: process.env.DEPOSIT_HOLD_SHARED_SECRET, purpose: 'renewal' },
  }, innerRes);

  if (result.statusCode !== 200 || !result.body || result.body.status !== 'succeeded') {
    const detail = (result.body && (result.body.error || result.body.status)) || ('unexpected status ' + result.statusCode);
    // eslint-disable-next-line no-console
    console.error('apply-manual-adjustment: resized hold placement did not succeed', bookingId, detail);
    return { ok: false, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
  }

  const newPaymentIntentId = result.body.paymentIntentId;
  const cancelResult = oldPaymentIntentId ? await cancelOldDepositHold(oldPaymentIntentId, bookingId) : { ok: true, skipped: true };
  const oldHoldCancelFailed = !!(oldPaymentIntentId && !cancelResult.ok);

  try {
    await recordHoldRenewed({
      bookingId,
      renewedAt: new Date().toISOString(),
      oldPaymentIntentId: oldPaymentIntentId || '',
      newPaymentIntentId,
      oldHoldCancelSucceeded: !oldHoldCancelFailed,
    });
  } catch (writeBackErr) {
    // eslint-disable-next-line no-console
    console.error('apply-manual-adjustment: resized hold placed but write-back failed', bookingId, newPaymentIntentId, writeBackErr);
    try {
      await recordOpsAlert({
        bookingId,
        alertType: 'kit_count_correction_hold_resize_writeback_failed',
        stripeErrorDetail: writeBackErr.message,
        urgency: 'urgent_same_day',
        notes: `A resized deposit hold (${newPaymentIntentId}) was placed for a manual kit-count correction, but the booking's Change Log entry could not be written. The hold itself is live and correctly sized — this only means the audit trail is incomplete.`,
      });
    } catch (alertErr) {
      // eslint-disable-next-line no-console
      console.error('apply-manual-adjustment: also failed to write the hold-resize-writeback-failed Ops Alert', bookingId, alertErr);
    }
  }

  if (oldHoldCancelFailed) {
    return {
      ok: false,
      detail: 'New hold placed (' + newPaymentIntentId + '), but cancelling the old hold (' + oldPaymentIntentId + ') failed: ' + cancelResult.detail + '. Guest now has two live holds.',
      oldPaymentIntentId, newPaymentIntentId, cancelResult,
    };
  }
  return { ok: true, oldPaymentIntentId, newPaymentIntentId, cancelResult };
}

const VALID_TYPES = [
  'kit_count_correction',
  'gear_check_log_adjustment',
  'change_log_note',
  'gear_returned_uncleaned',
  'update_delivery_address',
  'trail_day_change',
  'swap_allocated_unit',
  'post_delivery_cancellation',
];

const SWAP_UNIT_REASONS = ['damaged_before_delivery', 'dirty_before_delivery', 'wrong_size_or_type', 'lost_or_destroyed_in_transit', 'broken_during_rental'];

function checkSecret(payload) {
  // Fail closed: require both a configured secret and a non-empty
  // caller-supplied one, so an unset env var never matches an absent
  // payload.secret (undefined === undefined would otherwise pass).
  if (!process.env.MANUAL_ADJUSTMENT_SHARED_SECRET) return false;
  return !!(payload && payload.secret && payload.secret === process.env.MANUAL_ADJUSTMENT_SHARED_SECRET);
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

    const { type, bookingId } = body;
    const rawStaffNotes = body.staffNotes;
    if (!bookingId) {
      res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
      return;
    }
    if (VALID_TYPES.indexOf(type) === -1) {
      res.status(400).json({ error: 'bad_request', detail: `type must be one of: ${VALID_TYPES.join(', ')}` });
      return;
    }
    if (!rawStaffNotes || !rawStaffNotes.trim()) {
      res.status(400).json({ error: 'bad_request', detail: 'staffNotes is required for every manual adjustment' });
      return;
    }
    // Who authorized an adjustment (including one that can resize a live
    // deposit hold) is forced from the signed-in session by ops-proxy.js
    // (staffEmail), never accepted as-is from an unverified free-text
    // field. A direct server-to-server call bypassing the proxy has no
    // session and no staffEmail, so it's left unprefixed rather than
    // guessed at. Every downstream use of `staffNotes` below (all 8 types)
    // picks this up automatically.
    const staffNotes = body.staffEmail ? `[authorized by ${body.staffEmail}] ${rawStaffNotes}` : rawStaffNotes;

    let result;
    let extra = {};
    if (type === 'kit_count_correction') {
      if (body.newConfirmedKitCount == null || isNaN(Number(body.newConfirmedKitCount))) {
        res.status(400).json({ error: 'bad_request', detail: 'newConfirmedKitCount (a number) is required for kit_count_correction' });
        return;
      }
      // Clamp to [1,20] — every booking requires at least 1 kit, there is
      // no valid 0-kit booking — and reject out-of-range explicitly rather
      // than silently clamping a value staff didn't intend.
      const newConfirmedKitCountNum = Number(body.newConfirmedKitCount);
      if (!Number.isInteger(newConfirmedKitCountNum) || newConfirmedKitCountNum < 1 || newConfirmedKitCountNum > 20) {
        res.status(400).json({ error: 'bad_request', detail: 'newConfirmedKitCount must be a whole number between 1 and 20' });
        return;
      }
      // Check for a live T-1 deposit hold BEFORE applying the correction,
      // so we still have the old PaymentIntent id on hand afterward if a
      // resize turns out to be needed.
      const depositCtxBefore = await getBookingContext(bookingId);
      result = await manualAdjustmentService.kitCountCorrection({
        bookingId, newConfirmedKitCount: Number(body.newConfirmedKitCount), staffNotes,
      });
      if (result && result.ok && depositCtxBefore && depositCtxBefore.depositStatus === 'held') {
        const resize = await resizeDepositHoldForCorrection(bookingId, depositCtxBefore.depositPaymentIntentId);
        if (!resize.ok) {
          try {
            await recordOpsAlert({
              bookingId,
              alertType: 'kit_count_correction_hold_resize_failed',
              stripeErrorDetail: resize.detail,
              urgency: 'urgent_same_day',
              notes: 'Kit count was manually corrected to ' + body.newConfirmedKitCount + ', but resizing the live deposit hold (' + depositCtxBefore.depositPaymentIntentId + ') failed: ' + resize.detail + '. The OLD hold has been left untouched (still sized for the pre-correction kit count) — needs a manual look before reconciliation runs against it.',
            });
          } catch (alertErr) {
            // eslint-disable-next-line no-console
            console.error('apply-manual-adjustment: also failed to write the hold-resize-failed Ops Alert', bookingId, alertErr);
          }
        }
        // The kit-count correction ITSELF did succeed (result.ok, untouched
        // here) — this only flips the top-level `ok` on a genuine resize
        // failure, via `extra.ok` overriding the `{ok:true}` spread below
        // (Object.assign applies `extra` last). `partialFailure` names
        // which part actually failed, since `ok:false` alone reads like
        // the whole adjustment was rejected, which isn't true.
        extra = Object.assign({}, extra, {
          depositHoldResized: resize.ok,
          depositHoldResizeDetail: resize.ok ? undefined : resize.detail,
        });
        if (!resize.ok) {
          extra.ok = false;
          extra.partialFailure = 'deposit_hold_resize_failed';
          extra.warning = 'Kit count correction saved, but the live deposit hold could not be resized to match — see depositHoldResizeDetail. An Ops Alert was raised.';
        }
      }
    } else if (type === 'gear_check_log_adjustment') {
      if (!Array.isArray(body.kitNumbersToRemove) || !body.kitNumbersToRemove.length) {
        res.status(400).json({ error: 'bad_request', detail: 'kitNumbersToRemove (non-empty array) is required for gear_check_log_adjustment' });
        return;
      }
      result = await manualAdjustmentService.gearCheckLogAdjustment({
        bookingId, kitNumbersToRemove: body.kitNumbersToRemove, staffNotes,
      });
    } else if (type === 'change_log_note') {
      result = await manualAdjustmentService.changeLogNote({
        bookingId, changeType: body.changeType || 'kit_count', staffNotes,
      });
    } else if (type === 'gear_returned_uncleaned') {
      result = await manualAdjustmentService.gearReturnedUncleaned({
        bookingId, staffNotes,
      });
    } else if (type === 'update_delivery_address') {
      const input = body.addressInput || {};
      if (!input.line1) {
        res.status(400).json({ error: 'bad_request', detail: 'addressInput.line1 is required for update_delivery_address' });
        return;
      }
      // Same validation core Surface A uses (lib/validate-address.js) — one
      // source of truth, so staff and guest self-service never disagree on
      // what counts as a confirmed address. Soft-fail here too: an
      // unconfirmed match still gets saved (staff explicitly chose to enter
      // this address, unlike a guest typo), just flagged as unvalidated.
      const validation = await validateAddress(input);
      const std = validation.standardized || {
        line1: input.line1, line2: input.line2 || '', city: input.city || '',
        state: input.state || 'CA', zip: input.zip || '', lat: null, lng: null,
      };
      result = await manualAdjustmentService.updateDeliveryAddress({
        bookingId,
        deliveryAddressLine1: std.line1,
        deliveryAddressLine2: std.line2 || input.line2 || '',
        deliveryCity: std.city,
        deliveryState: std.state || 'CA',
        deliveryZip: std.zip,
        deliveryAddressRaw: [std.line1, std.city, std.state || 'CA', std.zip].filter(Boolean).join(', '),
        deliveryAddressValidated: validation.validated,
        deliveryLat: std.lat,
        deliveryLng: std.lng,
        staffNotes,
      });
      extra = { addressValidated: validation.validated, standardizedAddress: std };
    } else if (type === 'trail_day_change') {
      if (!body.newTripDate || !/^\d{4}-\d{2}-\d{2}/.test(String(body.newTripDate))) {
        res.status(400).json({ error: 'bad_request', detail: 'newTripDate (YYYY-MM-DD) is required for trail_day_change' });
        return;
      }
      result = await manualAdjustmentService.trailDayChange({
        bookingId, newTripDate: body.newTripDate, staffNotes,
      });
      if (result && result.ok) {
        // A full re-run of the trail-selection engine against the new date
        // — Airey's own confirmed answer (Section 2 Amendment 2): a date
        // change discards and replaces the `source: rules_v1` candidates,
        // and re-checks any preserved `source: manual_override` entry
        // against the NEW date's Tier A filters.
        try {
          const refresh = await runTrailAssignmentForBooking({ bookingId, operation: 'refresh' });
          extra = {
            trailRefresh: refresh.outcome,
            candidateTrails: refresh.candidateTrails,
            manualOverrideDropped: refresh.outcome === 'assigned' ? !!refresh.swapRequestOpened && refresh.manualOverrideDroppedOnRefresh : undefined,
            swapRequestOpened: refresh.swapRequestOpened,
          };
          if (refresh.outcome !== 'assigned') {
            extra.warning = 'Trail day was changed, but re-running trail selection did not complete cleanly (outcome: ' + refresh.outcome + '). Check this booking\'s trail assignment manually.';
          }
        } catch (refreshErr) {
          // eslint-disable-next-line no-console
          console.error('apply-manual-adjustment: trail_day_change date write succeeded but the trail_refresh re-run failed', bookingId, refreshErr);
          extra = { warning: 'Trail day was changed, but re-running trail selection failed: ' + refreshErr.message + '. The date is saved; trail candidates were NOT refreshed — needs a manual retry.' };
        }
      }
    } else if (type === 'swap_allocated_unit') {
      if (!body.originalUnitId || SWAP_UNIT_REASONS.indexOf(body.reason) === -1) {
        res.status(400).json({ error: 'bad_request', detail: `originalUnitId is required and reason must be one of: ${SWAP_UNIT_REASONS.join(', ')}` });
        return;
      }
      if (!body.noSubstitute && !body.newUnitId) {
        res.status(400).json({ error: 'bad_request', detail: 'newUnitId is required unless noSubstitute is true' });
        return;
      }
      result = await manualAdjustmentService.swapAllocatedUnit({
        bookingId,
        originalUnitId: body.originalUnitId,
        reason: body.reason,
        newUnitId: body.noSubstitute ? '' : body.newUnitId,
        noSubstitute: !!body.noSubstitute,
        staffNotes,
      });
    } else if (type === 'post_delivery_cancellation') {
      result = await manualAdjustmentService.postDeliveryCancellation({
        bookingId, cancellationReason: body.cancellationReason || 'post_delivery_cancellation', staffNotes,
      });
    }

    if (!result || result.ok !== true) {
      res.status(500).json({ error: 'adjustment_failed', detail: result });
      return;
    }

    res.status(200).json(Object.assign({ ok: true, type }, result, extra));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('apply-manual-adjustment failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
