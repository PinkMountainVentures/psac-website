/**
 * apps-script/booking-detail-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Backs the new Booking Detail page (ops-booking-detail.html) — the single
 * page Airey asked for after noticing All Bookings' "→ Booking detail" link
 * didn't actually go anywhere real (it just re-filtered All Bookings back
 * down to one row). One aggregator action, `bookingDetail_get`, gathers
 * everything known about ONE booking across every tab/domain this app
 * tracks, so the frontend makes exactly one call instead of nine.
 *
 * ============================================================================
 * WHY THIS CALLS INTO OTHER FILES' FUNCTIONS DIRECTLY, RATHER THAN
 * RE-DERIVING THEIR LOGIC
 * ============================================================================
 *
 * Gear allocation, gear delivery/return, gear check-in condition, and
 * reconciliation are each already correctly computed by an existing,
 * already-live, already-bug-fixed function elsewhere in this project
 * (gearOps_getAllocation, gearOps_getReturnContext, gearOps_getCheckinContext,
 * gearOps_getReconciliationContext — see gear-inventory-actions.gs and
 * ops-redesign-round2-actions.gs). This file calls those functions directly
 * — an in-process Apps Script call, not a second HTTP round trip — rather
 * than re-reading the underlying tabs itself. Re-deriving any of that logic
 * here would risk silently drifting from the real, already-fixed behavior
 * (gearOps_getReconciliationContext alone has at least one documented past
 * bug fix in its own header). This is the "call the already-correct shared
 * helper directly" pattern this codebase uses for genuinely settled,
 * already-reviewed logic — as opposed to the separate "duplicate rather
 * than depend on an unreviewed helper" pattern used elsewhere (e.g.
 * trail-swap-actions.gs's own header) for logic that hadn't been verified
 * yet. These four have been verified: they're each already serving a real,
 * currently-working ops page.
 *
 * Payment/hold/booking-status bucketing reuses the exact same helpers
 * allBookings_listAll already uses (opsRedesign_paymentStatusBucket_,
 * opsRedesign_holdStatusBucket_, opsRedesign_bookingStatusInfo_,
 * opsRedesign_deliveryReturnStatus_, all in
 * ops-redesign-round1-actions.gs) — same reasoning: All Bookings and
 * Booking Detail must never disagree about what a given booking's status
 * actually is.
 *
 * Trail swap requests, the roster/waiver-signing history, and manual
 * adjustment history are read directly off their own tabs here
 * (Trail Swap Requests, Waiver Signatures, Adventure Prep Change Log) using
 * the shared adventurePrep_readRowsAsObjects_ header-keyed reader — the
 * SAME function that reads "the Trail Swap Requests tab, per bookingId" for
 * openSwapByBooking inside allBookings_listAll, so this can't drift from
 * that tab's real schema either. This file deliberately does NOT call
 * trailSwap_listAll or changeLog_listRecent — a repo-wide grep during this
 * build turned up doPost dispatch lines and an ops-proxy wrapper for both,
 * but no actual function definition for either one anywhere in the
 * checked-in .gs files (they must exist only in the live Apps Script
 * project, never committed back — worth reconciling separately). Reading
 * the tabs directly here sidesteps depending on code that can't be
 * reviewed, and also sidesteps changeLog_listRecent's apparent "recent,
 * uncapped-by-caller" shape (ops-manual-adjustment.html calls it with zero
 * scoping params and filters client-side — a real risk of missing an older
 * booking's earlier history that this page needs to show in full).
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste this whole file into the "PSAC_backend_database" Apps Script
 *    project (its own file, or appended into Code.gs — order doesn't
 *    matter, one shared global scope per project). Requires
 *    adventure-prep-actions.gs, ops-redesign-round1-actions.gs,
 *    gear-inventory-actions.gs, ops-redesign-round2-actions.gs, and
 *    trail-swap-actions.gs already pasted in (reuses their shared helpers).
 *
 * 2. Wire the one new action into the existing doPost's dispatch:
 *
 *      } else if (body.action === 'bookingDetail_get') {
 *        out = bookingDetail_get(body);
 *
 * 3. Deploy → Manage deployments → New version.
 *
 * No new tabs, no new columns — purely a read aggregator.
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

/**
 * @param {object} payload
 * @param {string} payload.bookingId
 * @returns one object with a section per area of the app, or { notFound: true }
 */
function bookingDetail_get(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var bookingId = payload.bookingId;

  var booking = adventurePrep_findExperienceBookingById_(ss, bookingId);
  if (!booking) return { notFound: true };

  var fullPayload = {};
  try { fullPayload = JSON.parse(booking.fullPayloadJson || '{}'); } catch (e) { fullPayload = {}; }

  var ap = adventurePrep_readAdventurePrepRow_(ss, bookingId);

  // Roster: reconfirmed (Adventure Prep 1.2a) if it exists, else the
  // original booking-time roster — the SAME fallback already fixed in
  // lib/run-trail-assignment.js and trailSwap_getDropdownOptions (see
  // those files' own header comments for the full incident). A booking
  // that hasn't reached Adventure Prep yet still has a perfectly real
  // roster from when it was first booked; this page should show it, not a
  // blank "no roster on file."
  var reconfirmedRoster = null;
  if (ap && ap.reconfirmedRosterJson) {
    try { reconfirmedRoster = JSON.parse(ap.reconfirmedRosterJson); } catch (e) { reconfirmedRoster = null; }
  }
  var roster = (reconfirmedRoster && reconfirmedRoster.length) ? reconfirmedRoster : (fullPayload.roster || []);
  var rosterSource = (reconfirmedRoster && reconfirmedRoster.length) ? 'reconfirmed' : 'booking_time';

  var candidateTrails = [];
  if (ap && ap.candidateTrails) {
    try { candidateTrails = JSON.parse(ap.candidateTrails); } catch (e) { candidateTrails = []; }
  }

  var bookingInfo = opsRedesign_bookingStatusInfo_(booking);
  var deliveryReturn = opsRedesign_deliveryReturnStatus_(booking);

  var allocation = [];
  try { allocation = (gearOps_getAllocation({ bookingId: bookingId }) || {}).allocation || []; } catch (e) { allocation = []; }

  var deliveryContext = null;
  try { deliveryContext = gearOps_getReturnContext({ bookingId: bookingId }); } catch (e) { deliveryContext = null; }

  var checkinContext = null;
  try { checkinContext = gearOps_getCheckinContext({ bookingId: bookingId }); } catch (e) { checkinContext = null; }

  var reconciliation = null;
  try { reconciliation = gearOps_getReconciliationContext({ bookingId: bookingId }); } catch (e) { reconciliation = null; }

  return {
    booking: {
      bookingId: booking.bookingId,
      createdAt: booking.createdAt,
      contactName: booking.contactName,
      contactEmail: booking.contactEmail,
      contactPhone: booking.contactPhone,
      tier: booking.tier,
      tripDate: booking.date,
      timePreference: booking.timePreference,
      gearKitCount: booking.gearKitCount,
      duffelCount: booking.duffelCount,
      bookingStatusBucket: bookingInfo.bucket,
      cancellationReasons: bookingInfo.reasons,
      cancelledAt: booking.cancelledAt || '',
      refundAmount: booking.refundAmount || '',
      smsConsent: booking.smsConsent,
      bookingTimeRoster: fullPayload.roster || [],
    },
    payment: {
      total: booking.total,
      mainPaymentIntentId: booking.mainPaymentIntentId,
      paymentStatusBucket: opsRedesign_paymentStatusBucket_(booking.fullPayloadJson),
      depositPaymentIntentId: booking.depositPaymentIntentId,
      depositStatus: booking.depositStatus,
      holdStatusBucket: opsRedesign_holdStatusBucket_(booking.depositStatus),
    },
    adventurePrep: {
      exists: !!ap,
      isParticipating: ap ? ap.isParticipating : '',
      technicalComfort: ap ? ap.technicalComfort : '',
      heatComfort: ap ? ap.heatComfort : '',
      bestForAttributes: ap ? ap.bestForAttributes : '',
      candidateTrails: candidateTrails,
      selectedTrailId: ap ? ap.selectedTrailId : '',
      assignedAt: ap ? ap.assignedAt : '',
      assignmentMethod: ap ? ap.assignmentMethod : '',
      roster: roster,
      rosterSource: rosterSource,
      confirmedKitCount: ap ? ap.confirmedKitCount : '',
      pendingKitCount: ap ? ap.pendingKitCount : '',
      allWaiversComplete: ap ? ap.allWaiversComplete : '',
      deliveryAddressLine1: ap ? ap.deliveryAddressLine1 : '',
      deliveryAddressLine2: ap ? ap.deliveryAddressLine2 : '',
      deliveryCity: ap ? ap.deliveryCity : '',
      deliveryState: ap ? ap.deliveryState : '',
      deliveryZip: ap ? ap.deliveryZip : '',
      deliveryWindow: ap ? ap.deliveryWindow : '',
      returnPreference: ap ? ap.returnPreference : '',
    },
    waivers: bookingDetail_readWaiverSignatures_(ss, bookingId),
    gearAllocation: allocation,
    deliveryContext: deliveryContext,
    checkinContext: checkinContext,
    trailSwaps: bookingDetail_readTrailSwapRequests_(ss, bookingId),
    changeLog: bookingDetail_readChangeLog_(ss, bookingId),
    reconciliation: reconciliation,
  };
}

function bookingDetail_readWaiverSignatures_(ss, bookingId) {
  var sheet = ss.getSheetByName('Waiver Signatures');
  if (!sheet) return [];
  return adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    return String(r.bookingId) === String(bookingId);
  });
}

function bookingDetail_readTrailSwapRequests_(ss, bookingId) {
  var sheet = ss.getSheetByName('Trail Swap Requests');
  if (!sheet) return [];
  return adventurePrep_readRowsAsObjects_(sheet).filter(function (r) {
    return String(r.bookingId) === String(bookingId);
  });
}

function bookingDetail_readChangeLog_(ss, bookingId) {
  var sheet = ss.getSheetByName('Adventure Prep Change Log');
  if (!sheet) return [];
  return adventurePrep_readRowsAsObjects_(sheet)
    .filter(function (r) { return String(r.bookingId) === String(bookingId); })
    .sort(function (a, b) { return String(b.timestamp || '').localeCompare(String(a.timestamp || '')); }); // most recent first
}
