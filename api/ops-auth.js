/**
 * api/ops-auth.js
 *
 * Google Sign-In auth for the internal ops app (Operations UX PRD Section
 * 13: "Sign in with Google... checked server-side, on every request,
 * against an explicit allowlist... not merely any Workspace user, rejected
 * even if they successfully authenticate"). Consolidated action-dispatched
 * file (same Vercel-function-cap consolidation pattern as api/adventure-
 * prep.js), handling all three auth steps: 'login', 'logout', 'check'.
 *
 * ============================================================================
 * SETUP AIREY STILL NEEDS TO DO — THIS SESSION CANNOT DO THIS PART
 * ============================================================================
 * This code is real and complete, but Google Sign-In needs an actual OAuth
 * 2.0 Client ID, which only exists inside Airey's own Google Cloud Console
 * project — this session has no access to create one on his behalf:
 *
 *   1. console.cloud.google.com -> APIs & Services -> Credentials ->
 *      Create Credentials -> OAuth client ID -> Web application.
 *   2. Authorized JavaScript origin: https://www.palmspringsadventureclub.com
 *      (or wherever the ops app actually ends up hosted, if different).
 *   3. Copy the resulting Client ID into TWO places: the
 *      GOOGLE_OAUTH_CLIENT_ID env var (checked below as the token's
 *      audience) and the data-client_id attribute in ops-login.html's
 *      Google Sign-In button markup.
 *   4. Set ALLOWED_STAFF_EMAILS (comma-separated, e.g.
 *      "airey@palmspringsadventureclub.com,heather@palmspringsadventureclub.com").
 *   5. Set a new OPS_SESSION_SECRET (any long random string, unique to this
 *      purpose) — see lib/ops-session.js.
 *
 * Until those are in place, every login attempt fails CLOSED (500
 * not_configured, or 403 not_allowlisted with an empty allowlist), never
 * open — there's no path where a missing env var accidentally lets someone
 * in.
 */

'use strict';

// BUG FIX (payment-review, Aug 2026, Medium #47): allowedEmails() moved to
// lib/ops-session.js, which now also re-checks it on every request (not
// just at login) — imported from there instead of duplicated here, so the
// two call sites can't drift apart.
const { issueSessionCookie, clearSessionCookie, requireStaffSession, allowedEmails } = require('../lib/ops-session');

async function handleLogin(req, res) {
  const { idToken } = req.body || {};
  if (!idToken) {
    res.status(400).json({ error: 'bad_request', detail: 'idToken is required' });
    return;
  }
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
    res.status(500).json({ error: 'not_configured', detail: 'GOOGLE_OAUTH_CLIENT_ID is not set' });
    return;
  }

  // Verified via Google's own tokeninfo endpoint — no google-auth-library
  // dependency, matching this project's "no SDK, fetch directly" convention.
  const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const info = await verifyRes.json();

  if (!verifyRes.ok || info.error) {
    res.status(401).json({ error: 'invalid_token', detail: info.error || info.error_description });
    return;
  }
  if (info.aud !== process.env.GOOGLE_OAUTH_CLIENT_ID) {
    res.status(401).json({ error: 'invalid_token', detail: 'audience mismatch' });
    return;
  }
  if (info.email_verified !== 'true' && info.email_verified !== true) {
    res.status(401).json({ error: 'email_not_verified' });
    return;
  }

  const email = String(info.email || '').toLowerCase();
  if (allowedEmails().indexOf(email) === -1) {
    res.status(403).json({ error: 'not_allowlisted', detail: 'This Google account is not authorized for the ops app.' });
    return;
  }

  res.setHeader('Set-Cookie', issueSessionCookie(email));
  res.status(200).json({ ok: true, email });
}

async function handleLogout(req, res) {
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.status(200).json({ ok: true });
}

async function handleCheck(req, res) {
  const session = requireStaffSession(req);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.status(200).json({ ok: true, email: session.email });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const body = req.body || {};
    const action = body.action || 'check';

    if (action === 'login') { await handleLogin(req, res); return; }
    if (action === 'logout') { await handleLogout(req, res); return; }
    if (action === 'check') { await handleCheck(req, res); return; }

    res.status(400).json({ error: 'unknown_action', detail: action });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('ops-auth failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
