/**
 * lib/address-autocomplete.js
 *
 * NEW (Airey's direct request, 2026-09-02): Surface A's Gear Kits delivery
 * screen let guests type a delivery address with zero assistance -- no
 * suggestions, and city/zip had to be typed by hand even after picking a
 * real place. This wraps Google Maps Platform's Places API (New) --
 * `:autocomplete` for the live-typing suggestion list and Place Details
 * for filling in the standardized address once a guest picks one -- the
 * same Google Maps project/key as lib/validate-address.js's Address
 * Validation call (process.env.GOOGLE_MAPS_API_KEY), just a different API
 * on that key. That existing Address Validation call still runs on
 * Continue as the final confirm/standardize step; this module only
 * powers the as-you-type suggestion dropdown and the auto-fill of city/
 * zip when a suggestion is picked.
 *
 * Deliberately side-effect-free and auth-agnostic, mirroring
 * lib/validate-address.js: callers own their own auth and their own
 * decision about what to do with a soft-fail. A missing/invalid key or a
 * failed Google call returns an empty result here rather than throwing --
 * same "never block a guest from typing the address out by hand instead"
 * posture as the rest of this delivery-address flow.
 */

'use strict';

const AUTOCOMPLETE_ENDPOINT = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_ENDPOINT = 'https://places.googleapis.com/v1/places';

// Biases (never restricts) results toward the Coachella Valley, since the
// overwhelming majority of guests are typing a Palm Springs-area hotel,
// vacation rental, or home address. A ~25mi radius centered on Palm
// Springs comfortably covers La Quinta/Indio on the valley's far end
// without excluding an edge-case delivery just outside it.
const COACHELLA_VALLEY_BIAS = {
  circle: {
    center: { latitude: 33.8303, longitude: -116.5453 },
    radius: 40000.0,
  },
};

/**
 * @param {string} input raw, in-progress text the guest has typed so far
 * @param {string} [sessionToken]
 * @returns {Promise<{predictions: Array<{placeId:string, text:string, mainText:string, secondaryText:string}>, error?:string}>}
 */
async function getPredictions(input, sessionToken) {
  input = String(input || '').trim();
  if (!input) return { predictions: [] };

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return { predictions: [], error: 'GOOGLE_MAPS_API_KEY not configured' };
  }

  const requestBody = {
    input,
    regionCode: 'US',
    includedRegionCodes: ['us'],
    locationBias: COACHELLA_VALLEY_BIAS,
  };
  if (sessionToken) requestBody.sessionToken = sessionToken;

  let googleRes, googleJson;
  try {
    googleRes = await fetch(AUTOCOMPLETE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
      },
      body: JSON.stringify(requestBody),
    });
    googleJson = await googleRes.json();
  } catch (fetchErr) {
    return { predictions: [], error: fetchErr.message };
  }

  if (!googleRes.ok) {
    return { predictions: [], error: (googleJson && googleJson.error && googleJson.error.message) || `Places API returned ${googleRes.status}` };
  }

  const suggestions = Array.isArray(googleJson.suggestions) ? googleJson.suggestions : [];
  const predictions = suggestions
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .map((p) => ({
      placeId: p.placeId,
      text: (p.text && p.text.text) || '',
      mainText: (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || '',
      secondaryText: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || '',
    }));

  return { predictions };
}

function extractComponent(components, type) {
  const match = (components || []).find((c) => Array.isArray(c.types) && c.types.includes(type));
  return match ? match.longText || match.shortText || '' : '';
}

/**
 * @param {string} placeId
 * @param {string} [sessionToken] same token used for the predictions call
 *   that produced this placeId -- closes out that session for billing.
 * @returns {Promise<{standardized: {line1:string, city:string, state:string, zip:string, lat:number|null, lng:number|null, formattedAddress:string}|null, error?:string}>}
 */
async function getPlaceDetails(placeId, sessionToken) {
  if (!placeId) return { standardized: null, error: 'placeId is required' };

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return { standardized: null, error: 'GOOGLE_MAPS_API_KEY not configured' };
  }

  const params = new URLSearchParams({ fields: 'addressComponents,formattedAddress,location' });
  if (sessionToken) params.set('sessionToken', sessionToken);

  let googleRes, googleJson;
  try {
    googleRes = await fetch(`${DETAILS_ENDPOINT}/${encodeURIComponent(placeId)}?${params.toString()}`, {
      headers: { 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY },
    });
    googleJson = await googleRes.json();
  } catch (fetchErr) {
    return { standardized: null, error: fetchErr.message };
  }

  if (!googleRes.ok) {
    return { standardized: null, error: (googleJson && googleJson.error && googleJson.error.message) || `Places API returned ${googleRes.status}` };
  }

  const components = googleJson.addressComponents || [];
  const streetNumber = extractComponent(components, 'street_number');
  const route = extractComponent(components, 'route');
  const line1 = [streetNumber, route].filter(Boolean).join(' ');
  const city = extractComponent(components, 'locality') || extractComponent(components, 'postal_town') || extractComponent(components, 'sublocality');
  const state = extractComponent(components, 'administrative_area_level_1');
  const zip = extractComponent(components, 'postal_code');
  const loc = googleJson.location || {};

  return {
    standardized: {
      line1: line1 || googleJson.formattedAddress || '',
      city,
      state,
      zip,
      lat: typeof loc.latitude === 'number' ? loc.latitude : null,
      lng: typeof loc.longitude === 'number' ? loc.longitude : null,
      formattedAddress: googleJson.formattedAddress || '',
    },
  };
}

module.exports = { getPredictions, getPlaceDetails };
