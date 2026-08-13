/**
 * apps-script/trail-swap-actions.gs
 *
 * PASTE-IN PATCH for the existing "PSAC Bookings & Operations" Code.gs.
 * Sheet-side support for api/write-manual-trail-override.js and the
 * internal ops app's Trail Swap Requests page — Operations UX PRD Section 7,
 * amended by the finalized Trail Selection Logic PRD (its Sections 2, 7, 8).
 *
 * ============================================================================
 * RESOLVED, Aug 2026 build-review follow-up — ceiling check now implemented
 * directly, not delegated to an assumed external helper
 * ============================================================================
 *
 * Section 7's per-selection safety check needs to evaluate a trail's
 * difficulty ceiling and technical ceiling against THIS booking's group
 * (least-experienced roster member's fitness tier; the booking owner's
 * technicalComfort answer). This file originally called an ASSUMED shared
 * helper, `trailSelection_computeBookingCeilings_(bookingId)`, presumed to
 * live in `apps-script/trail-selection-actions.gs` — that file's actual
 * exports were never reviewed this session (no repo access), so the
 * assumption was flagged rather than trusted.
 *
 * Revisited on follow-up: the fitness-level -> ceiling mapping isn't actually
 * an unreviewed implementation detail of 2.2's engine, it's a Airey-confirmed
 * table stated directly in the finalized Trail Selection Logic PRD (Section
 * 4): Easygoing -> ceiling 2, Comfortable -> ceiling 4, Strong/experienced ->
 * ceiling 5, identical mapping for both the Difficulty axis (roster fitness,
 * least-experienced ATTENDING member governs the group) and the Technical
 * axis (the single `technicalComfort` field, no group summarization needed).
 * That's settled business logic, not a guess at 2.2's unseen internals, so
 * `trailSwap_computeGroupCeilings_()` below implements it directly instead of
 * depending on a same-named function elsewhere that may or may not exist. If
 * `trail-selection-actions.gs` already exposes an equivalent helper, this is
 * a harmless duplicate of a settled rule, not a second, possibly-divergent
 * guess at an unsettled one — a materially safer place to land than either
 * the old assumed-call or a from-scratch reimplementation of something
 * genuinely unknown.
 *
 * Roster fitness field confirmed as `fitness` (not `fitnessLevel`), value one
 * of "Easygoing pace" / "Comfortable hiker" / "Strong / experienced"
 * (`claude/psac-start-my-adventure-recent-changes.md` item 2). Matched here
 * by case-insensitive substring so this also tolerates the PRD's own
 * shorter tier labels or the technical-comfort question's descriptive
 * option text, whichever a given field actually stores. Still degrades to
 * `evaluatable: false` (never a guessed pass/fail) if neither axis can be
 * read — same fallback posture as before, matching the PRD's own documented
 * behavior at 7 launch trails ("eyeball the fit ... doesn't need a filter
 * tool built for a 7-row table").
 *
 * A second, related bug caught while fixing this: `trailSwap_
 * familyTierEligible_` below checked `p.ageRange`, a field name that doesn't
 * exist in the confirmed roster schema — the real field is `age`, holding an
 * age BUCKET string (e.g. "Under 14", "14-17", ...), never a separate
 * ageRange field or a numeric age. As originally written, `Number(p.age)` on
 * a bucket string like "18-24" is always NaN, so the minors filter matched
 * nobody, ever. Fixed below to bucket-match directly.
 *
 * Bookable?, Park/date availability, and seasonal safety (Optimal/Viable/
 * Avoid Season) remain implemented for real below — those field names are
 * directly confirmed against the live Trail Database
 * (`claude/psac-adventure-prep-jtbd-prd-v1.md` Section 3,
 * `claude/psac-trail-selection-logic-jtbd-prd-v1.md` Section 3) and never
 * depended on the ceiling question either way.
 *
 * ============================================================================
 * HOW TO INSTALL
 * ============================================================================
 *
 * 1. Paste everything below the marker into Code.gs (or its own .gs file).
 *    Requires apps-script/adventure-prep-actions.gs already pasted in
 *    (reuses its header-map/row-read helpers, shared global scope).
 *
 * 2. Wire the four new actions into the existing doPost's action dispatch:
 *
 *      } else if (body.action === 'trailSwap_logIntake') {
 *        out = trailSwap_logIntake(body);
 *      } else if (body.action === 'trailSwap_getDropdownOptions') {
 *        out = trailSwap_getDropdownOptions(body);
 *      } else if (body.action === 'trailSwap_applyOverride') {
 *        out = trailSwap_applyOverride(body);
 *      } else if (body.action === 'trailSwap_getRequestContext') {
 *        out = trailSwap_getRequestContext(body);
 *
 * 3. Run trailSwap_setup() once from the Apps Script editor after pasting.
 *    Safe to re-run.
 *
 * ============================================================================
 * PASTE BELOW THIS LINE
 * ============================================================================
 */

var TRAIL_SWAP_REQUESTS_HEADERS = [
  'swapRequestId', 'bookingId', 'guestConcernSummary', 'receivedAt', 'status',
  'reviewedBy', 'newTrailId', 'staffNotes', 'resolvedAt',
  'tierASafetyFiltersOverridden', 'safetyOverrideReason',
];

function trailSwap_setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  adventurePrep_ensureTabWithHeaders_(ss, 'Trail Swap Requests', TRAIL_SWAP_REQUESTS_HEADERS);
}

/**
 * Staff-initiated intake only (Section 7's "a short, manual entry through a
 * small form in the app"). The system-generated intake path (2.2's own
 * <3-candidate auto-open) belongs to the Trail Selection Logic PRD's own
 * build, not this file — it writes the same tab/shape directly from its own
 * code, this action is only the staff-facing form's entry point.
 */
function trailSwap_logIntake(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = ss.getSheetByName('Trail Swap Requests');
    var map = adventurePrep_headerMap_(sheet);
    var row = new Array(sheet.getLastColumn()).fill('');
    row[map['swapRequestId'] - 1] = adventurePrep_newId_('SWAP');
    row[map['bookingId'] - 1] = payload.bookingId;
    row[map['guestConcernSummary'] - 1] = payload.guestConcernSummary || '';
    row[map['receivedAt'] - 1] = adventurePrep_nowIso_();
    row[map['status'] - 1] = 'Open';
    sheet.appendRow(row);
    return { ok: true, swapRequestId: row[map['swapRequestId'] - 1] };
  } finally {
    lock.releaseLock();
  }
}

function trailSwap_getRequestContext(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Trail Swap Requests');
  var found = adventurePrep_findRowByColumnValue_(sheet, 'swapRequestId', payload.swapRequestId);
  if (!found) return { notFound: true };
  var row = sheet.getRange(found.rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  var obj = {};
  Object.keys(found.headerMap).forEach(function (h) { obj[h] = row[found.headerMap[h] - 1]; });
  return obj;
}

// ---------------------------------------------------------------------------
// Read-side: the dropdown's underlying data (Section 7).
// ---------------------------------------------------------------------------

function trailSwap_readTrailsTab_(ss) {
  var sheet = ss.getSheetByName('Trails');
  if (!sheet) throw new Error('Trails tab not found');
  return adventurePrep_readRowsAsObjects_(sheet);
}

function trailSwap_readParkAccess_(ss) {
  var sheet = ss.getSheetByName('Park Access');
  if (!sheet) return [];
  return adventurePrep_readRowsAsObjects_(sheet);
}

function trailSwap_monthAbbrev_(dateStr) {
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var m = String(dateStr || '').match(/^\d{4}-(\d{2})-\d{2}/);
  if (!m) return null;
  return months[Number(m[1]) - 1];
}

/**
 * Park/date availability (absolute exclusion) — checks the trail's `Park`
 * value against the `Park Access` tab's schedule for the booking's trip
 * date. A trail with no `Park` value is open/unrestricted (Adventure Prep
 * PRD Section 3: "Trails with no Park value ... open, unrestricted access,
 * a valid state, not a gap to fill").
 *
 * BUG FIX (independent bug pass, Aug 2026): this used to check a
 * `Months Open` column, which does not exist anywhere in the confirmed live
 * Park Access schema (claude/psac-park-access-data-entry-kickoff-prompt.md,
 * claude/psac-trail-selection-engine-handoff.md): the real columns are
 * `Park`, `Season` (e.g. "Jul 6 - Oct 1" or "Year-round"), `Applicable Days`
 * (e.g. "Fri, Sat, Sun", blank/absent meaning every day), `Opening Time`,
 * `Closing Time`. Since `r['Months Open']` was always undefined, `!r['Months
 * Open']` was always true, so this "absolute, no-override" Tier A filter
 * silently passed every trail regardless of season or day-of-week — exactly
 * the Indian Canyons/Tahquitz Canyon Fri-Sun-only-in-summer case this filter
 * exists to catch. Rewritten against the real columns, checking BOTH the
 * season date range and the day-of-week the trip actually falls on.
 */
function trailSwap_parseParkSeasonRange_(seasonStr) {
  var s = String(seasonStr || '').trim();
  if (!s || /year-round/i.test(s)) return null; // no restriction
  var months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  var m = s.match(/([A-Za-z]{3})\s*(\d{1,2})\s*-\s*([A-Za-z]{3})\s*(\d{1,2})/);
  if (!m) return null; // unrecognized format -> don't falsely exclude
  return {
    startMonth: months[m[1]], startDay: Number(m[2]),
    endMonth: months[m[3]], endDay: Number(m[4]),
  };
}

function trailSwap_dateInSeasonRange_(tripDate, range) {
  if (!range) return true; // year-round or unrecognized -> not restricted
  var d = String(tripDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return true;
  var month = Number(d[2]) - 1, day = Number(d[3]);
  var startsBeforeEnds = range.startMonth < range.endMonth ||
    (range.startMonth === range.endMonth && range.startDay <= range.endDay);
  var afterStart = month > range.startMonth || (month === range.startMonth && day >= range.startDay);
  var beforeEnd = month < range.endMonth || (month === range.endMonth && day <= range.endDay);
  if (startsBeforeEnds) return afterStart && beforeEnd;
  // Range wraps the calendar year (e.g. Nov 1 - Feb 1) — inside if on/after
  // start OR on/before end.
  return afterStart || beforeEnd;
}

function trailSwap_dayOfWeekAbbrev_(tripDate) {
  var d = String(tripDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return null;
  var abbrevs = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var dateObj = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
  return abbrevs[dateObj.getDay()];
}

function trailSwap_parkAvailable_(trail, tripDate, parkAccessRows) {
  if (!trail['Park']) return true;
  var relevant = parkAccessRows.filter(function (r) { return r['Park'] === trail['Park']; });
  if (!relevant.length) return true; // no schedule row for this park -> not restricted
  var dayAbbrev = trailSwap_dayOfWeekAbbrev_(tripDate);
  return relevant.some(function (r) {
    var range = trailSwap_parseParkSeasonRange_(r['Season']);
    if (!trailSwap_dateInSeasonRange_(tripDate, range)) return false;
    var applicableDays = String(r['Applicable Days'] || '').trim();
    if (!applicableDays) return true; // blank -> every day
    if (!dayAbbrev) return true; // unparseable trip date -> don't falsely exclude
    return applicableDays.indexOf(dayAbbrev) !== -1;
  });
}

/**
 * Seasonal safety (absolute-adjacent, but Section 2 treats it as overridable
 * — see below). Returns 'unknown' only when the trip date's month isn't
 * graded in ANY of Avoid/Optimal/Viable Season for this trail — the caller
 * (trailSwap_getDropdownOptions) is responsible for treating that the same
 * as 'avoid', per the Trail Selection Logic PRD Section 3's explicit
 * "treat an unassigned month as Avoid by default" instruction. Not
 * triggered today (all 7 launch trails are fully graded for every month),
 * but this function itself stays a neutral reporter of what it found rather
 * than deciding the fail-open/fail-closed policy itself.
 */
function trailSwap_seasonStatus_(trail, tripDate) {
  var monthAbbrev = trailSwap_monthAbbrev_(tripDate);
  if (!monthAbbrev) return 'unknown';
  var avoid = String(trail['Avoid Season'] || '').split(',').map(function (s) { return s.trim(); });
  var viable = String(trail['Viable Season'] || '').split(',').map(function (s) { return s.trim(); });
  var optimal = String(trail['Optimal Season'] || '').split(',').map(function (s) { return s.trim(); });
  if (avoid.indexOf(monthAbbrev) !== -1) return 'avoid';
  if (optimal.indexOf(monthAbbrev) !== -1) return 'optimal';
  if (viable.indexOf(monthAbbrev) !== -1) return 'viable';
  return 'unknown';
}

/**
 * Family-tier eligibility — fully specified, per Trail Selection Logic PRD
 * Section 4. Roster ages are collected as BUCKETS (Under 14 / 14-17 / 18-24 /
 * ...), confirmed field name `age`, never a separate `ageRange` field or an
 * exact numeric age — see this file's header for the bug this replaced.
 *
 * BUG FIX (independent bug pass, Aug 2026): the live roster UI
 * (adventure-form.js line 316) generates the 14-17 bucket's option value
 * with an EN DASH ('14–17', U+2013), not an ASCII hyphen ('14-17',
 * U+002D) — this comparison used the ASCII hyphen, so it never matched any
 * real 14-17-year-old roster entry. Every such minor silently fell out of
 * the minors filter, meaning a trail unsafe/inappropriate for a 14-17 year
 * old could be offered with no family-tier warning at all. Same bug class
 * as the ageRange-vs-age bug this file's header already documents fixing.
 */
function trailSwap_familyTierEligible_(trail, roster) {
  var minors = (roster || []).filter(function (p) {
    return p.age === 'Under 14' || p.age === '14–17';
  });
  if (!minors.length) return { applies: false, eligible: true };
  var kidFriendly = String(trail['Kid Friendly'] || '').toLowerCase() === 'yes';
  if (!kidFriendly) return { applies: true, eligible: false };
  var minAgeRec = trail['Min Age Rec'];
  if (minAgeRec === '' || minAgeRec == null || isNaN(Number(minAgeRec))) return { applies: true, eligible: true };
  var minAge = Number(minAgeRec);
  // A bucket only gives a lower bound, never an exact age, so an exact
  // minAgeRec comparison isn't fully knowable from this data. Stays
  // permissive on genuine uncertainty (this filter is advisory per Section 7,
  // never an absolute exclusion) — but "Under 14" still correctly fails any
  // real minAgeRec above 0, since that bucket can include children well
  // below any trail's stated minimum. "14-17" can't be ruled out precisely
  // (could be 14, could be 17), so it's never falsely excluded.
  var allMeetMinAge = minors.every(function (p) {
    if (p.age === 'Under 14') return minAge <= 0;
    return true; // '14–17' bucket: see comment above trailSwap_familyTierEligible_
  });
  return { applies: true, eligible: allMeetMinAge };
}

// ---------------------------------------------------------------------------
// Ceiling computation — see this file's header for why this is implemented
// directly against the Airey-confirmed mapping table, not delegated.
// ---------------------------------------------------------------------------

var TRAIL_SWAP_FITNESS_TIER_CEILING_ = { easygoing: 2, comfortable: 4, strong: 5 };
var TRAIL_SWAP_FITNESS_TIER_ORDER_ = ['easygoing', 'comfortable', 'strong'];

/**
 * Matches either the roster's own fitness-level labels ("Easygoing pace" /
 * "Comfortable hiker" / "Strong / experienced") or the Trail Selection Logic
 * PRD's own tier labels/technical-comfort option text, by case-insensitive
 * substring, so this works regardless of which exact copy a given field
 * stores. Returns null (never a guess) if nothing recognizable matches.
 */
function trailSwap_fitnessTierKey_(value) {
  var v = String(value || '').toLowerCase();
  if (v.indexOf('easygoing') !== -1 || v.indexOf('wide, easy') !== -1) return 'easygoing';
  if (v.indexOf('comfortable') !== -1 || v.indexOf('some rock') !== -1) return 'comfortable';
  if (v.indexOf('strong') !== -1 || v.indexOf('experienced') !== -1 || v.indexOf('scrambling') !== -1) return 'strong';
  return null;
}

/**
 * Difficulty ceiling: the least-experienced ATTENDING roster member's own
 * tier ceiling (Trail Selection Logic PRD Section 4 — "the appropriate rule
 * already being to optimize for the least fit person"). Technical ceiling:
 * whatever the booking's single `technicalComfort` field maps to, no
 * per-person summarization needed for that axis.
 */
function trailSwap_computeGroupCeilings_(ss, bookingId, roster) {
  var worstTierIdx = null;
  (roster || []).forEach(function (p) {
    var key = trailSwap_fitnessTierKey_(p.fitness || p.fitnessLevel);
    if (!key) return;
    var idx = TRAIL_SWAP_FITNESS_TIER_ORDER_.indexOf(key);
    if (worstTierIdx === null || idx < worstTierIdx) worstTierIdx = idx;
  });
  var difficultyCeiling = worstTierIdx === null ? null : TRAIL_SWAP_FITNESS_TIER_CEILING_[TRAIL_SWAP_FITNESS_TIER_ORDER_[worstTierIdx]];

  var ap = adventurePrep_readAdventurePrepRow_(ss, bookingId);
  var technicalKey = trailSwap_fitnessTierKey_(ap && ap.technicalComfort);
  var technicalCeiling = technicalKey ? TRAIL_SWAP_FITNESS_TIER_CEILING_[technicalKey] : null;

  return {
    difficultyCeiling: difficultyCeiling,
    technicalCeiling: technicalCeiling,
    evaluatable: difficultyCeiling != null && technicalCeiling != null,
  };
}

/** Never throws a guessed pass/fail out to the caller — see header. */
function trailSwap_evaluateCeilings_(ss, bookingId, roster) {
  try {
    return trailSwap_computeGroupCeilings_(ss, bookingId, roster);
  } catch (e) {
    return { difficultyCeiling: null, technicalCeiling: null, evaluatable: false, error: String(e) };
  }
}

/**
 * Returns every `Bookable? = Yes` trail, each annotated with whether it
 * clears this booking's Tier A filters. Bookable?/park-date are absolute
 * (excluded from the list entirely, per Section 7: "a trail failing either
 * of those never appears as a selectable option at all"). The other four
 * are advisory flags the dropdown/Apply-button UI uses to trigger the
 * inline warning-and-reason gate.
 */
function trailSwap_getDropdownOptions(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var booking = adventurePrep_findExperienceBookingById_(ss, payload.bookingId);
  if (!booking) return { notFound: true };
  var ap = adventurePrep_readAdventurePrepRow_(ss, payload.bookingId);
  var roster = [];
  try { roster = JSON.parse((ap && ap.reconfirmedRosterJson) || '[]'); } catch (e) { roster = []; }

  var trails = trailSwap_readTrailsTab_(ss).filter(function (t) { return String(t['Bookable?']).toLowerCase() === 'yes'; });
  var parkAccessRows = trailSwap_readParkAccess_(ss);
  var ceilings = trailSwap_evaluateCeilings_(ss, payload.bookingId, roster);

  var options = [];
  trails.forEach(function (trail) {
    if (!trailSwap_parkAvailable_(trail, booking.date, parkAccessRows)) return; // absolute exclusion

    var season = trailSwap_seasonStatus_(trail, booking.date);
    var family = trailSwap_familyTierEligible_(trail, roster);
    var difficultyRating = Number(trail['Difficulty (1-5)'] || trail['Difficulty'] || 0);
    var technicalRating = Number(trail['Technical Rating (1-5)'] || trail['Technical Rating'] || 0);

    var failedFilters = [];
    // BUG FIX (independent bug pass, Aug 2026): 'unknown' (a trip month not
    // graded in any of Avoid/Optimal/Viable Season for this trail) used to
    // silently pass this filter — only the literal 'avoid' excluded. Trail
    // Selection Logic PRD Section 3 explicitly says an ungraded month should
    // default to Avoid (fail closed), not pass through. Not currently
    // triggered (all launch trails are fully graded), but a real latent risk
    // for any future trail added with incomplete season data.
    if (season === 'avoid' || season === 'unknown') failedFilters.push('seasonal_safety');
    if (family.applies && !family.eligible) failedFilters.push('family_tier');
    if (ceilings.evaluatable !== false) {
      if (ceilings.difficultyCeiling != null && difficultyRating > ceilings.difficultyCeiling) failedFilters.push('difficulty_ceiling');
      if (ceilings.technicalCeiling != null && technicalRating > ceilings.technicalCeiling) failedFilters.push('technical_ceiling');
    }

    options.push({
      trailId: trail['Trail ID'] || trail['trailId'] || trail['Trail Name'],
      trailName: trail['Trail Name'] || trail['Name'] || '',
      difficultyRating: difficultyRating,
      technicalRating: technicalRating,
      failedFilters: failedFilters,
      ceilingsEvaluatable: ceilings.evaluatable !== false,
      seasonStatus: season,
    });
  });

  return { options: options, ceilingsEvaluatable: ceilings.evaluatable !== false };
}

// ---------------------------------------------------------------------------
// Write-back: the Apply action (Section 7).
// ---------------------------------------------------------------------------

/**
 * Single manual-slot cap (Section 7, Section 18 item 6b): a manual entry
 * replaces any PRIOR manual entry rather than the array growing further.
 * Algorithmic (`rules_v1`) entries are always left untouched.
 */
function trailSwap_appendManualCandidate_(candidateTrails, newEntry) {
  var withoutPriorManual = (candidateTrails || []).filter(function (c) { return c.source !== 'manual_override'; });
  withoutPriorManual.push(newEntry);
  return withoutPriorManual;
}

/**
 * The Apply action: one call does everything (Section 7: "closing the loop
 * on the Trail Swap Requests row itself, the same call sets ... status to
 * Resolved, one write, not a separate step staff has to remember").
 *
 * @param {object} payload
 * @param {string} payload.swapRequestId
 * @param {string} payload.bookingId
 * @param {string} payload.newTrailId
 * @param {string} payload.reviewedBy
 * @param {string} [payload.staffNotes]
 * @param {string[]} [payload.tierASafetyFiltersOverridden] - required non-empty justification pairing enforced by the caller (api/write-manual-trail-override.js), not re-validated here
 * @param {string} [payload.safetyOverrideReason]
 * @param {number} [payload.difficultyRating] - the selected trail's own Difficulty value, passed through from the dropdown response so this write doesn't need to re-read the Trails tab
 */
function trailSwap_applyOverride(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var target = adventurePrep_getOrCreateRow_(ss, payload.bookingId);
    var ap = adventurePrep_readAdventurePrepRow_(ss, payload.bookingId);
    var candidateTrails = [];
    try { candidateTrails = JSON.parse((ap && ap.candidateTrails) || '[]'); } catch (e) { candidateTrails = []; }

    var newEntry = {
      trailId: payload.newTrailId,
      matchedAttributes: null,
      source: 'manual_override',
      difficultyRating: payload.difficultyRating != null ? payload.difficultyRating : null,
    };
    var updatedCandidates = trailSwap_appendManualCandidate_(candidateTrails, newEntry);

    var now = adventurePrep_nowIso_();
    target.sheet.getRange(target.rowIndex, target.headerMap['candidateTrails']).setValue(JSON.stringify(updatedCandidates));
    target.sheet.getRange(target.rowIndex, target.headerMap['selectedTrailId']).setValue(payload.newTrailId);
    target.sheet.getRange(target.rowIndex, target.headerMap['assignmentMethod']).setValue('manual_override');
    target.sheet.getRange(target.rowIndex, target.headerMap['assignedAt']).setValue(now);

    // Trail Swap Requests row resolution — same call, per Section 7.
    var swapSheet = ss.getSheetByName('Trail Swap Requests');
    var swapMap = adventurePrep_headerMap_(swapSheet);
    var found = adventurePrep_findRowByColumnValue_(swapSheet, 'swapRequestId', payload.swapRequestId);
    if (found) {
      function setSwap(name, value) {
        if (!swapMap[name]) return;
        swapSheet.getRange(found.rowIndex, swapMap[name]).setValue(value === undefined || value === null ? '' : value);
      }
      setSwap('reviewedBy', payload.reviewedBy || '');
      setSwap('newTrailId', payload.newTrailId);
      setSwap('staffNotes', payload.staffNotes || '');
      setSwap('tierASafetyFiltersOverridden', JSON.stringify(payload.tierASafetyFiltersOverridden || []));
      setSwap('safetyOverrideReason', payload.safetyOverrideReason || '');
      setSwap('resolvedAt', now);
      setSwap('status', 'Resolved');
    }

    adventurePrep_appendChangeLog_(ss, {
      bookingId: payload.bookingId,
      changeType: 'trail_manual_override',
      oldValueJson: JSON.stringify({ selectedTrailId: ap ? ap.selectedTrailId : null }),
      newValueJson: JSON.stringify({
        selectedTrailId: payload.newTrailId,
        tierASafetyFiltersOverridden: payload.tierASafetyFiltersOverridden || [],
        safetyOverrideReason: payload.safetyOverrideReason || '',
      }),
      staffNotes: payload.staffNotes || '',
    });

    return {
      ok: true,
      bookingId: payload.bookingId,
      selectedTrailId: payload.newTrailId,
      candidateTrails: updatedCandidates,
      contactEmail: (adventurePrep_findExperienceBookingById_(ss, payload.bookingId) || {}).contactEmail,
      contactName: (adventurePrep_findExperienceBookingById_(ss, payload.bookingId) || {}).contactName,
    };
  } finally {
    lock.releaseLock();
  }
}
