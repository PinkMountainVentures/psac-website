/**
 * lib/gear-service.js
 *
 * Postgres replacement for apps-script/gear-inventory-actions.gs's
 * gearOps_* actions PLUS the gear/delivery/return-relevant subset of
 * apps-script/ops-redesign-round2-actions.gs (gearOps_markReadyForDelivery
 * through gearOps_getCheckinQueueV2) — every gearOps_* action the 9
 * gear-ops api/*.js files call via callBookingsWebApp. This is the last
 * major unmigrated subsystem discovered while closing out the booking+
 * payment core: every one of those 9 files (allocate-gear-units,
 * charge-gear-shortfall, check-gear-availability, check-in-gear-item,
 * checkout-gear, manage-gear-units, reconcile-gear-deposit,
 * refund-gear-charge, trigger-gear-reconciliation) was still 100%
 * Apps-Script-backed — any real post-cutover booking's gear would never
 * have been allocatable, checkoutable, checkinable, or reconcilable.
 *
 * NOT included here (flagged separately, not silently folded in): the
 * three manualAdjustment_* actions later in ops-redesign-round2-
 * actions.gs (trail-day change, swap-allocated-unit, post-delivery
 * cancellation — Ops/Alerts territory, a separate subsystem), and the
 * deposit-hold PLACEMENT/renewal engine (api/create-deposit-hold.js,
 * api/trigger-deposit-holds.js, api/renew-deposit-hold.js) — also still
 * 100% Apps-Script-backed, discovered during this same pass, but a
 * distinct, similarly-sized subsystem in its own right. See the migration
 * progress doc.
 *
 * SCHEMA FIXES made alongside this file (db/schema.sql), since nothing
 * live depends on the old values yet:
 *   - gear_unit_status_t's value set was authored before this file's real
 *     status machine was read in detail and didn't match it at all
 *     (had 'delivered'/'returned'/'cleaning'/'deep_clean_due' instead of
 *     the real 'allocated'/'needs_cleaning'/'needs_deep_clean'/
 *     'damaged_pending_repair'). Fixed to the real value set.
 *   - gear_condition_t was lowercase ('good'/'damaged'/...); the real,
 *     already-established wire contract (VALID_CONDITIONS in
 *     api/check-in-gear-item.js, the live check-in UI) is Title-Case
 *     ('Good'/'Damaged'/'Missing'/'Recovered'). Fixed the casing.
 *   - deposit_status_t was missing 'refunded' (gearOps_recordRefund's
 *     terminal status) and 'shortfall_charge_in_progress'
 *     (gearOps_beginShortfallCharge's CAS claim state). Added both.
 *
 * CONCURRENCY: the Apps Script original used one global LockService lock
 * across every write in the file. Postgres has no equivalent single
 * cross-request lock available through the Neon HTTP driver used here
 * (lib/db.js), so every write below that could plausibly race a
 * concurrent call (unit allocation/claim, the shortfall-charge begin/
 * claim, reconciliation write-back) uses a targeted, guarded
 * UPDATE ... WHERE <still-in-the-expected-state> instead, checking
 * whether the guarded row actually came back before treating the action
 * as having succeeded — the same posture lib/finalize-kit-change.js's own
 * CAS guard already established for this migration.
 *
 * pack_size_preference NOTE: unlike the Apps Script era (where
 * packSizePreference didn't exist on any schema yet and
 * gearOps_resolveBackpackType_ was a documented always-'backpack_standard'
 * placeholder), booking_participants.pack_size_preference is a real column
 * in this schema — a genuine behavior improvement over the old
 * always-standard placeholder, not a like-for-like port, worth Airey's
 * awareness. resolveBackpackType below originally read it via a
 * name-matched join flagged as fragile at the time (gear_check_log.
 * person_name is a denormalized display string, and participant_id wasn't
 * populated by lib/booking-service.js yet) — BUG FIX (2026-08-31,
 * roster/gear-kit ID-link fix): participant_id is now populated at
 * booking/kit-add time, so this resolves by that real ID first, falling
 * back to the old name-matched join only for a row that predates the fix.
 */

'use strict';

const { sql, query, transaction } = require('../lib/db');
const { genId } = require('../lib/ids');

// ---------------------------------------------------------------------------
// Shared helpers (deliberately duplicated per this codebase's established
// small-per-file convention, matching lib/finalize-kit-change.js's own
// recordOpsAlert/appendAuditLog rather than a shared ops-alerts module).
// ---------------------------------------------------------------------------

// BUG FIX (2026-08-31, deposit-hold engine build session): the original
// port of this function (built during the gear-ops session) discarded the
// generated alertId entirely — every gear-ops caller up to that point only
// ever fire-and-forgot this call. The real Apps Script opsAlerts_recordAlert
// (ops-alerts-actions.gs) returns {ok:true, alertId}, and
// api/trigger-deposit-holds.js's own deposit_hold_failed alert path reports
// that alertId straight back in its own response (staff-visible, used to
// jump to the alert) — silently always undefined until this fix.
async function recordOpsAlert({ bookingId, alertType, amount, stripeErrorDetail, urgency, notes }) {
  const alertId = genId('ALERT');
  await query(
    `INSERT INTO ops_alerts (alert_id, booking_id, alert_type, amount, stripe_error_detail, urgency, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [alertId, bookingId || null, alertType, amount != null ? amount : null, stripeErrorDetail || null, urgency || null, notes || null]
  );
  return { ok: true, alertId };
}

/** Equivalent of holdClearance_findOpenDepositAlert — dedupe guard for alert types this file re-checks on every call (not just once). */
async function findOpenAlert({ bookingId, alertType }) {
  const rows = await query(
    `SELECT alert_id FROM ops_alerts WHERE booking_id = $1 AND alert_type = $2 AND status = 'Open' LIMIT 1`,
    [bookingId, alertType]
  );
  return rows.length ? { found: true, alertId: rows[0].alert_id } : { found: false };
}

async function appendAuditLog(entry) {
  await query(
    `INSERT INTO audit_log (
       audit_id, booking_id, change_type, before_t3_cutoff, old_value_json,
       new_value_json, delta, refund_or_charge_amount, stripe_transaction_id, staff_notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      genId('AUDIT'), entry.bookingId, entry.changeType, !!entry.beforeT3Cutoff,
      entry.oldValueJson != null ? JSON.stringify(entry.oldValueJson) : null,
      entry.newValueJson != null ? JSON.stringify(entry.newValueJson) : null,
      entry.delta != null ? entry.delta : null, entry.refundOrChargeAmount != null ? entry.refundOrChargeAmount : null,
      entry.stripeTransactionId || '', entry.staffNotes || '',
    ]
  );
}

function nowIsoDefault() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Section 2/5/9/16: per-itemType config that has no DB table of its own
// (label/unitPrefix/deepCleanThreshold) — replacementCostCents itself lives
// in gear_item_catalog (already seeded) and is read from there, not
// duplicated here, so this file never becomes a second source of truth for
// a cost figure the way ITEM_COSTS (lib/booking-service.js,
// lib/finalize-kit-change.js) and the old GEAR_ITEM_TYPE_CONFIG already
// were for each other in the Apps Script era.
// ---------------------------------------------------------------------------

const GEAR_ITEM_TYPE_CONFIG = {
  backpack_standard: { label: 'Backpack, Standard', unitPrefix: 'GP', deepCleanThreshold: 10 },
  backpack_plus: { label: 'Backpack, Plus', unitPrefix: 'GP', deepCleanThreshold: 10 },
  poles: { label: 'Trekking Poles (pair)', unitPrefix: 'LK', deepCleanThreshold: 5 },
  bottle: { label: 'Water Bottle', unitPrefix: 'HF', deepCleanThreshold: 5 },
  first_aid_kit: { label: 'Hard-Shell First Aid Kit', unitPrefix: 'FA', deepCleanThreshold: 10 },
  duffel: { label: 'Duffel', unitPrefix: 'RM', deepCleanThreshold: 10 },
};

// Maps gear_check_log.item_name (written by lib/booking-service.js's
// buildGearCheckLogRows / lib/finalize-kit-change.js's kit-count-change
// inserts — both already migrated, both use these exact strings) to a
// GEAR_ITEM_TYPE_CONFIG/gear_units.item_type key.
const GEAR_ITEM_NAME_TO_TYPE = {
  'Gregory Miko 20L Backpack': 'backpack_standard',
  'Hydro Flask Big Mouth 32oz Bottle': 'bottle',
  'Leki Khumbu Lite Trekking Poles': 'poles',
  'Hard-Shell First Aid Kit': 'first_aid_kit',
  'REI Pack Mule 90L Duffel': 'duffel',
};

const RECONCILED_DEPOSIT_STATUSES = ['released', 'partial_capture', 'full_capture', 'full_capture_pending_review', 'shortfall_charged'];

async function defaultReplacementCostCentsFor(itemType) {
  const rows = await query(`SELECT replacement_cost_cents FROM gear_item_catalog WHERE item_type = $1`, [itemType]);
  return rows.length ? Number(rows[0].replacement_cost_cents) : 0;
}

// ---------------------------------------------------------------------------
// Section 2/11: Gear Units CRUD
// ---------------------------------------------------------------------------

function unitRowToWire(r) {
  return {
    unitId: r.unit_id,
    itemType: r.item_type,
    status: r.status,
    currentBookingId: r.current_booking_id || '',
    replacementCostCents: r.replacement_cost_cents,
    acquiredAt: r.acquired_at ? new Date(r.acquired_at).toISOString() : '',
    retiredAt: r.retired_at ? new Date(r.retired_at).toISOString() : '',
    retiredReason: r.retired_reason || '',
    qrToken: r.qr_token || '',
    usesSinceDeepClean: r.uses_since_deep_clean,
  };
}

async function listUnits({ itemType } = {}) {
  const rows = itemType
    ? await query(`SELECT * FROM gear_units WHERE item_type = $1 ORDER BY unit_id`, [itemType])
    : await query(`SELECT * FROM gear_units ORDER BY unit_id`);
  return { units: rows.map(unitRowToWire) };
}

async function addUnit({ unitId, itemType, replacementCostCents, acquiredAt }) {
  if (!GEAR_ITEM_TYPE_CONFIG[itemType]) return { ok: false, error: 'Unknown itemType: ' + itemType };
  const id = String(unitId || '').trim();
  if (!id) return { ok: false, error: 'unitId is required' };

  const existing = await query(`SELECT 1 FROM gear_units WHERE unit_id = $1`, [id]);
  if (existing.length) return { ok: false, error: 'A unit with this ID already exists' };

  const cents = replacementCostCents != null ? Number(replacementCostCents) : await defaultReplacementCostCentsFor(itemType);
  const qrToken = genId();

  try {
    await query(
      `INSERT INTO gear_units (unit_id, item_type, status, replacement_cost_cents, acquired_at, qr_token, uses_since_deep_clean)
       VALUES ($1, $2, 'available', $3, $4, $5, 0)`,
      [id, itemType, cents, acquiredAt || nowIsoDefault(), qrToken]
    );
  } catch (err) {
    if (err && err.code === '23505') return { ok: false, error: 'A unit with this ID already exists' };
    throw err;
  }
  return { ok: true, unitId: id, itemType, qrToken, status: 'available' };
}

async function retireUnit({ unitId, retiredReason }) {
  const rows = await query(
    `UPDATE gear_units SET status = 'retired', retired_at = now(), retired_reason = $2, current_booking_id = NULL
     WHERE unit_id = $1 RETURNING unit_id`,
    [unitId, retiredReason || '']
  );
  if (!rows.length) return { ok: false, error: 'Unit not found' };
  return { ok: true, unitId };
}

async function markClean({ unitId }) {
  const rows = await query(`UPDATE gear_units SET status = 'available' WHERE unit_id = $1 RETURNING unit_id`, [unitId]);
  if (!rows.length) return { ok: false, error: 'Unit not found' };
  return { ok: true, unitId, status: 'available' };
}

async function markDeepCleaned({ unitId }) {
  const rows = await query(
    `UPDATE gear_units SET status = 'available', uses_since_deep_clean = 0 WHERE unit_id = $1 RETURNING unit_id`,
    [unitId]
  );
  if (!rows.length) return { ok: false, error: 'Unit not found' };
  return { ok: true, unitId, status: 'available', usesSinceDeepClean: 0 };
}

// ---------------------------------------------------------------------------
// Section 3: availability (raw data only — date math stays in Node)
// ---------------------------------------------------------------------------

async function checkAvailabilityRaw() {
  const units = (await query(`SELECT unit_id, item_type, status, current_booking_id FROM gear_units`)).map((u) => ({
    unitId: u.unit_id, itemType: u.item_type, status: u.status, currentBookingId: u.current_booking_id || '',
  }));
  const bookingIds = units
    .filter((u) => u.currentBookingId && (u.status === 'allocated' || u.status === 'checked_out'))
    .map((u) => u.currentBookingId);
  const uniqueIds = [...new Set(bookingIds)];
  const bookingTripDates = {};
  if (uniqueIds.length) {
    const rows = await query(`SELECT booking_id, date FROM experience_bookings WHERE booking_id = ANY($1::text[])`, [uniqueIds]);
    rows.forEach((r) => {
      if (r.date) bookingTripDates[r.booking_id] = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date);
    });
  }
  return { units, bookingTripDates };
}

// ---------------------------------------------------------------------------
// Section 3/4: allocation
// ---------------------------------------------------------------------------

/**
 * Section 2/13's real (not placeholder) resolution, since
 * booking_participants.pack_size_preference actually exists in this
 * schema.
 *
 * BUG FIX (2026-08-31, roster/gear-kit ID-link fix): gear_check_log.
 * participant_id is now actually populated at booking time (and at
 * post-booking kit-add time — see lib/finalize-kit-change.js), so this
 * resolves by that real ID first — an exact match, immune to the
 * name-collision risk the Apps Script original's own comment already
 * flagged. Falls back to the old name-matched join ONLY when
 * participantId is absent (a row that predates this fix, if one ever
 * exists) — kept as a safety net, not the primary path anymore.
 */
async function resolveBackpackType(bookingId, personName, participantId) {
  if (participantId) {
    const idRows = await query(
      `SELECT pack_size_preference FROM booking_participants
       WHERE experience_booking_id = $1 AND participant_id = $2`,
      [bookingId, participantId]
    );
    if (idRows.length) {
      return idRows[0].pack_size_preference === 'plus' ? 'backpack_plus' : 'backpack_standard';
    }
    // participantId given but no matching row (shouldn't happen) — fall through to the name-matched path below.
  }
  if (!personName) return 'backpack_standard';
  const rows = await query(
    `SELECT pack_size_preference FROM booking_participants
     WHERE experience_booking_id = $1 AND display_name = $2 AND pack_size_preference IS NOT NULL
     LIMIT 1`,
    [bookingId, personName]
  );
  if (rows.length && rows[0].pack_size_preference === 'plus') return 'backpack_plus';
  return 'backpack_standard';
}

async function allocateUnits({ bookingId }) {
  const gearRows = await query(
    `SELECT item_row_id, kit_number, person_name, participant_id, item_name, unit_id
     FROM gear_check_log WHERE booking_id = $1 AND checked_out_at IS NULL`,
    [bookingId]
  );

  const shortages = [];
  const allocation = [];

  for (const row of gearRows) {
    if (row.unit_id) {
      allocation.push({ kitNumber: row.kit_number, personName: row.person_name, itemName: row.item_name, unitId: row.unit_id });
      continue;
    }
    let itemType = GEAR_ITEM_NAME_TO_TYPE[row.item_name];
    if (!itemType) continue; // not a trackable item this file knows about
    if (itemType === 'backpack_standard') {
      itemType = await resolveBackpackType(bookingId, row.person_name, row.participant_id);
    }

    // Claim loop: pick the lowest-unitId available candidate, then attempt
    // a guarded UPDATE; if a concurrent caller won the race first (0 rows
    // updated), that unit is no longer 'available' so the next SELECT
    // naturally skips it — no separate exclusion list needed.
    let claimedUnitId = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidates = await query(
        `SELECT unit_id FROM gear_units WHERE item_type = $1 AND status = 'available' ORDER BY unit_id LIMIT 1`,
        [itemType]
      );
      if (!candidates.length) break;
      const claimRows = await query(
        `UPDATE gear_units SET status = 'allocated', current_booking_id = $2
         WHERE unit_id = $1 AND status = 'available' RETURNING unit_id`,
        [candidates[0].unit_id, bookingId]
      );
      if (claimRows.length) { claimedUnitId = claimRows[0].unit_id; break; }
      // lost the race — loop again, the losing unit no longer matches 'available'
    }

    if (!claimedUnitId) {
      shortages.push({
        itemType, label: (GEAR_ITEM_TYPE_CONFIG[itemType] || {}).label || itemType,
        kitNumber: row.kit_number, personName: row.person_name,
      });
      allocation.push({ kitNumber: row.kit_number, personName: row.person_name, itemName: row.item_name, unitId: '', shortage: true, itemType });
      continue;
    }

    await query(`UPDATE gear_check_log SET unit_id = $1 WHERE item_row_id = $2`, [claimedUnitId, row.item_row_id]);
    allocation.push({ kitNumber: row.kit_number, personName: row.person_name, itemName: row.item_name, unitId: claimedUnitId, itemType });
  }

  return { ok: true, bookingId, allocation, shortages };
}

async function getAllocation({ bookingId }) {
  const rows = await query(
    `SELECT kit_number, person_name, item_name, unit_id, checked_out_at, participant_id
     FROM gear_check_log WHERE booking_id = $1`,
    [bookingId]
  );
  const allocation = [];
  for (const r of rows) {
    let itemType = GEAR_ITEM_NAME_TO_TYPE[r.item_name] || '';
    if (itemType === 'backpack_standard') {
      itemType = await resolveBackpackType(bookingId, r.person_name, r.participant_id);
    }
    allocation.push({
      kitNumber: r.kit_number, personName: r.person_name, itemName: r.item_name,
      unitId: r.unit_id || '', checkedOutAt: r.checked_out_at ? new Date(r.checked_out_at).toISOString() : '',
      itemType,
    });
  }
  return { allocation };
}

async function recordShortageResolution({ bookingId, itemType, resolution, note }) {
  await appendAuditLog({
    bookingId, changeType: 'gear_shortage_resolution', beforeT3Cutoff: false,
    staffNotes: '[' + (itemType || 'item') + '] ' + (resolution || '') + (note ? ' — ' + note : ''),
  });
  return { ok: true, bookingId };
}

// ---------------------------------------------------------------------------
// Section 4: checkout queue, scan-confirm, Mark Delivered (V1)
// ---------------------------------------------------------------------------

async function getCheckoutQueue({ tripDate }) {
  const rows = await query(
    `SELECT booking_id, contact_name, contact_email, tier, gear_kit_count, date, gear_delivered_at
     FROM experience_bookings
     WHERE (booking_status IS NULL OR booking_status = 'active') AND date::text LIKE $1 || '%'`,
    [tripDate]
  );
  return {
    bookings: rows.map((r) => ({
      bookingId: r.booking_id, contactName: r.contact_name, contactEmail: r.contact_email,
      tier: r.tier, gearKitCount: r.gear_kit_count, tripDate: r.date,
      gearDeliveredAt: r.gear_delivered_at ? new Date(r.gear_delivered_at).toISOString() : '',
    })),
  };
}

async function confirmCheckoutScan({ bookingId, unitId }) {
  const unitRows = await query(`SELECT * FROM gear_units WHERE unit_id = $1`, [unitId]);
  if (!unitRows.length) {
    return { ok: false, mismatch: { reason: 'unit_not_found', detail: 'No unit with this ID exists in inventory.' } };
  }
  const unit = unitRows[0];

  if (unit.status === 'retired') {
    return { ok: false, mismatch: { reason: 'retired', detail: 'This unit was retired and should not be in circulation.' } };
  }
  if (String(unit.current_booking_id || '') !== String(bookingId)) {
    return {
      ok: false,
      mismatch: {
        reason: unit.current_booking_id ? 'allocated_elsewhere' : 'not_allocated',
        detail: unit.current_booking_id
          ? ('This unit is currently allocated to booking #' + unit.current_booking_id + ', not this one.')
          : 'This unit is not currently allocated to any booking — allocate it to this booking first.',
        actualBookingId: unit.current_booking_id || null,
      },
    };
  }

  const gearRows = await query(
    `SELECT item_row_id, item_name FROM gear_check_log WHERE booking_id = $1 AND unit_id = $2`,
    [bookingId, unitId]
  );
  if (!gearRows.length) {
    return { ok: false, mismatch: { reason: 'no_gear_log_row', detail: 'This unit is allocated to this booking, but no Gear Check Log row references it — an engineering data-integrity gap worth a look.' } };
  }

  const checkedOutAt = nowIsoDefault();
  await query(`UPDATE gear_check_log SET checked_out_at = $1 WHERE item_row_id = $2`, [checkedOutAt, gearRows[0].item_row_id]);
  await query(
    `UPDATE gear_units SET status = 'checked_out', uses_since_deep_clean = uses_since_deep_clean + 1 WHERE unit_id = $1`,
    [unitId]
  );

  return { ok: true, unitId, itemName: gearRows[0].item_name, checkedOutAt };
}

/** V1 — superseded by markDeliveredFinal below for pages built against the Round 2 delivery state machine, kept for backward compatibility (checkout-gear.js still has both branches). */
async function markDelivered({ bookingId, deliveredBy }) {
  const now = nowIsoDefault();
  const rows = await query(
    `UPDATE experience_bookings SET gear_delivered_at = $2, gear_delivered_by = $3 WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId, now, deliveredBy || '']
  );
  if (!rows.length) throw new Error('Booking not found: ' + bookingId);
  return { ok: true, bookingId, gearDeliveredAt: now, gearDeliveredBy: deliveredBy || '' };
}

// ---------------------------------------------------------------------------
// Section 5/9: Return Check-In (V1)
// ---------------------------------------------------------------------------

/**
 * Settled means every trackable item's condition is Good/Damaged/Recovered,
 * or Missing with its grace deadline already passed. An empty gearRows
 * array (nothing allocated/checked out yet) is explicitly NOT settled —
 * matches the .gs original's own two documented bug fixes for this exact
 * vacuous-truth trap.
 */
function isBookingSettled(gearRows, nowIso) {
  if (!gearRows.length) return false;
  const now = new Date(nowIso).getTime();
  return gearRows.every((r) => {
    if (!r.unit_id) return false; // not yet allocated/checked out — never settled
    if (r.condition === 'Good' || r.condition === 'Damaged' || r.condition === 'Recovered') return true;
    if (r.condition === 'Missing') {
      if (!r.grace_deadline) return false;
      return new Date(r.grace_deadline).getTime() <= now;
    }
    return false;
  });
}

async function getCheckinQueue({ tripDate }) {
  const rows = await query(
    `SELECT booking_id, contact_name, date, gear_delivered_at
     FROM experience_bookings
     WHERE (booking_status IS NULL OR booking_status = 'active') AND date::text LIKE $1 || '%' AND gear_delivered_at IS NOT NULL`,
    [tripDate]
  );
  return {
    bookings: rows.map((r) => ({
      bookingId: r.booking_id, contactName: r.contact_name, tripDate: r.date,
      gearDeliveredAt: new Date(r.gear_delivered_at).toISOString(),
    })),
  };
}

async function getCheckinContext({ bookingId }) {
  const gearRows = await query(
    `SELECT * FROM gear_check_log WHERE booking_id = $1 AND unit_id IS NOT NULL`,
    [bookingId]
  );
  const unitIds = gearRows.map((r) => r.unit_id);
  const unitsById = {};
  if (unitIds.length) {
    (await query(`SELECT * FROM gear_units WHERE unit_id = ANY($1::text[])`, [unitIds])).forEach((u) => { unitsById[u.unit_id] = u; });
  }

  const items = gearRows.map((r) => {
    const u = unitsById[r.unit_id] || {};
    return {
      unitId: r.unit_id, itemName: r.item_name, itemType: u.item_type || GEAR_ITEM_NAME_TO_TYPE[r.item_name] || '',
      kitNumber: r.kit_number, personName: r.person_name,
      condition: r.condition || '', checkedOutAt: r.checked_out_at ? new Date(r.checked_out_at).toISOString() : '',
      checkedInAt: r.checked_in_at ? new Date(r.checked_in_at).toISOString() : '',
      graceDeadline: r.grace_deadline ? new Date(r.grace_deadline).toISOString() : '',
      recoveredAt: r.recovered_at ? new Date(r.recovered_at).toISOString() : '',
      notes: r.notes || '', photoUrl: r.photo_url || '',
      usesSinceDeepClean: u.uses_since_deep_clean != null ? u.uses_since_deep_clean : '',
      deepCleanThreshold: (GEAR_ITEM_TYPE_CONFIG[u.item_type] || {}).deepCleanThreshold || '',
      replacementCostCents: u.replacement_cost_cents != null ? u.replacement_cost_cents : '',
    };
  });
  return { bookingId, items };
}

/**
 * Per-item check-in write-back. Mirrors gearOps_checkInItem exactly,
 * including its two hard-won bug fixes: checkedInAt is unconditionally
 * restamped on every write (corrections included — the reconciliation
 * settle-buffer depends on this), and a Damaged/Missing correction landing
 * after this booking's deposit hold already reconciled raises an Ops Alert
 * rather than going nowhere.
 */
async function checkInItem({ bookingId, unitId, condition, notes, photoUrl, nowIso, graceDeadline }) {
  if (['Good', 'Damaged', 'Missing', 'Recovered'].indexOf(condition) === -1) {
    return { ok: false, error: 'condition must be Good, Damaged, Missing, or Recovered' };
  }
  const gearRows = await query(
    `SELECT item_row_id, item_name, notes FROM gear_check_log WHERE booking_id = $1 AND unit_id = $2`,
    [bookingId, unitId]
  );
  if (!gearRows.length) return { ok: false, error: 'Gear Check Log row not found for this booking/unit' };
  const found = gearRows[0];
  const effectiveNowIso = nowIso || nowIsoDefault();

  let routedTo = null;
  let unitStatusUpdate = null;

  if (condition === 'Missing') {
    routedTo = 'checked_out'; // unchanged — still logically "out in the field"
    await query(
      `UPDATE gear_check_log SET condition = $1, checked_in_at = $2, notes = $3, photo_url = COALESCE($4, photo_url),
              grace_deadline = $5, recovered_at = NULL
       WHERE item_row_id = $6`,
      [condition, effectiveNowIso, notes || found.notes || '', photoUrl || null, graceDeadline || null, found.item_row_id]
    );
  } else if (condition === 'Damaged') {
    routedTo = 'damaged_pending_repair';
    unitStatusUpdate = routedTo;
    await query(
      `UPDATE gear_check_log SET condition = $1, checked_in_at = $2, notes = $3, photo_url = COALESCE($4, photo_url),
              grace_deadline = NULL
       WHERE item_row_id = $5`,
      [condition, effectiveNowIso, notes || found.notes || '', photoUrl || null, found.item_row_id]
    );
  } else {
    // Good or Recovered — cleaning/deep-clean routing.
    const unitRows = await query(`SELECT item_type, uses_since_deep_clean FROM gear_units WHERE unit_id = $1`, [unitId]);
    if (unitRows.length) {
      const threshold = (GEAR_ITEM_TYPE_CONFIG[unitRows[0].item_type] || {}).deepCleanThreshold;
      const uses = Number(unitRows[0].uses_since_deep_clean || 0);
      routedTo = (threshold && uses >= threshold) ? 'needs_deep_clean' : 'needs_cleaning';
      unitStatusUpdate = routedTo;
    }
    // recoveredAtValue is only set when condition==='Recovered' (matching
    // gearOps_checkInItem's own `if (condition === 'Recovered') set(...)`);
    // COALESCE(...,recovered_at) leaves any earlier value untouched for a
    // plain 'Good' write, same as the original never calling set() at all
    // in that case.
    const recoveredAtValue = condition === 'Recovered' ? effectiveNowIso : null;
    await query(
      `UPDATE gear_check_log SET condition = $1, checked_in_at = $2, notes = $3, photo_url = COALESCE($4, photo_url),
              grace_deadline = NULL, recovered_at = COALESCE($6::timestamptz, recovered_at)
       WHERE item_row_id = $5`,
      [condition, effectiveNowIso, notes || found.notes || '', photoUrl || null, found.item_row_id, recoveredAtValue]
    );
  }

  if (unitStatusUpdate) {
    await query(`UPDATE gear_units SET status = $1 WHERE unit_id = $2`, [unitStatusUpdate, unitId]);
  }

  // Safety net: a chargeable correction landing after this booking's
  // deposit was already reconciled.
  if (condition === 'Damaged' || condition === 'Missing') {
    try {
      const bookingRows = await query(`SELECT deposit_status FROM experience_bookings WHERE booking_id = $1`, [bookingId]);
      if (bookingRows.length && RECONCILED_DEPOSIT_STATUSES.indexOf(bookingRows[0].deposit_status) !== -1) {
        const unitRows2 = await query(`SELECT replacement_cost_cents FROM gear_units WHERE unit_id = $1`, [unitId]);
        const lateCostCents = unitRows2.length && unitRows2[0].replacement_cost_cents != null ? Number(unitRows2[0].replacement_cost_cents) : 0;
        await recordOpsAlert({
          bookingId, alertType: 'gear_condition_corrected_after_reconciliation',
          amount: lateCostCents ? lateCostCents / 100 : 0, urgency: 'urgent_same_day',
          notes: `Item ${unitId} (${found.item_name}) was marked ${condition} after this booking's deposit hold was already reconciled (depositStatus=${bookingRows[0].deposit_status}). That reconciliation ran without this item's real condition, so the deposit outcome may no longer be correct — review whether a manual charge is owed (api/apply-manual-adjustment.js or api/charge-gear-shortfall.js).`,
        });
      }
    } catch (alertErr) {
      // Never let the alert path block check-in itself.
      // eslint-disable-next-line no-console
      console.error('gear-service.checkInItem: post-reconciliation-correction alert failed (non-fatal)', bookingId, unitId, alertErr);
    }
  }

  return { ok: true, bookingId, unitId, condition, routedTo };
}

// ---------------------------------------------------------------------------
// Delivery/Return V2 (from ops-redesign-round2-actions.gs) — the two-leg
// state machine checkout-gear.js and check-in-gear-item.js already call.
// ---------------------------------------------------------------------------

async function markReadyForDelivery({ bookingId }) {
  const now = nowIsoDefault();
  const rows = await query(
    `UPDATE experience_bookings SET delivery_status = 'ready_for_delivery', delivery_ready_at = $2 WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId, now]
  );
  if (!rows.length) throw new Error('Booking not found: ' + bookingId);
  return { ok: true, bookingId, deliveryStatus: 'ready_for_delivery' };
}

async function scheduleDelivery({ bookingId, deliveryServiceType, deliveryTimeSlot }) {
  const now = nowIsoDefault();
  const rows = await query(
    `UPDATE experience_bookings SET delivery_status = 'delivery_scheduled', delivery_service_type = $2,
            delivery_time_slot = $3, delivery_scheduled_at = $4
     WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId, deliveryServiceType || '', deliveryTimeSlot || '', now]
  );
  if (!rows.length) throw new Error('Booking not found: ' + bookingId);
  return { ok: true, bookingId, deliveryStatus: 'delivery_scheduled' };
}

async function markDeliveredFinal({ bookingId, deliveredBy }) {
  const now = nowIsoDefault();
  const rows = await query(
    `UPDATE experience_bookings SET gear_delivered_at = $2, gear_delivered_by = $3, delivery_status = 'delivered'
     WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId, now, deliveredBy || '']
  );
  if (!rows.length) throw new Error('Booking not found: ' + bookingId);
  return { ok: true, bookingId, gearDeliveredAt: now, gearDeliveredBy: deliveredBy || '', deliveryStatus: 'delivered' };
}

async function schedulePickup({ bookingId, pickupServiceType, pickupAddressOverride, pickupTimeNote }) {
  const now = nowIsoDefault();
  const rows = await query(
    `UPDATE experience_bookings SET return_status = 'pickup_scheduled', pickup_service_type = $2,
            pickup_address_override = $3, pickup_time_note = $4, pickup_scheduled_at = $5
     WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId, pickupServiceType || '', pickupAddressOverride || '', pickupTimeNote || '', now]
  );
  if (!rows.length) throw new Error('Booking not found: ' + bookingId);
  return { ok: true, bookingId, returnStatus: 'pickup_scheduled' };
}

async function markPickedUp({ bookingId }) {
  const now = nowIsoDefault();
  const rows = await query(
    `UPDATE experience_bookings SET return_status = 'picked_up', picked_up_at = $2 WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId, now]
  );
  if (!rows.length) throw new Error('Booking not found: ' + bookingId);
  return { ok: true, bookingId, returnStatus: 'picked_up' };
}

async function markReturned({ bookingId }) {
  const now = nowIsoDefault();
  const rows = await query(
    `UPDATE experience_bookings SET return_status = 'returned', gear_returned_at = $2 WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId, now]
  );
  if (!rows.length) throw new Error('Booking not found: ' + bookingId);
  return { ok: true, bookingId, returnStatus: 'returned' };
}

/** Called right after every successful per-item check-in write, so Checked-In flips the instant the last item is judged. */
async function syncReturnStatusIfSettled({ bookingId, nowIso }) {
  const gearRows = await query(`SELECT unit_id, condition, grace_deadline FROM gear_check_log WHERE booking_id = $1`, [bookingId]);
  const effectiveNowIso = nowIso || nowIsoDefault();
  const settled = isBookingSettled(gearRows, effectiveNowIso);
  if (!settled) return { ok: true, bookingId, settled: false };

  const rows = await query(
    `UPDATE experience_bookings SET return_status = 'checked_in' WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId]
  );
  if (!rows.length) return { ok: false, error: 'Booking not found' };
  return { ok: true, bookingId, settled: true, returnStatus: 'checked_in' };
}

async function getReturnContext({ bookingId }) {
  const bookingRows = await query(
    `SELECT * FROM experience_bookings WHERE booking_id = $1`,
    [bookingId]
  );
  if (!bookingRows.length) return { notFound: true };
  const booking = bookingRows[0];
  const apRows = await query(
    `SELECT delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
            delivery_address_raw, delivery_window
     FROM adventure_prep WHERE booking_id = $1`,
    [bookingId]
  );
  const ap = apRows[0] || {};
  return {
    bookingId,
    deliveryAddressLine1: ap.delivery_address_line1 || '',
    deliveryAddressLine2: ap.delivery_address_line2 || '',
    deliveryCity: ap.delivery_city || '',
    deliveryState: ap.delivery_state || '',
    deliveryZip: ap.delivery_zip || '',
    deliveryAddressRaw: ap.delivery_address_raw || '',
    deliveryWindow: ap.delivery_window || '',
    deliveryStatus: booking.delivery_status || '',
    deliveryReadyAt: booking.delivery_ready_at ? new Date(booking.delivery_ready_at).toISOString() : '',
    deliveryScheduledAt: booking.delivery_scheduled_at ? new Date(booking.delivery_scheduled_at).toISOString() : '',
    deliveryTimeSlot: booking.delivery_time_slot || '',
    deliveryServiceType: booking.delivery_service_type || '',
    gearDeliveredAt: booking.gear_delivered_at ? new Date(booking.gear_delivered_at).toISOString() : '',
    gearDeliveredBy: booking.gear_delivered_by || '',
    returnStatus: booking.return_status || '',
    pickupServiceType: booking.pickup_service_type || '',
    pickupAddressOverride: booking.pickup_address_override || '',
    pickupTimeNote: booking.pickup_time_note || '',
    pickedUpAt: booking.picked_up_at ? new Date(booking.picked_up_at).toISOString() : '',
    gearReturnedAt: booking.gear_returned_at ? new Date(booking.gear_returned_at).toISOString() : '',
  };
}

async function getCheckinQueueV2({ tripDate }) {
  const rows = await query(
    `SELECT booking_id, contact_name, date, booking_status, gear_delivered_at, return_status,
            pickup_service_type, pickup_scheduled_at, picked_up_at, gear_returned_at,
            pickup_address_override, pickup_time_note
     FROM experience_bookings
     WHERE (booking_status IS NULL OR booking_status = 'active' OR booking_status = 'cancelled_post_delivery')
       AND date::text LIKE $1 || '%' AND gear_delivered_at IS NOT NULL`,
    [tripDate]
  );
  return {
    bookings: rows.map((r) => ({
      bookingId: r.booking_id, contactName: r.contact_name, tripDate: r.date,
      bookingStatus: r.booking_status || 'active',
      gearDeliveredAt: new Date(r.gear_delivered_at).toISOString(),
      returnStatus: r.return_status || '',
      pickupServiceType: r.pickup_service_type || '',
      pickupScheduledAt: r.pickup_scheduled_at ? new Date(r.pickup_scheduled_at).toISOString() : '',
      pickedUpAt: r.picked_up_at ? new Date(r.picked_up_at).toISOString() : '',
      gearReturnedAt: r.gear_returned_at ? new Date(r.gear_returned_at).toISOString() : '',
      pickupAddressOverride: r.pickup_address_override || '',
      pickupTimeNote: r.pickup_time_note || '',
    })),
  };
}

// ---------------------------------------------------------------------------
// Section 7/10: reconciliation
// ---------------------------------------------------------------------------

async function getReconciliationContext({ bookingId, nowIso }) {
  const bookingRows = await query(`SELECT * FROM experience_bookings WHERE booking_id = $1`, [bookingId]);
  if (!bookingRows.length) return { notFound: true };
  const booking = bookingRows[0];

  // Every Gear Check Log row for the booking, regardless of allocation
  // state (NOT filtered to unit_id truthy) — see isBookingSettled's own
  // header for the incident this guards against.
  const gearRows = await query(`SELECT * FROM gear_check_log WHERE booking_id = $1`, [bookingId]);
  const unitIds = gearRows.map((r) => r.unit_id).filter(Boolean);
  const unitsById = {};
  if (unitIds.length) {
    (await query(`SELECT * FROM gear_units WHERE unit_id = ANY($1::text[])`, [unitIds])).forEach((u) => { unitsById[u.unit_id] = u; });
  }

  const effectiveNowIso = nowIso || nowIsoDefault();
  const settled = isBookingSettled(gearRows, effectiveNowIso);

  const lastItemUpdateIso = gearRows.reduce((latest, r) => {
    if (!r.checked_in_at) return latest;
    const checkedInIso = new Date(r.checked_in_at).toISOString();
    if (!latest || new Date(checkedInIso).getTime() > new Date(latest).getTime()) return checkedInIso;
    return latest;
  }, null);

  const items = [];
  for (const r of gearRows) {
    const u = r.unit_id ? unitsById[r.unit_id] : null;
    const itemType = u ? (u.item_type || '') : '';
    let replacementCostCents = u
      ? (u.replacement_cost_cents != null ? Number(u.replacement_cost_cents) : await defaultReplacementCostCentsFor(itemType))
      : 0;
    if (!u && r.unit_id && (r.condition === 'Damaged' || r.condition === 'Missing')) {
      try {
        const existingAlert = await findOpenAlert({ bookingId, alertType: 'gear_reconciliation_unmatched_unit' });
        if (!existingAlert.found) {
          await recordOpsAlert({
            bookingId, alertType: 'gear_reconciliation_unmatched_unit', amount: 0, urgency: 'urgent_same_day',
            notes: `Gear Check Log row for unitId "${r.unit_id}" (${r.item_name || 'unknown item'}, condition: ${r.condition}) has no matching row in Gear Units — replacementCostCents defaulted to $0 for reconciliation purposes. Likely a typo'd, retired, or deleted unit. Review whether a manual charge (api/apply-manual-adjustment.js) is owed for this item before/after this booking's deposit resolves.`,
          });
        }
      } catch (alertErr) {
        // eslint-disable-next-line no-console
        console.error('gear-service.getReconciliationContext: unmatched-unit alert failed (non-fatal)', bookingId, alertErr);
      }
    }
    items.push({
      unitId: r.unit_id || '', itemName: r.item_name, itemType,
      condition: r.condition || '', graceDeadline: r.grace_deadline ? new Date(r.grace_deadline).toISOString() : '',
      recoveredAt: r.recovered_at ? new Date(r.recovered_at).toISOString() : '', photoUrl: r.photo_url || '',
      replacementCostCents,
    });
  }

  return {
    bookingId: booking.booking_id, tier: booking.tier, contactEmail: booking.contact_email, contactName: booking.contact_name,
    adventurePrepToken: booking.adventure_prep_token || '',
    mainPaymentIntentId: booking.main_payment_intent_id, depositPaymentIntentId: booking.deposit_payment_intent_id,
    depositStatus: booking.deposit_status || '',
    reconciledAt: booking.reconciled_at ? new Date(booking.reconciled_at).toISOString() : '',
    reconciledAmountCents: booking.reconciled_amount_cents != null ? Number(booking.reconciled_amount_cents) : null,
    gearShortfallCents: booking.gear_shortfall_cents != null ? Number(booking.gear_shortfall_cents) : null,
    shortfallChargeId: booking.shortfall_charge_id || '',
    shortfallChargedAmountCents: booking.shortfall_charged_amount_cents != null ? Number(booking.shortfall_charged_amount_cents) : null,
    shortfallChargedAt: booking.shortfall_charged_at ? new Date(booking.shortfall_charged_at).toISOString() : '',
    depositRefundId: booking.deposit_refund_id || '',
    depositRefundAmountCents: booking.deposit_refund_amount_cents || '',
    shortfallRefundId: booking.shortfall_refund_id || '',
    shortfallRefundAmountCents: booking.shortfall_refund_amount_cents || '',
    refundedAt: booking.refunded_at ? new Date(booking.refunded_at).toISOString() : '',
    settled, lastItemUpdateIso: lastItemUpdateIso || '', items,
  };
}

/** Section 7's write-back, with the renewal-vs-reconciliation CAS guard (payment-review High #14). */
async function writeReconciliation({ bookingId, depositStatus, reconciledAt, reconciledAmountCents, gearShortfallCents, stripeTransactionId, itemizedItems, expectedPaymentIntentId }) {
  let rows;
  if (expectedPaymentIntentId) {
    rows = await query(
      `UPDATE experience_bookings
       SET deposit_status = $2, reconciled_at = $3, reconciled_amount_cents = $4, gear_shortfall_cents = $5
       WHERE booking_id = $1 AND deposit_payment_intent_id = $6
       RETURNING deposit_payment_intent_id`,
      [bookingId, depositStatus, reconciledAt, reconciledAmountCents, gearShortfallCents != null ? gearShortfallCents : null, expectedPaymentIntentId]
    );
    if (!rows.length) {
      const current = await query(`SELECT deposit_payment_intent_id FROM experience_bookings WHERE booking_id = $1`, [bookingId]);
      return { ok: false, stale: true, bookingId, expectedPaymentIntentId, currentPaymentIntentId: (current[0] && current[0].deposit_payment_intent_id) || '' };
    }
  } else {
    rows = await query(
      `UPDATE experience_bookings
       SET deposit_status = $2, reconciled_at = $3, reconciled_amount_cents = $4, gear_shortfall_cents = $5
       WHERE booking_id = $1
       RETURNING deposit_payment_intent_id`,
      [bookingId, depositStatus, reconciledAt, reconciledAmountCents, gearShortfallCents != null ? gearShortfallCents : null]
    );
    if (!rows.length) throw new Error('Booking not found: ' + bookingId);
  }

  await appendAuditLog({
    bookingId, changeType: 'gear_reconciliation', beforeT3Cutoff: false,
    newValueJson: { depositStatus, reconciledAmountCents, gearShortfallCents: gearShortfallCents || 0, itemizedItems: itemizedItems || [] },
    refundOrChargeAmount: reconciledAmountCents != null ? reconciledAmountCents / 100 : null,
    stripeTransactionId: stripeTransactionId || '', staffNotes: 'Automated gear deposit reconciliation.',
  });

  return { ok: true, bookingId };
}

async function listReconciliationQueue() {
  const rows = await query(
    `SELECT booking_id, contact_name, date, deposit_status, reconciled_amount_cents, gear_shortfall_cents,
            reconciled_at, shortfall_charged_amount_cents, shortfall_charged_at
     FROM experience_bookings
     WHERE deposit_status = 'full_capture_pending_review' OR deposit_status = 'shortfall_charged'`
  );
  return {
    bookings: rows.map((r) => ({
      bookingId: r.booking_id, contactName: r.contact_name, tripDate: r.date,
      depositStatus: r.deposit_status, reconciledAmountCents: r.reconciled_amount_cents,
      gearShortfallCents: r.gear_shortfall_cents, reconciledAt: r.reconciled_at ? new Date(r.reconciled_at).toISOString() : '',
      shortfallChargedAmountCents: r.shortfall_charged_amount_cents || '',
      shortfallChargedAt: r.shortfall_charged_at ? new Date(r.shortfall_charged_at).toISOString() : '',
    })),
  };
}

// ---------------------------------------------------------------------------
// Shortfall charge (Section 10) — CAS claim/release, write-backs, guest token
// ---------------------------------------------------------------------------

const SHORTFALL_CHARGE_LOCK_STALE_MS = 5 * 60 * 1000;

/** Atomically claims the booking for a shortfall-charge attempt — see payment-review High #17's own reasoning, reproduced via a single guarded UPDATE rather than LockService. */
async function beginShortfallCharge({ bookingId, nowIso }) {
  const now = nowIso || nowIsoDefault();
  const staleBefore = new Date(Date.now() - SHORTFALL_CHARGE_LOCK_STALE_MS).toISOString();

  const claimRows = await query(
    `UPDATE experience_bookings SET deposit_status = 'shortfall_charge_in_progress', shortfall_charge_lock_at = $2
     WHERE booking_id = $1
       AND (
         deposit_status = 'full_capture_pending_review'
         OR (deposit_status = 'shortfall_charge_in_progress' AND shortfall_charge_lock_at < $3)
       )
     RETURNING booking_id`,
    [bookingId, now, staleBefore]
  );
  if (claimRows.length) return { ok: true, bookingId };

  const current = await query(`SELECT deposit_status, shortfall_charge_lock_at FROM experience_bookings WHERE booking_id = $1`, [bookingId]);
  const currentStatus = current.length ? current[0].deposit_status : '';
  if (currentStatus === 'shortfall_charge_in_progress') {
    const lockAt = current[0].shortfall_charge_lock_at;
    const lockAgeMs = lockAt ? (Date.now() - new Date(lockAt).getTime()) : Infinity;
    return { ok: false, reason: 'charge_in_progress', depositStatus: currentStatus, lockAgeMs };
  }
  return { ok: false, reason: 'not_in_review_state', depositStatus: currentStatus };
}

async function recordShortfallCharge({ bookingId, shortfallChargeId, shortfallChargedAmountCents, shortfallChargedAt, staffNotes }) {
  const existing = await query(`SELECT shortfall_charge_id FROM experience_bookings WHERE booking_id = $1`, [bookingId]);
  const existingChargeId = existing.length ? String(existing[0].shortfall_charge_id || '') : '';
  const alreadyRecorded = !!(existingChargeId && shortfallChargeId && existingChargeId === String(shortfallChargeId));

  await query(
    `UPDATE experience_bookings
     SET deposit_status = 'shortfall_charged', shortfall_charge_id = $2, shortfall_charged_amount_cents = $3,
         shortfall_charged_at = $4, shortfall_staff_notes = $5, shortfall_charge_pending_payment_intent_id = ''
     WHERE booking_id = $1`,
    [bookingId, shortfallChargeId, shortfallChargedAmountCents, shortfallChargedAt, staffNotes || '']
  );

  if (!alreadyRecorded) {
    await appendAuditLog({
      bookingId, changeType: 'gear_shortfall_charge', beforeT3Cutoff: false,
      refundOrChargeAmount: shortfallChargedAmountCents != null ? shortfallChargedAmountCents / 100 : null,
      stripeTransactionId: shortfallChargeId || '', staffNotes: staffNotes || '',
    });
  }
  return { ok: true, bookingId };
}

async function recordShortfallChargeFailure({ bookingId, detail, pendingPaymentIntentId }) {
  await query(
    `UPDATE experience_bookings
     SET deposit_status = CASE WHEN deposit_status = 'shortfall_charge_in_progress' THEN 'full_capture_pending_review' ELSE deposit_status END,
         shortfall_charge_pending_payment_intent_id = $2
     WHERE booking_id = $1`,
    [bookingId, pendingPaymentIntentId || '']
  );
  await appendAuditLog({
    bookingId, changeType: 'gear_shortfall_charge_failed', beforeT3Cutoff: false,
    staffNotes: detail || 'Shortfall charge attempt failed.',
  });
  return { ok: true, bookingId };
}

/** Guest-token auth for the self-service 3DS-completion flow. */
async function shortfallPaymentGetBookingForToken({ bookingId, token }) {
  const rows = await query(`SELECT * FROM experience_bookings WHERE booking_id = $1`, [bookingId]);
  if (!rows.length) return { notFound: true };
  const booking = rows[0];
  if (!booking.adventure_prep_token || String(booking.adventure_prep_token) !== String(token)) {
    return { unauthorized: true };
  }
  const openAlert = await findOpenAlert({ bookingId: booking.booking_id, alertType: 'gear_shortfall_charge_failed' });
  if (!openAlert.found) return { noOpenIssue: true };
  if (!booking.shortfall_charge_pending_payment_intent_id) return { noResolvablePayment: true };
  return {
    ok: true, bookingId: booking.booking_id,
    pendingPaymentIntentId: booking.shortfall_charge_pending_payment_intent_id,
    contactName: booking.contact_name,
  };
}

// ---------------------------------------------------------------------------
// Refund (Section 10 addendum)
// ---------------------------------------------------------------------------

async function recordRefund({ bookingId, refundTarget, refundId, refundAmountCents, refundedAt, staffNotes }) {
  // Atomic accumulation (COALESCE(col,0)+$x computed server-side) — an
  // improvement over the .gs original's read-then-write, which was only
  // safe under LockService's single global lock and would otherwise be a
  // lost-update race between two concurrent partial refunds.
  const isShortfall = refundTarget === 'shortfall';
  const updateSql = isShortfall
    ? `UPDATE experience_bookings
       SET shortfall_refund_id = $2, shortfall_refund_amount_cents = COALESCE(shortfall_refund_amount_cents, 0) + $3,
           refunded_at = $4, refund_staff_notes = $5
       WHERE booking_id = $1
       RETURNING deposit_status, reconciled_amount_cents, shortfall_charged_amount_cents, deposit_refund_amount_cents, shortfall_refund_amount_cents`
    : `UPDATE experience_bookings
       SET deposit_refund_id = $2, deposit_refund_amount_cents = COALESCE(deposit_refund_amount_cents, 0) + $3,
           refunded_at = $4, refund_staff_notes = $5
       WHERE booking_id = $1
       RETURNING deposit_status, reconciled_amount_cents, shortfall_charged_amount_cents, deposit_refund_amount_cents, shortfall_refund_amount_cents`;

  const rows = await query(updateSql, [bookingId, refundId, Number(refundAmountCents || 0), refundedAt, staffNotes || '']);
  if (!rows.length) throw new Error('Booking not found: ' + bookingId);
  const after = rows[0];
  const cumulativeRefundAmountCents = isShortfall ? Number(after.shortfall_refund_amount_cents || 0) : Number(after.deposit_refund_amount_cents || 0);

  // Advance to the terminal 'refunded' status once everything actually
  // captured/charged has been fully refunded (payment-review Medium #35).
  if (after.deposit_status === 'full_capture_pending_review' || after.deposit_status === 'shortfall_charged') {
    const reconciledAmountCents = Number(after.reconciled_amount_cents || 0);
    const shortfallChargedAmountCents = Number(after.shortfall_charged_amount_cents || 0);
    const depositRefundedCents = Number(after.deposit_refund_amount_cents || 0);
    const shortfallRefundedCents = Number(after.shortfall_refund_amount_cents || 0);
    const depositFullyRefunded = reconciledAmountCents <= 0 || depositRefundedCents >= reconciledAmountCents;
    const shortfallFullyRefunded = shortfallChargedAmountCents <= 0 || shortfallRefundedCents >= shortfallChargedAmountCents;
    if (depositFullyRefunded && shortfallFullyRefunded) {
      await query(
        `UPDATE experience_bookings SET deposit_status = 'refunded'
         WHERE booking_id = $1 AND deposit_status IN ('full_capture_pending_review', 'shortfall_charged')`,
        [bookingId]
      );
    }
  }

  await appendAuditLog({
    bookingId, changeType: 'gear_refund', beforeT3Cutoff: false,
    refundOrChargeAmount: refundAmountCents != null ? -Math.abs(refundAmountCents) / 100 : null,
    stripeTransactionId: refundId || '', staffNotes: '[' + (refundTarget || 'deposit') + '] ' + (staffNotes || ''),
  });

  return { ok: true, bookingId, cumulativeRefundAmountCents };
}

// ---------------------------------------------------------------------------
// Section 8: hold-renewal safety net (candidate list also reused by
// api/trigger-gear-reconciliation.js)
// ---------------------------------------------------------------------------

async function listHoldRenewalCandidates() {
  const rows = await query(
    `SELECT booking_id, date, deposit_hold_renewed_at, main_payment_intent_id, deposit_payment_intent_id, contact_email, contact_name
     FROM experience_bookings
     WHERE (booking_status = 'active' OR booking_status IS NULL OR booking_status = 'cancelled_post_delivery')
       AND deposit_status = 'held'`
  );
  return {
    bookings: rows.map((r) => ({
      bookingId: r.booking_id, tripDate: r.date, depositHoldRenewedAt: r.deposit_hold_renewed_at ? new Date(r.deposit_hold_renewed_at).toISOString() : '',
      mainPaymentIntentId: r.main_payment_intent_id, depositPaymentIntentId: r.deposit_payment_intent_id,
      contactEmail: r.contact_email, contactName: r.contact_name,
    })),
  };
}

async function recordHoldRenewed({ bookingId, renewedAt, oldPaymentIntentId, newPaymentIntentId, oldHoldCancelSucceeded }) {
  const now = renewedAt || nowIsoDefault();
  const rows = await query(
    `UPDATE experience_bookings SET deposit_hold_renewed_at = $2 WHERE booking_id = $1 RETURNING booking_id`,
    [bookingId, now]
  );
  if (!rows.length) throw new Error('Booking not found: ' + bookingId);

  const cancelSucceeded = oldHoldCancelSucceeded !== false;
  const cancelNote = cancelSucceeded ? 'cancelled' : 'NOT cancelled (cancel attempt failed — still live, see Ops Alerts for detail)';
  await appendAuditLog({
    bookingId, changeType: 'gear_hold_renewed', beforeT3Cutoff: false,
    staffNotes: `Old hold ${oldPaymentIntentId || ''} ${cancelNote}, new hold ${newPaymentIntentId || ''} placed by the automated 3-day safety net.`,
  });
  return { ok: true, bookingId };
}

module.exports = {
  GEAR_ITEM_TYPE_CONFIG,
  GEAR_ITEM_NAME_TO_TYPE,
  recordOpsAlert,
  findOpenAlert,
  // Units CRUD
  listUnits, addUnit, retireUnit, markClean, markDeepCleaned,
  // Availability
  checkAvailabilityRaw,
  // Allocation
  resolveBackpackType, allocateUnits, getAllocation, recordShortageResolution,
  // Checkout V1
  getCheckoutQueue, confirmCheckoutScan, markDelivered,
  // Checkin V1
  isBookingSettled, getCheckinQueue, getCheckinContext, checkInItem,
  // Delivery/Return V2
  markReadyForDelivery, scheduleDelivery, markDeliveredFinal,
  schedulePickup, markPickedUp, markReturned, syncReturnStatusIfSettled,
  getReturnContext, getCheckinQueueV2,
  // Reconciliation
  getReconciliationContext, writeReconciliation, listReconciliationQueue,
  // Shortfall
  beginShortfallCharge, recordShortfallCharge, recordShortfallChargeFailure, shortfallPaymentGetBookingForToken,
  // Refund
  recordRefund,
  // Hold renewal
  listHoldRenewalCandidates, recordHoldRenewed,
};
