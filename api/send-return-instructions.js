/**
 * api/send-return-instructions.js
 *
 * NEW (2026-09-11 email/SMS audit follow-up): wires up the previously
 * unwired lib/email-templates/return-instructions-email.js -- zero live
 * callers before this (confirmed by grep across api/ and apps-script/,
 * same check this session already ran for gear-on-its-way and trail-day
 * before those got wired on 2026-09-10). See
 * claude/psac-email-sms-sinek-godin-miller-audit-2026-09-10.md,
 * "What this leaves for engineering, not copy" -- the copy itself needed
 * no changes, only wiring.
 *
 * *** NOT YET REGISTERED IN vercel.json -- DO NOT deploy this as a live
 * *** cron without Airey's confirmation. Written and ready, but the exact
 * *** send instant is a real product decision, not something to default
 * *** silently (this codebase's standing convention -- same reason DB
 * *** migrations in this repo are written but run by Airey, not the
 * *** agent). See the trigger-timing note below for the specific
 * *** question this needs answered.
 *
 * TRIGGER TIMING -- what changed since the template's old header comment:
 * return-instructions-email.js used to speculate "trail start time + 2
 * hours, tentative default; open to a duration-aware refinement against
 * q6_duration". That refinement already exists and is better than
 * q6_duration would have been: adventure_prep.expected_return_at, added
 * by the Heading Out feature (2026-09-08,
 * lib/adventure-prep-service.js's confirmHeadingOutByBookingId). It is
 * computed from the guest's ACTUAL Heading Out check-in time plus the
 * assigned trail's own est_time_easy_pace, not a pre-trip guess bucket --
 * so it tightens automatically for a trail that runs long or short, and
 * it doesn't exist at all until the guest has actually checked in.
 *
 * This handler polls for bookings where:
 *   - heading_out_at IS NOT NULL (guest actually started their trail --
 *     sending return instructions to someone who never checked in would
 *     be confusing, and we have no other reliable "they're out there" signal)
 *   - expected_return_at IS NOT NULL (the trail had a known easy-pace
 *     estimate; fails safe otherwise -- no send rather than a guessed one)
 *   - expected_return_at + RETURN_INSTRUCTIONS_BUFFER_MINUTES <= NOW()
 *     (a grace window past the estimate, so this doesn't land while the
 *     group is plausibly still out -- 20 minutes is this file's own
 *     placeholder default, not a copy-locked or Airey-confirmed number)
 *   - return_instructions_sent_at IS NULL (dedup, same pattern as every
 *     other cadence marker in this schema)
 * Runs on a short repeating tick (suggested: every 15 minutes, same
 * cadence as send-trail-day-message.js) rather than one fixed Pacific
 * clock time, since expected_return_at is a real per-booking timestamp,
 * not a shared daily instant.
 *
 * Pickup phrasing: reuses lib/delivery-handoff-note.js's
 * buildPickupArrangement(property_type, return_note || delivery_note),
 * the exact same helper and precedence api/send-trail-day-message.js
 * already uses -- see return-instructions-email.js's own updated header
 * comment for why its old internal propertyType map was retired in favor
 * of this.
 *
 * Sends to the booker and to every attending signer
 * (waiverService.getAttendingSignersForBooking), same booker+signer
 * parity api/send-trail-day-message.js already established -- deliberate
 * simplification, not a new call: the duffel-return paragraph is really
 * the kit-owner's own logistics, but a signer as likely as the booker to
 * be the one physically holding the duffel at day's end.
 */

'use strict';

const { query } = require('../lib/db');
const { sendEmail } = require('../lib/send-email');
const { renderReturnInstructionsEmail } = require('../lib/email-templates/return-instructions-email');
const { buildPickupArrangement } = require('../lib/delivery-handoff-note');
const waiverService = require('../lib/waiver-service');

const LOGO_URL = process.env.BOOKING_CONFIRMATION_LOGO_URL || 'https://palmspringsadventureclub.com/images/psac-logo-email-header.png';

// Placeholder default -- flagged above as needing Airey's confirmation,
// not copy-locked or previously discussed anywhere in this project's docs.
const RETURN_INSTRUCTIONS_BUFFER_MINUTES = 20;

function checkCronAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + secret;
}

async function listBookingsDueForReturnInstructions() {
  const rows = await query(
    `SELECT eb.booking_id, eb.contact_email, eb.contact_name,
            ap.property_type, ap.delivery_note, ap.return_note
     FROM experience_bookings eb
     JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
     WHERE (eb.booking_status = 'active' OR eb.booking_status IS NULL)
       AND ap.heading_out_at IS NOT NULL
       AND ap.expected_return_at IS NOT NULL
       AND ap.expected_return_at + (${RETURN_INSTRUCTIONS_BUFFER_MINUTES} * interval '1 minute') <= NOW()
       AND eb.return_instructions_sent_at IS NULL`
  );
  return rows.map((r) => ({
    bookingId: r.booking_id,
    contactEmail: r.contact_email,
    contactName: r.contact_name,
    pickupArrangement: buildPickupArrangement(r.property_type, r.return_note || r.delivery_note),
  }));
}

async function markReturnInstructionsSent(bookingId) {
  await query(
    `UPDATE experience_bookings SET return_instructions_sent_at = NOW() WHERE booking_id = $1`,
    [bookingId]
  );
}

async function sendSignerReturnInstructions(booking) {
  const signers = await waiverService.getAttendingSignersForBooking(booking.bookingId);
  const results = [];
  for (const signer of signers) {
    let emailOutcome = 'no_signer_email';
    if (signer.signerEmail) {
      try {
        const html = renderReturnInstructionsEmail({
          logoUrl: LOGO_URL,
          pickupArrangement: booking.pickupArrangement,
        });
        await sendEmail({ to: signer.signerEmail, subject: 'Almost done, one last step', html });
        emailOutcome = 'sent';
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('send-return-instructions: failed to send signer email', booking.bookingId, signer.signatureId, err);
        emailOutcome = 'error';
      }
    }
    results.push({ signatureId: signer.signatureId, email: emailOutcome });
  }
  return results;
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const due = await listBookingsDueForReturnInstructions();

    const results = [];
    for (const b of due) {
      if (!b.contactEmail) {
        // eslint-disable-next-line no-console
        console.error('send-return-instructions: no contactEmail on file, guest not notified', b.bookingId);
        try {
          await markReturnInstructionsSent(b.bookingId);
        } catch (err) {
          console.error('send-return-instructions: failed to mark no-email booking sent', b.bookingId, err);
        }
        results.push({ bookingId: b.bookingId, outcome: 'no_contact_email' });
        continue;
      }

      try {
        const html = renderReturnInstructionsEmail({
          logoUrl: LOGO_URL,
          pickupArrangement: b.pickupArrangement,
        });
        await sendEmail({ to: b.contactEmail, subject: 'Almost done, one last step', html });

        const signerResults = await sendSignerReturnInstructions(b);

        await markReturnInstructionsSent(b.bookingId);
        results.push({ bookingId: b.bookingId, outcome: 'sent', signers: signerResults });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('send-return-instructions: failed to send/mark', b.bookingId, err);
        results.push({ bookingId: b.bookingId, outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({ ok: true, dueCount: due.length, results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('send-return-instructions failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
