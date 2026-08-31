/* ============================================
   PSAC — Kit-count debounce finalization logic (Postgres rewrite)

   Postgres replacement for lib/finalize-kit-change.js's Apps-Script-calling
   version — same job: once a pending kit-count change's debounce window has
   closed, compute the delta against the last confirmed count, issue the
   Stripe refund or off-session charge, and regenerate the Gear Check Log
   rows atomically with it. Called only by api/process-pending-kit-
   changes.js's cron tick, same as before.

   Every Stripe-calling function (stripeAuthHeader/stripeGet/stripePost,
   opsAlertUrgency, the TIERS map, the whole charge/refund decision tree) is
   UNCHANGED from the pre-migration version — none of that ever touched
   Apps Script, so none of it needed rewriting. What changed is everything
   that used to go through callBookingsWebApp: reading kit context/roster,
   and the write-back (adventurePrep_finalizeKitChange) that applies the
   confirmed-count/Gear Check Log/duffel/audit-log changes together.

   ============================================================================
   WHAT CHANGED, AND WHY
   ============================================================================

   1. THE WRITE-BACK'S CAS GUARD IS NOW A REAL GUARDED UPDATE, NOT A
      LOCKED READ-THEN-COMPARE. adventurePrep_finalizeKitChange's own
      `expectedConfirmedKitCount` staleness check (added payment-review,
      Aug 2026, Medium #38 — refuses to blindly overwrite confirmedKitCount
      if a concurrent staff correction already changed it) is now a single
      `UPDATE ... WHERE confirmed_kit_count = expected` — Postgres already
      makes that atomic, no LockService needed. Zero rows updated means the
      guard fired; the caller re-reads the current value to report it,
      exactly like the old function's own {ok:false, stale:true, ...}
      response.

   2. GEAR CHECK LOG ROSTER COMES FROM booking_participants (attending
      rows), NOT reconfirmedRosterJson.

   3. AUDIT LOG (was "Adventure Prep Change Log" sheet) IS THE audit_log
      TABLE. schema.sql's audit_log already has every column the old
      sheet's appendChangeLog_ wrote (change_type/timestamp/
      before_t3_cutoff/old_value_json/new_value_json/delta/
      refund_or_charge_amount/stripe_transaction_id/staff_notes/
      triggering_input) — confirmed column-for-column before writing this,
      not assumed.

   4. BUG FOUND AND FIXED, FLAG FOR AIREY: the old gearLogAdd loop (inside
      adventurePrep_finalizeKitChange) only ever created 4 items per added
      kit — backpack, 2 bottles, poles — silently missing the 5th item
      ('Hard-Shell First Aid Kit') that buildGearLogRows already includes
      for every kit created AT BOOKING TIME. So a kit added via a post-
      booking increase never got a first-aid-kit row, while a kit present
      from the original booking always did — a real, live inconsistency,
      not a deliberate design difference (nothing in any PRD says a
      post-booking kit should be missing an item type an original kit
      gets). Fixed here to add all 5 items, matching buildGearLogRows
      exactly. FLAG FOR AIREY: confirm this is the right call — if the
      first-aid-kit omission on kit-count increases was actually
      intentional for some reason not written down anywhere, say so and
      this gets reverted to the old 4-item behavior instead.

   5. TWO NEW EXPORTS CLOSE THE OTHER HALF OF THIS GAP:
      getKitAdjustContextByToken/setPendingKitChange (the debounce-SETTING
      side, called by api/adventure-prep.js's adjustGearKitCount action —
      a guest moving the kit-count stepper) and listPendingKitChanges
      (replaces api/process-pending-kit-changes.js's own
      callBookingsWebApp('adventurePrep_listPendingKitChanges', {}) cron-
      discovery call). Both were necessary, not optional extras: a
      Postgres-only booking's pending change would never be set correctly,
      and even if it were, the cron's old Apps-Script-aimed listing call
      would never find it, so the debounce loop would silently never close
      for any real post-cutover booking without both of these moving too.

   6. BUG FIX (2026-08-31, roster/gear-kit ID-link fix): a kit added here
      (post-booking increase) now carries the real participant_id of the
      attending roster member it was positionally assigned to, not just a
      denormalized person_name string — getAttendingRosterNames (renamed
      getAttendingRoster) now returns participant_id alongside display_name,
      and the gear_check_log INSERT below writes it through. Same
      positional "k-th newly-added kit -> k-th attending roster member by
      roster_index" assignment as before — unchanged, just carrying the ID
      that assignment already implied.
   ============================================ */

'use strict';

const { sql, query, transaction } = require('./db');
const { genId } = require('./ids');
const { sendEmail } = require('./send-email');
const { renderKitChargeFailedEmail } = require('./email-templates/kit-charge-failed-email');
const { renderKitRefundFailedEmail } = require('./email-templates/kit-refund-failed-email');

// UNCHANGED from the pre-migration version — deliberately duplicated
// rather than imported, matching this repo's existing convention (see
// create-deposit-hold.js / create-payment-intent.js, which each keep
// their own copy too).
var TIERS = {
  trail: { name: 'Trail Guide Experience', gear: 65 },
  p2p: { name: 'Peaks to Pools Experience', gear: 100 },
};

// Matches lib/booking-service.js's ITEM_COSTS (dollars, not cents) — see
// this file's header comment, point 4, for why the first-aid-kit row is
// now included on every added kit, matching buildGearLogRows.
var ITEM_COSTS = {
  'Gregory Miko 20L Backpack': 159,
  'Hydro Flask Big Mouth 32oz Bottle': 42,
  'Leki Khumbu Lite Trekking Poles': 129,
  'REI Pack Mule 90L Duffel': 159,
  'Hard-Shell First Aid Kit': 9.99,
};
var KIT_ITEM_NAMES = [
  'Gregory Miko 20L Backpack',
  'Hydro Flask Big Mouth 32oz Bottle',
  'Hydro Flask Big Mouth 32oz Bottle',
  'Leki Khumbu Lite Trekking Poles',
  'Hard-Shell First Aid Kit',
];

function stripeAuthHeader() {
  return 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64');
}

async function stripeGet(path) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: stripeAuthHeader() },
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function stripePost(path, params, idempotencyKey) {
  const headers = {
    Authorization: stripeAuthHeader(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

function opsAlertUrgency(tripDateStr) {
  if (!tripDateStr) return 'standard_24hr';
  const m = String(tripDateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 'standard_24hr';
  const tripDate = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const hoursToTrip = (tripDate.getTime() - Date.now()) / (1000 * 60 * 60);
  return hoursToTrip <= 48 ? 'urgent_same_day' : 'standard_24hr';
}

async function recordOpsAlert({ bookingId, alertType, amount, stripeErrorDetail, urgency, notes }) {
  await query(
    `INSERT INTO ops_alerts (alert_id, booking_id, alert_type, amount, stripe_error_detail, urgency, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [genId('ALERT'), bookingId || null, alertType, amount != null ? amount : null, stripeErrorDetail || null, urgency, notes || null]
  );
}

async function appendAuditLog(entry) {
  await query(
    `INSERT INTO audit_log (
       audit_id, booking_id, change_type, before_t3_cutoff, old_value_json,
       new_value_json, delta, refund_or_charge_amount, stripe_transaction_id, staff_notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      genId('AUDIT'), entry.bookingId, entry.changeType, !!entry.beforeT3Cutoff,
      JSON.stringify(entry.oldValueJson || {}), JSON.stringify(entry.newValueJson || {}),
      entry.delta != null ? entry.delta : null, entry.refundOrChargeAmount != null ? entry.refundOrChargeAmount : null,
      entry.stripeTransactionId || '', entry.staffNotes || '',
    ]
  );
}

async function getKitContext(bookingId) {
  const rows = await sql`
    SELECT eb.booking_id, eb.tier, eb.date, eb.main_payment_intent_id, eb.gear_kit_count,
           eb.contact_email, eb.contact_name, eb.duffel_count,
           ap.confirmed_kit_count, ap.pending_kit_count, ap.pending_since
    FROM experience_bookings eb
    LEFT JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
    WHERE eb.booking_id = ${bookingId}
  `;
  return rows[0] || null;
}

/**
 * BUG FIX (2026-08-31, roster/gear-kit ID-link fix): renamed from
 * getAttendingRosterNames and now returns participant_id alongside
 * display_name (previously display_name only) — see this file's header
 * comment, point 6.
 */
async function getAttendingRoster(bookingId) {
  const rows = await sql`
    SELECT participant_id, display_name FROM booking_participants
    WHERE experience_booking_id = ${bookingId} AND is_participating = true
    ORDER BY roster_index
  `;
  return rows.map((r) => ({ participantId: r.participant_id, displayName: r.display_name }));
}

/**
 * Token-scoped lookup for api/adventure-prep.js's adjustGearKitCount
 * handler — this is the debounce-SETTING side (a guest moving the kit-
 * count stepper), a completely different operation from
 * finalizePendingKitChange above (the cron tick that actually bills/
 * refunds once the debounce window closes). Kept in this file rather than
 * lib/adventure-prep-service.js because it's kit-billing-adjacent context
 * (confirmedKitCount, gearKitCount, tier/date for the T-3 cutoff check),
 * matching the file split adventure-prep-service.js's own header comment
 * already calls out ("the gear-kit debounce actions ... —
 * lib/finalize-kit-change.js's own rewrite").
 */
async function getKitAdjustContextByToken(token) {
  const rows = await sql`
    SELECT eb.booking_id, eb.tier, eb.date, eb.gear_kit_count, eb.booking_status,
           ap.confirmed_kit_count
    FROM experience_bookings eb
    LEFT JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
    WHERE eb.adventure_prep_token = ${token}
  `;
  return rows[0] || null;
}

/**
 * Sets (or clears) the pending kit-count debounce fields. adventure_prep's
 * row is guaranteed to already exist by the time a guest can reach this
 * screen (getContextByToken auto-creates it on first Surface A visit), but
 * the ON CONFLICT upsert is kept here anyway rather than assumed, same
 * "don't assume, some other call already did it" posture as
 * applyKitChangeWriteBack's own guarded UPDATE above.
 */
async function setPendingKitChange({ bookingId, pendingKitCount, pendingSince }) {
  await sql`
    INSERT INTO adventure_prep (booking_id, pending_kit_count, pending_since)
    VALUES (${bookingId}, ${pendingKitCount}, ${pendingSince})
    ON CONFLICT (booking_id) DO UPDATE SET pending_kit_count = EXCLUDED.pending_kit_count, pending_since = EXCLUDED.pending_since
  `;
}

/**
 * Postgres replacement for api/process-pending-kit-changes.js's own
 * callBookingsWebApp('adventurePrep_listPendingKitChanges', {}) call — the
 * cron's discovery step. Same launch-blocking reasoning as everywhere else
 * in this migration: a Postgres-only booking's pending kit-count change
 * (set via adjustGearKitCount, now Postgres-native) would never be found
 * by a listing call still aimed at the old Apps Script backend, so this
 * had to move too, not just the finalize step itself, for the debounce
 * loop to actually close for any real post-cutover booking.
 */
async function listPendingKitChanges() {
  const rows = await sql`
    SELECT eb.booking_id, eb.date, ap.pending_since
    FROM adventure_prep ap
    JOIN experience_bookings eb ON eb.booking_id = ap.booking_id
    WHERE ap.pending_kit_count IS NOT NULL
  `;
  return rows.map((r) => ({ bookingId: r.booking_id, date: r.date, pendingSince: r.pending_since }));
}

/**
 * Applies the confirmed-count/Gear Check Log/duffel/audit-log changes
 * together. Reads (which specific gear_check_log rows to remove) happen
 * BEFORE the atomic write batch, same reasoning as lib/booking-service.js's
 * own header comment on lib/db.js's "no interdependent read-then-write in
 * one transaction() call" constraint — the only value that genuinely needs
 * read-then-guarded-write atomicity is confirmed_kit_count itself, and that
 * guard is a single UPDATE ... WHERE, already atomic on its own.
 *
 * @returns {Promise<{ok: boolean, stale?: boolean, currentConfirmedKitCount?: number}>}
 */
async function applyKitChangeWriteBack({
  bookingId, newConfirmedKitCount, oldConfirmedKitCount, delta, refundOrChargeAmount,
  stripeTransactionId, gearLogAddKitNumbers, gearLogRemoveCount, newDuffelCount, duffelDelta,
  beforeT3Cutoff, staffNotes, expectedConfirmedKitCount,
}) {
  if (expectedConfirmedKitCount != null) {
    const guardedRows = await sql`
      UPDATE adventure_prep SET confirmed_kit_count = ${newConfirmedKitCount}, pending_kit_count = NULL, pending_since = NULL
      WHERE booking_id = ${bookingId} AND confirmed_kit_count = ${expectedConfirmedKitCount}
      RETURNING confirmed_kit_count
    `;
    if (guardedRows.length === 0) {
      const currentRows = await sql`SELECT confirmed_kit_count FROM adventure_prep WHERE booking_id = ${bookingId}`;
      return { ok: false, stale: true, bookingId, expectedConfirmedKitCount, currentConfirmedKitCount: currentRows[0] && currentRows[0].confirmed_kit_count };
    }
  } else {
    await sql`
      UPDATE adventure_prep SET confirmed_kit_count = ${newConfirmedKitCount}, pending_kit_count = NULL, pending_since = NULL
      WHERE booking_id = ${bookingId}
    `;
  }

  // Rows to remove (kit-numbered items, highest kit numbers first) —
  // decided from a pre-transaction read, same "which physical unit this
  // should release, if any, is a genuinely open question" caveat the old
  // system's own comment already carried; this is a placeholder-row
  // removal, not a real unit release, unchanged in that respect.
  let kitRowsToDelete = [];
  if (gearLogRemoveCount > 0) {
    const openKitRows = await sql`
      SELECT item_row_id, kit_number FROM gear_check_log
      WHERE booking_id = ${bookingId} AND kit_number IS NOT NULL AND checked_out_at IS NULL
    `;
    const byKit = {};
    openKitRows.forEach((r) => {
      const k = String(r.kit_number);
      (byKit[k] = byKit[k] || []).push(r.item_row_id);
    });
    const kitNumbers = Object.keys(byKit).map(Number).sort((a, b) => b - a);
    const toRemove = kitNumbers.slice(0, gearLogRemoveCount);
    toRemove.forEach((k) => { kitRowsToDelete = kitRowsToDelete.concat(byKit[String(k)]); });
  }

  let duffelRowsToDelete = [];
  if (duffelDelta < 0) {
    const openDuffelRows = await sql`
      SELECT item_row_id FROM gear_check_log
      WHERE booking_id = ${bookingId} AND kit_number IS NULL AND item_name = 'REI Pack Mule 90L Duffel' AND checked_out_at IS NULL
      LIMIT ${Math.abs(duffelDelta)}
    `;
    duffelRowsToDelete = openDuffelRows.map((r) => r.item_row_id);
  }

  await transaction((txSql) => {
    const queries = [];

    (gearLogAddKitNumbers || []).forEach(({ kitNumber, personName, participantId }) => {
      KIT_ITEM_NAMES.forEach((itemName) => {
        queries.push(txSql`
          INSERT INTO gear_check_log (item_row_id, booking_id, kit_number, person_name, participant_id, item_name, item_cost, notes)
          VALUES (${genId().replace(/-.*/, '')}, ${bookingId}, ${kitNumber}, ${personName || `Kit ${kitNumber}`}, ${participantId || null}, ${itemName}, ${ITEM_COSTS[itemName] || null}, 'added via adjust-gear-kit-count.js')
        `);
      });
    });

    kitRowsToDelete.forEach((id) => {
      queries.push(txSql`DELETE FROM gear_check_log WHERE item_row_id = ${id}`);
    });

    if (duffelDelta > 0) {
      for (let i = 0; i < duffelDelta; i++) {
        queries.push(txSql`
          INSERT INTO gear_check_log (item_row_id, booking_id, kit_number, person_name, item_name, item_cost, notes)
          VALUES (${genId().replace(/-.*/, '')}, ${bookingId}, NULL, 'Shared', 'REI Pack Mule 90L Duffel', ${ITEM_COSTS['REI Pack Mule 90L Duffel']}, 'added via adjust-gear-kit-count.js')
        `);
      }
    }
    duffelRowsToDelete.forEach((id) => {
      queries.push(txSql`DELETE FROM gear_check_log WHERE item_row_id = ${id}`);
    });

    if (newDuffelCount != null) {
      queries.push(txSql`UPDATE experience_bookings SET duffel_count = ${newDuffelCount} WHERE booking_id = ${bookingId}`);
    }

    return queries;
  });

  await appendAuditLog({
    bookingId,
    changeType: 'kit_count',
    beforeT3Cutoff: !!beforeT3Cutoff,
    oldValueJson: { confirmedKitCount: oldConfirmedKitCount },
    newValueJson: { confirmedKitCount: newConfirmedKitCount },
    delta,
    refundOrChargeAmount,
    stripeTransactionId,
    staffNotes: staffNotes || '',
  });

  return { ok: true };
}

/**
 * @param {object} opts
 * @param {string} opts.bookingId
 * @param {boolean} opts.beforeT3Cutoff
 * @returns {Promise<{outcome: 'no_change'|'charged'|'refunded'|'requires_action'|'unavailable'|'failed'|'race_with_manual_correction', detail?: string}>}
 */
async function finalizePendingKitChange({ bookingId, beforeT3Cutoff }) {
  const ctx = await getKitContext(bookingId);
  if (!ctx) {
    return { outcome: 'failed', detail: 'booking_not_found' };
  }

  const pending = ctx.pending_kit_count;
  if (pending === '' || pending === null || pending === undefined) {
    return { outcome: 'no_change', detail: 'no pending change recorded' };
  }

  // Same [1,20] clamp on BOTH bounds as the pre-migration version — see
  // its own comment: every booking requires at least 1 kit, and both the
  // requested value and the stored confirmed value are defensively
  // clamped regardless of what wrote them.
  const currentConfirmed = Math.max(1, Math.min(20, parseInt(ctx.confirmed_kit_count, 10) || 1));
  const requested = Math.max(1, Math.min(20, parseInt(pending, 10) || 1));
  const delta = requested - currentConfirmed;

  const oldDuffelCount = Math.ceil(currentConfirmed / 2);
  const newDuffelCount = Math.ceil(requested / 2);
  const duffelDelta = newDuffelCount - oldDuffelCount;

  if (delta === 0) {
    await applyKitChangeWriteBack({
      bookingId, newConfirmedKitCount: requested, oldConfirmedKitCount: currentConfirmed,
      delta: 0, refundOrChargeAmount: 0, stripeTransactionId: '',
      gearLogAddKitNumbers: [], gearLogRemoveCount: 0, newDuffelCount, duffelDelta,
      beforeT3Cutoff, staffNotes: 'No net change at debounce finalization.',
    });
    return { outcome: 'no_change' };
  }

  const tierKey = String(ctx.tier || '');
  const tier = TIERS[tierKey];
  if (!tier) {
    return { outcome: 'failed', detail: 'unknown or unsupported tier for kit-count billing: ' + tierKey };
  }
  if (!ctx.main_payment_intent_id) {
    return { outcome: 'failed', detail: 'booking has no main PaymentIntent on file' };
  }

  const mainRes = await stripeGet('payment_intents/' + encodeURIComponent(ctx.main_payment_intent_id));
  if (!mainRes.ok) {
    return { outcome: 'failed', detail: 'could not retrieve main PaymentIntent' };
  }
  const customerId = mainRes.data.customer;
  const paymentMethodId = mainRes.data.payment_method;

  const roster = await getAttendingRoster(bookingId);

  let outcome;
  let stripeTransactionId = '';
  let refundOrChargeAmount = Math.abs(delta) * tier.gear;
  let chargeErrorDetail = '';
  let refundErrorDetail = '';

  if (delta > 0) {
    if (!customerId || !paymentMethodId) {
      outcome = 'unavailable';
      chargeErrorDetail = 'No saved card on file to run an off-session charge against.';
    } else {
      const params = new URLSearchParams();
      params.append('amount', String(Math.round(refundOrChargeAmount * 100)));
      params.append('currency', 'usd');
      params.append('customer', customerId);
      params.append('payment_method', paymentMethodId);
      params.append('payment_method_types[]', 'card');
      params.append('off_session', 'true');
      params.append('confirm', 'true');
      params.append('description', 'Gear kit count increase (+' + delta + ') — Palm Springs Adventure Club');
      params.append('metadata[kind]', 'kit_count_delta_charge');
      params.append('metadata[bookingId]', bookingId);
      params.append('metadata[delta]', String(delta));

      const chargeRes = await stripePost('payment_intents', params, 'kitchg_' + bookingId + '_' + currentConfirmed + '_' + requested);
      if (!chargeRes.ok) {
        outcome = 'failed';
        chargeErrorDetail = (chargeRes.data && chargeRes.data.error && chargeRes.data.error.message) || 'Stripe API error creating the charge.';
      } else if (chargeRes.data.status === 'requires_action') {
        outcome = 'requires_action';
        stripeTransactionId = chargeRes.data.id;
        chargeErrorDetail = 'Card requires additional authentication (3D Secure) before the charge can complete.';
      } else if (chargeRes.data.status === 'succeeded' || chargeRes.data.status === 'processing') {
        outcome = 'charged';
        stripeTransactionId = chargeRes.data.id;
      } else {
        outcome = 'failed';
        chargeErrorDetail = 'Unexpected PaymentIntent status: ' + chargeRes.data.status;
      }
    }
  } else {
    const params = new URLSearchParams();
    params.append('payment_intent', ctx.main_payment_intent_id);
    params.append('amount', String(Math.round(refundOrChargeAmount * 100)));
    params.append('metadata[kind]', 'kit_count_delta_refund');
    params.append('metadata[bookingId]', bookingId);
    params.append('metadata[delta]', String(delta));

    const refundRes = await stripePost('refunds', params, 'kitrfnd_' + bookingId + '_' + currentConfirmed + '_' + requested);
    if (!refundRes.ok) {
      outcome = 'failed';
      refundErrorDetail = (refundRes.data && refundRes.data.error && refundRes.data.error.message) || 'Stripe API error creating the refund.';
    } else {
      outcome = 'refunded';
      stripeTransactionId = refundRes.data.id;
    }
  }

  const gearLogAddKitNumbers = [];
  if (delta > 0 && (outcome === 'charged' || outcome === 'requires_action')) {
    for (let k = currentConfirmed + 1; k <= requested; k++) {
      const rosterEntry = roster[k - 1];
      gearLogAddKitNumbers.push({
        kitNumber: k,
        personName: rosterEntry ? rosterEntry.displayName : null,
        participantId: rosterEntry ? rosterEntry.participantId : null,
      });
    }
  }
  const gearLogRemoveCount = delta < 0 && outcome === 'refunded' ? Math.abs(delta) : 0;

  const CHARGE_FAILURE_OUTCOMES = ['requires_action', 'unavailable', 'failed'];
  if (delta > 0 && CHARGE_FAILURE_OUTCOMES.indexOf(outcome) !== -1) {
    try {
      await recordOpsAlert({
        bookingId,
        alertType: 'kit_charge_failed',
        amount: refundOrChargeAmount,
        stripeErrorDetail: chargeErrorDetail || ('Charge outcome: ' + outcome),
        urgency: opsAlertUrgency(ctx.date),
      });
    } catch (alertErr) {
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: failed to record kit_charge_failed Ops Alert', bookingId, alertErr);
    }
    if (ctx.contact_email) {
      try {
        await sendEmail({
          to: ctx.contact_email,
          subject: "We couldn't process your gear kit change",
          html: renderKitChargeFailedEmail({
            logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
            guestName: ctx.contact_name || '',
            amount: refundOrChargeAmount,
          }),
        });
      } catch (emailErr) {
        // eslint-disable-next-line no-console
        console.error('finalizePendingKitChange: failed to send charge-failure email', bookingId, emailErr);
      }
    } else {
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: no contactEmail on file, guest not notified of charge failure', bookingId);
    }
  }

  if (delta < 0 && outcome === 'failed') {
    try {
      await recordOpsAlert({
        bookingId,
        alertType: 'kit_refund_failed',
        amount: refundOrChargeAmount,
        stripeErrorDetail: refundErrorDetail || 'Refund outcome: failed',
        urgency: 'standard_24hr',
      });
    } catch (alertErr) {
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: failed to record kit_refund_failed Ops Alert', bookingId, alertErr);
    }
    if (ctx.contact_email) {
      try {
        await sendEmail({
          to: ctx.contact_email,
          subject: "We couldn't process your refund",
          html: renderKitRefundFailedEmail({
            logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
            guestName: ctx.contact_name || '',
            amount: refundOrChargeAmount,
          }),
        });
      } catch (emailErr) {
        // eslint-disable-next-line no-console
        console.error('finalizePendingKitChange: failed to send refund-failure email', bookingId, emailErr);
      }
    } else {
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: no contactEmail on file, guest not notified of refund failure', bookingId);
    }
  }

  if (outcome === 'charged' || outcome === 'refunded') {
    let writeBackResult;
    try {
      writeBackResult = await applyKitChangeWriteBack({
        bookingId,
        newConfirmedKitCount: requested,
        oldConfirmedKitCount: currentConfirmed,
        delta,
        refundOrChargeAmount,
        stripeTransactionId,
        gearLogAddKitNumbers,
        gearLogRemoveCount,
        newDuffelCount,
        duffelDelta,
        beforeT3Cutoff,
        staffNotes: '',
        expectedConfirmedKitCount: currentConfirmed,
      });
    } catch (writeBackErr) {
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: Stripe succeeded but the booking write-back failed', bookingId, stripeTransactionId, writeBackErr);
      try {
        await recordOpsAlert({
          bookingId,
          alertType: 'kit_change_writeback_failed',
          amount: refundOrChargeAmount,
          stripeErrorDetail: writeBackErr.message,
          urgency: 'urgent_same_day',
          notes: (outcome === 'charged' ? 'Charge ' : 'Refund ') + stripeTransactionId + ' for $' + refundOrChargeAmount
            + ' succeeded on Stripe, but the booking/Gear Check Log record could not be updated. Should self-heal on the next cron retry (same Idempotency-Key), but flagged in case it does not.',
        });
      } catch (alertErr) {
        // eslint-disable-next-line no-console
        console.error('finalizePendingKitChange: also failed to write the write-back-failed Ops Alert', bookingId, alertErr);
      }
      throw writeBackErr;
    }

    if (writeBackResult && writeBackResult.stale) {
      // eslint-disable-next-line no-console
      console.error('finalizePendingKitChange: write-back refused, confirmedKitCount changed concurrently (likely a staff correction)', bookingId, writeBackResult);
      try {
        await recordOpsAlert({
          bookingId,
          alertType: 'kit_change_race_with_manual_correction',
          amount: refundOrChargeAmount,
          stripeErrorDetail: (outcome === 'charged' ? 'Charge ' : 'Refund ') + stripeTransactionId + ' for $' + refundOrChargeAmount
            + ' succeeded on Stripe (baseline: ' + currentConfirmed + ' -> ' + requested + ' kits), but the write-back was refused because confirmedKitCount is now ' + writeBackResult.currentConfirmedKitCount
            + ' — something else (most likely a staff manual correction) changed it in between. The record was NOT overwritten and still reflects that other change. Needs manual reconciliation: confirm the guest was correctly charged/refunded and that confirmedKitCount, the Gear Check Log, and the deposit hold all agree.',
          urgency: 'urgent_same_day',
        });
      } catch (alertErr) {
        // eslint-disable-next-line no-console
        console.error('finalizePendingKitChange: also failed to write the race-with-manual-correction Ops Alert', bookingId, alertErr);
      }
      return { outcome: 'race_with_manual_correction', stripeTransactionId, refundOrChargeAmount, requested, currentConfirmed, delta };
    }
  }

  return { outcome, stripeTransactionId, refundOrChargeAmount, requested, currentConfirmed, delta };
}

module.exports = { finalizePendingKitChange, TIERS, getKitAdjustContextByToken, setPendingKitChange, listPendingKitChanges };
