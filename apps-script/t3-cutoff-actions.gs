/**
 * apps-script/t3-cutoff-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Sheet-side support for api/process-t3-cutoff.js — the Section 14 ordered
 * master sequence. Built against claude/psac-operations-ux-jtbd-prd-v1.md
 * Section 3 (the three tracked completion states), Section 5 (the three
 * cancellation gates, actually executed by api/cancel-and-refund-booking.js,
 * not this file), Section 9 (the "kit removed T-3, unsigned waiver" reason
 * tag), and Section 14 (the canonical step order).
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file).
 *
 * 2. Wire the four new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 't3Cutoff_listActiveBookings') {
 *        out = t3Cutoff_listActiveBookings(body);
 *      } else if (body.action === 't3Cutoff_getProcessingContext') {
 *        out = t3Cutoff_getProcessingContext(body);
 *      } else if (body.action === 't3Cutoff_markProcessed') {
 *        out = t3Cutoff_markProcessed(body);
 *      } else if (body.action === 't3Cutoff_removeUncoveredKit') {
 *        out = t3Cutoff_removeUncoveredKit(body);
 *      } else if (body.action === 't3Cutoff_writeRideWithGpsAccess') {
 *        out = t3Cutoff_writeRideWithGpsAccess(body);
 *
 * 3. Run adventurePrep_setup() again after pasting apps-script/adventure-
 *    prep-actions.gs's updated version (the one that adds
 *    'rideWithGpsExperienceAccess' to the Adventure Prep tab and
 *    't3CutoffProcessedAt' to Experience Bookings) — safe to re-run, and
 *    this patch's own actions assume both columns already exist.
 *
 * ============================================================================
 * IMPORTANT — WHAT THIS FILE DOES NOT DO
 * ============================================================================
 *
 * t3Cutoff_writeRideWithGpsAccess below is a PLACEHOLDER, not a real
 * RideWithGPS integration. Nothing in the three files reviewed this session
 * (apps-script/adventure-prep-actions.gs, api/adventure-prep.js,
 * lib/finalize-kit-change.js) touches RideWithGPS at all, and no RideWithGPS
 * API credentials or client library are referenced anywhere in this
 * project's docs beyond "RideWithGPS's own tour-operator dashboard" being
 * used MANUALLY (Section 8b's playbook). Whether a real
 * create-Experience-link API call exists or needs to be built from scratch
 * is unconfirmed — this file writes a placeholder value so the T-3 sequence
 * doesn't silently skip the step, and flags it loudly rather than guessing
 * at endpoint names/fields the way the Uber Direct integration was
 * explicitly NOT guessed at elsewhere in this project (build checklist:
 * "verify current Uber Direct API field names ... before writing dispatch
 * code"). Same posture here: don't invent a RideWithGPS API surface without
 * checking their real developer docs first.
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

/**
 * Returns every booking whose bookingStatus is 'active' (or blank, for a
 * pre-this-column booking) and whose t3CutoffProcessedAt is still blank —
 * i.e. every candidate the T-3 cutoff job might need to act on. Trip date
 * is included so the CALLER (api/process-t3-cutoff.js, in Node) decides
 * whether each one has actually crossed its T-3, 10pm Pacific cutoff yet,
 * via lib/t3-cutoff.js's isBeforeT3Cutoff — same "don't do real date math
 * in Apps Script" posture adventurePrep_listPendingKitChanges already
 * established.
 */
function t3Cutoff_listActiveBookings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var status = r.bookingStatus || 'active';
    return status === 'active' && !r.t3CutoffProcessedAt;
  });
  return {
    bookings: rows.map(function (r) {
      return { bookingId: r.bookingId, tripDate: r.date };
    }),
  };
}

/**
 * Everything api/process-t3-cutoff.js needs to run the three cancellation
 * gates (Section 3/5) and, for a booking that survives them, the rest of
 * the Section 14 sequence for that one booking.
 */
function t3Cutoff_getProcessingContext(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var booking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
  if (!booking) return { notFound: true };
  var ap = adventurePrep_readAdventurePrepRow_(ss, payload.bookingId);

  var waiverSheet = ss.getSheetByName('Waiver Signatures');
  var waiverRows = adventurePrep_readRowsAsObjects_(waiverSheet).filter(function (r) {
    return String(r.bookingId) === String(payload.bookingId);
  });
  // Section 3's three-state waiver track: zero (no row anywhere has
  // status === 'signed'), partial (some signed, allWaiversComplete still
  // false), complete (allWaiversComplete true). Computed here rather than
  // re-deriving "who's required" from roster data independently, per
  // Adventure Prep PRD's own anti-drift design — this just reads the
  // signer rows adventurePrep_recomputeAllWaiversComplete_ already
  // maintains.
  var anySigned = waiverRows.some(function (r) { return r.status === 'signed'; });
  var waiverTrack = (ap && ap.allWaiversComplete === true) ? 'complete' : (anySigned ? 'partial' : 'zero');

  return {
    bookingId: booking.bookingId,
    bookingStatus: booking.bookingStatus || 'active',
    tripDate: booking.date,
    contactEmail: booking.contactEmail,
    contactName: booking.contactName,
    assignedAt: ap ? ap.assignedAt : '',
    waiverTrack: waiverTrack,
    deliveryAddressLine1: ap ? ap.deliveryAddressLine1 : '',
    deliveryAddressRaw: ap ? ap.deliveryAddressRaw : '',
    pendingKitCount: ap ? ap.pendingKitCount : '',
    confirmedKitCount: ap ? ap.confirmedKitCount : booking.gearKitCount,
    reconfirmedRosterJson: ap ? ap.reconfirmedRosterJson : '',
    selectedTrailId: ap ? ap.selectedTrailId : '',
    rideWithGpsExperienceAccess: ap ? ap.rideWithGpsExperienceAccess : '',
    waiverRows: waiverRows.map(function (r) {
      return { rosterRef: r.rosterRef, signerName: r.signerName, role: r.role, status: r.status };
    }),
  };
}

function t3Cutoff_markProcessed(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Experience Bookings');
    var found = adventurePrep_findRowByColumnValue_(sheet, 'bookingId', payload.bookingId);
    if (!found) return { ok: false, error: 'Booking not found' };
    var map = found.headerMap;
    if (map['t3CutoffProcessedAt']) {
      sheet.getRange(found.rowIndex, map['t3CutoffProcessedAt']).setValue(adventurePrep_nowIso_());
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Section 9's per-kit removal for a `partial` waiver state at cutoff: pulls
 * the Gear Check Log rows for ONE specific kit (by rosterRef/personName,
 * not checked out yet), decrements confirmedKitCount by exactly one, and
 * appends the Change Log row Section 9 says should carry the
 * "kit removed T-3, unsigned waiver" reason so the Gear Assembly view can
 * surface it inline. Mirrors lib/finalize-kit-change.js's own
 * kit-by-kit-number removal pattern rather than inventing a new one.
 *
 * Deliberately does NOT touch Stripe — this is a non-payment removal (the
 * guest isn't charged less for a kit that never got a valid waiver, they
 * just don't receive it), distinct from a guest-initiated kit-count
 * reduction, which does refund via lib/finalize-kit-change.js.
 */
function t3Cutoff_removeUncoveredKit(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var gearSheet = ss.getSheetByName('Gear Check Log');
    var rows = adventurePrep_readRowsAsObjects_(gearSheet).filter(function (r) {
      return String(r.bookingId) === String(payload.bookingId) &&
        String(r.personName) === String(payload.personName) &&
        r.checkedOutAt === '';
    });

    // BUG FIX (independent bug pass, Aug 2026): this used to decrement
    // confirmedKitCount and append a Change Log row UNCONDITIONALLY, even
    // when rows.length === 0 (nothing actually removed). api/process-t3-
    // cutoff.js only marks a booking processed (t3CutoffProcessedAt) after
    // ALL steps for that booking complete — if anything throws between
    // this step and that final mark (a transient network failure two steps
    // later, say), the next ~15-minute cron tick reprocesses the same
    // booking from the top. On that retry, the Gear Check Log row is
    // already gone (rows.length === 0 here), but this function still
    // decremented the count and logged a second "kit removed" entry for a
    // kit that was already removed — silently corrupting confirmedKitCount
    // below the true value. Now a genuine no-op when there's nothing left
    // to remove, matching how every other idempotent step in this sequence
    // behaves.
    if (!rows.length) {
      return { ok: true, removedRowCount: 0, alreadyRemoved: true };
    }

    rows.map(function (r) { return r.__rowIndex; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (rowIndex) { gearSheet.deleteRow(rowIndex); });

    var target = adventurePrep_getOrCreateRow_(ss, payload.bookingId);
    var currentConfirmed = parseInt(target.sheet.getRange(target.rowIndex, target.headerMap['confirmedKitCount']).getValue(), 10) || 0;
    var newConfirmed = Math.max(0, currentConfirmed - 1);
    target.sheet.getRange(target.rowIndex, target.headerMap['confirmedKitCount']).setValue(newConfirmed);

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'kit_count',
      beforeT3Cutoff: false,
      oldValueJson: JSON.stringify({ confirmedKitCount: currentConfirmed }),
      newValueJson: JSON.stringify({ confirmedKitCount: newConfirmed }),
      delta: -1,
      staffNotes: 'kit removed T-3, unsigned waiver (' + payload.personName + ')',
    });

    return { ok: true, removedRowCount: rows.length, newConfirmedKitCount: newConfirmed };
  } finally {
    lock.releaseLock();
  }
}

/**
 * PLACEHOLDER — see the file header's "IMPORTANT" note. Writes a marker
 * value, not a real RideWithGPS Experience link, since no real integration
 * has been confirmed to exist. Deliberately still writes SOMETHING (rather
 * than leaving the field blank) so Section 8b's manual playbook check
 * ("Check whether rideWithGpsExperienceAccess is populated") has a
 * consistent signal to test against once a real integration lands —
 * replace this function's body, not its call site, when that happens.
 */
function t3Cutoff_writeRideWithGpsAccess(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_(ss, payload.bookingId);
    if (!target.headerMap['rideWithGpsExperienceAccess']) {
      return { ok: false, error: 'rideWithGpsExperienceAccess column missing — run adventurePrep_setup() first' };
    }
    var placeholder = 'PENDING_REAL_INTEGRATION:' + payload.trailId + ':' + adventurePrep_nowIso_();
    target.sheet.getRange(target.rowIndex, target.headerMap['rideWithGpsExperienceAccess']).setValue(placeholder);
    return { ok: true, rideWithGpsExperienceAccess: placeholder, isPlaceholder: true };
  } finally {
    lock.releaseLock();
  }
}
