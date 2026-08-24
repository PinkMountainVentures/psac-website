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
 *
 * RETRY (added 2026-08-24, see psac-build-checklist.md's Apps Script
 * incident writeup). Confirmed via the Apps Script project's own
 * Executions log that the "non-JSON response" failure is a transient
 * Google Web-App response-delivery glitch, not a script execution
 * failure — every execution logged Completed, no exception, even on a
 * call whose caller got back a garbage interstitial page instead of the
 * real JSON. Retrying the exact same call is safe ONLY when the action
 * being called is a pure, idempotent field-set (replaying it does
 * nothing worse than re-set the same values, at most one extra Change
 * Log/Ops Alert row). Callers opt in with { retries: N } — this defaults
 * to 0 (no retry), so a non-idempotent action (saveBooking, or anything
 * that appends a guest-facing send) is never silently retried without an
 * explicit, reviewed decision to do so at the call site.
 */

'use strict';

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function callBookingsWebApp(action, params, opts) {
  opts = opts || {};
  const retries = opts.retries || 0;
  const retryDelayMs = opts.retryDelayMs || 600;
  const url = process.env.BOOKINGS_WEBAPP_URL;
  const secret = process.env.BOOKINGS_WEBAPP_SECRET;
  if (!url || !secret) {
    throw new Error('BOOKINGS_WEBAPP_URL / BOOKINGS_WEBAPP_SECRET not configured');
  }

  let attempt = 0;
  for (;;) {
    attempt++;
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
      // The transient, non-JSON "Apps Script Web App served a Google
      // interstitial page instead of the real output" symptom. Only this
      // specific failure is ever retried — a real, parsed error response
      // below is never blindly retried.
      if (attempt <= retries) {
        await sleep(retryDelayMs);
        continue;
      }
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
}

module.exports = { callBookingsWebApp };
