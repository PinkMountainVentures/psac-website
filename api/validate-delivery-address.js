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
 * deliveryAddressRaw, deliveryAddressValidated, and — after this session's
 * fix to adventure-prep-actions.gs — deliveryLat/deliveryLng). Keeping this
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
 * ============================================================================
 * Built against Google's Address Validation API v1 (addressvalidation.
 * googleapis.com) — a stable, publicly documented API. Requires
 * GOOGLE_MAPS_API_KEY (Address Validation API + Places API enabled on that
 * key/project). This session has no network egress or a live key to test
 * against, so — unlike the RideWithGPS/Uber Direct placeholders elsewhere in
 * this project, which are genuinely unconfirmed API shapes — this is a
 * real implementation against the documented request/response shape, not a
 * guess, but it's still worth one live smoke test against a real address
 * before Surface A depends on it in production.
 * ============================================================================
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

const VALIDATE_ENDPOINT = 'https://addressvalidation.googleapis.com/v1:validateAddress';

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

/**
 * Maps Google's verdict object to this project's single boolean,
 * `deliveryAddressValidated`. Deliberately conservative: only a match
 * Google reports as complete AND with no unconfirmed components counts as
 * validated. Anything else (partial match, inferred components, an
 * address Google flat-out couldn't parse) reads as `false` and routes to
 * the soft-fail path — matching Section 10's own posture that a
 * legitimately unusual address a geocoder chokes on shouldn't be treated
 * as a guest error, just an unresolved one.
 */
function isFullyValidated(verdict) {
  if (!verdict) return false;
  return verdict.addressComplete === true && !verdict.hasUnconfirmedComponents;
}

function extractComponent(components, type) {
  const match = (components || []).find((c) => (c.componentType === type));
  return match ? match.componentName?.text || '' : '';
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
    const addressLines = [input.line1, input.line2].filter(Boolean);
    if (!addressLines.length) {
      res.status(400).json({ error: 'bad_request', detail: 'addressInput.line1 is required' });
      return;
    }

    if (!process.env.GOOGLE_MAPS_API_KEY) {
      // Config problem, not a guest-facing one — soft-fail exactly like a
      // real validation miss, so the caller's fallback path (guest
      // proceeds, booking flags for staff review) works identically
      // whether Google said no or we couldn't ask.
      res.status(200).json({
        validated: false,
        standardized: null,
        rawEcho: input,
        error: 'GOOGLE_MAPS_API_KEY not configured',
      });
      return;
    }

    const requestBody = {
      address: {
        regionCode: 'US',
        postalCode: input.zip || undefined,
        administrativeArea: input.state || undefined,
        locality: input.city || undefined,
        addressLines,
      },
    };

    let googleRes, googleJson;
    try {
      googleRes = await fetch(`${VALIDATE_ENDPOINT}?key=${process.env.GOOGLE_MAPS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      googleJson = await googleRes.json();
    } catch (fetchErr) {
      res.status(200).json({
        validated: false,
        standardized: null,
        rawEcho: input,
        error: 'address validation request failed: ' + fetchErr.message,
      });
      return;
    }

    if (!googleRes.ok) {
      res.status(200).json({
        validated: false,
        standardized: null,
        rawEcho: input,
        error: 'Google Address Validation API error: ' + (googleJson?.error?.message || googleRes.status),
      });
      return;
    }

    const result = googleJson.result || {};
    const verdict = result.verdict || {};
    const postalAddress = result.address?.postalAddress || {};
    const components = result.address?.addressComponents || [];
    const location = result.geocode?.location || {};

    const standardized = {
      line1: (postalAddress.addressLines || [])[0] || input.line1 || '',
      line2: (postalAddress.addressLines || [])[1] || input.line2 || '',
      city: postalAddress.locality || extractComponent(components, 'locality') || input.city || '',
      state: postalAddress.administrativeArea || input.state || '',
      zip: postalAddress.postalCode || input.zip || '',
      lat: location.latitude != null ? location.latitude : null,
      lng: location.longitude != null ? location.longitude : null,
    };

    const validated = isFullyValidated(verdict);

    res.status(200).json({
      validated,
      standardized,
      rawEcho: input,
      verdict: {
        addressComplete: !!verdict.addressComplete,
        hasUnconfirmedComponents: !!verdict.hasUnconfirmedComponents,
        hasInferredComponents: !!verdict.hasInferredComponents,
      },
    });
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
