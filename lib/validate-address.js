/**
 * lib/validate-address.js
 *
 * Shared core of the Google Address Validation API call, factored out of
 * api/validate-delivery-address.js so api/apply-manual-adjustment.js's new
 * `update_delivery_address` type (staff manually correcting/entering a
 * guest's delivery address after a phone/SMS/email interaction, per
 * Airey's Aug 2026 request) can reuse the exact same validation and
 * standardization logic instead of a second, driftable copy.
 *
 * Deliberately side-effect-free and auth-agnostic — callers own their own
 * auth (guest-token for Surface A, shared-secret for the ops app) and their
 * own decision about what to do with an unvalidated result. This module's
 * job stops at "here's what Google said."
 */

'use strict';

const VALIDATE_ENDPOINT = 'https://addressvalidation.googleapis.com/v1:validateAddress';

/**
 * Deliberately conservative: only a match Google reports as complete AND
 * with no unconfirmed components counts as validated. Anything else
 * (partial match, inferred components, an address Google flat-out
 * couldn't parse) reads as `false` and routes to the soft-fail path.
 */
function isFullyValidated(verdict) {
  if (!verdict) return false;
  return verdict.addressComplete === true && !verdict.hasUnconfirmedComponents;
}

function extractComponent(components, type) {
  const match = (components || []).find((c) => c.componentType === type);
  return match ? match.componentName?.text || '' : '';
}

/**
 * @param {{line1:string, line2?:string, city?:string, state?:string, zip?:string}} input
 * @returns {Promise<{validated:boolean, standardized:object|null, rawEcho:object, verdict?:object, error?:string}>}
 */
async function validateAddress(input) {
  input = input || {};
  const addressLines = [input.line1, input.line2].filter(Boolean);
  if (!addressLines.length) {
    return { validated: false, standardized: null, rawEcho: input, error: 'line1 is required' };
  }

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    // Config problem, not a guest/staff-facing one — soft-fail exactly like
    // a real validation miss, so every caller's existing fallback path
    // (proceed, flag for review) works identically whether Google said no
    // or we couldn't ask.
    return {
      validated: false,
      standardized: null,
      rawEcho: input,
      error: 'GOOGLE_MAPS_API_KEY not configured',
    };
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
    return {
      validated: false,
      standardized: null,
      rawEcho: input,
      error: 'address validation request failed: ' + fetchErr.message,
    };
  }

  if (!googleRes.ok) {
    return {
      validated: false,
      standardized: null,
      rawEcho: input,
      error: 'Google Address Validation API error: ' + (googleJson?.error?.message || googleRes.status),
    };
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

  return {
    validated: isFullyValidated(verdict),
    standardized,
    rawEcho: input,
    verdict: {
      addressComplete: !!verdict.addressComplete,
      hasUnconfirmedComponents: !!verdict.hasUnconfirmedComponents,
      hasInferredComponents: !!verdict.hasInferredComponents,
    },
  };
}

module.exports = { validateAddress };
