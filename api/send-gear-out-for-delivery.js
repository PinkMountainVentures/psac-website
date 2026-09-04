/**
 * api/send-gear-out-for-delivery.js
 *
 * NEW (Airey's direct request, 2026-09-05): "add trigger emails for
 * 'gear out for delivery' and 'gear delivered'... triggered by the same
 * status logic used for the gear delivery card." This is the Out for
 * Delivery half -- the one TIME-triggered state in that card's own
 * four-state machine (Packing/Packed/Out for Delivery/Delivered; see
 * adventure-prep-form.js's computeGearDeliveryStatus() for the
 * authoritative logic this mirrors server-side). Delivered doesn't need
 * a cron -- it's a real staff/Uber action with a clear hook point (see
 * api/checkout-gear.js's markDeliveredFinal branch instead). Out for
 * Delivery has no such hook: nobody clicks a button at "1 hour before
 * the slot," so this has to poll.
 *
 * Vercel Cron, every 15 minutes, unrestricted (unlike
 * send-deposit-hold-heads-up.js's narrow morning window -- delivery
 * slots span 3pm-9pm Pacific, and the per-row time check below already
 * gates correctly regardless of when this fires, so a narrower cron
 * window would only add complexity for no benefit, same reasoning as
 * api/process-t3-cutoff.js's own unrestricted every-15-minute schedule).
 *
 * Query: active bookings whose trip date is tomorrow (i.e. delivery
 * night is tonight), still short of Delivered, with a real staff-picked
 * time slot on file. deliverySlotInstantUtc() (lib/cadence.js) turns
 * that slot label into a real Pacific-time instant on tonight's date;
 * this endpoint fires once now is within 1 hour of it -- matching the
 * card's own "no slot yet? stays at Packed" rule (Airey's explicit
 * call): a booking with delivery_time_slot still blank never matches
 * the WHERE clause at all, so it's correctly skipped every tick until
 * staff actually pick one.
 *
 * Dedup: experience_bookings.gear_out_for_delivery_sent_at (new column,
 * db/2026-09-05_add_gear_delivery_email_dedup.sql) -- same plain-
 * nullable-timestamp idempotency pattern as deposit_heads_up_sent_at.
 *
 * Booker-only, per Airey's direct instruction -- same as the card
 * itself (contact_email/contact_name on experience_bookings, the
 * booking owner, never a Surface B signer's own email).
 */

'use strict';

const { query } = require('../lib/db');
const { sendEmail } = require('../lib/send-email');
const { renderGearOutForDeliveryEmail } = require('../lib/email-templates/gear-out-for-delivery-email');
const { pacificDateString, addDaysToDateString, deliverySlotInstantUtc } = require('../lib/cadence');

function checkCronAuth(req) {
  // Same fail-closed-if-unset posture as every other cron endpoint.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + secret;
}

/**
 * Every active booking whose trip date is `tripDate` (so delivery night
 * is TODAY), with a real time slot on file, not yet delivered, not yet
 * emailed for this state. gearKitCount prefers adventure_prep.
 * confirmed_kit_count over the booking-time gear_kit_count, same
 * precedence lib/booking-service.js's getBooking and
 * send-deposit-hold-heads-up.js's own listBookingsDueForHeadsUp use.
 */
async function listBookingsDueForOutForDelivery(tripDate) {
  const rows = await query(
    `SELECT eb.booking_id, eb.contact_email, eb.contact_name, eb.date,
            eb.delivery_time_slot, eb.gear_kit_count,
            ap.confirmed_kit_count, ap.delivery_address_line1, ap.delivery_address_line2,
            ap.delivery_city, ap.delivery_state, ap.delivery_zip
     FROM experience_bookings eb
     LEFT JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
     WHERE eb.date = $1
       AND (eb.booking_status = 'active' OR eb.booking_status IS NULL)
       AND eb.delivery_status IN ('ready_for_delivery', 'delivery_scheduled')
       AND eb.delivery_time_slot IS NOT NULL AND eb.delivery_time_slot != ''
       AND eb.gear_delivered_at IS NULL
       AND eb.gear_out_for_delivery_sent_at IS NULL`,
    [tripDate]
  );
  return rows.map((r) => {
    const hasConfirmedCount = r.confirmed_kit_count !== null && r.confirmed_kit_count !== undefined;
    const addressLine1 = [r.delivery_address_line1, r.delivery_address_line2].filter(Boolean).join(', ');
    const addressLine2 = [r.delivery_city, r.delivery_state].filter(Boolean).join(', ') + (r.delivery_zip ? ' ' + r.delivery_zip : '');
    return {
      bookingId: r.booking_id,
      contactEmail: r.contact_email,
      contactName: r.contact_name,
      tripDate: r.date,
      deliveryTimeSlot: r.delivery_time_slot,
      kitCount: hasConfirmedCount ? r.confirmed_kit_count : r.gear_kit_count,
      address: [addressLine1, addressLine2].filter(Boolean).join(', '),
    };
  });
}

async function markOutForDeliverySent(bookingId) {
  await query(
    `UPDATE experience_bookings SET gear_out_for_delivery_sent_at = NOW() WHERE booking_id = $1`,
    [bookingId]
  );
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const now = new Date();
    const today = pacificDateString(now);
    const tomorrow = addDaysToDateString(today, 1);
    const due = await listBookingsDueForOutForDelivery(tomorrow);

    const results = [];
    for (const b of due) {
      // Delivery night is TODAY (the trip is tomorrow) -- the slot label
      // ("7:00pm") has no date of its own, so it's resolved against
      // today's Pacific date, same as adventure-prep-form.js's own
      // computeDeliverySlotDate(eb.date, ...) resolves it against
      // eb.date minus one day.
      const slotInstant = deliverySlotInstantUtc(today, b.deliveryTimeSlot);
      if (!slotInstant) {
        results.push({ bookingId: b.bookingId, outcome: 'unparseable_slot', slot: b.deliveryTimeSlot });
        continue;
      }
      const oneHourBefore = new Date(slotInstant.getTime() - 3600000);
      if (now < oneHourBefore) {
        results.push({ bookingId: b.bookingId, outcome: 'not_yet_within_1hr' });
        continue;
      }

      if (!b.contactEmail) {
        // eslint-disable-next-line no-console
        console.error('send-gear-out-for-delivery: no contactEmail on file, guest not notified', b.bookingId);
        results.push({ bookingId: b.bookingId, outcome: 'no_contact_email' });
        continue;
      }

      try {
        const html = renderGearOutForDeliveryEmail({
          logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || 'https://palmspringsadventureclub.com/images/psac-logo-email-header.png',
          arrivalTime: b.deliveryTimeSlot,
          address: b.address,
          kitCount: Math.max(Number(b.kitCount) || 0, 1),
        });
        await sendEmail({ to: b.contactEmail, subject: 'Your gear is out for delivery', html });
        await markOutForDeliverySent(b.bookingId);
        results.push({ bookingId: b.bookingId, outcome: 'sent' });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('send-gear-out-for-delivery: failed to send/mark', b.bookingId, err);
        results.push({ bookingId: b.bookingId, outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({ ok: true, tripDate: tomorrow, dueCount: due.length, results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('send-gear-out-for-delivery failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
