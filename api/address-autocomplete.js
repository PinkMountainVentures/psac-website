/**
 * api/address-autocomplete.js
 *
 * NEW (Airey's direct request, 2026-09-02): powers the address suggestion
 * dropdown on Surface A's Gear Kits delivery screen. Two modes in one
 * endpoint, selected by `body.mode`:
 *   - 'predict' (default): live-typing suggestions for `body.input`.
 *   - 'details': standardized line1/city/state/zip for `body.placeId`,
 *     once the guest picks a suggestion.
 * The actual Google-calling logic lives in lib/address-autocomplete.js,
 * kept separate from this HTTP handler the same way
 * api/validate-delivery-address.js splits out lib/validate-address.js.
 *
 * Auth: same Layer 2 guest-token check as validate-delivery-address --
 * this is called directly from Surface A's browser-side flow (no Sheet
 * write to gate behind a shared secret, and a shared secret can't safely
 * live in browser code anyway), so it's gated on the guest's own
 * adventurePrepToken resolving to a real, active booking before this repo
 * spends Google Maps quota on their behalf.
 */

'use strict';

const { findBookingByToken } = require('../lib/adventure-prep-service');
const { getPredictions, getPlaceDetails } = require('../lib/address-autocomplete');

/**
 * Reuses lib/adventure-prep-service.js's findBookingByToken purely as an
 * auth check, same pattern as validate-delivery-address.js.
 */
async function tokenIsActiveBooking(token) {
  if (!token) return false;
  const booking = await findBookingByToken(token);
  if (!booking) return false;
  const status = booking.booking_status || 'active';
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

    if (body.mode === 'details') {
      if (!body.placeId) {
        res.status(400).json({ error: 'bad_request', detail: 'placeId is required' });
        return;
      }
      const result = await getPlaceDetails(body.placeId, body.sessionToken);
      res.status(200).json(result);
      return;
    }

    if (!body.input) {
      res.status(400).json({ error: 'bad_request', detail: 'input is required' });
      return;
    }
    const result = await getPredictions(body.input, body.sessionToken);
    res.status(200).json(result);
  } catch (err) {
    // Soft-fail toward the guest (an empty suggestion list, not a broken
    // page) but still a real 500 so staff/monitoring see it -- this branch
    // means something in this handler itself broke, not just a poor or
    // absent Google match.
    // eslint-disable-next-line no-console
    console.error('address-autocomplete failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
