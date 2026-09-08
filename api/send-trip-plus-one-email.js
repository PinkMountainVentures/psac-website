/**
 * api/send-trip-plus-one-email.js
 *
 * Post-Adventure Check-in "How was it?" T+1 email (2026-09-08). See
 * claude/psac-post-adventure-phase3-final-spec-2026-09-08.md, sections
 * 4/5/7, and lib/email-templates/trip-plus-one-email.js for the four
 * persona copy variants this sends. Sent trip date + 1, 9am Pacific --
 * the same instant adventure-prep-form.js's and waiver-signer-form.js's
 * own computeT1SendDate()/isPastT1SendTime() browser-side helpers use as
 * the boundary between The Turn and Check-in (see those files' own
 * header comments for why the T+1 send time is the sequencing boundary,
 * not a separate tracked moment).
 *
 * Vercel Cron, every 15 minutes, unrestricted -- same reasoning as
 * api/send-gear-out-for-delivery.js's own unrestricted schedule: the
 * per-row isPastT1SendTime() check below already gates correctly
 * regardless of when this fires, so a narrower cron window only adds
 * complexity for no benefit. Querying eb.date = yesterday (Pacific)
 * bounds every row to the one calendar day whose T+1 send instant could
 * possibly have arrived by "today"; the per-row time check (not just the
 * date match) is still what decides whether 9am Pacific has actually
 * passed yet.
 *
 * Two independent sends per booking, each with its own dedup column
 * (db/2026-09-08_add_trip_plus_one_email_dedup.sql):
 *   - ONE booker email (experience_bookings.trip_plus_one_booker_email_sent_at)
 *   - ONE email per eligible Surface B signer (waiver_signatures.
 *     trip_plus_one_email_sent_at) -- every signed signer with an email
 *     on file, participant/participant_guardian/guardian_only alike.
 *     An unsigned invite (status != 'signed') is skipped -- nothing to
 *     ask "how was it?" about for someone who never actually confirmed.
 */

'use strict';

const { sql, query } = require('../lib/db');
const { sendEmail } = require('../lib/send-email');
const { renderTripPlusOneEmail } = require('../lib/email-templates/trip-plus-one-email');
const { pacificDateString, addDaysToDateString } = require('../lib/cadence');
const { getSiteUrl } = require('../lib/site-url');

const SITE_URL = getSiteUrl();
const LOGO_URL = process.env.BOOKING_CONFIRMATION_LOGO_URL || 'https://palmspringsadventureclub.com/images/psac-logo-email-header.png';

function checkCronAuth(req) {
  // Same fail-closed-if-unset posture as every other cron endpoint.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + secret;
}

/**
 * Server-side twin of adventure-prep-form.js's/waiver-signer-form.js's
 * own browser-side computeT1SendDate/isPastT1SendTime -- see either
 * file's header comment for why this exists in three places (separate
 * client bundles, no shared import path -- same duplication convention
 * lib/t3-cutoff.js already documents for the T-3 cutoff). Kept in sync
 * manually; a real cross-surface time-math helper is a good candidate
 * for a future consolidation pass, not something to block this build on.
 */
function pacificOffsetMinutes(utcInstant) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(utcInstant).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (asIfUtc - utcInstant.getTime()) / 60000;
}

function computeT1SendUtc(tripDateStr) {
  const m = String(tripDateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const oneForward = new Date(Date.UTC(y, mo - 1, d) + 1 * 86400000);
  const cy = oneForward.getUTCFullYear(), cm = oneForward.getUTCMonth(), cd = oneForward.getUTCDate();
  const guess = new Date(Date.UTC(cy, cm, cd, 9, 0, 0) + 8 * 3600000);
  const offset = pacificOffsetMinutes(guess);
  return new Date(Date.UTC(cy, cm, cd, 9, 0, 0) - offset * 60000);
}

function isPastT1SendTime(tripDateStr, now) {
  const sendAt = computeT1SendUtc(tripDateStr);
  return !!sendAt && (now || new Date()).getTime() >= sendAt.getTime();
}

function joinWithAnd(items) {
  if (!items.length) return 'them';
  if (items.length === 1) return items[0];
  if (items.length === 2) return items[0] + ' and ' + items[1];
  return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
}

async function listBookersDueForT1(tripDate) {
  const rows = await sql`
    SELECT eb.booking_id, eb.contact_email, eb.contact_name, eb.date, eb.adventure_prep_token,
           t.trail_name
    FROM experience_bookings eb
    LEFT JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
    LEFT JOIN trails t ON t.trail_id = ap.selected_trail_id
    WHERE eb.date = ${tripDate}
      AND (eb.booking_status = 'active' OR eb.booking_status IS NULL)
      AND eb.trip_plus_one_booker_email_sent_at IS NULL
      AND eb.adventure_prep_token IS NOT NULL
  `;
  return rows;
}

async function markBookerSent(bookingId) {
  await sql`UPDATE experience_bookings SET trip_plus_one_booker_email_sent_at = NOW() WHERE booking_id = ${bookingId}`;
}

async function listSignersDueForT1(tripDate) {
  const rows = await sql`
    SELECT ws.signature_id, ws.signer_token, ws.signer_email, ws.signer_name, ws.is_guardian,
           ws.guardian_for_children_json, ws.participant_id,
           bp.role_on_booking,
           eb.booking_id, eb.contact_name, eb.date,
           t.trail_name
    FROM waiver_signatures ws
    JOIN experience_bookings eb ON eb.booking_id = ws.booking_id
    LEFT JOIN booking_participants bp ON bp.participant_id = ws.participant_id
    LEFT JOIN adventure_prep ap ON ap.booking_id = ws.booking_id
    LEFT JOIN trails t ON t.trail_id = ap.selected_trail_id
    WHERE eb.date = ${tripDate}
      AND (eb.booking_status = 'active' OR eb.booking_status IS NULL)
      AND ws.status = 'signed'
      AND ws.signer_email IS NOT NULL AND ws.signer_email != ''
      AND ws.trip_plus_one_email_sent_at IS NULL
  `;
  return rows;
}

async function markSignerSent(signatureId) {
  await sql`UPDATE waiver_signatures SET trip_plus_one_email_sent_at = NOW() WHERE signature_id = ${signatureId}`;
}

/**
 * A signer's own guardian_for_children_json is an array of
 * participant_ids -- resolved here to display names for the "How did
 * [child] do" copy. One lookup query per due-run (not per signer): small
 * volume, this cron isn't in a hot path.
 */
async function resolveChildNames(participantIds) {
  if (!participantIds.length) return {};
  const rows = await query(
    `SELECT participant_id, display_name FROM booking_participants WHERE participant_id = ANY($1)`,
    [participantIds]
  );
  const byId = {};
  rows.forEach((r) => { byId[r.participant_id] = r.display_name; });
  return byId;
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const now = new Date();
    const today = pacificDateString(now);
    const tripDate = addDaysToDateString(today, -1);

    const results = [];

    // -- Booker sends --------------------------------------------------
    const bookers = await listBookersDueForT1(tripDate);
    for (const b of bookers) {
      if (!isPastT1SendTime(b.date, now)) {
        results.push({ bookingId: b.booking_id, kind: 'booker', outcome: 'not_yet_within_window' });
        continue;
      }
      if (!b.contact_email) {
        results.push({ bookingId: b.booking_id, kind: 'booker', outcome: 'no_contact_email' });
        continue;
      }
      try {
        const ctaUrl = `${SITE_URL}/complete-adventure-prep?token=${encodeURIComponent(b.adventure_prep_token)}`;
        const html = renderTripPlusOneEmail({
          logoUrl: LOGO_URL,
          persona: 'booker',
          trailName: b.trail_name || 'your trail',
          ctaUrl,
        });
        await sendEmail({ to: b.contact_email, subject: `How was ${b.trail_name || 'your adventure'}?`, html });
        await markBookerSent(b.booking_id);
        results.push({ bookingId: b.booking_id, kind: 'booker', outcome: 'sent' });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('send-trip-plus-one-email: booker send failed', b.booking_id, err);
        results.push({ bookingId: b.booking_id, kind: 'booker', outcome: 'error', detail: err.message });
      }
    }

    // -- Signer sends ----------------------------------------------------
    const signers = await listSignersDueForT1(tripDate);
    const allChildIds = [];
    signers.forEach((s) => {
      (s.guardian_for_children_json || []).forEach((id) => { if (allChildIds.indexOf(id) === -1) allChildIds.push(id); });
    });
    const childNamesById = await resolveChildNames(allChildIds);

    for (const s of signers) {
      if (!isPastT1SendTime(s.date, now)) {
        results.push({ signatureId: s.signature_id, kind: 'signer', outcome: 'not_yet_within_window' });
        continue;
      }
      const isGuardianOnly = s.role_on_booking === 'guardian_only';
      const persona = isGuardianOnly ? 'guardian_only' : (s.is_guardian ? 'participant_guardian' : 'participant');
      const childNames = (s.guardian_for_children_json || []).map((id) => childNamesById[id]).filter(Boolean);
      const childLabel = joinWithAnd(childNames);
      try {
        const ctaUrl = `${SITE_URL}/sign-waiver?token=${encodeURIComponent(s.signer_token)}`;
        const html = renderTripPlusOneEmail({
          logoUrl: LOGO_URL,
          persona,
          trailName: s.trail_name || 'the trail',
          ownerName: s.contact_name,
          childLabel,
          ctaUrl,
        });
        const subject = persona === 'participant'
          ? `How was your day on ${s.trail_name || 'the trail'}?`
          : `How did ${childLabel} do on ${s.trail_name || 'the trail'}?`;
        await sendEmail({ to: s.signer_email, subject, html });
        await markSignerSent(s.signature_id);
        results.push({ signatureId: s.signature_id, kind: 'signer', persona, outcome: 'sent' });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('send-trip-plus-one-email: signer send failed', s.signature_id, err);
        results.push({ signatureId: s.signature_id, kind: 'signer', outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({ ok: true, tripDate, bookerCount: bookers.length, signerCount: signers.length, results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('send-trip-plus-one-email failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
