/**
 * api/process-t3-cutoff.js
 *
 * Operations UX PRD Section 14: the T-3, 10pm Pacific cutoff's ordered
 * master sequence, run via Vercel Cron roughly every 15 minutes (PRD
 * Section 13). For every active booking whose cutoff has passed and hasn't
 * been processed yet:
 *
 *   1. Three cancellation gates, in order, first one firing short-circuits
 *      the rest for that booking: no_1.2a, zero_waivers, no_address.
 *   2. Kit-count debounce force-finalized if still pending.
 *   3. Partial-waiver kit removal (zero already handled by gate 1).
 *   4. Address/trail-swap self-service window close — enforced directly at
 *      the write endpoints (api/adventure-prep.js's saveFields/selectTrail),
 *      not here; see this file's own step 4 comment below for why this cron
 *      has nothing to actively do at that step.
 *   5. RideWithGPS access generated once, if not already present — see the
 *      PLACEHOLDER note in apps-script/t3-cutoff-actions.gs, this is not a
 *      real integration yet.
 *
 * Idempotent per booking via t3CutoffProcessedAt (set after steps 2-5
 * complete) and via bookingStatus itself (a cancelled booking drops out of
 * the candidate list on its own, since cancellation gates check
 * bookingStatus === 'active').
 *
 * ============================================================================
 * RESOLVED (build review, Aug 2026, second pass): this file's first pass
 * flagged a gap here — saveFields/selectTrail had no cutoff check, and this
 * build's own first fix routed them to a NEW T-1 noon Pacific lock instead of
 * T-3, which conflicted with what psac-adventure-prep-jtbd-prd-v1.md Section
 * 10 and psac-operations-ux-jtbd-prd-v1.md Section 14 already lock (address
 * and trail-swap windows close at the SAME T-3, 10pm cutoff as kit count,
 * specifically because step 5 below mints RideWithGPS access right after —
 * a trail edit that stayed open past T-3 could invalidate a credential
 * already generated for the old selection). Reverted: saveFields/selectTrail
 * now gate on isBeforeT3Cutoff directly, the same check adjustGearKitCount
 * already used. Step 4 below is a correctly-enforced no-op, not an
 * unenforced one — the closing already happened at the write layer before
 * this cron ever sees the booking.
 * ============================================================================
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { isBeforeT3Cutoff } = require('../lib/t3-cutoff');
const { finalizePendingKitChange } = require('../lib/finalize-kit-change');

const CANCEL_ENDPOINT = 'https://www.palmspringsadventureclub.com/api/cancel-and-refund-booking';

function checkCronAuth(req) {
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + process.env.CRON_SECRET;
}

async function cancelBooking(bookingId, reason) {
  // BUG FIX (payment-review, Aug 2026, High #22, applied here for the same
  // reason as check-hold-clearance-deadline.js's own copy of this bug):
  // a thrown fetch/JSON error used to propagate straight past
  // reportCancelOutcome's alerting logic into the per-booking catch in the
  // handler below, which only console.errors — no Ops Alert. This cron
  // does get a "next tick" roughly every 15 minutes (unlike the noon
  // single-fire endpoint), so the exposure window is smaller, but a booking
  // that should have been cancelled and wasn't deserves the same alert
  // either way. Catch here and return the same failure shape
  // reportCancelOutcome already checks for (result.ok !== true).
  try {
    const res = await fetch(CANCEL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookingId,
        secret: process.env.CANCEL_AND_REFUND_SHARED_SECRET,
        reasons: [reason],
      }),
    });
    return await res.json();
  } catch (fetchErr) {
    return { ok: false, error: 'fetch_threw', detail: fetchErr.message };
  }
}

function hasDeliveryAddress(ctx) {
  return !!(ctx.deliveryAddressLine1 || ctx.deliveryAddressRaw);
}

/**
 * Section 9's per-kit removal for a `partial` waiver track: any roster
 * member without a `signed` Waiver Signatures row loses their kit. Matches
 * rosterRef first (the reliable key waiver rows and roster entries both
 * carry), falling back to name only if rosterRef is missing on either side
 * — a defensive fallback, not the primary matching path, since name
 * collisions are possible in a group booking.
 *
 * BUG FIX (independent bug pass, Aug 2026): this used to return every
 * uncovered roster member regardless of whether they actually had their own
 * kit. A roster member sharing someone else's kit (`gearKit: false`) who
 * lacks a valid waiver was still passed to t3Cutoff_removeUncoveredKit,
 * which found zero matching Gear Check Log rows for them but still
 * unconditionally decremented confirmedKitCount and logged a "kit removed"
 * entry for a kit that never existed for that person. Filtered to
 * `gearKit === true` roster members only — the only ones who actually have
 * a kit to remove.
 */
function findUncoveredRosterMembers(roster, waiverRows) {
  const coveredRefs = new Set(
    waiverRows.filter((r) => r.status === 'signed').map((r) => String(r.rosterRef || ''))
  );
  const coveredNames = new Set(
    waiverRows.filter((r) => r.status === 'signed').map((r) => String(r.signerName || ''))
  );
  return (roster || []).filter((person) => {
    if (!person.gearKit) return false;
    const ref = String(person.rosterRef || person.id || '');
    if (ref && coveredRefs.has(ref)) return false;
    if (!ref && person.name && coveredNames.has(String(person.name))) return false;
    return true;
  });
}

// BUG FIX (payment-review, Aug 2026, High #23): all three of this file's
// cancellation gates used to report outcome: 'cancelled' regardless of
// whether the downstream cancel-and-refund-booking.js call actually
// succeeded — its response was captured into `result` but never checked.
// A genuinely failed cancellation (a Stripe refund decline, an engineering
// error) reported as success in this cron's own output, with no alert,
// leaving a booking that should have been cancelled quietly still 'active'.
async function reportCancelOutcome(bookingId, reason, result) {
  if (!result || result.ok !== true) {
    try {
      await callBookingsWebApp('opsAlerts_recordAlert', {
        bookingId,
        alertType: 'cancellation_gate_call_failed',
        stripeErrorDetail: (result && (result.detail || result.error)) || 'no response',
        urgency: 'urgent_same_day',
        notes: 'process-t3-cutoff (the T-3, 10pm gate: ' + reason + ') tried to cancel this booking, but cancel-and-refund-booking.js did not report success: ' + JSON.stringify(result) + '. The booking was NOT cancelled — it is still active. Needs manual review.',
      }, { retries: 2 });
    } catch (alertErr) {
      // eslint-disable-next-line no-console
      console.error('process-t3-cutoff: also failed to write the cancellation_gate_call_failed Ops Alert', bookingId, alertErr);
    }
    return { bookingId, outcome: 'cancel_call_failed', reason, result };
  }
  return { bookingId, outcome: 'cancelled', reason, result };
}

async function processOneBooking(bookingId) {
  const ctx = await callBookingsWebApp('t3Cutoff_getProcessingContext', { bookingId });
  if (!ctx || ctx.notFound) return { bookingId, outcome: 'not_found' };
  if (ctx.bookingStatus !== 'active') return { bookingId, outcome: 'already_inactive' };

  // Step 1: three cancellation gates, fixed order, first fire short-circuits.
  if (!ctx.assignedAt) {
    const result = await cancelBooking(bookingId, 'no_1.2a');
    return await reportCancelOutcome(bookingId, 'no_1.2a', result);
  }
  if (ctx.waiverTrack === 'zero') {
    const result = await cancelBooking(bookingId, 'zero_waivers');
    return await reportCancelOutcome(bookingId, 'zero_waivers', result);
  }
  if (!hasDeliveryAddress(ctx)) {
    const result = await cancelBooking(bookingId, 'no_address');
    return await reportCancelOutcome(bookingId, 'no_address', result);
  }

  const stepResults = {};

  // Step 2: force-finalize a still-open kit-count debounce window. Normally
  // finalizes on its own an hour after the last edit (a separate cron,
  // api/process-pending-kit-changes.js); the T-3 cutoff is the hard
  // backstop for a change made too close to the deadline to reach that hour
  // naturally.
  if (ctx.pendingKitCount !== '' && ctx.pendingKitCount != null) {
    stepResults.kitDebounce = await finalizePendingKitChange({ bookingId, beforeT3Cutoff: false });
  }

  // Step 3: partial-waiver kit removal. `zero` already exited via the gate
  // above; only `partial` reaches here (`complete` needs no action).
  if (ctx.waiverTrack === 'partial') {
    let roster = [];
    try {
      roster = JSON.parse(ctx.reconfirmedRosterJson || '[]');
    } catch (e) {
      roster = [];
    }
    const uncovered = findUncoveredRosterMembers(roster, ctx.waiverRows || []);
    stepResults.kitsRemoved = [];
    for (const person of uncovered) {
      const removeResult = await callBookingsWebApp('t3Cutoff_removeUncoveredKit', {
        bookingId,
        personName: person.name,
      });
      stepResults.kitsRemoved.push({ personName: person.name, removeResult });
    }
  }

  // Step 4: address/trail-swap self-service window close — see this file's
  // header comment. Enforcement already happened before this cron ever ran:
  // api/adventure-prep.js's saveFields/selectTrail both gate on
  // isBeforeT3Cutoff, so a guest simply cannot write either field past T-3.
  // Nothing for this cron to do at this step, by design, same as kit count's
  // own direct gate in adjustGearKitCount.
  stepResults.selfServiceWindowClose = 'enforced_at_write_endpoints';

  // Step 5: RideWithGPS access, generated once. Skipped (not blocked) if no
  // trail is selected yet — a thin/0-candidate result unresolved by staff
  // is a Trail Swap Requests problem, not a reason to hold up this booking
  // or any other in the same cron tick.
  if (!ctx.rideWithGpsExperienceAccess && ctx.selectedTrailId) {
    stepResults.rideWithGps = await callBookingsWebApp('t3Cutoff_writeRideWithGpsAccess', {
      bookingId,
      trailId: ctx.selectedTrailId,
    });
  } else if (!ctx.selectedTrailId) {
    stepResults.rideWithGps = 'skipped_no_selected_trail';
  }

  await callBookingsWebApp('t3Cutoff_markProcessed', { bookingId });

  return { bookingId, outcome: 'processed', stepResults };
}

module.exports = async function handler(req, res) {
  // BUG FIX (payment-review, Aug 2026, Medium #42): this cron fires roughly
  // every 15 minutes (vercel.json), each tick running one or more real
  // cancellation/Stripe calls per candidate. With no invocation-level
  // overlap guard, a slow tick still in flight when the next tick starts
  // could pull the same candidate list and run the same cancellation gate
  // for the same booking twice concurrently. t3Cutoff_acquireRunLock (see
  // its own header in t3-cutoff-actions.gs) is a simple whole-run mutex —
  // acquired here before the candidate loop, released in the finally below
  // so a run that errors out still frees it for the next tick, and a run
  // that never gets the chance to release (a crash/timeout) self-expires
  // after 10 minutes rather than wedging every future tick permanently.
  let runLockAcquired = false;
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const lockResult = await callBookingsWebApp('t3Cutoff_acquireRunLock', {});
    if (!lockResult || !lockResult.ok) {
      res.status(200).json({ ok: true, skipped: 'run_in_progress' });
      return;
    }
    runLockAcquired = true;

    const listRes = await callBookingsWebApp('t3Cutoff_listActiveBookings', {});
    const candidates = (listRes && listRes.bookings) || [];
    const due = candidates.filter((b) => !isBeforeT3Cutoff(b.tripDate));

    const results = [];
    for (const b of due) {
      try {
        results.push(await processOneBooking(b.bookingId));
      } catch (err) {
        // One booking's failure never blocks the rest of the tick.
        // eslint-disable-next-line no-console
        console.error('process-t3-cutoff: booking failed', b.bookingId, err);
        results.push({ bookingId: b.bookingId, outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({
      ok: true,
      candidateCount: candidates.length,
      dueCount: due.length,
      results,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('process-t3-cutoff failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  } finally {
    if (runLockAcquired) {
      try {
        await callBookingsWebApp('t3Cutoff_releaseRunLock', {});
      } catch (releaseErr) {
        // eslint-disable-next-line no-console
        console.error('process-t3-cutoff: failed to release the run lock — next tick(s) will wait out the 10-minute staleness window instead', releaseErr);
      }
    }
  }
};
