/**
 * api/get-adventure-prep.js
 *
 * Surface A's one load-everything call, thin wrapper over
 * adventurePrep_getContextByToken. Called on every page load/reload —
 * Surface A has no client-side state that survives a refresh, per the
 * "bookmarkable, multi-session" design in PRD Section 11, everything
 * needed to render whichever step the guest is on comes from this.
 *
 * Request:  GET /api/get-adventure-prep?token=...
 *   (GET, not POST — this is a pure read, matches the rest of this
 *   repo's convention of using POST only where something is written or a
 *   secret is involved; a token in a query string is already how this
 *   guest's browser reaches this page in the first place)
 *
 * Response:
 *   200 { bookingId, experienceBooking, adventurePrep, waiverSignatures, emergencyContacts }
 *   404 { error: 'invalid_token' }
 *   400 { error: 'missing_token' }
 *   500 { error: 'engineering_error', detail }
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const token = (req.query && req.query.token) || '';
  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }

  try {
    const ctx = await callBookingsWebApp('adventurePrep_getContextByToken', { token });
    if (!ctx || ctx.notFound) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }
    res.status(200).json(ctx);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('get-adventure-prep failed', token, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
