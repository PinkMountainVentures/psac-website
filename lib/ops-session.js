/**
 * lib/ops-session.js
 *
 * Signed session cookie for the internal ops app's Google Sign-In gate
 * (Operations UX PRD Section 13). No JWT library dependency — a plain
 * HMAC-SHA256 signature over a base64url JSON payload, matching this
 * project's "no SDK, use Node/fetch directly" convention (same posture as
 * the Stripe integration). Requires a new env var, OPS_SESSION_SECRET (any
 * long random string, never reused from another secret in this project).
 *
 * This is intentionally NOT a general-purpose auth library — it only ever
 * needs to answer one question, "is this request from an allowlisted staff
 * email, recently enough," for the ops app's own endpoints. See
 * api/ops-auth.js for the login/logout/check actions that issue and clear
 * this cookie, and api/ops-proxy.js for the one place it's actually checked
 * before any staff-facing action runs.
 */

'use strict';

const crypto = require('crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — a staff work shift, not a "stay signed in forever" cookie
const COOKIE_NAME = 'psac_ops_session';

function secret() {
  const s = process.env.OPS_SESSION_SECRET;
  if (!s) throw new Error('OPS_SESSION_SECRET is not configured');
  return s;
}

function sign(payloadStr) {
  return crypto.createHmac('sha256', secret()).update(payloadStr).digest('hex');
}

function issueSessionCookie(email) {
  const payload = JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = sign(encoded);
  const value = `${encoded}.${sig}`;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function parseCookies(req) {
  const header = (req.headers && req.headers.cookie) || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

/**
 * Returns { email } if the request carries a valid, unexpired, untampered
 * session cookie; null otherwise. Never throws — a malformed or missing
 * cookie is just "not signed in," not an error.
 */
function requireStaffSession(req) {
  try {
    const cookies = parseCookies(req);
    const raw = cookies[COOKIE_NAME];
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 2) return null;
    const [encoded, sig] = parts;
    // BUG FIX (independent bug pass, Aug 2026): a plain `!==` string
    // comparison on an HMAC signature short-circuits at the first
    // differing character, so how long the request takes to reject
    // leaks information about how many leading hex characters of the
    // guess were correct — a timing side-channel an attacker could use to
    // brute-force a valid signature byte-by-byte without ever knowing
    // OPS_SESSION_SECRET. crypto.timingSafeEqual compares in constant
    // time. It throws on a length mismatch rather than returning false,
    // so the lengths are checked first (a length mismatch is itself a
    // legitimate "not equal," not a case requiring the constant-time
    // path — the attacker learns nothing they didn't already know, since
    // valid signatures are always the same fixed length).
    const expected = sign(encoded);
    const sigBuf = Buffer.from(sig, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null; // tampered or signed with a stale secret
    }
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null; // expired
    if (!payload.email) return null;
    return { email: payload.email };
  } catch (e) {
    return null;
  }
}

module.exports = { issueSessionCookie, clearSessionCookie, requireStaffSession, COOKIE_NAME };
