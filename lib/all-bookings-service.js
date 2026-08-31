/**
 * lib/all-bookings-service.js
 *
 * MIGRATED (2026-08-31, Task 8 ops-proxy migration): Postgres replacement
 * for apps-script/ops-redesign-round1-actions.gs's All Bookings / Ops
 * Alerts (expanded) / Stalled Bookings / Cancellations functions —
 * allBookings_listAll, opsAlerts_listExpanded (+ its five live-computed
 * sub-producers), stalled_listAll, stalled_markCalled, cancellations_listAll.
 * Backs api/ops-proxy.js's listAllBookings/listOpsAlertsExpanded/
 * listStalledBookings/markStalledCalled/listCancellations actions.
 *
 * Reuses lib/ops-status-helpers.js's four shared bucket functions (hold/
 * payment/booking-status/delivery-return) — All Bookings and Booking Detail
 * "must never disagree about what a given booking's state actually is,"
 * per that file's own header — and lib/ops-list-service.js's listOpsAlerts
 * for the expanded feed's existing payment/hold-failure family, and
 * lib/gear-service.js's listReconciliationQueue for the Reconciliation
 * Required alerts (opsRedesign_reconciliationAlerts_'s own comment: "mirrors
 * gearOps_listReconciliationQueue's own exact query," now the same
 * function, not a second copy of it).
 */

'use strict';

const { sql, query } = require('./db');
const {
  holdStatusBucket,
  paymentStatusBucket,
  bookingStatusInfo,
  deliveryReturnStatus,
} = require('./ops-status-helpers');
const { listOpsAlerts } = require('./ops-list-service');
const { listReconciliationQueue, GEAR_ITEM_TYPE_CONFIG } = require('./gear-service');

function toDateStr(v) {
  if (!v) return '';
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}
function toIso(v) {
  if (!v) return '';
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// ---------------------------------------------------------------------------
// All Bookings
// ---------------------------------------------------------------------------

/**
 * Every booking, with every computed status field All Bookings' table and
 * filters need, plus the raw ingredients (openAlertCount, hasOpenTrailSwap,
 * hasReconciliationCase, checkoutStarted) the front end uses to build its
 * six-tier stacked link-out list per row. No pagination (same open question
 * the .gs source flags) — returns every row, capped at 500 as a sanity
 * backstop, matching allBookings_listAll exactly.
 */
async function listAllBookings() {
  const rows = await sql`
    SELECT booking_id, contact_name, contact_email, date, booking_status, cancellation_reasons,
           payment_status, deposit_status, delivery_status, return_status, gear_delivered_at
    FROM experience_bookings
  `;

  const alertRows = await sql`SELECT booking_id, alert_type FROM ops_alerts WHERE status = 'Open'`;
  const openAlertsByBooking = {};
  alertRows.forEach((a) => {
    const key = String(a.booking_id);
    if (!openAlertsByBooking[key]) openAlertsByBooking[key] = [];
    openAlertsByBooking[key].push(a.alert_type);
  });

  const swapRows = await sql`SELECT booking_id FROM trail_swap_requests WHERE status = 'Open'`;
  const openSwapByBooking = {};
  swapRows.forEach((s) => { openSwapByBooking[String(s.booking_id)] = true; });

  const gearRows = await sql`SELECT booking_id, unit_id FROM gear_check_log`;
  const gearRowsByBooking = {};
  gearRows.forEach((g) => {
    const key = String(g.booking_id);
    if (!gearRowsByBooking[key]) gearRowsByBooking[key] = [];
    gearRowsByBooking[key].push(g);
  });

  const bookings = rows.map((r) => {
    const bookingInfo = bookingStatusInfo(r);
    const deliveryReturn = deliveryReturnStatus(r);
    const openAlerts = openAlertsByBooking[String(r.booking_id)] || [];
    const gearRowsForBooking = gearRowsByBooking[String(r.booking_id)] || [];
    const checkoutStarted = gearRowsForBooking.some((g) => g.unit_id);
    const reconciliationOpen = r.deposit_status === 'full_capture_pending_review' || r.deposit_status === 'shortfall_charged';

    return {
      bookingId: r.booking_id,
      contactName: r.contact_name,
      contactEmail: r.contact_email,
      tripDate: toDateStr(r.date),
      bookingStatusBucket: bookingInfo.bucket,
      cancellationReasons: bookingInfo.reasons,
      paymentStatusBucket: paymentStatusBucket(r.payment_status),
      holdStatusBucket: holdStatusBucket(r.deposit_status),
      deliveryStatus: deliveryReturn.deliveryStatus,
      returnStatus: deliveryReturn.returnStatus,
      openAlertCount: openAlerts.length,
      openAlertTypes: openAlerts,
      hasOpenTrailSwap: !!openSwapByBooking[String(r.booking_id)],
      hasReconciliationCase: reconciliationOpen,
      checkoutStarted,
      checkoutDelivered: deliveryReturn.deliveryStatus === 'delivered',
      checkedIn: deliveryReturn.returnStatus === 'checked_in',
    };
  });

  bookings.sort((a, b) => String(a.tripDate).localeCompare(String(b.tripDate)));
  return { bookings: bookings.slice(0, 500), truncated: bookings.length > 500 };
}

// ---------------------------------------------------------------------------
// Ops Alerts, expanded
// ---------------------------------------------------------------------------

async function reconciliationAlerts() {
  const { bookings } = await listReconciliationQueue();
  return bookings.map((b) => ({
    source: 'reconciliation_required',
    bookingId: b.bookingId,
    description: 'Reconciliation needs review',
    urgencyTier: 'urgent',
    createdAt: b.reconciledAt || toDateStr(b.tripDate),
    amount: b.gearShortfallCents != null && b.gearShortfallCents !== '' ? b.gearShortfallCents / 100 : '',
  }));
}

/**
 * A booking whose Gear Check Log rows show a MIXED allocation state (some
 * rows have a unit_id, some don't) has genuinely had an allocation attempt
 * run and come up short — same signal Gear Assembly & Checkout's own fixed
 * "Retry Allocation" precondition uses, kept consistent on purpose.
 */
async function shortAllocationAlerts() {
  const activeBookings = await sql`
    SELECT booking_id, date FROM experience_bookings WHERE (booking_status = 'active' OR booking_status IS NULL)
  `;
  const activeById = {};
  activeBookings.forEach((r) => { activeById[String(r.booking_id)] = r; });

  const gearRows = await sql`SELECT booking_id, unit_id FROM gear_check_log`;
  const byBooking = {};
  gearRows.forEach((g) => {
    const key = String(g.booking_id);
    if (!activeById[key]) return;
    if (!byBooking[key]) byBooking[key] = [];
    byBooking[key].push(g);
  });

  const out = [];
  Object.keys(byBooking).forEach((bookingId) => {
    const rowsForBooking = byBooking[bookingId];
    const anyAllocated = rowsForBooking.some((r) => r.unit_id);
    const anyShort = rowsForBooking.some((r) => !r.unit_id);
    if (!anyAllocated || !anyShort) return; // either not started yet, or fully allocated
    out.push({
      source: 'manual_adjustment_short_allocation',
      bookingId,
      description: 'Booking short-allocated, needs retry',
      urgencyTier: 'urgent',
      createdAt: toDateStr(activeById[bookingId].date),
      amount: '',
      shortCount: rowsForBooking.filter((r) => !r.unit_id).length,
    });
  });
  return out;
}

/** Call-today (T-3 phone-fallback) tier only — Nudged (T-5) is routine volume, not a fire, and stays off this page. */
async function stalledCallTodayAlerts() {
  const rows = await sql`
    SELECT booking_id, date FROM experience_bookings
    WHERE adventure_prep_stalled_flag = true AND phone_fallback_due = true AND stalled_called_at IS NULL
  `;
  return rows.map((r) => ({
    source: 'stalled_call_today',
    bookingId: r.booking_id,
    description: 'Booking needs a call today',
    urgencyTier: 'urgent',
    createdAt: toDateStr(r.date),
    amount: '',
  }));
}

// Flat per-item-type threshold against Gear Units' live status counts — confirmed thresholds, Phase 4 Round 1's "Low-stock thresholds" table.
const OPS_ALERT_LOW_STOCK_THRESHOLDS = {
  poles: 0,
  backpack_standard: 1,
  backpack_plus: 2,
  bottle: 3,
  first_aid_kit: 1,
  duffel: 1,
};

async function gearStockAlerts() {
  const rows = await sql`SELECT item_type, status FROM gear_units`;
  const availableByType = {};
  rows.forEach((u) => {
    if (u.status !== 'available') return;
    availableByType[u.item_type] = (availableByType[u.item_type] || 0) + 1;
  });
  const out = [];
  Object.keys(OPS_ALERT_LOW_STOCK_THRESHOLDS).forEach((itemType) => {
    const available = availableByType[itemType] || 0;
    const threshold = OPS_ALERT_LOW_STOCK_THRESHOLDS[itemType];
    if (available > threshold) return; // auto-clears — not included once stock recovers
    const label = (GEAR_ITEM_TYPE_CONFIG[itemType] || {}).label || itemType;
    out.push({
      source: 'gear_low_stock',
      bookingId: '',
      description: 'Low stock: ' + label,
      urgencyTier: 'urgent',
      createdAt: '',
      amount: '',
      itemType,
      availableCount: available,
      threshold,
    });
  });
  return out;
}

/** For-your-awareness tier only — cancellations from the last 7 days, so this doesn't grow forever. */
async function cancellationAwarenessAlerts(nowIso) {
  const cutoffMs = new Date(nowIso).getTime() - 7 * 24 * 60 * 60 * 1000;
  const rows = await sql`
    SELECT booking_id, cancelled_at, cancellation_reasons FROM experience_bookings
    WHERE booking_status IS NOT NULL AND booking_status != 'active' AND cancelled_at IS NOT NULL
  `;
  return rows
    .filter((r) => new Date(r.cancelled_at).getTime() >= cutoffMs)
    .map((r) => ({
      source: 'cancellation_fyi',
      bookingId: r.booking_id,
      description: 'Cancellation (for awareness)',
      urgencyTier: 'awareness',
      createdAt: toIso(r.cancelled_at),
      amount: '',
      reasons: String(r.cancellation_reasons || '').split(',').map((s) => s.trim()).filter(Boolean),
    }));
}

/**
 * The expanded Ops Alerts feed: the existing sheet/table-backed payment/
 * hold-failure family (listOpsAlerts's own rows, unchanged), merged with
 * five live-computed producers (never persisted as ops_alerts rows).
 * Custom Tier requests are deliberately not included — no intake mechanism
 * exists anywhere in this codebase (matches the .gs source's own confirmed
 * finding, unchanged by this migration).
 */
async function listOpsAlertsExpanded({ nowIso } = {}) {
  const now = nowIso || new Date().toISOString();
  const { alerts } = await listOpsAlerts();
  const existing = alerts.map((a) => {
    let tier = 'urgent';
    if (a.status === 'Open' && a.urgency === 'same_day_2hr') tier = 'critical';
    return {
      source: 'payment_hold_failure',
      alertId: a.alertId,
      bookingId: a.bookingId,
      alertType: a.alertType,
      description: a.alertType,
      urgencyTier: tier,
      urgency: a.urgency,
      amount: a.amount,
      createdAt: a.createdAt,
      status: a.status,
      resolvedAt: a.resolvedAt,
      resolvedBy: a.resolvedBy,
      stripeErrorDetail: a.stripeErrorDetail,
      notes: a.notes,
    };
  });

  const [reconciliation, shortAllocation, stalled, gearStock, cancellations] = await Promise.all([
    reconciliationAlerts(),
    shortAllocationAlerts(),
    stalledCallTodayAlerts(),
    gearStockAlerts(),
    cancellationAwarenessAlerts(now),
  ]);

  return {
    paymentHoldFailure: existing,
    reconciliationRequired: reconciliation,
    shortAllocation,
    stalledCallToday: stalled,
    gearLowStock: gearStock,
    cancellationsFyi: cancellations,
    customTierBlocked: true, // no intake mechanism exists yet — see the .gs source's own header
  };
}

// ---------------------------------------------------------------------------
// Stalled Bookings
// ---------------------------------------------------------------------------

/**
 * Every booking currently flagged adventure_prep_stalled_flag=true, tagged
 * with which of the three tracks (Trail Details, Waiver, Address) are
 * still outstanding, and whether it's Nudged (T-5) or Call-today (T-3,
 * phone_fallback_due) stage. One combined queue, not two separate pages.
 */
async function listStalledBookings() {
  const rows = await sql`
    SELECT booking_id, contact_name, contact_phone, contact_email, date, phone_fallback_due,
           stalled_called_at, stalled_called_by
    FROM experience_bookings
    WHERE adventure_prep_stalled_flag = true
  `;

  const apRows = await sql`
    SELECT booking_id, assigned_at, all_waivers_complete, delivery_address_line1, delivery_address_raw
    FROM adventure_prep
  `;
  const apByBooking = {};
  apRows.forEach((ap) => { apByBooking[String(ap.booking_id)] = ap; });

  const signedRows = await sql`SELECT DISTINCT booking_id FROM waiver_signatures WHERE status = 'signed'`;
  const anySignedByBooking = {};
  signedRows.forEach((w) => { anySignedByBooking[String(w.booking_id)] = true; });

  const bookings = rows.map((r) => {
    const ap = apByBooking[String(r.booking_id)] || {};
    const waiverComplete = ap.all_waivers_complete === true;
    const waiverTrack = waiverComplete ? 'complete' : (anySignedByBooking[String(r.booking_id)] ? 'partial' : 'zero');
    const outstandingTracks = [];
    if (!ap.assigned_at) outstandingTracks.push('trail_details');
    if (waiverTrack !== 'complete') outstandingTracks.push('waiver');
    if (!(ap.delivery_address_line1 || ap.delivery_address_raw)) outstandingTracks.push('address');

    const isCallToday = r.phone_fallback_due === true;
    return {
      bookingId: r.booking_id,
      contactName: r.contact_name,
      contactPhone: r.contact_phone,
      contactEmail: r.contact_email,
      tripDate: toDateStr(r.date),
      stage: isCallToday ? 'call_today' : 'nudged',
      outstandingTracks,
      waiverTrack,
      calledAt: r.stalled_called_at ? toIso(r.stalled_called_at) : '',
      calledBy: r.stalled_called_by || '',
    };
  });

  bookings.sort((a, b) => {
    const aCall = a.stage === 'call_today' ? 0 : 1;
    const bCall = b.stage === 'call_today' ? 0 : 1;
    if (aCall !== bCall) return aCall - bCall;
    return String(a.tripDate).localeCompare(String(b.tripDate));
  });

  return { bookings };
}

/** New write action: "Mark called" — records who called and when, does not clear adventure_prep_stalled_flag (that's the cadence job's own job). */
async function markStalledCalled({ bookingId, calledBy }) {
  const now = new Date();
  const rows = await query(
    `UPDATE experience_bookings SET stalled_called_at = $2, stalled_called_by = $3 WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId, now.toISOString(), calledBy || '']
  );
  if (!rows.length) return { ok: false, error: 'Booking not found' };
  return { ok: true, bookingId, calledAt: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Cancellations
// ---------------------------------------------------------------------------

/**
 * Deliberately read-only, no Resolve/Edit/Reverse actions at all, by
 * design — "a fact to review, not a workflow to act on." Every cancelled
 * booking, its firing reason(s) verbatim, and its refund reference.
 */
async function listCancellations() {
  const rows = await sql`
    SELECT booking_id, contact_name, contact_email, date, booking_status, cancelled_at, cancellation_reasons, refund_amount
    FROM experience_bookings
    WHERE booking_status IS NOT NULL AND booking_status != 'active'
  `;
  const cancellations = rows.map((r) => ({
    bookingId: r.booking_id,
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    tripDate: toDateStr(r.date),
    bookingStatus: r.booking_status,
    cancelledAt: r.cancelled_at ? toIso(r.cancelled_at) : '',
    cancellationReasons: String(r.cancellation_reasons || '').split(',').map((s) => s.trim()).filter(Boolean),
    refundAmount: r.refund_amount != null ? Number(r.refund_amount) : '',
  }));
  cancellations.sort((a, b) => String(b.cancelledAt).localeCompare(String(a.cancelledAt)));
  return { cancellations };
}

module.exports = {
  listAllBookings,
  listOpsAlertsExpanded,
  listStalledBookings,
  markStalledCalled,
  listCancellations,
};
