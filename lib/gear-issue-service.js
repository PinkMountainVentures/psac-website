/**
 * lib/gear-issue-service.js
 *
 * Phase 2.5 Trail Day (claude/psac-trail-day-phase-proposal-2026-09-04.md)
 * -- backs the "Something not right?" escape hatch on the trail-day
 * Ready-to-go card. Modeled directly on lib/trail-swap-service.js's own
 * logIntake (same "staff-facing email already sent, this just also opens
 * a real row so it can't get lost in an inbox" job), but reuses the
 * EXISTING generic `ops_alerts` table instead of a new dedicated one.
 *
 * Why ops_alerts and not a new table: checked lib/ops-list-service.js's
 * listOpsAlerts() and lib/hold-clearance-service.js's resolveAlert()
 * before writing this -- both already operate on `SELECT * FROM
 * ops_alerts` / `UPDATE ops_alerts ... WHERE alert_id = $1` with no
 * alert_type filter at all. ops_alerts was already a generic
 * alert-with-Open/Resolved-status table; a gear issue is exactly that
 * shape (a message came in, a staffer looks at it, marks it handled -- no
 * review logic to build, unlike a trail swap). Adding rows here with
 * alert_type = 'gear_issue' gets the existing Resolve button, Open/
 * Resolved tag, and notes panel for free -- see lib/all-bookings-
 * service.js's listOpsAlertsExpanded for the one change needed on the
 * read side (branching `source` by alertType instead of assuming every
 * ops_alerts row is a payment/hold-failure row).
 *
 * The guest's message itself goes in stripe_error_detail -- a
 * payment-family column name, but it's plain TEXT with no payment-
 * specific meaning enforced anywhere; reusing it here (rather than adding
 * a new column) keeps this a zero-schema-change addition. Documented
 * here so a future reader isn't confused by the name.
 */

'use strict';

const { sql } = require('./db');
const { genId } = require('./ids');

/**
 * urgency: 'urgent_same_day' (not 'same_day_2hr', which is reserved for
 * the deposit-hold "call in 2 hours" critical tier) -- lands this in the
 * Urgent tier alongside reconciliation/short-allocation/stalled-call
 * rather than the Critical banner, matching Airey's resolved decision
 * (Urgent tier, Gear category, resolvable pattern -- not its own page).
 * Callable with a different urgency (see below) for a case that isn't
 * time-critical.
 *
 * contextLabel / urgency params (added Phase 3 Post-Adventure,
 * 2026-09-05, for the "Left something behind? Tell us" escape hatch on
 * the gear-return card's Double-Checking state): this function is reused
 * as-is rather than duplicated -- a found-item note after the trip is
 * the same shape of thing (a guest message that needs to reach a real
 * person, logged so it can't get lost in an inbox), it just isn't a
 * trail-day emergency, so it shouldn't share that case's urgency or its
 * "reported on trail day" description on the Ops Alerts read side (see
 * lib/all-bookings-service.js's listOpsAlertsExpanded, which branches on
 * the contextLabel prefix this stores). Both params default to the
 * original trail-day values, so the existing call in
 * api/send-help-message.js needs no change.
 */
async function logIntake({ bookingId, guestConcernSummary, contextLabel, urgency }) {
  const alertId = genId('ALERT');
  const message = contextLabel ? ('[' + contextLabel + '] ' + (guestConcernSummary || '')) : (guestConcernSummary || '');
  await sql`
    INSERT INTO ops_alerts (alert_id, booking_id, alert_type, created_at, status, urgency, stripe_error_detail)
    VALUES (${alertId}, ${bookingId}, 'gear_issue', NOW(), 'Open', ${urgency || 'urgent_same_day'}, ${message})
  `;
  return { ok: true, alertId };
}

module.exports = {
  logIntake,
};
