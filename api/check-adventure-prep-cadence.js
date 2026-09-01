/**
 * api/check-adventure-prep-cadence.js
 *
 * MIGRATED (2026-08-31, check-adventure-prep-cadence build session):
 * Operations UX PRD Sections 3-4: the daily stall-detection/escalation
 * cadence job, run via Vercel Cron once daily (~9am Pacific, per Section 3's
 * table — Vercel Cron's own schedule granularity should be set as close to
 * that as the platform allows; see the deployment note at the bottom of this
 * file). Completes Task 9 (the other half, api/process-t3-cutoff.js, was
 * migrated in the prior build turn) — swaps lib/apps-script-client's
 * callBookingsWebApp for lib/cadence-service.js's Postgres-backed calls.
 * lib/cadence.js's own date math (determineCadenceStage and friends) is
 * pure and untouched by this migration.
 *
 * What this endpoint does NOT do, on purpose:
 *
 * - It never sends the compressed-cadence "first touch." Per Section 4,
 *   that touch IS the booking-confirmation email itself ("the confirmation
 *   includes the live Adventure Prep link ... for a compressed booking,
 *   this substitutes for the T-7 nudge"), sent synchronously at booking
 *   time by the booking flow, not by this once-daily cron. Section 15's
 *   drafted "Compressed-cadence first touch" copy is that confirmation
 *   email's compressed-cadence variant — a requirement for whoever owns
 *   api/save-booking.js / the confirmation send, not built here. Flagged in
 *   this session's build-review addendum, not silently assumed handled.
 *
 * - It doesn't decide 1.2a-never-completed / zero-waiver / no-address
 *   cancellation (that's the T-3, 10pm job, api/process-t3-cutoff.js,
 *   Section 14). This job only nudges and flags before that hard cutoff;
 *   it never cancels anything itself.
 *
 * Per-booking algorithm, once daily, over every `bookingStatus === 'active'`
 * booking:
 *
 *   1. Compute today's cadence stage for this booking (lib/cadence.js),
 *      normal cadence (t7/t5/t3) or compressed (midwindow/t3) — see that
 *      file's header for why compressed bookings never get a 't7' stage.
 *   2. Fetch the three tracked completion states (Section 3's table:
 *      assignedAt / waiverTrack / delivery address presence).
 *   3. If all three are complete: clear adventurePrepStalledFlag and
 *      phoneFallbackDue if either is currently set (Section 3: "cleared
 *      once all three tracks complete"), and do nothing else — this check
 *      runs for EVERY active booking daily, not just ones on a stage day,
 *      specifically so a booking that finishes between its stage checks
 *      still gets its flags cleared promptly rather than waiting for its
 *      next mark.
 *   4. Otherwise, if today is a stage day for this booking AND that stage
 *      hasn't already fired (cadenceStagesSent):
 *        - 't7' (unconditional, normal cadence only): send the T-7 nudge
 *          regardless of completion state, per Section 3's table literally
 *          marking this row "Unconditional."
 *        - 't5' / 'midwindow' (conditional): send the unified stall
 *          reminder (Section 15, 'reminder' variant) listing outstanding
 *          tracks, and set adventurePrepStalledFlag = true — Section 3:
 *          "A booking is stalled the moment any of the three tracks is
 *          still incomplete at its T-5, 9am Pacific check," extended here
 *          to the compressed cadence's equivalent midpoint check.
 *        - 't3' (conditional): send the unified stall reminder ('action_
 *          needed' variant), and set BOTH adventurePrepStalledFlag and
 *          phoneFallbackDue = true (Section 3: T-3 morning "add the booking
 *          to the staff phone-fallback queue"). Set unconditionally here
 *          (not just "if not already true") so a super-compressed booking
 *          that skipped its midwindow check (Section 4: 48 hours or less
 *          remaining) still gets flagged at T-3 even though nothing set it
 *          true earlier.
 *      Every actual send records its stage via recordStageSent so a
 *      retried or duplicate cron tick never double-sends.
 */

'use strict';

const cadenceService = require('../lib/cadence-service');
const { determineCadenceStage } = require('../lib/cadence');
const { sendEmail } = require('../lib/send-email');
const { renderAdventurePrepT7NudgeEmail } = require('../lib/email-templates/adventure-prep-t7-nudge-email');
const { renderStallReminderEmail } = require('../lib/email-templates/adventure-prep-stall-reminder-email');
const { getSiteUrl } = require('../lib/site-url');

const ADVENTURE_PREP_BASE_URL = `${getSiteUrl()}/complete-adventure-prep`;

function checkCronAuth(req) {
  // BUG FIX (payment-review, Aug 2026, Medium #44): 'Bearer ' + undefined
  // string-concatenates to the literal 'Bearer undefined' — if
  // CRON_SECRET is ever unset, that literal string becomes a valid,
  // guessable bypass. Fail closed: require the secret configured first.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers && req.headers.authorization;
  return header === 'Bearer ' + secret;
}

function formatTripDate(isoDateStr) {
  if (!isoDateStr) return 'your trail day';
  const d = new Date(isoDateStr);
  if (isNaN(d.getTime())) return 'your trail day';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
}

function adventurePrepLinkFor(token) {
  return `${ADVENTURE_PREP_BASE_URL}?token=${encodeURIComponent(token || '')}`;
}

async function processOneBooking(bookingSummary, now) {
  const ctx = await cadenceService.getBookingContext(bookingSummary.bookingId);
  if (!ctx || ctx.notFound) return { bookingId: bookingSummary.bookingId, outcome: 'not_found' };

  const assignedAtMissing = !ctx.assignedAt;
  const waiverIncomplete = ctx.waiverTrack !== 'complete';
  const addressMissing = !ctx.hasAddress;
  const fullyComplete = !assignedAtMissing && !waiverIncomplete && !addressMissing;

  if (fullyComplete) {
    if (ctx.adventurePrepStalledFlag || ctx.phoneFallbackDue) {
      await cadenceService.setStallFlags({
        bookingId: ctx.bookingId,
        adventurePrepStalledFlag: false,
        phoneFallbackDue: false,
      });
      return { bookingId: ctx.bookingId, outcome: 'cleared_flags_fully_complete' };
    }
    return { bookingId: ctx.bookingId, outcome: 'fully_complete_no_action' };
  }

  const { isCompressed, stage } = determineCadenceStage({ tripDate: ctx.tripDate, createdAt: ctx.createdAt }, now);
  if (!stage) return { bookingId: ctx.bookingId, outcome: 'no_stage_today', isCompressed };

  if (ctx.cadenceStagesSent.includes(stage)) {
    return { bookingId: ctx.bookingId, outcome: 'stage_already_sent', stage };
  }

  const tripDateFormatted = formatTripDate(ctx.tripDate);
  const adventurePrepLink = adventurePrepLinkFor(ctx.adventurePrepToken);
  const logoUrl = process.env.BOOKING_CONFIRMATION_LOGO_URL || '';

  // BUG FIX (independent bug pass, Aug 2026): every stage block used to call
  // sendEmail(...) and only THEN record the stage sent. This cron is
  // recommended (see this file's own deployment note) to run every 15-30
  // minutes for DST-drift tolerance, same as process-t3-cutoff.js. If the
  // marker-write step failed transiently right after a successful send (a
  // dropped connection, a transient DB error), the stage would never be
  // recorded as sent, so the very next tick — 15-30 minutes later — would
  // see "stage not yet sent" and send the same escalating-urgency reminder
  // again, with no upper bound on how many times that could repeat for the
  // rest of that Pacific calendar day. Reordered so the marker is recorded
  // BEFORE the send: worst case on a failure is one missed reminder for a
  // booking that still has the T-3 hard cutoff and other cadence stages as
  // a safety net, which is a materially safer failure mode than an
  // unbounded run of duplicate "action needed" emails to a guest.
  if (stage === 't7') {
    // Unconditional: fires regardless of completion state, per Section 3's
    // table. lib/email-templates/adventure-prep-t7-nudge-email.js's own
    // header explains this in full: a best-effort reconstruction of an
    // "existing" send the PRD describes, checked this build-review round
    // against every reviewed doc, and confirmed nothing else in this stack
    // actually sends it today (psac-email-sms-infrastructure-setup-guide.md
    // lists it among several drafted-but-never-wired touchpoints). This is
    // the real, only implementation, not a duplicate.
    await cadenceService.recordStageSent(ctx.bookingId, 't7');
    const html = renderAdventurePrepT7NudgeEmail({ logoUrl, guestName: ctx.contactName, tripDateFormatted, adventurePrepLink });
    if (ctx.contactEmail) {
      await sendEmail({
        to: ctx.contactEmail,
        subject: "Let's finish setting up your adventure",
        html,
      });
    }
    return { bookingId: ctx.bookingId, outcome: 'sent', stage: 't7', isCompressed };
  }

  if (stage === 't5' || stage === 'midwindow') {
    await cadenceService.setStallFlags({ bookingId: ctx.bookingId, adventurePrepStalledFlag: true });
    await cadenceService.recordStageSent(ctx.bookingId, stage);
    const html = renderStallReminderEmail({
      logoUrl, guestName: ctx.contactName, tripDateFormatted, adventurePrepLink,
      variant: 'reminder',
      tracks: { assignedAtMissing, waiverIncomplete, addressMissing },
      waiverGroupNote: waiverIncomplete,
    });
    if (ctx.contactEmail) {
      await sendEmail({ to: ctx.contactEmail, subject: 'Still a few things needed before your trail day', html });
    }
    return { bookingId: ctx.bookingId, outcome: 'sent', stage, isCompressed };
  }

  if (stage === 't3') {
    await cadenceService.setStallFlags({
      bookingId: ctx.bookingId,
      adventurePrepStalledFlag: true,
      phoneFallbackDue: true,
    });
    await cadenceService.recordStageSent(ctx.bookingId, 't3');
    const html = renderStallReminderEmail({
      logoUrl, guestName: ctx.contactName, tripDateFormatted, adventurePrepLink,
      variant: 'action_needed',
      tracks: { assignedAtMissing, waiverIncomplete, addressMissing },
      waiverGroupNote: waiverIncomplete,
    });
    if (ctx.contactEmail) {
      await sendEmail({ to: ctx.contactEmail, subject: 'Action needed by 10pm tonight to keep your reservation', html });
    }
    return { bookingId: ctx.bookingId, outcome: 'sent', stage: 't3', isCompressed };
  }

  return { bookingId: ctx.bookingId, outcome: 'unknown_stage', stage };
}

module.exports = async function handler(req, res) {
  try {
    if (!checkCronAuth(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const now = new Date();
    const listRes = await cadenceService.listActiveBookings();
    const bookings = (listRes && listRes.bookings) || [];

    const results = [];
    for (const b of bookings) {
      try {
        results.push(await processOneBooking(b, now));
      } catch (err) {
        // One booking's failure never blocks the rest of the tick — same
        // posture as api/process-t3-cutoff.js.
        // eslint-disable-next-line no-console
        console.error('check-adventure-prep-cadence: booking failed', b.bookingId, err);
        results.push({ bookingId: b.bookingId, outcome: 'error', detail: err.message });
      }
    }

    res.status(200).json({
      ok: true,
      candidateCount: bookings.length,
      results,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('check-adventure-prep-cadence failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};

/**
 * DEPLOYMENT NOTE for vercel.json's crons entry: Vercel Cron schedules are
 * UTC and don't natively express "9am Pacific" across DST — the existing
 * T-3 job (api/process-t3-cutoff.js) sidesteps this by running every 15
 * minutes and letting isBeforeT3Cutoff decide readiness. This job can't use
 * that trick as directly, since its stage checks are meant to fire once,
 * near 9am Pacific, not continuously — but it's still SAFE to run more
 * often than once daily (e.g. every 15-30 minutes, matching the existing
 * job's cadence) because every send path is idempotent via
 * booking_cadence_log. Recommend scheduling this the same way as
 * process-t3-cutoff.js (frequent, cheap ticks) rather than trying to pin an
 * exact UTC cron expression to "9am Pacific" and having it drift a full
 * hour across DST transitions twice a year.
 */
