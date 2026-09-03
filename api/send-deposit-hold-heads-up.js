/**
 * api/send-deposit-hold-heads-up.js
 *
 * NEW (Airey's direct request, 2026-09-02): wires up the previously
 * unwired lib/email-templates/deposit-hold-heads-up-email.js. Vercel
 * Cron, 8am Pacific, T-1 dispatch day (gear delivers that same evening)
 * — for every active booking whose trip date is tomorrow AND has met all
 * T-3 requirements, sends the guest a heads-up that their refundable gear
 * deposit hold is coming, with the real per-kit dollar amount (see
 * api/create-deposit-hold.js's TIERS table — this file's own small copy
 * of it, same "deliberately matches, not a coincidence, commented at each
 * copy" convention already used between that file and
 * create-payment-intent.js's own TIERS).
 *
 * "Met all T-3 requirements" = experience_bookings.t3_cutoff_processed_at
 * IS NOT NULL. api/process-t3-cutoff.js sets that column ONLY after a
 * booking survives its three cancellation gates (no_1.2a / zero_waivers /
 * no_address) — a booking that fails one of those gets cancelled instead
 * and never reaches markProcessed. So this is exactly "the booking's
 * roster/kit count is locked in and gear really is going out tonight," not
 * just "trip date is tomorrow." Sending a "your gear deposit hold is
 * coming" email to a booking that isn't actually getting gear delivered
 * tonight (still mid-T-3-processing, or already cancelled) would be
 * actively misleading, not just premature.
 *
 * Dedup: experience_bookings.deposit_heads_up_sent_at (new column, see
 * db/schema.sql) — same plain-nullable-timestamp idempotency pattern as
 * t3_cutoff_processed_at/deposit_hold_renewed_at. This cron fires on a
 * repeating every-15-minutes window (same "actual instant +/- 1 hour UTC"
 * vercel.json shape as api/trigger-deposit-holds.js's own 9am-Pacific
 * window, one hour earlier) rather than a single fixed instant, so
 * without this dedup a slow first tick or an all-day-lingering booking
 * would get re-emailed on every subsequent tick.
 *
 * UPDATED (Airey's direct request, 2026-09-02): moved from noon Pacific
 * to 8am Pacific — one hour ahead of api/trigger-deposit-holds.js's own
 * 9am-Pacific hold-placement cron, so the heads-up email always lands in
 * the guest's inbox before the actual hold gets placed, not after.
 *
 * Skips (no email, no alert — not an error, just not applicable):
 *   - tier not in TIERS (Custom Experience and anything else) — no
 *     deposit hold ever applies, so no heads-up either. Mirrors
 *     api/create-deposit-hold.js's own tier check. Marked sent anyway so
 *     it doesn't get re-evaluated by every remaining tick.
 *   - no contactEmail on file — logged, not alerted (matches
 *     api/reconcile-gear-deposit.js's own "no contactEmail" handling).
 *
 * Deliberately does NOT gate on deposit_status the way
 * api/trigger-deposit-holds.js does — that field describes the ACTUAL
 * Stripe hold's own lifecycle (scheduled_t1 -> held/failed/...), which
 * this endpoint never touches. t3_cutoff_processed_at and
 * deposit_heads_up_sent_at are this endpoint's own, independent gate/dedup
 * pair — timed an hour ahead of the 9am hold-placement cron by clock
 * time alone, not by checking whether that cron has actually run yet.
 */

'use strict';

const { query } = require('../lib/db');
const { sendEmail } = require('../lib/send-email');
const { renderDepositHoldHeadsUpEmail } = require('../lib/email-templates/deposit-hold-heads-up-email');
const { pacificDateString, addDaysToDateString, pacificClockTimeReached } = require('../lib/cadence');

// Deposit-per-kit — see api/create-deposit-hold.js's own TIERS table, the
// actual charge logic this mirrors. Kept as a separate copy rather than a
// shared import, matching this codebase's existing convention
// (create-deposit-hold.js's own TIERS already carries the identical
// "matches create-payment-intent.js's TIERS.gear, not a coincidence"
// comment — this is the same kind of deliberate, cross-referenced
// duplication, not an oversight).
const TIERS = {
  trail: { gear: 65 },
  p2p: { gear: 100 },
};

function checkCronAuth(req) {
  // Same fail-closed-if-unset posture as every other cron endpoint in
  // this stack (payment-review, Aug 2026, Medium #44).
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + secret;
}

/**
 * Every active, T-3-cleared, not-yet-notified booking whose trip date is
 * `tripDate`. gearKitCount prefers adventure_prep.confirmed_kit_count over
 * the booking-time gear_kit_count when it exists — same "Adventure Prep's
 * live, T-3-pruned kit count is the real one once it exists" preference
 * as lib/booking-service.js's own getBooking.
 */
async function listBookingsDueForHeadsUp(tripDate) {
  const rows = await query(
    `SELECT eb.booking_id, eb.contact_email, eb.contact_name, eb.tier, eb.gear_kit_count,
            ap.confirmed_kit_count
     FROM experience_bookings eb
     LEFT JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
     WHERE eb.date = $1
       AND (eb.booking_status = 'active' OR eb.booking_status IS NULL)
       AND eb.t3_cutoff_processed_at IS NOT NULL
       AND eb.deposit_heads_up_sent_at IS NULL`,
    [tripDate]
  );
  return rows.map((r) => {
    const hasConfirmedCount = r.confirmed_kit_count !== null && r.confirmed_kit_count !== undefined;
    return {
      bookingId: r.booking_id,
      contactEmail: r.contact_email,
      contactName: r.contact_name,
      tier: r.tier || '',
      gearKitCount: hasConfirmedCount ? r.confirmed_kit_count : r.gear_kit_count,
    };
  });
}

async function markHeadsUpSent(bookingId) {
  await query(
    `UPDATE experience_bookings SET deposit_heads_up_sent_at = NOW() WHERE booking_id = $1`,
    [bookingId]
  );
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // Same "don't act on the cron window's first tick, gate to the
    // actual locked instant" pattern as api/trigger-deposit-holds.js's own
    // 9am gate (lib/cadence.js's pacificClockTimeReached header explains
    // why — the window's first tick lands up to two hours early during
    // PDT/PST). UPDATED (Airey's direct request, 2026-09-02): 8am, not
    // noon — one hour ahead of the 9am hold-placement cron, so this email
    // always lands before the hold, never after.
    const now = new Date();
    if (!pacificClockTimeReached(8, 0, now)) {
      res.status(200).json({ ok: true, skipped: 'before_8am_pacific' });
      return;
    }

    const tomorrow = addDaysToDateString(pacificDateString(now), 1);
    const due = await listBookingsDueForHeadsUp(tomorrow);

    const results = [];
    for (const b of due) {
      const tier = TIERS[b.tier];
      if (!tier) {
        // Custom Experience (or anything unrecognized) — no deposit hold
        // ever applies, so no heads-up either. Marked sent so this
        // booking doesn't get re-evaluated by every remaining tick before
        // this cron's window closes.
        try {
          await markHeadsUpSent(b.bookingId);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('send-deposit-hold-heads-up: failed to mark skipped (no deposit tier) booking sent', b.bookingId, err);
        }
        results.push({ bookingId: b.bookingId, outcome: 'skipped_no_deposit_tier' });
        continue;
      }

      // Floors at 1 kit, matching api/create-deposit-hold.js's own "every
      // booking requires at least 1 kit" floor for a stored count that
      // should never be 0 or blank.
      const kitCount = Math.max(Number(b.gearKitCount) || 0, 1);
      const depositAmount = tier.gear * kitCount;

      if (!b.contactEmail) {
        // eslint-disable-next-line no-console
        console.error('send-deposit-hold-heads-up: no contactEmail on file, guest not notified', b.bookingId);
        results.push({ bookingId: b.bookingId, outcome: 'no_contact_email' });
        continue;
      }

      try {
        const html = renderDepositHoldHeadsUpEmail({
          logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || 'https://palmspringsadventureclub.com/images/psac-logo-email-header.png',
          depositAmount,
          kitCount,
        });
        await sendEmail({ to: b.contactEmail, subject: 'Your gear deposit hold is coming', html });
        await markHeadsUpSent(b.bookingId);
        results.push({ bookingId: b.bookingId, outcome: 'sent', depositAmount, kitCount });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('send-deposit-hold-heads-up: failed to send/mark', b.bookingId, err);
        results.push({ bookingId: b.bookingId, outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({ ok: true, tripDate: tomorrow, dueCount: due.length, results });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('send-deposit-hold-heads-up failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
