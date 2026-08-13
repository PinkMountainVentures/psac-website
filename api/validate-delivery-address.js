/**
 * api/validate-delivery-address.js
 *
 * Operations UX PRD Section 10 / Section 13 / Section 18 item 15: a thin
 * server-side wrapper around Google Maps Platform's Address Validation API
 * (Airey confirmed, Section 18 item 15 — Google over Smarty). Called from
 * Surface A whenever the delivery address field is set or re-edited
 * (address is self-service-editable through the same T-3, 10pm Pacific
 * cutoff as everything else — see api/adventure-prep.js's
 * checkGuestSelfServiceEditAllowed — so this can still fire more than once
 * per booking, just not after that cutoff).
 *
 * This endpoint does NOT write to the Sheet itself — Section 13 is explicit
 * that it "wraps the Google Maps Platform ... call and returns the
 * standardized structured result for Adventure Prep's backend to store."
 * The caller (Surface A / its save path) takes this response and persists
 * it via the existing `adventurePrep_saveFields` action (already whitelists
 * deliveryAddressLine1/2, deliveryCity, deliveryState, deliveryZip,
 * deliveryAddressRaw, deliveryAddressValidated, and now deliveryLat/
 * deliveryLng too, per this round's fix to that whitelist). Keeping this
 * endpoint side-effect-free means a validation call that never gets saved
 * (guest navigates away mid-edit) never leaves stray state behind.
 *
 * Soft-fail, per Section 18 item 17 (confirmed by Airey): validation
 * failure or an unconfirmed/incomplete match is reported honestly as
 * `validated: false`, never a hard error that blocks the guest. The caller
 * decides what to do with that (Section 10: guest proceeds after a retry
 * prompt; the booking flags for the staff review path). This endpoint's own
 * job stops at reporting the verdict.
 *
 * Auth: unlike the server-to-server endpoints elsewhere in this stack
 * (which use a per-endpoint shared secret, since only this repo's own
 * api/*.js functions ever call them), this one is called directly from
 * Surface A's browser-side save flow — there's no Sheet write here to
 * gate behind BOOKINGS_WEBAPP_SECRET, and a shared secret can't safely
 * live in browser code anyway. So this uses the SAME Layer 2 guest-token
 * auth as saveFields/selectTrail (api/adventure-prep.js): the guest's own
 * `adventurePrepToken`, checked against the live Sheet before this repo
 * spends Google Maps quota on their behalf. An invalid or cancelled-booking
 * token is rejected; a valid one from an active booking proceeds.
 *
 * NOTE (this round): the actual Google-calling/standardization logic now
 * lives in lib/validate-address.js, shared with api/apply-manual-
 * adjustment.js's new `update_delivery_address` type (staff correcting an
 * address after a phone/SMS/email interaction with the guest) — one source
 * of truth instead of two copies that could drift.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { validateAddress } = require('../lib/validate-address');

/**
 * Reuses the existing adventurePrep_getContextByToken action purely as an
 * auth check — confirms the token resolves to a real, active booking
 * before this repo spends Google Maps quota on the caller's behalf.
 * Slightly more work than a dedicated token-check action would need, but
 * avoids adding yet another near-duplicate Apps Script action for a check
 * this one already does as a side effect of existing.
 */
async function tokenIsActiveBooking(token) {
  if (!token) return false;
  const ctx = await callBookingsWebApp('adventurePrep_getContextByToken', { token });
  if (!ctx || ctx.notFound) return false;
  const status = ctx.experienceBooking?.bookingStatus || 'active';
  return status === 'active';
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const body = req.body || {};
    if (!(await tokenIsActiveBooking(body.token))) {
      res.status(401).json({ error: 'unauthorized', detail: 'invalid or inactive adventurePrepToken' });
      return;
    }

    const input = body.addressInput || {};
    if (!input.line1) {
      res.status(400).json({ error: 'bad_request', detail: 'addressInput.line1 is required' });
      return;
    }

    const result = await validateAddress(input);
    res.status(200).json(result);
  } catch (err) {
    // Even an unexpected internal error here should soft-fail toward the
    // guest, not block them — but it's still surfaced as a real 500 so
    // staff/monitoring see it, since this branch means something in this
    // handler itself broke, not just that Google returned a poor match.
    // eslint-disable-next-line no-console
    console.error('validate-delivery-address failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
