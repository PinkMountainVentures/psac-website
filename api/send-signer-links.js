/**
 * api/send-signer-links.js
 *
 * Surface A step 10's "Confirm & Send" action. Writes one Waiver
 * Signatures row per required non-owner signer (idempotent — re-running
 * this for a signer who was already sent a link updates that same row,
 * never duplicates it) via adventurePrep_sendSignerLinks, then emails each
 * one their own tokenized Surface B link. Apps Script never sends email
 * itself, same convention as every other touchpoint in this repo
 * (save-booking.js, create-deposit-hold.js) — this file is the one place
 * that boundary is crossed for Adventure Prep's signer links.
 *
 * Request:  POST /api/send-signer-links
 *           { token: string, signers: Array<{ rosterRef, name, email }> }
 *
 *   `token` is the booking owner's own adventurePrepToken. `signers` is
 *   the confirmed list Surface A's step 10 review screen showed before
 *   the guest tapped confirm — never re-derived from the roster here, so
 *   what actually gets emailed always matches what the guest reviewed.
 *
 * Response:
 *   200 { status: 'sent', signers: [{ rosterRef, name, email, emailStatus }] }
 *   400 { error: 'missing_token' | 'missing_signers' }
 *   404 { error: 'invalid_token' }
 *   500 { error: 'engineering_error', detail }
 *
 * FLAGGED FOR AIREY: Surface B's URL path (`/sign-waiver`, below) isn't
 * decided anywhere in the Adventure Prep PRD — Section 11 only says the
 * signer links "will also need to be tokenized," not what path they live
 * at. This chat picked `/sign-waiver?token=...` as a reasonable sibling to
 * `/complete-adventure-prep?token=...`, but this is a real open decision,
 * not a locked one — confirm or redirect before this ships. Whatever path
 * is chosen also needs a static HTML file at that route (see Surface B's
 * frontend, sign-waiver.html, built in this same chat) actually deployed.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');
const { sendEmail } = require('../lib/send-email');
const { renderSignerWaiverInviteEmail } = require('../lib/email-templates/signer-waiver-invite-email');

const SITE_URL = 'https://www.palmspringsadventureclub.com';

function formatTripDate(dateStr) {
  if (!dateStr) return 'your upcoming trip';
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  var body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  body = body || {};

  const token = body.token;
  const signers = Array.isArray(body.signers) ? body.signers : null;

  if (!token) {
    res.status(400).json({ error: 'missing_token' });
    return;
  }
  if (!signers || !signers.length) {
    res.status(400).json({ error: 'missing_signers' });
    return;
  }

  try {
    const result = await callBookingsWebApp('adventurePrep_sendSignerLinks', { token, signers });
    if (!result || result.ok === false) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }

    const tripDateDisplay = formatTripDate(result.tripDate);
    const logoUrl = process.env.BOOKING_CONFIRMATION_LOGO_URL || '';

    const emailed = await Promise.all(
      (result.signers || []).map(async (signer) => {
        if (!signer.email) {
          return { ...signer, emailStatus: 'skipped_no_email' };
        }
        const signerUrl = `${SITE_URL}/sign-waiver?token=${encodeURIComponent(signer.signerToken)}`;
        const html = renderSignerWaiverInviteEmail({
          logoUrl,
          signerName: signer.name,
          ownerName: result.ownerName,
          tripDateDisplay,
          signerUrl,
        });
        const sendResult = await sendEmail({
          to: signer.email,
          subject: `${result.ownerName || 'Someone'} added you to an adventure — quick waiver needed`,
          html,
        });
        return { ...signer, emailStatus: sendResult.status };
      })
    );

    res.status(200).json({ status: 'sent', signers: emailed });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('send-signer-links failed', token, err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
