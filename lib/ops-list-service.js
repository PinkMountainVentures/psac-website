/**
 * lib/ops-list-service.js
 *
 * MIGRATED (2026-08-31, Task 8 ops-proxy migration): Postgres replacement
 * for apps-script/ops-app-list-actions.gs's three read-only "list
 * everything" actions — opsAlerts_listAll, trailSwap_listAll,
 * changeLog_listRecent. Backs api/ops-proxy.js's `listOpsAlerts`,
 * `listTrailSwapRequests`, and `listChangeLogRecent` READ_ACTIONS entries.
 *
 * listOpsAlerts (the raw, unexpanded family) isn't called by any current
 * ops-*.html page directly any more (they all moved to
 * lib/all-bookings-service.js's listOpsAlertsExpanded instead), but it's
 * still a real READ_ACTIONS entry and this module's own mapAlertRow is
 * reused by that expanded feed's "existing" payment/hold-failure family —
 * one source of truth for how an ops_alerts row becomes camelCase, not two.
 */

'use strict';

const { sql } = require('./db');

// BUG FIX (already baked into the .gs source, Aug 2026 independent bug
// pass): the only two writers of a real `urgency` value are
// lib/finalize-kit-change.js's opsAlertUrgency() ('urgent_same_day' /
// 'standard_24hr') and api/trigger-deposit-holds.js ('same_day_2hr') — kept
// here unchanged.
const OPS_ALERT_URGENCY_SORT = { same_day_2hr: 0, urgent_same_day: 1, standard_24hr: 2 };

function mapAlertRow(r) {
  return {
    alertId: r.alert_id,
    bookingId: r.booking_id,
    alertType: r.alert_type,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    amount: r.amount != null ? Number(r.amount) : '',
    stripeErrorDetail: r.stripe_error_detail || '',
    status: r.status,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : '',
    resolvedBy: r.resolved_by || '',
    notes: r.notes || '',
    urgency: r.urgency || '',
  };
}

/**
 * Postgres equivalent of opsAlerts_listAll: every Ops Alerts row, Open
 * first (same_day_2hr, then urgent_same_day, then standard_24hr, then
 * anything else), most-recently-created first within each group. Capped at
 * 100 rows — a live operational queue, not an archive.
 */
async function listOpsAlerts() {
  const rows = await sql`SELECT * FROM ops_alerts`;
  const alerts = rows.map(mapAlertRow);
  alerts.sort((a, b) => {
    const aOpen = a.status === 'Open' ? 0 : 1;
    const bOpen = b.status === 'Open' ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    const aUrg = OPS_ALERT_URGENCY_SORT[a.urgency] != null ? OPS_ALERT_URGENCY_SORT[a.urgency] : 9;
    const bUrg = OPS_ALERT_URGENCY_SORT[b.urgency] != null ? OPS_ALERT_URGENCY_SORT[b.urgency] : 9;
    if (aUrg !== bUrg) return aUrg - bUrg;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
  return { alerts: alerts.slice(0, 100) };
}

function mapSwapRow(r) {
  return {
    swapRequestId: r.swap_request_id,
    bookingId: r.booking_id,
    guestConcernSummary: r.guest_concern_summary || '',
    receivedAt: r.received_at ? new Date(r.received_at).toISOString() : '',
    status: r.status,
    reviewedBy: r.reviewed_by || '',
    newTrailId: r.new_trail_id || '',
    staffNotes: r.staff_notes || '',
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : '',
    tierASafetyFiltersOverridden: r.tier_a_safety_filters_overridden || [],
    safetyOverrideReason: r.safety_override_reason || '',
  };
}

/** Postgres equivalent of trailSwap_listAll: every Trail Swap Requests row, Open first, most-recent first. Capped at 100. */
async function listTrailSwapRequests() {
  const rows = await sql`SELECT * FROM trail_swap_requests`;
  const requests = rows.map(mapSwapRow);
  requests.sort((a, b) => {
    const aOpen = a.status === 'Open' ? 0 : 1;
    const bOpen = b.status === 'Open' ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return String(b.receivedAt).localeCompare(String(a.receivedAt));
  });
  return { requests: requests.slice(0, 100) };
}

/**
 * Postgres equivalent of changeLog_listRecent: the 30 most recent audit_log
 * rows, newest first — deliberately unfiltered by changeType, this tab is
 * shared with every other change-logging write path in the project (same
 * reasoning as the .gs source's own header comment).
 */
async function listChangeLogRecent() {
  const rows = await sql`
    SELECT booking_id, change_type, "timestamp", staff_notes
    FROM audit_log
    ORDER BY "timestamp" DESC
    LIMIT 30
  `;
  return {
    entries: rows.map((r) => ({
      bookingId: r.booking_id,
      changeType: r.change_type,
      staffNotes: r.staff_notes || '',
      timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : '',
    })),
  };
}

module.exports = { listOpsAlerts, listTrailSwapRequests, listChangeLogRecent, mapAlertRow };
