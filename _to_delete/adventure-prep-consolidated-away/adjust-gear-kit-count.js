/**
 * api/adjust-gear-kit-count.js
 *
 * Adventure Prep PRD Section 1's gear-kit-count debounce entry point. This
 * is the ONLY thing this endpoint does: record the guest's latest
 * requested kit count as a pending change, with a fresh pendingSince
 * timestamp each time it's called (overwriting any earlier pending value,
 * never stacking multiple pending requests). It never touches Stripe and
 * never recomputes the Gear Check Log itself.
 *
 * The actual refund/charge + Gear Check Log regeneration happens later,
 * once the debounce window closes (1 hour of no further edits, or the
 * trip's own T-3 10pm Pacific cutoff, whichever comes first) — that's
 * api/process-pending-kit-changes.js's cron tick, via
 * lib/finalize-kit-change.js. See that file's header for the full
 * walkthrough of why the split is drawn there (PRD Section 1: "the guest
 * sees an immediate 'got it, updating' response, never a live Stripe
 * round-trip on every keystroke/tap").
 *
 * Request:  POST /api/adjust-gear-kit-count
 *           { token: string, requestedKitCount: integer }
 *
 *   `token` is the guest's OWN adventurePrepToken — the Layer 2 credential
 *   documented in apps-script/adventure-prep-actions.gs's "Two layers of
 *   auth" section. The browser never sends a bookingId directly (it
 *   doesn't know one) and never holds BOOKINGS_WEBAPP_SECRET — bookingId
 *   is resolved server-side, in this handler, exactly like every other
 *   guest-facing endpoint in this build.
 *
 * Response shapes:
 *   200 { status: 'pending', requestedKitCount, currentConfirmedKitCount, pendingSince }
 *   200 { status: 'no_change', currentConfirmedKitCount }
 *   400 { error: 'missing_token' | 'invalid_kit_count' }
 *   404 { error: 'invalid_token' }
 *   409 { error: 'booking_cancelled' | 'past_t3_cutoff' }
 *   500 { error: 'engineering_error', detail }
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { isBeforeT3Cutoff } = require('../lib/t3-cutoff');

// Matches lib/finalize-kit-change.js's own clamp — kept in sync manually
// since that file duplicates TIERS the same way rather than importing, per
// this repo's established convention of not sharing these tiny constants.
const MAX_KIT_COUNT = 20;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  var body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  body = body || {};

  const token = body.token;
  const requestedKitCount = body.requestedKitCount;

  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  if (
    requestedKitCount === undefined ||
    requestedKitCount === null ||
    !Number.isInteger(requestedKitCount) ||
    requestedKitCount < 0 ||
    requestedKitCount > MAX_KIT_COUNT
  ) {
    res.status(400).json({ error: 'invalid_kit_count' });
    return;
  }

  try {
    const ctx = await callBookingsWebApp('adventurePrep_getContextByToken', { token });
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }
    if (ctx.experienceBooking && ctx.experienceBooking.bookingStatus === 'cancelled') {
      res.status(409).json({ error: 'booking_cancelled' });
      return;
    }
    if (!isBeforeT3Cutoff(ctx.experienceBooking && ctx.experienceBooking.date)) {
      res.status(409).json({ error: 'past_t3_cutoff' });
      return;
    }

    const ap = ctx.adventurePrep || {};
    const currentConfirmed =
      parseInt(ap.confirmedKitCount, 10) ||
      parseInt((ctx.experienceBooking && ctx.experienceBooking.gearKitCount) || 0, 10) ||
      0;

    if (requestedKitCount === currentConfirmed) {
      // Guest dialed back to the count already on file before the window
      // closed — clear any in-flight pending marker rather than leave a
      // stale one for the cron to turn into a no-op charge/refund later.
      await callBookingsWebApp('adventurePrep_setPendingKitChange', {
        bookingId: ctx.bookingId,
        pendingKitCount: '',
        pendingSince: '',
      });
      res.status(200).json({ status: 'no_change', currentConfirmedKitCount: currentConfirmed });
      return;
    }

    const pendingSince = new Date().toISOString();
    await callBookingsWebApp('adventurePrep_setPendingKitChange', {
      bookingId: ctx.bookingId,
      pendingKitCount: requestedKitCount,
      pendingSince,
    });

    res.status(200).json({
      status: 'pending',
      requestedKitCount,
      currentConfirmedKitCount: currentConfirmed,
      pendingSince,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('adjust-gear-kit-count failed', token, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
