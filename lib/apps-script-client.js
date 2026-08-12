/**
 * lib/apps-script-client.js
 *
 * Thin fetch wrapper for calling the existing "PSAC Bookings & Operations"
 * Apps Script Web App — the same webapp api/save-booking.js and
 * api/create-deposit-hold.js already call, following the exact pattern
 * documented in claude/psac-start-my-adventure-handoff-summary.md: a single
 * doPost(e) endpoint, dispatched by an `action` field in the JSON body,
 * authenticated by a shared secret checked against a script property.
 *
 * This file adds NO new authentication scheme — it reuses
 * BOOKINGS_WEBAPP_URL / BOOKINGS_WEBAPP_SECRET, the same env vars
 * api/save-booking.js already uses, per the kickoff prompt's own
 * instruction not to invent a new pattern.
 */

'use strict';

async function callBookingsWebApp(action, params) {
  const url = process.env.BOOKINGS_WEBAPP_URL;
  const secret = process.env.BOOKINGS_WEBAPP_SECRET;
  if (!url || !secret) {
    throw new Error('BOOKINGS_WEBAPP_URL / BOOKINGS_WEBAPP_SECRET not configured');
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action, secret }, params)),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`Apps Script webapp returned non-JSON (status ${response.status}): ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const message = (body && body.error) || `Apps Script webapp returned ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

module.exports = { callBookingsWebApp };
