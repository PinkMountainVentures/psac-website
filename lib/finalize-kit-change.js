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

async function stripePost(path, params) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: {
      Authorization: stripeAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json();
  return { ok: res.ok, data };
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

  const currentConfirmed = parseInt(ctx.confirmedKitCount, 10) || 0;
  const requested = Math.max(0, Math.min(20, parseInt(pending, 10) || 0));
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

  if (delta > 0) {
    // Kits added — an incremental off-session charge against the saved
    // card, per PRD Section 1 ("the main PaymentIntent already sets
    // setup_future_usage: 'off_session' for exactly this kind of reuse").
    if (!customerId || !paymentMethodId) {
      outcome = 'unavailable';
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

      const chargeRes = await stripePost('payment_intents', params);
      if (!chargeRes.ok) {
        outcome = 'failed';
      } else if (chargeRes.data.status === 'requires_action') {
        outcome = 'requires_action';
        stripeTransactionId = chargeRes.data.id;
      } else if (chargeRes.data.status === 'succeeded' || chargeRes.data.status === 'processing') {
        outcome = 'charged';
        stripeTransactionId = chargeRes.data.id;
      } else {
        outcome = 'failed';
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

    const refundRes = await stripePost('refunds', params);
    if (!refundRes.ok) {
      outcome = 'failed';
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
  // CORRECTION (build review, Aug 2026): this comment previously claimed
  // "the guest is notified (Section 15's charge-failure copy, sent by the
  // caller)" — that notification is NOT actually implemented anywhere in
  // this build. process-pending-kit-changes.js only returns a JSON summary
  // to whatever hit the cron endpoint; nothing reads that response or
  // emails/alerts anyone. Flagged for Airey: a failed or requires_action
  // kit-count charge currently produces no follow-up to the guest or staff
  // at all. Not fixed here since it needs a real decision (email? a row on
  // the existing Ops Alerts tab? something else?) and, if email, real
  // reviewed copy — same caution this build already applied to the signer
  // invite template.
  if (outcome === 'charged' || outcome === 'refunded') {
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
  }

  return { outcome, stripeTransactionId, refundOrChargeAmount, requested, currentConfirmed, delta };
}

module.exports = { finalizePendingKitChange, TIERS };
