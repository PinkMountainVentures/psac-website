/**
 * api/apply-manual-adjustment.js
 *
 * Operations UX PRD Section 8/13: "a constrained form for the three
 * off-system playbooks, a fixed set of adjustment types ... each calling
 * the new api/apply-manual-adjustment.js endpoint below, not an open-ended
 * cell edit." Consolidated action-dispatched file (same Vercel-12-function
 * consolidation as api/adventure-prep.js), one of five fixed `type` values:
 *
 *   - 'kit_count_correction'      (Section 8a)
 *   - 'gear_check_log_adjustment' (Section 8a)
 *   - 'change_log_note'           (Section 8a)
 *   - 'gear_returned_uncleaned'   (Section 8c)
 *   - 'update_delivery_address'   (Aug 2026, Airey's direct request: staff
 *                                  need to correct/enter a guest's delivery
 *                                  address after a phone/SMS/email
 *                                  interaction, not just via Surface A.
 *                                  Not in the original locked PRD's Section
 *                                  8 list, added as a fifth fixed type
 *                                  rather than an open-ended field edit, to
 *                                  keep this endpoint's whole design intent
 *                                  intact.)
 *
 * Note Section 8b (post-T-3 trail re-issuance) is deliberately NOT one of
 * these — that playbook reuses api/write-manual-trail-override.js directly
 * (Section 8b: "staff uses the same Trail Swap Requests page and
 * api/write-manual-trail-override.js endpoint from Section 7"), not this
 * file.
 *
 * `staffNotes` is required on every type — this is inherently an audit-
 * trail action (Section 8's whole point is that off-system steps still
 * leave a record), so an adjustment with no explanation defeats the
 * purpose of the endpoint existing at all.
 *
 * Shared-secret pattern (server-to-server, called by the internal ops
 * app's own backend, same as api/resolve-ops-alert.js), its own dedicated
 * env var: MANUAL_ADJUSTMENT_SHARED_SECRET.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { validateAddress } = require('../lib/validate-address');
const createDepositHoldHandler = require('./create-deposit-hold');

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
    const res = await fetch('https://api.stripe.com/v1/payment_intents/' + encodeURIComponent(paymentIntentId) + '/cancel', {
      method: 'POST',
      headers: { Authorization: stripeAuthHeader() },
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
// Called AFTER the Sheet's confirmedKitCount has already been updated, so
// create-deposit-hold.js's own getBooking lookup (fixed 2026-08-25 to read
// confirmedKitCount) picks up the corrected count automatically — no
// amount is computed or passed here.
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

  try {
    await callBookingsWebApp('gearOps_recordHoldRenewed', {
      bookingId,
      renewedAt: new Date().toISOString(),
      oldPaymentIntentId: oldPaymentIntentId || '',
      newPaymentIntentId,
    }, { retries: 2 });
  } catch (writeBackErr) {
    // eslint-disable-next-line no-console
    console.error('apply-manual-adjustment: resized hold placed but write-back failed', bookingId, newPaymentIntentId, writeBackErr);
  }

  return { ok: true, oldPaymentIntentId, newPaymentIntentId, cancelResult };
}

const VALID_TYPES = [
  'kit_count_correction',
  'gear_check_log_adjustment',
  'change_log_note',
  'gear_returned_uncleaned',
  'update_delivery_address',
];

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

    const { type, bookingId, staffNotes } = body;
    if (!bookingId) {
      res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
      return;
    }
    if (VALID_TYPES.indexOf(type) === -1) {
      res.status(400).json({ error: 'bad_request', detail: `type must be one of: ${VALID_TYPES.join(', ')}` });
      return;
    }
    if (!staffNotes || !staffNotes.trim()) {
      res.status(400).json({ error: 'bad_request', detail: 'staffNotes is required for every manual adjustment' });
      return;
    }

    let result;
    let extra = {};
    if (type === 'kit_count_correction') {
      if (body.newConfirmedKitCount == null || isNaN(Number(body.newConfirmedKitCount))) {
        res.status(400).json({ error: 'bad_request', detail: 'newConfirmedKitCount (a number) is required for kit_count_correction' });
        return;
      }
      // BUG FIX (payment-review, Aug 2026, Critical #7, floor corrected per
      // Airey): this used to accept any finite number with no bounds check.
      // A staff typo (e.g. -8 meant to be 8) wrote a negative
      // confirmedKitCount that nothing downstream caught - the deposit-hold
      // resize above is separately clamped to [1,20] so nothing looked
      // wrong at correction time, but the next routine kit-count change
      // (lib/finalize-kit-change.js) computed its delta off the
      // uncorrected negative value and issued a real off-session charge
      // for far more kits than the guest actually requested. Clamp to
      // [1,20] - every booking requires at least 1 kit, 1 person = 1 kit
      // minimum, there is no valid 0-kit booking - and reject out-of-range
      // explicitly rather than silently clamping a value staff didn't intend.
      const newConfirmedKitCountNum = Number(body.newConfirmedKitCount);
      if (!Number.isInteger(newConfirmedKitCountNum) || newConfirmedKitCountNum < 1 || newConfirmedKitCountNum > 20) {
        res.status(400).json({ error: 'bad_request', detail: 'newConfirmedKitCount must be a whole number between 1 and 20' });
        return;
      }
      // ADDED (2026-08-25): check for a live T-1 deposit hold BEFORE
      // applying the correction, so we still have the old PaymentIntent id
      // on hand afterward if a resize turns out to be needed.
      const depositCtxBefore = await callBookingsWebApp('cancelRefund_getBookingContext', { bookingId });
      result = await callBookingsWebApp('manualAdjustment_kitCountCorrection', {
        bookingId, newConfirmedKitCount: Number(body.newConfirmedKitCount), staffNotes,
      });
      if (result && result.ok && depositCtxBefore && depositCtxBefore.depositStatus === 'held') {
        const resize = await resizeDepositHoldForCorrection(bookingId, depositCtxBefore.depositPaymentIntentId);
        if (!resize.ok) {
          try {
            await callBookingsWebApp('opsAlerts_recordAlert', {
              bookingId,
              alertType: 'kit_count_correction_hold_resize_failed',
              stripeErrorDetail: resize.detail,
              urgency: 'urgent_same_day',
              notes: 'Kit count was manually corrected to ' + body.newConfirmedKitCount + ', but resizing the live deposit hold (' + depositCtxBefore.depositPaymentIntentId + ') failed: ' + resize.detail + '. The OLD hold has been left untouched (still sized for the pre-correction kit count) — needs a manual look before reconciliation runs against it.',
            }, { retries: 2 });
          } catch (alertErr) {
            // eslint-disable-next-line no-console
            console.error('apply-manual-adjustment: also failed to write the hold-resize-failed Ops Alert', bookingId, alertErr);
          }
        }
        extra = Object.assign({}, extra, { depositHoldResized: resize.ok, depositHoldResizeDetail: resize.ok ? undefined : resize.detail });
      }
    } else if (type === 'gear_check_log_adjustment') {
      if (!Array.isArray(body.kitNumbersToRemove) || !body.kitNumbersToRemove.length) {
        res.status(400).json({ error: 'bad_request', detail: 'kitNumbersToRemove (non-empty array) is required for gear_check_log_adjustment' });
        return;
      }
      result = await callBookingsWebApp('manualAdjustment_gearCheckLogAdjustment', {
        bookingId, kitNumbersToRemove: body.kitNumbersToRemove, staffNotes,
      });
    } else if (type === 'change_log_note') {
      result = await callBookingsWebApp('manualAdjustment_changeLogNote', {
        bookingId, changeType: body.changeType || 'kit_count', staffNotes,
      });
    } else if (type === 'gear_returned_uncleaned') {
      result = await callBookingsWebApp('manualAdjustment_gearReturnedUncleaned', {
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
      result = await callBookingsWebApp('manualAdjustment_updateDeliveryAddress', {
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
