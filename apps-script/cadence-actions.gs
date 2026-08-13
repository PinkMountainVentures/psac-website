/**
 * apps-script/cadence-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Sheet-side support for api/check-adventure-prep-cadence.js — the Section
 * 3/4 daily stall-detection and escalation cadence job.
 *
 * Built against claude/psac-operations-ux-jtbd-prd-v1.md Section 3 (three
 * tracked completion states, the escalation ladder, adventurePrepStalledFlag/
 * phoneFallbackDue), Section 4 (compressed cadence), and Section 13 (new
 * fields living on Experience Bookings, read but never hand-edited).
 *
 * ============================================================================
 * SCHEMA NOTE — closes a gap flagged in this session's build-review addendum
 * ============================================================================
 *
 * Section 16 of the finalized PRD names `adventurePrepStalledFlag` and
 * `phoneFallbackDue` as fields that live on Experience Bookings, "computed
 * daily" — but per the build checklist's own report of the live Sheet
 * columns actually created so far (`adventurePrepToken`, `bookingStatus`,
 * `cancelledAt`, `refundId`, `refundAmount`, `cancellationReasons`, plus
 * `t3CutoffProcessedAt` added earlier this session), these two were never
 * actually created as columns. This patch adds them, plus a third,
 * `cadenceStagesSent` — NOT itself named by the PRD, this build's own
 * idempotency marker (a comma-joined list like "t7,t5,t3" or "midwindow,t3")
 * so a booking's T-7/T-5/midwindow/T-3 sends each fire at most once even if
 * this cron job's daily tick runs more than once on the same calendar day.
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file).
 *
 * 2. Wire the four new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'cadence_listActiveBookings') {
 *        out = cadence_listActiveBookings(body);
 *      } else if (body.action === 'cadence_getBookingContext') {
 *        out = cadence_getBookingContext(body);
 *      } else if (body.action === 'cadence_recordStageSent') {
 *        out = cadence_recordStageSent(body);
 *      } else if (body.action === 'cadence_setStallFlags') {
 *        out = cadence_setStallFlags(body);
 *
 * 3. Run cadence_setup() once from the Apps Script editor after pasting.
 *    Safe to re-run — reuses adventurePrep_appendColumnsIfMissing_ from
 *    apps-script/adventure-prep-actions.gs (must be pasted in first; shared
 *    global scope, same convention as every other patch file in this repo).
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

var EXPERIENCE_BOOKINGS_CADENCE_COLUMNS = [
  'adventurePrepStalledFlag', 'phoneFallbackDue', 'cadenceStagesSent',
];

function cadence_setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_appendColumnsIfMissing_(ss, 'Experience Bookings', EXPERIENCE_BOOKINGS_CADENCE_COLUMNS);
}

/**
 * Every booking the cadence job needs to consider today: active, with a
 * future (or today's) trip date isn't filtered here — the Node caller
 * decides which of these are actually due for a stage today, via
 * lib/cadence.js's determineCadenceStage, and which just need a
 * fully-complete recheck to clear stale stall flags (Section 3: "cleared
 * once all three tracks complete").
 */
function cadence_listActiveBookings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Experience Bookings');
  var rows = adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    var status = r.bookingStatus || 'active';
    return status === 'active';
  });
  return {
    bookings: rows.map(function (r) {
      return {
        bookingId: r.bookingId,
        tripDate: r.date,
        createdAt: r.createdAt,
      };
    }),
  };
}

/**
 * Everything api/check-adventure-prep-cadence.js needs for one booking: the
 * three tracked completion states (Section 3's table), contact info for the
 * send, and this booking's current cadence bookkeeping fields.
 *
 * waiverTrack computed identically to t3Cutoff_getProcessingContext
 * (apps-script/t3-cutoff-actions.gs) — same zero/partial/complete tri-state,
 * intentionally not re-derived differently here.
 */
function cadence_getBookingContext(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var booking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
  if (!booking) return { notFound: true };
  var ap = adventurePrep_readAdventurePrepRow_(ss, payload.bookingId);

  var waiverSheet = ss.getSheetByName('Waiver Signatures');
  var waiverRows = adventurePrep_readRowsAsObjects_(waiverSheet).filter(function (r) {
    return String(r.bookingId) === String(payload.bookingId);
  });
  var anySigned = waiverRows.some(function (r) { return r.status === 'signed'; });
  var waiverTrack = (ap && ap.allWaiversComplete === true) ? 'complete' : (anySigned ? 'partial' : 'zero');

  var hasAddress = !!(ap && (ap.deliveryAddressLine1 || ap.deliveryAddressRaw));

  return {
    bookingId: booking.bookingId,
    tripDate: booking.date,
    createdAt: booking.createdAt,
    contactEmail: booking.contactEmail,
    contactName: booking.contactName,
    contactPhone: booking.contactPhone,
    smsConsent: booking.smsConsent === true || booking.smsConsent === 'true',
    adventurePrepToken: booking.adventurePrepToken,
    assignedAt: ap ? ap.assignedAt : '',
    waiverTrack: waiverTrack,
    hasAddress: hasAddress,
    adventurePrepStalledFlag: booking.adventurePrepStalledFlag === true || booking.adventurePrepStalledFlag === 'true',
    phoneFallbackDue: booking.phoneFallbackDue === true || booking.phoneFallbackDue === 'true',
    cadenceStagesSent: booking.cadenceStagesSent || '',
  };
}

/**
 * Appends `stage` to this booking's cadenceStagesSent list, idempotently
 * (never adds the same stage twice, so a retried/duplicate cron tick can't
 * double-send).
 */
function cadence_recordStageSent(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Experience Bookings');
    var found = adventurePrep_findRowByColumnValue_(sheet, 'bookingId', payload.bookingId);
    if (!found) return { ok: false, error: 'Booking not found' };
    var map = found.headerMap;
    if (!map['cadenceStagesSent']) return { ok: false, error: 'cadenceStagesSent column missing — run cadence_setup() first' };
    var current = String(sheet.getRange(found.rowIndex, map['cadenceStagesSent']).getValue() || '');
    var stages = current ? current.split(',') : [];
    if (stages.indexOf(payload.stage) === -1) {
      stages.push(payload.stage);
      sheet.getRange(found.rowIndex, map['cadenceStagesSent']).setValue(stages.join(','));
    }
    return { ok: true, cadenceStagesSent: stages.join(',') };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Writes adventurePrepStalledFlag/phoneFallbackDue directly (booleans).
 * Called both to SET them (a stage's conditional check found an incomplete
 * track) and to CLEAR them (a later check finds all three tracks complete —
 * Section 3: "cleared once all three tracks complete or the booking
 * cancels/finalizes").
 */
function cadence_setStallFlags(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Experience Bookings');
    var found = adventurePrep_findRowByColumnValue_(sheet, 'bookingId', payload.bookingId);
    if (!found) return { ok: false, error: 'Booking not found' };
    var map = found.headerMap;
    if (map['adventurePrepStalledFlag'] && payload.adventurePrepStalledFlag !== undefined) {
      sheet.getRange(found.rowIndex, map['adventurePrepStalledFlag']).setValue(!!payload.adventurePrepStalledFlag);
    }
    if (map['phoneFallbackDue'] && payload.phoneFallbackDue !== undefined) {
      sheet.getRange(found.rowIndex, map['phoneFallbackDue']).setValue(!!payload.phoneFallbackDue);
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
