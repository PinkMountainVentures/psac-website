/**
 * api/check-gear-availability.js
 *
 * Gear Inventory PRD Section 3: real-time gear availability, computed from
 * the Gear Units tab's live status column, never a static/expected count.
 * Section 3/16 is explicit that this is a CAPABILITY, not an activation:
 * built correct and complete here, but the guest-facing booking-flow
 * calendar's own decision to actually call this endpoint and gate on its
 * result is a separate, not-yet-made decision that belongs elsewhere. This
 * file does not know or care who calls it.
 *
 * Read-only. Shared-secret auth rather than a staff session, specifically
 * so a future guest-facing caller (which has no staff cookie) can reach it
 * without this file changing.
 *
 * BUG FIX (payment-review, Aug 2026, Plausible finding): originally reused
 * GEAR_OPS_SHARED_SECRET, this build's one shared secret across every
 * other new gear-ops endpoint (charge/refund/reconcile/checkout/checkin/
 * manage-units — see those files' own headers for why one secret rather
 * than one per endpoint that round). That was fine while every caller was
 * internal staff, but this file's own stated intent is to eventually be
 * reachable by a guest-facing caller with no staff cookie — the moment
 * that happens, this secret is necessarily exposed to a less-trusted
 * context, and a leak of it (client-side exposure, a log, a misconfigured
 * proxy) would hand out unauthenticated access to every OTHER gear-ops
 * endpoint sharing it too, including the ones that move real money. Given
 * its own dedicated, narrower-scoped secret instead —
 * GEAR_AVAILABILITY_SHARED_SECRET — so a future leak here can't be
 * replayed against anything else. Read-only endpoint, so the blast radius
 * of THIS secret leaking on its own stays low either way.
 *
 * Availability math, deliberately conservative — Section 3 doesn't specify
 * an exact algorithm, this is a documented judgment call, flagged for
 * Airey to override if a more optimistic projection is wanted:
 *   - Only Gear Units rows with status==='available' right now count toward
 *     capacity. Units currently allocated/checked_out to a booking whose
 *     trip date has already passed are surfaced separately as
 *     `pendingReturn` (informational only) rather than counted available —
 *     they haven't actually been checked in yet, so their eventual routing
 *     (available / needs_cleaning / needs_deep_clean / damaged_pending_repair)
 *     is still unknown.
 *   - backpack_standard and backpack_plus are pooled into one figure for
 *     the assemblable-kit count, since size matching only matters once a
 *     real roster exists (allocation time), not for a general "can we fit
 *     N more kits" check.
 *   - Poles are tracked as pairs already (one Gear Units row = one pair,
 *     serves one kit) — the real seed count is 1 pair total, so
 *     assemblableKits will almost always be capped at 0 or 1 by poles until
 *     the ~Sept 7 restock. That's the real inventory, not a bug in this
 *     math.
 *   - Duffels are reported separately (duffelsAvailable /
 *     duffelsNeededForRequest) rather than folded into assemblableKits,
 *     since one duffel serves up to two kits (bookings-code.gs's
 *     buildGearLogRows(): ceil(kitCount/2)), not one-per-kit.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { pacificDateString } = require('../lib/cadence');

const POOLED_BACKPACK_TYPES = ['backpack_standard', 'backpack_plus'];

function checkSecret(body) {
  // Fail closed: require both a configured secret and a non-empty
  // caller-supplied one, so an unset env var never matches an absent
  // payload.secret (undefined === undefined would otherwise pass).
  // Own dedicated secret, not the shared GEAR_OPS_SHARED_SECRET — see this
  // file's header comment (payment-review Plausible finding).
  if (!process.env.GEAR_AVAILABILITY_SHARED_SECRET) return false;
  return !!(body && body.secret && body.secret === process.env.GEAR_AVAILABILITY_SHARED_SECRET);
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  return body || {};
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

    const tripDate = String(body.tripDate || pacificDateString(new Date())).slice(0, 10);
    const kitsNeeded = body.kitsNeeded != null ? Math.max(0, parseInt(body.kitsNeeded, 10) || 0) : null;

    const raw = await callBookingsWebApp('gearOps_checkAvailabilityRaw', {});
    const units = raw.units || [];
    const tripDates = raw.bookingTripDates || {};

    const byType = {};
    units.forEach((u) => {
      if (!byType[u.itemType]) byType[u.itemType] = { available: 0, pendingReturn: 0, other: 0, total: 0 };
      const bucket = byType[u.itemType];
      bucket.total += 1;
      if (u.status === 'available') {
        bucket.available += 1;
      } else if (
        (u.status === 'allocated' || u.status === 'checked_out') &&
        u.currentBookingId && tripDates[u.currentBookingId] &&
        String(tripDates[u.currentBookingId]).slice(0, 10) < tripDate
      ) {
        bucket.pendingReturn += 1;
      } else {
        bucket.other += 1;
      }
    });

    const backpacksAvailable = POOLED_BACKPACK_TYPES.reduce((sum, t) => sum + ((byType[t] && byType[t].available) || 0), 0);
    const bottlesAvailable = (byType.bottle && byType.bottle.available) || 0;
    const polesAvailable = (byType.poles && byType.poles.available) || 0;
    const firstAidAvailable = (byType.first_aid_kit && byType.first_aid_kit.available) || 0;
    const duffelsAvailable = (byType.duffel && byType.duffel.available) || 0;

    const assemblableKits = Math.min(
      backpacksAvailable,
      Math.floor(bottlesAvailable / 2),
      polesAvailable,
      firstAidAvailable
    );

    const result = {
      ok: true,
      tripDate,
      perItemType: byType,
      assemblableKits,
      duffelsAvailable,
      note: 'Conservative: counts only units with status=available right now. Units tied to already-past trip dates are reported separately as pendingReturn, not counted as available, since they have not actually been checked in yet.',
    };

    if (kitsNeeded != null) {
      result.requested = kitsNeeded;
      result.sufficientForRequest = assemblableKits >= kitsNeeded;
      result.duffelsNeededForRequest = Math.ceil(kitsNeeded / 2);
      result.sufficientDuffelsForRequest = duffelsAvailable >= result.duffelsNeededForRequest;
    }

    res.status(200).json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('check-gear-availability failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
