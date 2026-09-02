/**
 * api/send-help-message.js
 *
 * Backs the "Questions? Ask us anything" panel on both Adventure Prep
 * surfaces (complete-adventure-prep.html's #ap-help-panel and
 * sign-waiver.html's identical markup — see ap-styles.css's .help-panel
 * rules, and the panel's own inline script for the click handler this
 * responds to). Replaces the provisional mailto: fallback shipped
 * 2026-09-02, per Airey: "i do want to actually use resend to send the
 * email. ideally, the interaction moves to email at that point and the
 * user's email address is either used as the 'from' address or is
 * included in the email body so the interaction can begin from there."
 *
 * Implementation of that ask: Resend requires `from` to be on a verified
 * sending domain (mail.palmspringsadventureclub.com here — see
 * lib/send-email.js's header comment), so a guest's own address can't
 * literally BE the from address. This sends to the reservations@ inbox
 * with the guest's address as `reply_to` instead — the standard way to
 * get the same result Airey described: a staffer opens the notification
 * in their inbox and hitting Reply goes straight to the guest, no separate
 * system, no copy/paste. The guest's address is also included in the
 * email body itself (detail row), matching the "or is included in the
 * email body" half of the request as a visible backup even if reply-to
 * handling ever behaves oddly in someone's mail client.
 *
 * One endpoint serves both surfaces without a surface flag from the
 * client: it just tries the token against both places a token can mean
 * something (Adventure Prep hub's adventure_prep_token, or a waiver
 * signer's own signer_token) and uses whichever resolves. A signer's own
 * name/email (when present) is preferred over the booking owner's, since
 * the signer asking the question may be a different person entirely (a
 * non-attending guardian, PRD Section 6) — reply-to should reach the
 * actual person who typed the message.
 *
 * Request shape: POST /api/send-help-message { token, message }
 */

'use strict';

const { sql } = require('../lib/db');
const { sendEmail } = require('../lib/send-email');
const { renderAdventurePrepQuestionEmail } = require('../lib/email-templates/adventure-prep-question-email');

const STAFF_INBOX = 'reservations@palmspringsadventureclub.com';
const MAX_MESSAGE_LENGTH = 4000;

function parseBody(req) {
  var body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  return body || {};
}

function formatTripDate(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

// Tries the Adventure Prep hub's own token first (the more common path —
// most "Send" clicks will come from the booking owner on Surface A), then
// falls back to a waiver signer token (Surface B, a non-owner signer who
// may not be the booking's contact_email at all).
async function resolveContext(token) {
  const apRows = await sql`
    SELECT booking_id, contact_name, contact_email, date
    FROM experience_bookings
    WHERE adventure_prep_token = ${token}
  `;
  if (apRows.length) {
    const b = apRows[0];
    return {
      bookingId: b.booking_id,
      guestName: b.contact_name,
      guestEmail: b.contact_email,
      tripDate: b.date,
      sourcePage: 'Adventure Prep hub',
    };
  }

  const signerRows = await sql`
    SELECT ws.signer_name, ws.signer_email, eb.booking_id, eb.contact_name, eb.contact_email, eb.date
    FROM waiver_signatures ws
    JOIN experience_bookings eb ON eb.booking_id = ws.booking_id
    WHERE ws.signer_token = ${token}
  `;
  if (signerRows.length) {
    const r = signerRows[0];
    return {
      bookingId: r.booking_id,
      guestName: r.signer_name || r.contact_name,
      guestEmail: r.signer_email || r.contact_email,
      tripDate: r.date,
      sourcePage: 'Waiver signer page',
    };
  }

  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  try {
    const body = parseBody(req);
    const token = body.token;
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!token) {
      res.status(400).json({ error: 'missing_token' });
      return;
    }
    if (!message) {
      res.status(400).json({ error: 'missing_message' });
      return;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: 'message_too_long' });
      return;
    }

    const ctx = await resolveContext(token);
    if (!ctx) {
      res.status(404).json({ error: 'invalid_token' });
      return;
    }

    const html = renderAdventurePrepQuestionEmail({
      logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
      guestName: ctx.guestName,
      guestEmail: ctx.guestEmail,
      bookingId: ctx.bookingId,
      tripDateDisplay: formatTripDate(ctx.tripDate),
      sourcePage: ctx.sourcePage,
      message: message,
    });

    const sendResult = await sendEmail({
      to: STAFF_INBOX,
      replyTo: ctx.guestEmail || undefined,
      subject: 'Question from ' + (ctx.guestName || 'a guest') + ' — ' + ctx.bookingId,
      html: html,
    });

    if (sendResult.status !== 'sent') {
      res.status(502).json({ error: 'send_failed', detail: sendResult.error || sendResult.reason });
      return;
    }

    res.status(200).json({ status: 'sent' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('send-help-message failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
