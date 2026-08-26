/* ============================================
   PSAC — Kit-count debounce finalization logic
   Adventure Prep PRD Section 1's actual money-moving step: once a pending
   kit-count change's debounce window has closed (an hour with no further
   edits, or the T-3 cutoff, whichever comes first — the caller,
   api/process-pending-kit-changes.js, decides WHEN to call this; this
   module only decides WHAT to do once called), compute the delta against
   the last confirmed count, issue the Stripe refund or off-session charge,
   and regenerate the Gear Check Log rows atomically with it (PRD Section
   10: "Gear Check Log regeneration isn't a separate response shape, it
   happens inside the same refunded/charged outcome").

   Deliberately NOT called directly by api/adjust-gear-kit-count.js (the
   guest-facing debounce-recording endpoint) — that endpoint only ever
   records the pending request per its own explicit {token,
   requestedKitCount} contract (guest's own adventurePrepToken, no shared
   secret involved — see that file's own header for the real contract this
   comment previously misdescribed). This module is called only by
   api/process-pending-kit-changes.js's cron tick, once a pending row's
   window has actually closed. See that file's own header comment for the
   full walkthrough of why the split is drawn there.

   Same "never trust a caller-supplied money value" posture as
   create-deposit-hold.js: the delta is always computed here, server-side,
   from the Sheet's own stored confirmedKitCount and pendingKitCount, never
   from a value threaded through from the original request.
   ============================================ */

'use strict';

const { callBookingsWebApp } = require('./apps-script-client');
const { sendEmail } = require('./send-email');
const { renderKitChargeFailedEmail } = require('./email-templates/kit-charge-failed-email');
const { renderKitRefundFailedEmail } = require('./email-templates/kit-refund-failed-email');

// Deliberately duplicated from create-deposit-hold.js / create-payment-intent.js
// rather than imported — those two files also each define their own local,
// unexported copy of this exact map (see their own header comments), so a
// third identical copy here matches this repo's established convention
// rather than introducing a new shared-module pattern on its own.
var TIERS = {
  trail: { name: 'Trail Guide Experience', gear: 65 },
  p2p: { name: 'Peaks to Pools Experience', gear: 100 },
};

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

// BUG FIX (independent bug pass, Aug 2026): idempotencyKey added. Without
// it, a retried finalization (the write-back below throws after this
// Stripe call already succeeded, so the pending row stays pending and gets
// picked up again — more likely now that process-pending-kit-changes.js
// runs once daily instead of every ~15 minutes) recomputed the identical
// delta and issued a SECOND, real charge or refund for the same kit-count
// change. A deterministic key (same bookingId + before/after kit count ->
// same key) makes Stripe return the original transaction on any retry
// instead of creating a new one.
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

// NEW (build review, Aug 2026): urgency tiering for a kit_charge_failed Ops
// Alert, per the finalized Operations UX PRD Section 6 ("More than 48 hours
// to trip: urgency: standard_24hr ... 48 hours or less: urgency:
// urgent_same_day"). Not the same fixed 9am/11am/noon mechanic Section 6
// defines for the T-1 deposit hold, that's bucket 2.9's own trigger, this is
// only the general days-to-trip tiering that section also specifies for
// everything else.
function opsAlertUrgency(tripDateStr) {
  if (!tripDateStr) return 'standard_24hr';
  const m = String(tripDateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 'standard_24hr';
  const tripDate = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const hoursToTrip = (tripDate.getTime() - Date.now()) / (1000 * 60 * 60);
  return hoursToTrip <= 48 ? 'urgent_same_day' : 'standard_24hr';
}

/**
 * @param {object} opts
 * @param {string} opts.bookingId
 * @param {boolean} opts.beforeT3Cutoff - whether this finalization ran
 *   before the T-3, 10pm cutoff (always true today, since nothing in this
 *   build fires this job post-cutoff; kept explicit for the Change Log
 *   field Operations UX's own review already expects there).
 * @returns {Promise<{outcome: 'no_change'|'charged'|'refunded'|'requires_action'|'unavailable'|'failed', detail?: string}>}
 */
async function finalizePendingKitChange({ bookingId, beforeT3Cutoff }) {
  const ctx = await callBookingsWebApp('adventurePrep_getKitContext', { bookingId });
  if (!ctx || ctx.notFound) {
    return { outcome: 'failed', detail: 'booking_not_found' };
  }

  const pending = ctx.pendingKitCount;
  if (pending === '' || pending === null || pending === undefined) {
    return { outcome: 'no_change', detail: 'no pending change recorded' };
  }

  // BUG FIX (payment-review, Aug 2026, Critical #7 hardening, floor
  // corrected per Airey): every booking requires at least 1 kit — 1 person
  // = 1 kit minimum, there is no valid 0-kit booking — so both bounds here
  // are [1,20], not [0,20]. `requested` was already clamped (just to the
  // wrong floor); `currentConfirmed` (read straight off the stored Sheet
  // value) wasn't clamped at all — a stored value outside range (e.g. a
  // manual-adjustment typo that predates the clamp now added in
  // api/apply-manual-adjustment.js) would flow straight into `delta` and
  // produce a real off-session charge/refund sized off the bad value.
  // Clamp both defensively here, independent of whatever wrote them.
  const currentConfirmed = Math.max(1, Math.min(20, parseInt(ctx.confirmedKitCount, 10) || 1));
  const requested = Math.max(1, Math.min(20, parseInt(pending, 10) || 1));
  const delta = requested - currentConfirmed;

  // BUGFIX (build review, Aug 2026): duffel count is derived from kit count
  // using the exact formula bookings-code.gs's buildGearLogRows() uses at
  // booking time (one shared delivery duffel per up to two gear kits).
  // Previously this module only ever touched the per-kit gear items on a
  // kit-count change, never the duffel count, so delivery packaging drifted
  // out of sync with the guest's actual confirmed kit count after any
  // post-booking adjustment. Computed here (Node, not Apps Script) so the
  // Sheet-side finalizer stays a dumb apply-the-numbers-I-was-given step.
  const oldDuffelCount = Math.ceil(currentConfirmed / 2);
  const newDuffelCount = Math.ceil(requested / 2);
  const duffelDelta = newDuffelCount - oldDuffelCount;

  if (delta === 0) {
    // Guest landed back on the same count before the window closed —
    // nothing to charge or refund, just clear the pending marker. Duffel
    // count can't have changed either, since it's purely a function of kit
    // count, but pass the (zero) delta through anyway for consistency
    // rather than special-casing this branch.
    await callBookingsWebApp('adventurePrep_finalizeKitChange', {
      bookingId,
      newConfirmedKitCount: requested,
      oldConfirmedKitCount: currentConfirmed,
      delta: 0,
      refundOrChargeAmount: 0,
      stripeTransactionId: '',
      gearLogAdd: [],
      gearLogRemoveCount: 0,
      newDuffelCount: newDuffelCount,
      duffelDelta: duffelDelta,
      beforeT3Cutoff: !!beforeT3Cutoff,
      staffNotes: 'No net change at debounce finalization.',
    });
    // No Stripe call on this branch (delta === 0), so no idempotency
    // concern if this write-back itself needs a retry — a re-run just
    // clears the same already-zero pending marker again.
    return { outcome: 'no_change' };
  }

  const tierKey = String(ctx.tier || '');
  const tier = TIERS[tierKey];
  if (!tier) {
    return { outcome: 'failed', detail: 'unknown or unsupported tier for kit-count billing: ' + tierKey };
  }
  if (!ctx.mainPaymentIntentId) {
    return { outcome: 'failed', detail: 'booking has no main PaymentIntent on file' };
  }

  const mainRes = await stripeGet('payment_intents/' + encodeURIComponent(ctx.mainPaymentIntentId));
  if (!mainRes.ok) {
    return { outcome: 'failed', detail: 'could not retrieve main PaymentIntent' };
  }
  const customerId = mainRes.data.customer;
  const paymentMethodId = mainRes.data.payment_method;

  let roster = [];
  try { roster = JSON.parse(ctx.reconfirmedRosterJson || '[]'); } catch (e) { roster = []; }

  let outcome;
  let stripeTransactionId = '';
  let refundOrChargeAmount = Math.abs(delta) * tier.gear;
  // NEW (build review, Aug 2026): human-readable reason for a charge
  // failure/requires_action/unavailable outcome, fed into the Ops Alert
  // written below. Only ever set on the delta > 0 (charge) path.
  let chargeErrorDetail = '';
  // NEW (build review, Aug 2026, round 3): same idea for the delta < 0
  // (refund) path — see the refund-failure fix below.
  let refundErrorDetail = '';

  if (delta > 0) {
    // Kits added — an incremental off-session charge against the saved
    // card, per PRD Section 1 ("the main PaymentIntent already sets
    // setup_future_usage: 'off_session' for exactly this kind of reuse").
    if (!customerId || !paymentMethodId) {
      outcome = 'unavailable';
      chargeErrorDetail = 'No saved card on file to run an off-session charge against.';
    } else {
      const params = new URLSearchParams();
      params.append('amount', String(Math.round(refundOrChargeAmount * 100)));
      params.append('currency', 'usd');
      params.append('customer', customerId);
      params.append('payment_method', paymentMethodId);
      params.append('payment_method_types[]', 'card');
      params.append('off_session', 'true');
      params.append('confirm', 'true');
      params.append('description', 'Gear kit count increase (+' + delta + ') — Palm Springs Adventure Club');
      params.append('metadata[kind]', 'kit_count_delta_charge');
      params.append('metadata[bookingId]', bookingId);
      params.append('metadata[delta]', String(delta));

      const chargeRes = await stripePost('payment_intents', params, 'kitchg_' + bookingId + '_' + currentConfirmed + '_' + requested);
      if (!chargeRes.ok) {
        outcome = 'failed';
        chargeErrorDetail = (chargeRes.data && chargeRes.data.error && chargeRes.data.error.message) || 'Stripe API error creating the charge.';
      } else if (chargeRes.data.status === 'requires_action') {
        outcome = 'requires_action';
        stripeTransactionId = chargeRes.data.id;
        chargeErrorDetail = 'Card requires additional authentication (3D Secure) before the charge can complete.';
      } else if (chargeRes.data.status === 'succeeded' || chargeRes.data.status === 'processing') {
        outcome = 'charged';
        stripeTransactionId = chargeRes.data.id;
      } else {
        outcome = 'failed';
        chargeErrorDetail = 'Unexpected PaymentIntent status: ' + chargeRes.data.status;
      }
    }
  } else {
    // Kits removed — a partial refund against the original, already-
    // captured main PaymentIntent.
    const params = new URLSearchParams();
    params.append('payment_intent', ctx.mainPaymentIntentId);
    params.append('amount', String(Math.round(refundOrChargeAmount * 100)));
    params.append('metadata[kind]', 'kit_count_delta_refund');
    params.append('metadata[bookingId]', bookingId);
    params.append('metadata[delta]', String(delta));

    const refundRes = await stripePost('refunds', params, 'kitrfnd_' + bookingId + '_' + currentConfirmed + '_' + requested);
    if (!refundRes.ok) {
      outcome = 'failed';
      refundErrorDetail = (refundRes.data && refundRes.data.error && refundRes.data.error.message) || 'Stripe API error creating the refund.';
    } else {
      outcome = 'refunded';
      stripeTransactionId = refundRes.data.id;
    }
  }

  // Gear Check Log delta — additions get named rows for the newly-added kit
  // slots (kitNumber continuing from the current count), removals delete
  // placeholder rows for the highest-numbered kits first (see
  // adventurePrep_finalizeKitChange's own comment on the open physical-
  // unit-ID question this doesn't resolve).
  const gearLogAdd = [];
  if (delta > 0 && (outcome === 'charged' || outcome === 'requires_action')) {
    for (let k = currentConfirmed + 1; k <= requested; k++) {
      const person = roster[k - 1];
      gearLogAdd.push({ kitNumber: k, personName: person ? person.name : null });
    }
  }
  const gearLogRemoveCount = delta < 0 && outcome === 'refunded' ? Math.abs(delta) : 0;

  // Only actually move confirmedKitCount / touch the Gear Check Log for an
  // outcome that reflects money having actually moved (charged/refunded).
  // A failed or requires_action charge leaves the booking's confirmed count
  // unchanged and is flagged for staff follow-up (surfaced in this
  // function's own return value, read by api/process-pending-kit-changes.js's
  // `failed` array), not silently treated as if the new count took effect.
  //
  // RESOLVED (build review, Aug 2026, round 2 and round 3): a prior round of
  // this file flagged that a failed/requires_action charge produced no
  // follow-up to the guest or staff at all, contradicting the finalized
  // Operations UX PRD's Section 6, which assumes this endpoint already
  // writes a `kit_charge_failed` Ops Alert row and notifies the guest
  // directly the moment a delta charge fails. That assumption was false
  // when this comment was first written; it's true now. Round 3 closes the
  // symmetric gap on the refund side (delta < 0), which Section 6/15 never
  // spoke to directly since both are framed around a rental-fee charge
  // failing, not a refund — per Airey's direct call, this now gets the same
  // treatment via a distinct `kit_refund_failed` alert type rather than
  // being folded into `kit_charge_failed` (the two are different failure
  // modes: a stuck charge risks an unpaid kit going out, a stuck refund
  // just means the guest is owed money a little longer, so they're kept
  // visually and operationally distinguishable on the Ops Alerts page
  // rather than merged).
  const CHARGE_FAILURE_OUTCOMES = ['requires_action', 'unavailable', 'failed'];
  if (delta > 0 && CHARGE_FAILURE_OUTCOMES.indexOf(outcome) !== -1) {
    try {
      await callBookingsWebApp('opsAlerts_recordAlert', {
        bookingId,
        alertType: 'kit_charge_failed',
        amount: refundOrChargeAmount,
        stripeErrorDetail: chargeErrorDetail || ('Charge outcome: ' + outcome),
        urgency: opsAlertUrgency(ctx.tripDate),
      });
    } catch (alertErr) {
      // Never let an Ops Alerts write failure block the guest email below,
      // or bubble up and make process-pending-kit-changes.js think the
      // whole finalization failed when the actual Stripe outcome (recorded
      // in the return value regardless) already happened.
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: failed to record kit_charge_failed Ops Alert', bookingId, alertErr);
    }

    if (ctx.contactEmail) {
      try {
        await sendEmail({
          to: ctx.contactEmail,
          subject: "We couldn't process your gear kit change",
          html: renderKitChargeFailedEmail({
            logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
            guestName: ctx.contactName || '',
            amount: refundOrChargeAmount,
          }),
        });
      } catch (emailErr) {
        // eslint-disable-next-line no-console
        console.error('finalizePendingKitChange: failed to send charge-failure email', bookingId, emailErr);
      }
    } else {
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: no contactEmail on file, guest not notified of charge failure', bookingId);
    }
  }

  // NEW (build review, Aug 2026, round 3): the refund-side counterpart.
  // Deliberately always `standard_24hr` urgency rather than running through
  // opsAlertUrgency() — a stuck refund never blocks dispatch or packing the
  // way a stuck charge can (the kit was already removed from the order
  // either way), so there's no same-day forcing function tied to days-to-
  // trip the way there is on the charge side. Flagged for Airey to confirm;
  // easy to change to opsAlertUrgency(ctx.tripDate) if a stuck refund
  // should escalate the same way as a stuck charge after all.
  if (delta < 0 && outcome === 'failed') {
    try {
      await callBookingsWebApp('opsAlerts_recordAlert', {
        bookingId,
        alertType: 'kit_refund_failed',
        amount: refundOrChargeAmount,
        stripeErrorDetail: refundErrorDetail || 'Refund outcome: failed',
        urgency: 'standard_24hr',
      });
    } catch (alertErr) {
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: failed to record kit_refund_failed Ops Alert', bookingId, alertErr);
    }

    if (ctx.contactEmail) {
      try {
        await sendEmail({
          to: ctx.contactEmail,
          subject: "We couldn't process your refund",
          html: renderKitRefundFailedEmail({
            logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
            guestName: ctx.contactName || '',
            amount: refundOrChargeAmount,
          }),
        });
      } catch (emailErr) {
        // eslint-disable-next-line no-console
        console.error('finalizePendingKitChange: failed to send refund-failure email', bookingId, emailErr);
      }
    } else {
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: no contactEmail on file, guest not notified of refund failure', bookingId);
    }
  }

  if (outcome === 'charged' || outcome === 'refunded') {
    // BUG FIX (independent bug pass, Aug 2026): this write-back used to run
    // with no try/catch, right after Stripe had already moved real money
    // (charged or refunded above). If it throws — a Sheet lock timeout, a
    // transient Apps Script error — the exception used to propagate
    // straight up to process-pending-kit-changes.js's per-row catch, which
    // just logs it and moves on: confirmedKitCount/pendingKitCount never
    // update, so this same row gets picked up again on the next cron tick
    // (now once daily) and recomputes the identical delta. Without the
    // Idempotency-Key added above, that retry would have charged or
    // refunded the guest a SECOND time for the same change. With it, a
    // retried Stripe call now safely returns the original transaction
    // instead. Still rethrown after a best-effort Ops Alert, so the
    // existing "leave pendingKitCount set, try again next tick" retry
    // behavior is unchanged — only the double-money-movement risk is fixed.
    try {
      await callBookingsWebApp('adventurePrep_finalizeKitChange', {
        bookingId,
        newConfirmedKitCount: requested,
        oldConfirmedKitCount: currentConfirmed,
        delta,
        refundOrChargeAmount,
        stripeTransactionId,
        gearLogAdd,
        gearLogRemoveCount,
        newDuffelCount: newDuffelCount,
        duffelDelta: duffelDelta,
        beforeT3Cutoff: !!beforeT3Cutoff,
        staffNotes: '',
      });
    } catch (writeBackErr) {
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: Stripe succeeded but the booking write-back failed', bookingId, stripeTransactionId, writeBackErr);
      try {
        await callBookingsWebApp('opsAlerts_recordAlert', {
          bookingId,
          alertType: 'kit_change_writeback_failed',
          amount: refundOrChargeAmount,
          stripeErrorDetail: writeBackErr.message,
          urgency: 'urgent_same_day',
          notes: (outcome === 'charged' ? 'Charge ' : 'Refund ') + stripeTransactionId + ' for $' + refundOrChargeAmount
            + ' succeeded on Stripe, but the booking/Gear Check Log record could not be updated. Should self-heal on the next cron retry (same Idempotency-Key), but flagged in case it does not.',
        });
      } catch (alertErr) {
        // eslint-disable-next-line no-console
        console.error('finalizePendingKitChange: also failed to write the write-back-failed Ops Alert', bookingId, alertErr);
      }
      throw writeBackErr;
    }
  }

  return { outcome, stripeTransactionId, refundOrChargeAmount, requested, currentConfirmed, delta };
}

module.exports = { finalizePendingKitChange, TIERS };
