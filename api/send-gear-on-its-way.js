/**
 * api/send-gear-on-its-way.js
 *
 * NEW (Airey's direct request, 2026-09-10): wires up the previously
 * unwired lib/email-templates/gear-on-its-way-email.js. Confirmed by grep
 * across api/ and apps-script/ before building this — the template
 * existed, psac-copy-drafts.md section 8 documented its copy, but nothing
 * in this repo ever called it. Distinct from the already-live
 * gear-out-for-delivery-email.js (a staff/Uber-Direct-triggered, precise
 * arrival-time notification, sent from api/send-gear-out-for-delivery.js)
 * — this is the broad T-1-evening heads-up with trail reference, no fixed
 * delivery instant, that fires the evening BEFORE gear actually goes out
 * the door. No Uber Direct API integration exists in this repo (grepped
 * for it — only comments describing a future manual staff/Uber trigger
 * point), so nothing else is quietly sending this.
 *
 * Vercel Cron, 6pm Pacific, T-1 dispatch day. For every active booking
 * whose trip date is tomorrow AND has cleared T-3 (t3_cutoff_processed_at
 * IS NOT NULL — same "gear really is going out tonight" gate as
 * api/send-deposit-hold-heads-up.js uses for its own 8am heads-up, see
 * that file's header comment for the full reasoning). A booking that
 * survived T-3 is guaranteed to have a delivery address, a completed
 * waiver set, and a trail assignment (api/process-t3-cutoff.js's own
 * three cancellation gates: no_1.2a / zero_waivers / no_address), so this
 * template's fields are never missing by the time this fires.
 *
 * UPDATED (Airey's direct request, 2026-09-10, same day): the email's
 * "Get Guide"/trail-details link now points at the Adventure Prep hub
 * (tokens.hubLink), not straight at trails.ridewithgps_link. The hub is
 * the one central place a guest gets to RideWithGPS from — see
 * lib/email-templates/gear-on-its-way-email.js's own header comment, and
 * the ridewithgpsLink fix in lib/adventure-prep-service.js /
 * lib/waiver-service.js (the hub's own Get Guide button used to always
 * fall back to the generic ridewithgps.com homepage; now fixed to use the
 * trail's real curated link). trails.ridewithgps_link is no longer
 * queried directly here as a result.
 *
 * Handoff note (property-type-specific "we'll leave it ___") built by
 * lib/delivery-handoff-note.js, shared with api/send-trail-day-message.js
 * so the two crons can't drift on the wording.
 *
 * Dedup: experience_bookings.gear_on_its_way_sent_at (new column, see
 * db/2026-09-10_add_gear_on_its_way_and_trail_day_dedup.sql) — same
 * plain-nullable-timestamp idempotency pattern as every other cadence
 * marker in this schema. This cron fires on a repeating 15-minute window,
 * not a single fixed instant, so without this dedup a slow first tick or
 * an all-evening-lingering booking would get re-emailed on every
 * subsequent tick. Covers the booker's own send AND every signer send
 * below as one booking-level marker — a booking's whole message fan-out
 * (booker + signers) either all goes out on this tick or, on a retried
 * tick, none of it re-goes-out.
 *
 * NEW (Airey's direct request, 2026-09-10, same day): now also sends
 * every attending Surface B signer (waiverService.getAttendingSignersForBooking
 * — role='non_owner', status='signed', i.e. confirmed to actually be on
 * this trip) their own gear-on-its-way email, closing the gap flagged in
 * this repo's 2026-09-10 SMS-support build handoff ("today only the
 * booker gets proactively messaged"). Deliberately simplified for a
 * signer: deliveryLocation reads "[Owner]'s place" rather than the
 * booker's literal street address (not the signer's own delivery, and
 * the specific address isn't necessarily this signer's business), and
 * handoffNote is omitted — the property-type handoff detail is about the
 * booker's own coordination with their property, not something a signer
 * needs. Signer's own hub link (`/sign-waiver?token=`) backs their Get
 * Guide link, same "hub is the central point" principle as the booker's
 * own email. Email only, matching the booker's own scope for this
 * touchpoint (no SMS for gear-on-its-way).
 */

'use strict';

const { query } = require('../lib/db');
const { sendEmail } = require('../lib/send-email');
const { renderGearOnItsWayEmail } = require('../lib/email-templates/gear-on-its-way-email');
const { buildHandoffNote } = require('../lib/delivery-handoff-note');
const waiverService = require('../lib/waiver-service');
const { getSiteUrl } = require('../lib/site-url');
const { pacificDateString, addDaysToDateString, pacificClockTimeReached } = require('../lib/cadence');

const ADVENTURE_PREP_BASE_URL = `${getSiteUrl()}/complete-adventure-prep`;
const SIGN_WAIVER_BASE_URL = `${getSiteUrl()}/sign-waiver`;
const LOGO_URL = process.env.BOOKING_CONFIRMATION_LOGO_URL || 'https://palmspringsadventureclub.com/images/psac-logo-email-header.png';

function checkCronAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + secret;
}

function bookerHubLinkFor(adventurePrepToken) {
  return `${ADVENTURE_PREP_BASE_URL}?token=${encodeURIComponent(adventurePrepToken || '')}`;
}

function signerHubLinkFor(signerToken) {
  return `${SIGN_WAIVER_BASE_URL}?token=${encodeURIComponent(signerToken || '')}`;
}

function formatDeliveryLocation(row) {
  if (!row.delivery_address_line1) return 'your delivery address';
  let loc = row.delivery_address_line1;
  if (row.delivery_address_line2) loc += ', ' + row.delivery_address_line2;
  if (row.delivery_city) loc += ', ' + row.delivery_city;
  return loc;
}

async function listBookingsDueForGearOnItsWay(tripDate) {
  const rows = await query(
    `SELECT eb.booking_id, eb.contact_email, eb.contact_name, eb.adventure_prep_token,
            ap.property_type, ap.delivery_note,
            ap.delivery_address_line1, ap.delivery_address_line2, ap.delivery_city,
            ap.delivery_window, ap.selected_trail_id,
            t.trail_name
     FROM experience_bookings eb
     LEFT JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
     LEFT JOIN trails t ON t.trail_id = ap.selected_trail_id
     WHERE eb.date = $1
       AND (eb.booking_status = 'active' OR eb.booking_status IS NULL)
       AND eb.t3_cutoff_processed_at IS NOT NULL
       AND eb.gear_on_its_way_sent_at IS NULL`,
    [tripDate]
  );
  return rows.map((r) => ({
    bookingId: r.booking_id,
    contactEmail: r.contact_email,
    contactName: r.contact_name,
    deliveryLocation: formatDeliveryLocation(r),
    deliveryWindow: r.delivery_window || 'this evening',
    handoffNote: buildHandoffNote(r.property_type, r.delivery_note),
    trailName: r.trail_name || 'your trail',
    hubLink: bookerHubLinkFor(r.adventure_prep_token),
  }));
}

async function markGearOnItsWaySent(bookingId) {
  await query(
    `UPDATE experience_bookings SET gear_on_its_way_sent_at = NOW() WHERE booking_id = $1`,
    [bookingId]
  );
}

async function sendSignerGearOnItsWayEmails(booking) {
  const signers = await waiverService.getAttendingSignersForBooking(booking.bookingId);
  const results = [];
  for (const signer of signers) {
    if (!signer.signerEmail) {
      results.push({ signatureId: signer.signatureId, outcome: 'no_signer_email' });
      continue;
    }
    try {
      const html = renderGearOnItsWayEmail({
        logoUrl: LOGO_URL,
        deliveryLocation: (booking.contactName || 'your host') + '’s place',
        deliveryWindow: booking.deliveryWindow,
        handoffNote: '',
        trailName: booking.trailName,
        hubLink: signerHubLinkFor(signer.signerToken),
      });
      await sendEmail({ to: signer.signerEmail, subject: 'Your gear is on its way', html });
      results.push({ signatureId: signer.signatureId, outcome: 'sent' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('send-gear-on-its-way: failed to send signer email', booking.bookingId, signer.signatureId, err);
      results.push({ signatureId: signer.signatureId, outcome: 'error', detail: err.message });
    }
  }
  return results;
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const now = new Date();
    if (!pacificClockTimeReached(18, 0, now)) {
      res.status(200).json({ ok: true, skipped: 'before_6pm_pacific' });
      return;
    }

    const tomorrow = addDaysToDateString(pacificDateString(now), 1);
    const due = await listBookingsDueForGearOnItsWay(tomorrow);

    const results = [];
    for (const b of due) {
      if (!b.contactEmail) {
        // eslint-disable-next-line no-console
        console.error('send-gear-on-its-way: no contactEmail on file, guest not notified', b.bookingId);
        try {
          await markGearOnItsWaySent(b.bookingId);
        } catch (err) {
          console.error('send-gear-on-its-way: failed to mark no-email booking sent', b.bookingId, err);
        }
        results.push({ bookingId: b.bookingId, outcome: 'no_contact_email' });
        continue;
      }

      try {
        const html = renderGearOnItsWayEmail({
          logoUrl: LOGO_URL,
          deliveryLocation: b.deliveryLocation,
          deliveryWindow: b.deliveryWindow,
          handoffNote: b.handoffNote,
          trailName: b.trailName,
          hubLink: b.hubLink,
        });
        await sendEmail({ to: b.contactEmail, subject: 'Your gear is on its way', html });

        const signerResults = await sendSignerGearOnItsWayEmails(b);

        await markGearOnItsWaySent(b.bookingId);
        results.push({ bookingId: b.bookingId, outcome: 'sent', signers: signerResults });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('send-gear-on-its-way: failed to send/mark', b.bookingId, err);
        results.push({ bookingId: b.bookingId, outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({ ok: true, tripDate: tomorrow, dueCount: due.length, results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('send-gear-on-its-way failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
