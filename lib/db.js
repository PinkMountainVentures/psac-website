/**
 * lib/db.js
 *
 * Replaces lib/apps-script-client.js as the one chokepoint every api/*.js
 * file goes through to reach persisted data (PRD Section 8.1, Section 9).
 * Backed by Neon Postgres via @neondatabase/serverless's HTTP driver --
 * chosen specifically because it's HTTP-based (no long-lived connection
 * held per invocation), which avoids the connection-pool-exhaustion
 * problem a traditional `pg` Pool has under Vercel's per-invocation
 * concurrency model (every concurrent request is a fresh serverless
 * invocation, so a real TCP-pooled client can't be shared across them the
 * way it would on a long-running server).
 *
 * DATABASE_URL is wired in automatically by Vercel's Postgres (Neon)
 * integration once connected in the dashboard (Project -> Storage ->
 * Connect Database) -- see the migration handoff doc for the exact steps.
 * Locally, copy it into .env.local same as every other env var here.
 *
 * USAGE
 * -----
 * Simple single-statement query (tagged template, values are safely
 * parameterized -- never string-concatenate a value into the template):
 *
 *   const { sql } = require('../lib/db');
 *   const rows = await sql`SELECT * FROM people WHERE email = ${email}`;
 *
 * Dynamic SQL (built column list, `IN (...)`, etc. -- mirrors the
 * allowlisted-field-set pattern already used by adventurePrep_saveFields
 * for its ADVENTURE_PREP_WRITABLE_FIELDS whitelist):
 *
 *   const { query } = require('../lib/db');
 *   const rows = await query('SELECT * FROM trails WHERE trail_id = $1', [trailId]);
 *
 * Multi-statement atomic transaction (replaces this codebase's
 * LockService.getScriptLock() + single global lock pattern with a real
 * Postgres transaction -- see handleSaveBooking's rewrite for the primary
 * example). All queries in the array are built BEFORE any of them run --
 * this only works when every value is already known in JS (which is true
 * everywhere this codebase used a single global lock instead of per-row
 * CAS, since the old code never needed to read a value back mid-lock
 * either). A CAS-guarded single UPDATE ... WHERE clause (see
 * updateDepositStatus below) does NOT need a transaction at all --
 * Postgres already makes a single UPDATE atomic, matching every
 * guardReconciled-style check this codebase already relies on:
 *
 *   const { transaction } = require('../lib/db');
 *   await transaction((txSql) => [
 *     txSql`INSERT INTO experience_bookings (...) VALUES (...)`,
 *     txSql`INSERT INTO booking_participants (...) VALUES (...)`,
 *   ]);
 *
 * No connection pooling code, no manual open/close -- the HTTP driver
 * makes one fetch() per query (or one fetch() for a whole transaction()
 * batch), matching this codebase's existing "no build step, plain
 * fetch()-first" convention (see api/kit-subscribe.js's own header
 * comment for the same philosophy applied to the Kit API).
 */

'use strict';

const { neon } = require('@neondatabase/serverless');

let _client = null;

function client() {
  if (!_client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not configured');
    }
    _client = neon(url);
  }
  return _client;
}

// Tagged-template query: sql`SELECT * FROM people WHERE email = ${email}`
function sql(strings, ...values) {
  return client()(strings, ...values);
}

// Parameterized dynamic query: query('SELECT * FROM x WHERE y = $1', [val])
function query(text, params) {
  return client().query(text, params || []);
}

// Atomic multi-statement transaction. Pass either an array of
// already-built (unexecuted) query promises, or a function that receives
// a transaction-scoped sql/query pair and returns such an array -- see
// the @neondatabase/serverless README for the underlying contract this
// wraps. Prefer the function form so query-building can use the
// transaction-scoped tagged template consistently.
function transaction(queriesOrFn) {
  return client().transaction(queriesOrFn);
}

module.exports = { sql, query, transaction };
