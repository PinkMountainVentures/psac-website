/**
 * lib/kit-sync-service.js
 *
 * Task 10 (Relational Database Migration PRD, Section 4.1 / Section 10
 * item 7) — the one-way sync FROM Kit (the homepage email-signup tool)
 * INTO people.kit_subscriber_id / people.email_list_status. Kit stays the
 * real system of record for email-list membership; this never writes back
 * to Kit — same posture this migration already takes with Stripe (Postgres
 * caches a pointer, never becomes the source of truth for the thing it
 * points at).
 *
 * DESIGN CHOICE, made here per the build kickoff prompt's explicit "pick
 * one, justify it briefly" instruction: a periodic poll cron
 * (api/sync-kit-subscribers.js), not a webhook receiver. Reasoning:
 *
 *   1. This repo has ZERO existing webhook endpoints — every recurring job
 *      (process-t3-cutoff, check-adventure-prep-cadence, trigger-deposit-
 *      holds, trigger-gear-reconciliation, etc.) is a Vercel Cron target
 *      gated by CRON_SECRET. A poll fits that established convention
 *      directly; a webhook would be the only one of its kind in the repo.
 *   2. A webhook needs Airey to register a target URL + verify a signing
 *      secret inside Kit's own dashboard before it does anything at all —
 *      genuinely Airey's action, not buildable/testable end-to-end from
 *      here. A poll needs nothing new from Kit's side beyond the same
 *      KIT_API_KEY api/kit-subscribe.js already uses.
 *   3. Per the kickoff prompt's own Prerequisite 4, Kit credentials for
 *      this sync may not be in hand yet — the poll design degrades
 *      cleanly to a documented no-op (see syncKitSubscribers's first
 *      branch) rather than sitting inert waiting for a webhook Kit will
 *      never call because it was never registered.
 *
 * Kit API v4 reference used to build this (developers.kit.com):
 *   GET /v4/subscribers?status=all&per_page=1000&after=<cursor>
 *   Response: { subscribers: [{id, email_address, state, ...}],
 *               pagination: {has_next_page, end_cursor, ...} }
 *   `state` is one of active|cancelled|bounced|complained|inactive.
 *
 * STATE MAPPING (2026-08-31, corrected per Airey's explicit direction —
 * an earlier version of this file collapsed all four non-active states to
 * a single 'unsubscribed' value; Airey's call: "map them 1:1, otherwise
 * the statuses will be out of sync between kit and this system"): Kit's
 * `state` is stored VERBATIM, not translated. `email_list_status_t` was
 * widened to `('active','cancelled','bounced','complained','inactive',
 * 'unknown')` — Kit's own five states, plus 'unknown' for a person who has
 * never appeared in a Kit sync result at all (the column's un-synced
 * default). This is a real, deliberate departure from the migration PRD's
 * original Section 4.1 wording (which specified a subscribed/unsubscribed/
 * unknown enum) — Airey's correction supersedes that spec. Any Kit state
 * this file doesn't recognize (a genuinely new state Kit adds in the
 * future) maps defensively to 'unknown' rather than aborting the whole
 * sync on an invalid-enum-literal error — see `KNOWN_KIT_STATES` below;
 * this schema needs a follow-up widening if Kit ever adds a real new
 * state, since 'unknown' would otherwise silently under-report it forever.
 *
 * FULL PULL, NOT INCREMENTAL. Kit's list is not filtered by
 * `updated_after`, on purpose: (1) the only rows that matter are the ones
 * that also exist in the much smaller local `people` table, so this job's
 * real cost is bounded by Kit's total subscriber count, not by anything
 * that needs a persisted "last synced" cursor; (2) it keeps the job
 * stateless — no new tracking table/column just to remember a timestamp.
 * If Kit's subscriber count grows large enough that a full pull gets
 * expensive, `updated_after` is the first thing to add — not needed yet.
 */

'use strict';

const { query } = require('./db');
const { genId } = require('./ids');

const KIT_API_BASE = 'https://api.kit.com/v4';
const MAX_PAGES = 200; // safety cap: 200 * 1000/page = 200,000 subscribers, well past this business's scale

// Kit's own five subscriber states (developers.kit.com) — kept in exact
// sync with email_list_status_t's enum values (minus 'unknown', which is
// this side's own value for "never synced," not a Kit state at all).
const KNOWN_KIT_STATES = ['active', 'cancelled', 'bounced', 'complained', 'inactive'];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * 1:1 passthrough of Kit's own state, per Airey's explicit correction (see
 * this file's header) — no collapsing. Exported so the mapping rule itself
 * can be unit-tested independent of any HTTP call. Falls back to
 * 'unknown' only for a state Kit returns that isn't in KNOWN_KIT_STATES —
 * defensive against Kit adding a new state this schema hasn't been
 * widened for yet, never something expected to trigger in normal use.
 */
function mapKitStateToLocalStatus(state) {
  return KNOWN_KIT_STATES.indexOf(state) !== -1 ? state : 'unknown';
}

/**
 * Paginates through Kit's entire subscriber list. Returns
 * {byEmail, unmappedStateCount} — byEmail is a Map keyed by normalized
 * email -> {subscriberId, status}. Last-write-wins on a duplicate email
 * across pages (shouldn't happen with cursor pagination against a stable
 * list, but cheap to make safe regardless). unmappedStateCount counts
 * subscribers whose Kit `state` fell outside KNOWN_KIT_STATES — should
 * always be 0 in normal operation; a nonzero count means Kit has added a
 * state this schema/mapping hasn't been updated for yet.
 */
async function fetchAllKitSubscribers(apiKey) {
  const byEmail = new Map();
  let unmappedStateCount = 0;
  let after;
  let page = 0;

  do {
    page += 1;
    if (page > MAX_PAGES) {
      throw new Error(`Kit subscriber list exceeded ${MAX_PAGES} pages (${MAX_PAGES * 1000}+ subscribers) — aborting rather than looping forever`);
    }
    const url = new URL(`${KIT_API_BASE}/subscribers`);
    url.searchParams.set('status', 'all');
    url.searchParams.set('per_page', '1000');
    if (after) url.searchParams.set('after', after);

    const kitRes = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'X-Kit-Api-Key': apiKey },
    });
    const kitJson = await kitRes.json();
    if (!kitRes.ok) {
      throw new Error('Kit list-subscribers error: ' + ((kitJson && (kitJson.error || kitJson.message)) || kitRes.status));
    }

    for (const sub of (kitJson && kitJson.subscribers) || []) {
      const email = normalizeEmail(sub.email_address);
      if (!email || sub.id == null) continue;
      if (KNOWN_KIT_STATES.indexOf(sub.state) === -1) unmappedStateCount += 1;
      byEmail.set(email, { subscriberId: String(sub.id), status: mapKitStateToLocalStatus(sub.state) });
    }

    after = kitJson && kitJson.pagination && kitJson.pagination.has_next_page ? kitJson.pagination.end_cursor : null;
  } while (after);

  return { byEmail, unmappedStateCount };
}

async function findOpenKitSyncFailedAlert() {
  const rows = await query(
    `SELECT alert_id FROM ops_alerts WHERE booking_id IS NULL AND alert_type = 'kit_sync_failed' AND status = 'Open' LIMIT 1`
  );
  return rows.length ? rows[0].alert_id : null;
}

async function recordKitSyncFailedAlert(errorMessage) {
  // Dedupe against a still-open alert from a prior failed tick — this cron
  // can run several times a day, and a persistent Kit-side outage
  // shouldn't stack a fresh Ops Alert on every single tick.
  const existing = await findOpenKitSyncFailedAlert();
  if (existing) return existing;
  const alertId = genId('ALERT');
  await query(
    `INSERT INTO ops_alerts (alert_id, booking_id, alert_type, notes) VALUES ($1, NULL, 'kit_sync_failed', $2)`,
    [alertId, errorMessage || null]
  );
  return alertId;
}

/** Self-heal: a next tick that succeeds clears whatever failure alert a prior tick raised. */
async function resolveKitSyncFailedAlertIfOpen() {
  const existing = await findOpenKitSyncFailedAlert();
  if (!existing) return;
  await query(
    `UPDATE ops_alerts SET status = 'Resolved', resolved_at = NOW(), resolved_by = 'system (kit-sync auto-recovery)' WHERE alert_id = $1`,
    [existing]
  );
}

/**
 * The job itself. Never throws — a Kit-side failure is reported via the
 * return value AND a real Ops Alert (same posture as every other cron job
 * in this migration), not an uncaught exception the caller has to know to
 * catch.
 */
async function syncKitSubscribers() {
  const apiKey = process.env.KIT_API_KEY;
  if (!apiKey) {
    // Config gap, not a runtime failure — same soft-fail posture as
    // lib/validate-address.js's own missing-API-key branch. No Ops Alert:
    // an unconfigured env var (this sync's Kit credentials, per the build
    // kickoff's Prerequisite 4, may genuinely not be in hand yet) isn't a
    // staff-actionable incident the way a live Kit API error is.
    return { ok: false, error: 'KIT_API_KEY not configured', kitSubscribersFetched: 0, matched: 0 };
  }

  let byEmail, unmappedStateCount;
  try {
    ({ byEmail, unmappedStateCount } = await fetchAllKitSubscribers(apiKey));
  } catch (err) {
    const alertId = await recordKitSyncFailedAlert(err.message);
    return { ok: false, error: err.message, alertId, kitSubscribersFetched: 0, matched: 0 };
  }

  await resolveKitSyncFailedAlertIfOpen();

  if (byEmail.size === 0) {
    return { ok: true, kitSubscribersFetched: 0, matched: 0, unmappedStateCount };
  }

  const emails = [];
  const subscriberIds = [];
  const statuses = [];
  for (const [email, data] of byEmail) {
    emails.push(email);
    subscriberIds.push(data.subscriberId);
    statuses.push(data.status);
  }

  // people.email is already stored normalized (trim+lowercase — see
  // lib/booking-service.js's own normalizeEmail/findOrCreatePerson), so a
  // direct equality join against the same normalization done above is
  // exact, no lower() needed on either side.
  const rows = await query(
    `UPDATE people p
     SET kit_subscriber_id = d.subscriber_id,
         email_list_status = d.status::email_list_status_t
     FROM (
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[]) AS d(email, subscriber_id, status)
     ) d
     WHERE p.email = d.email
     RETURNING p.person_id`,
    [emails, subscriberIds, statuses]
  );

  return { ok: true, kitSubscribersFetched: byEmail.size, matched: rows.length, unmappedStateCount };
}

module.exports = { syncKitSubscribers, mapKitStateToLocalStatus, fetchAllKitSubscribers };
