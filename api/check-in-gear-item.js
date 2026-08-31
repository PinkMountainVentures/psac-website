/**
 * api/check-in-gear-item.js
 *
 * MIGRATED (2026-08-31, gear-ops build session): now calls lib/gear-
 * service.js (Postgres) instead of lib/apps-script-client.js's
 * callBookingsWebApp(). See lib/gear-service.js's own header for the full
 * scope of this migration.
 *
 * Gear Inventory PRD Section 5/9: consolidated dispatcher for Return
 * Check-In. Server-to-server only (api/ops-proxy.js), GEAR_OPS_SHARED_SECRET.
 *
 *   - 'getQueue'    -> getCheckinQueue (V1)
 *   - 'getContext'  -> getCheckinContext (per-item state, rubric-relevant
 *     fields, deep-clean threshold/progress — everything the check-in
 *     screen needs in one call)
 *   - 'uploadPhoto' -> lib/gear-photo-upload.js's uploadGearPhoto(),
 *     unchanged by this migration (Vercel Blob, not Apps Script)
 *   - 'checkIn'     -> checkInItem. Photo required (enforced HERE, not
 *     just trusted from the client's own form validation) for Damaged,
 *     required text note for Missing, per Section 5/10 (Round 2 item 6).
 *     The 48-hour grace deadline is computed HERE in Node from the real
 *     clock.
 *   - 'getQueueV2' / 'getReturnContext' / 'schedulePickup' / 'markPickedUp'
 *     / 'markReturned' -> the Round 2 inbound-leg state machine (Pickup
 *     Scheduled -> optional Picked Up -> Returned (required gate) ->
 *     Checked-In (automatic, via syncReturnStatusIfSettled below))
 */

'use strict';

const gearService = require('../lib/gear-service');
const { uploadGearPhoto } = require('../lib/gear-photo-upload');

const VALID_CONDITIONS = ['Good', 'Damaged', 'Missing', 'Recovered'];
const GRACE_PERIOD_HOURS = 48;

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

    const action = body.action;

    if (action === 'getQueue') {
      if (!body.tripDate) {
        res.status(400).json({ error: 'bad_request', detail: 'tripDate is required' });
        return;
      }
      const result = await gearService.getCheckinQueue({ tripDate: body.tripDate });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'getContext') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await gearService.getCheckinContext({ bookingId: body.bookingId });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'uploadPhoto') {
      if (!body.bookingId || !body.unitId || !body.dataUrl) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId, unitId, and dataUrl are required' });
        return;
      }
      try {
        const photoUrl = await uploadGearPhoto({
          dataUrl: body.dataUrl,
          bookingId: body.bookingId,
          unitId: body.unitId,
        });
        res.status(200).json({ ok: true, photoUrl });
      } catch (uploadErr) {
        // eslint-disable-next-line no-console
        console.error('check-in-gear-item: photo upload failed', body.bookingId, body.unitId, uploadErr);
        res.status(502).json({ error: 'photo_upload_failed', detail: uploadErr.message });
      }
      return;
    }

    if (action === 'checkIn') {
      if (!body.bookingId || !body.unitId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId and unitId are required' });
        return;
      }
      const condition = body.condition;
      if (VALID_CONDITIONS.indexOf(condition) === -1) {
        res.status(400).json({ error: 'bad_request', detail: `condition must be one of: ${VALID_CONDITIONS.join(', ')}` });
        return;
      }
      // BUG FIX (Ops App Redesign, Aug 2026 — Round 2 item 6, resolves P2d):
      // photo requirement applies to Damaged only (nothing to photograph
      // for an item that isn't there); Missing gets its own required text
      // note instead. The 48-hour grace-period countdown and guest
      // notification are unchanged either way.
      if (condition === 'Damaged' && !body.photoUrl) {
        res.status(400).json({ error: 'bad_request', detail: 'photoUrl is required when condition is Damaged' });
        return;
      }
      if (condition === 'Missing' && !(body.notes && String(body.notes).trim())) {
        res.status(400).json({ error: 'bad_request', detail: 'notes is required when condition is Missing (describe what\'s known about the missing item)' });
        return;
      }

      const nowIso = new Date().toISOString();
      const graceDeadline = condition === 'Missing'
        ? new Date(Date.now() + GRACE_PERIOD_HOURS * 60 * 60 * 1000).toISOString()
        : '';

      const result = await gearService.checkInItem({
        bookingId: body.bookingId,
        unitId: String(body.unitId).trim(),
        condition,
        notes: body.notes || '',
        photoUrl: body.photoUrl || '',
        nowIso,
        graceDeadline,
      });

      // Ops App Redesign (Aug 2026) — Round 2 item 6: Checked-In is set
      // automatically the instant every item on the booking has a judged
      // condition, never a button staff clicks. Best-effort — a sync
      // failure here never masks the check-in write that already
      // succeeded above; the next check-in on this booking (or a manual
      // glance) will catch it if this one call happens to fail.
      if (result && result.ok !== false) {
        try {
          await gearService.syncReturnStatusIfSettled({ bookingId: body.bookingId, nowIso });
        } catch (syncErr) {
          // eslint-disable-next-line no-console
          console.error('check-in-gear-item: returnStatus sync failed', body.bookingId, syncErr);
        }
      }

      // Section 5/11: fire the grace-period guest notification the moment
      // an item is marked Missing — not a separate cron job, this is the
      // one and only place a fresh Missing status gets set.
      if (result && result.ok && condition === 'Missing') {
        try {
          const { sendEmail } = require('../lib/send-email');
          const { renderGracePeriodEmail, gracePeriodSubject } = require('../lib/email-templates/grace-period-email');
          const ctx = await gearService.getCheckinContext({ bookingId: body.bookingId });
          const missingItems = (ctx.items || []).filter((i) => i.unitId === body.unitId).map((i) => i.itemName);
          const contactRes = await gearService.getReconciliationContext({ bookingId: body.bookingId });
          if (contactRes && contactRes.contactEmail && missingItems.length) {
            const deadlineDisplay = new Date(graceDeadline).toLocaleString('en-US', {
              timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short',
            }) + ' Pacific';
            await sendEmail({
              to: contactRes.contactEmail,
              subject: gracePeriodSubject(missingItems),
              html: renderGracePeriodEmail({
                logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
                items: missingItems,
                deadline: deadlineDisplay,
              }),
            });
          }
        } catch (emailErr) {
          // Never let a best-effort notification failure mask the
          // successful check-in write that already happened.
          // eslint-disable-next-line no-console
          console.error('check-in-gear-item: grace-period email failed', body.bookingId, body.unitId, emailErr);
        }
      }

      res.status(200).json(result);
      return;
    }

    // Ops App Redesign (Aug 2026) — Round 2 item 6: the inbound return leg.
    // Pickup Scheduled -> optional Picked Up -> Returned (required gate) ->
    // Checked-In (automatic, handled above).
    if (action === 'getQueueV2') {
      if (!body.tripDate) {
        res.status(400).json({ error: 'bad_request', detail: 'tripDate is required' });
        return;
      }
      const result = await gearService.getCheckinQueueV2({ tripDate: body.tripDate });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'getReturnContext') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await gearService.getReturnContext({ bookingId: body.bookingId });
      res.status(200).json(Object.assign({ ok: true }, result));
      return;
    }

    if (action === 'schedulePickup') {
      if (!body.bookingId || !body.pickupServiceType) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId and pickupServiceType are required' });
        return;
      }
      const result = await gearService.schedulePickup({
        bookingId: body.bookingId,
        pickupServiceType: body.pickupServiceType,
        pickupAddressOverride: body.pickupAddressOverride || '',
        pickupTimeNote: body.pickupTimeNote || '',
      });
      res.status(200).json(result);
      return;
    }

    if (action === 'markPickedUp') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await gearService.markPickedUp({ bookingId: body.bookingId });
      res.status(200).json(result);
      return;
    }

    if (action === 'markReturned') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await gearService.markReturned({ bookingId: body.bookingId });
      res.status(200).json(result);
      return;
    }

    res.status(400).json({ error: 'unknown_action', detail: action });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('check-in-gear-item failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
