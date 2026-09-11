/**
 * api/send-trail-day-message.js
 *
 * NEW (Airey's direct request, 2026-09-10): wires up the previously
 * unwired lib/email-templates/trail-day-email.js, and sends the new T-0
 * "Heading Out" SMS prompt (lib/send-heading-out-prompt-sms.js) alongside
 * it. Confirmed by grep across api/ and apps-script/ before building this
 * — the email template existed, psac-copy-drafts.md section 9 documented
 * its copy, but nothing in this repo ever called it.
 *
 * Vercel Cron, 7am Pacific, trail day itself (T-0). For every active
 * booking whose trip date is today AND has cleared T-3
 * (t3_cutoff_processed_at IS NOT NULL — same gate as
 * api/send-gear-on-its-way.js and api/send-deposit-hold-heads-up.js use,
 * see the latter's header comment for the full reasoning). UPDATED
 * (Airey's direct request, 2026-09-10): moved from 6am to 7am Pacific —
 * 6am felt too early for guests to actually see it before heading out,
 * since most starts don't happen until after 8am despite the booking flow
 * only offering morning start windows (psac-copy-drafts.md section 13).
 * 7am still comfortably clears every offered start time.
 *
 * Both the email and SMS now carry a "Heading Out" prompt — tapping it (in
 * the email's CTA button, or the SMS's link) opens the existing Adventure
 * Prep hub, where the Heading Out button already renders once trail day
 * arrives and heading_out_at is unset (adventure-prep-form.js's
 * headingOutButtonHtml/trailDayBodyHtml, Phase 2.5 Trail Day, 2026-09-04).
 * No new hub work needed — this cron only needed to point at it.
 *
 * SMS is narrower than email on purpose: only the Heading Out prompt gets
 * an SMS variant (lib/send-heading-out-prompt-sms.js), not the full
 * trail-day message — trail-day itself stays email-only, per the Sept
 * 2026 SMS build's "hard deadlines only" scope call (psac-copy-drafts.md
 * section 14). Gated on booking.smsConsent/booking.contactPhone, same
 * convention as every other SMS touchpoint in this repo.
 *
 * UPDATED (Airey's direct request, 2026-09-10, same day): the email's
 * "Get Guide"/trail-details link now points at the hub (tokens.hubLink),
 * not straight at trails.ridewithgps_link — see
 * lib/email-templates/trail-day-email.js's own header comment, and the
 * ridewithgpsLink fix in lib/adventure-prep-service.js/lib/waiver-
 * service.js (the hub's own Get Guide button used to always fall back to
 * the generic ridewithgps.com homepage; now fixed). trails.ridewithgps_link
 * is no longer queried directly here as a result. Still uses
 * lib/delivery-handoff-note.js's buildPickupArrangement for the "Leave the
 * duffel ___" phrase, shared with api/send-gear-on-its-way.js so the two
 * can't drift.
 *
 * Dedup: experience_bookings.trail_day_message_sent_at (new column, see
 * db/2026-09-10_add_gear_on_its_way_and_trail_day_dedup.sql) — covers the
 * booker's own email+SMS AND every signer send below as one booking-level
 * marker, same as every other cadence marker in this schema.
 *
 * NEW (Airey's direct request, 2026-09-10, same day): now also sends every
 * attending Surface B signer (waiverService.getAttendingSignersForBooking
 * — role='non_owner', status='signed') their own trail-day email plus
 * their own Heading Out SMS, closing the gap flagged in this repo's
 * 2026-09-10 SMS-support build handoff ("today only the booker gets
 * proactively messaged"). Signers share the exact same meet time,
 * trailhead, and trail tip as the booker (those are trip-level facts, not
 * booker-specific), and any participant tapping Heading Out already sets
 * the same booking-level heading_out_at either surface reads — so a
 * signer's own prompt is just as valid a way to get that tapped. The
 * duffel-return paragraph in the shared template is left as-is even
 * though it's really the kit-owner's own logistics, not a signer's — a
 * deliberate simplification (same spirit as this session's earlier
 * guardian-agnostic signer-reminder call), not something this round
 * builds a signer-specific template variant to avoid. Each signer gets
 * their own hub link (`/sign-waiver?token=`) for both the inline Get
 * Guide link and their own Heading Out CTA/SMS.
 */

'use strict';

const { query } = require('../lib/db');
const { sendEmail } = require('../lib/send-email');
const { renderTrailDayEmail } = require('../lib/email-templates/trail-day-email');
const { sendHeadingOutPromptSms } = require('../lib/send-heading-out-prompt-sms');
const { buildPickupArrangement } = require('../lib/delivery-handoff-note');
const waiverService = require('../lib/waiver-service');
const { getSiteUrl } = require('../lib/site-url');
const { pacificDateString, pacificClockTimeReached } = require('../lib/cadence');

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

// NEW (2026-09-10 email/SMS audit follow-up): the tribal entry-fee
// reminder fragment drafted in psac-copy-drafts.md section 12, never
// implemented here until now. Fails safe on purpose -- a trail with
// entry_fee_required = false, or a park value that doesn't match either
// mapped canyon (a future non-Agua-Caliente trail, or a data gap), gets
// no fragment at all rather than a wrong or generic one. Per that
// section's own closing note: "if the trail library later expands to
// include fee-free land ... all four fragments need a guard on whether
// the assigned trail actually requires a fee at all" -- entry_fee_required
// IS that guard, already a real column on trails.
function entryFeeFragmentFor(park, entryFeeRequired) {
  if (!entryFeeRequired) return '';
  if (park === 'Indian Canyons') {
    return 'Bring a card or cash for the \$12 tribal entry fee at the drive-up tollbooth, or skip the line with a ticket bought in advance. Arrive early, the canyon can reach capacity.';
  }
  if (park === 'Tahquitz Canyon') {
    return 'Bring a card or cash for the \$15 tribal entry fee at the walk-up tollbooth, or skip the line with a ticket bought in advance. Arrive early, the canyon can reach capacity.';
  }
  return '';
}

async function listBookingsDueForTrailDayMessage(tripDate) {
  const rows = await query(
    `SELECT eb.booking_id, eb.contact_email, eb.contact_name, eb.contact_phone, eb.sms_consent,
            eb.time_preference, eb.adventure_prep_token,
            ap.property_type, ap.delivery_note, ap.return_note, ap.selected_trail_id,
            t.trail_name, t.trailhead_name, t.trail_day_tip, t.park, t.entry_fee_required
     FROM experience_bookings eb
     LEFT JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
     LEFT JOIN trails t ON t.trail_id = ap.selected_trail_id
     WHERE eb.date = $1
       AND (eb.booking_status = 'active' OR eb.booking_status IS NULL)
       AND eb.t3_cutoff_processed_at IS NOT NULL
       AND eb.trail_day_message_sent_at IS NULL`,
    [tripDate]
  );
  return rows.map((r) => ({
    bookingId: r.booking_id,
    contactEmail: r.contact_email,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    smsConsent: r.sms_consent === true,
    trailheadLocation: r.trailhead_name || 'your trailhead',
    startTime: r.time_preference || 'the time you selected',
    tripTip: r.trail_day_tip || '',
    pickupArrangement: buildPickupArrangement(r.property_type, r.return_note || r.delivery_note),
    hubLink: bookerHubLinkFor(r.adventure_prep_token),
    entryFeeFragment: entryFeeFragmentFor(r.park, r.entry_fee_required),
  }));
}

async function markTrailDayMessageSent(bookingId) {
  await query(
    `UPDATE experience_bookings SET trail_day_message_sent_at = NOW() WHERE booking_id = $1`,
    [bookingId]
  );
}

async function sendSignerTrailDayMessages(booking) {
  const signers = await waiverService.getAttendingSignersForBooking(booking.bookingId);
  const results = [];
  for (const signer of signers) {
    const signerHubLink = signerHubLinkFor(signer.signerToken);
    let emailOutcome = 'no_signer_email';
    if (signer.signerEmail) {
      try {
        const html = renderTrailDayEmail({
          logoUrl: LOGO_URL,
          trailheadLocation: booking.trailheadLocation,
          startTime: booking.startTime,
          tripTip: booking.tripTip,
          pickupArrangement: booking.pickupArrangement,
          hubLink: signerHubLink,
          entryFeeFragment: booking.entryFeeFragment,
        });
        await sendEmail({ to: signer.signerEmail, subject: 'Today\'s the day', html });
        emailOutcome = 'sent';
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('send-trail-day-message: failed to send signer email', booking.bookingId, signer.signatureId, err);
        emailOutcome = 'error';
      }
    }

    const smsResult = await sendHeadingOutPromptSms({
      phone: signer.signerPhone,
      smsConsent: signer.smsConsent,
      trailheadLocation: booking.trailheadLocation,
      startTime: booking.startTime,
      hubLink: signerHubLink,
    });

    results.push({ signatureId: signer.signatureId, email: emailOutcome, sms: smsResult.status });
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
    if (!pacificClockTimeReached(7, 0, now)) {
      res.status(200).json({ ok: true, skipped: 'before_7am_pacific' });
      return;
    }

    const today = pacificDateString(now);
    const due = await listBookingsDueForTrailDayMessage(today);

    const results = [];
    for (const b of due) {
      if (!b.contactEmail) {
        // eslint-disable-next-line no-console
        console.error('send-trail-day-message: no contactEmail on file, guest not notified', b.bookingId);
        try {
          await markTrailDayMessageSent(b.bookingId);
        } catch (err) {
          console.error('send-trail-day-message: failed to mark no-email booking sent', b.bookingId, err);
        }
        results.push({ bookingId: b.bookingId, outcome: 'no_contact_email' });
        continue;
      }

      try {
        const html = renderTrailDayEmail({
          logoUrl: LOGO_URL,
          trailheadLocation: b.trailheadLocation,
          startTime: b.startTime,
          tripTip: b.tripTip,
          pickupArrangement: b.pickupArrangement,
          hubLink: b.hubLink,
          entryFeeFragment: b.entryFeeFragment,
        });
        await sendEmail({ to: b.contactEmail, subject: 'Today\'s the day', html });

        const smsResult = await sendHeadingOutPromptSms({
          phone: b.contactPhone,
          smsConsent: b.smsConsent,
          trailheadLocation: b.trailheadLocation,
          startTime: b.startTime,
          hubLink: b.hubLink,
        });

        const signerResults = await sendSignerTrailDayMessages(b);

        await markTrailDayMessageSent(b.bookingId);
        results.push({ bookingId: b.bookingId, outcome: 'sent', sms: smsResult.status, signers: signerResults });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('send-trail-day-message: failed to send/mark', b.bookingId, err);
        results.push({ bookingId: b.bookingId, outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({ ok: true, tripDate: today, dueCount: due.length, results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('send-trail-day-message failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
