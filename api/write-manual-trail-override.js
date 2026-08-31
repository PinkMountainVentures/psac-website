/**
 * api/write-manual-trail-override.js
 *
 * Operations UX PRD Section 7 / Section 13, amended by the finalized Trail
 * Selection Logic PRD (Sections 2, 7, 8) — the Trail Swap Requests page's
 * backing endpoint. Consolidated as an action-dispatched file:
 *
 *   - action: 'logIntake'          — staff-initiated intake only
 *   - action: 'getDropdownOptions' — the live bookable=true trail list,
 *                                     annotated per-trail with which Tier A
 *                                     filters it fails for this booking
 *   - action: 'applyOverride'      — the actual write-back (default action,
 *                                     for backward-compatible callers that
 *                                     don't pass one)
 *
 * MIGRATED (2026-08-31, Task 8 ops-proxy migration): all three actions now
 * call lib/trail-swap-service.js directly (in-process, no more
 * callBookingsWebApp/Apps Script round trip). Validation, the shared-secret
 * gate, and the guest-notification email are all unchanged.
 *
 * Shared-secret pattern, same convention as every other server-to-server
 * endpoint in this stack: TRAIL_OVERRIDE_SHARED_SECRET, its own dedicated
 * env var, never reused from another endpoint.
 */

'use strict';

const trailSwapService = require('../lib/trail-swap-service');
const { sendEmail } = require('../lib/send-email');
const { renderTrailSwapResolutionEmail } = require('../lib/email-templates/trail-swap-resolution-email');
const { addDaysToDateString } = require('../lib/cadence');

const VALID_SAFETY_FILTERS = ['difficulty_ceiling', 'technical_ceiling', 'family_tier', 'seasonal_safety'];

function checkSecret(payload) {
  // Fail closed: require both a configured secret and a non-empty
  // caller-supplied one, so an unset env var never matches an absent
  // payload.secret (undefined === undefined would otherwise pass).
  if (!process.env.TRAIL_OVERRIDE_SHARED_SECRET) return false;
  return !!(payload && payload.secret && payload.secret === process.env.TRAIL_OVERRIDE_SHARED_SECRET);
}

function formatDate(isoDateStr) {
  if (!isoDateStr) return null;
  const d = new Date(isoDateStr);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const body = req.body || {};
    if (!checkSecret(body)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const action = body.action || 'applyOverride';

    if (action === 'logIntake') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await trailSwapService.logIntake({
        bookingId: body.bookingId,
        guestConcernSummary: body.guestConcernSummary || '',
      });
      res.status(200).json(result);
      return;
    }

    if (action === 'getDropdownOptions') {
      if (!body.bookingId) {
        res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
        return;
      }
      const result = await trailSwapService.getDropdownOptions({ bookingId: body.bookingId });
      res.status(200).json(result);
      return;
    }

    // action === 'applyOverride' (default)
    const { bookingId, swapRequestId, newTrailId, reviewedBy } = body;
    if (!bookingId || !newTrailId || !reviewedBy) {
      res.status(400).json({ error: 'bad_request', detail: 'bookingId, newTrailId, and reviewedBy are required' });
      return;
    }

    const overrides = Array.isArray(body.tierASafetyFiltersOverridden) ? body.tierASafetyFiltersOverridden : [];
    const invalidFilters = overrides.filter((f) => VALID_SAFETY_FILTERS.indexOf(f) === -1);
    if (invalidFilters.length) {
      res.status(400).json({ error: 'bad_request', detail: `unrecognized safety filter(s): ${invalidFilters.join(', ')}` });
      return;
    }
    // Mandatory reason whenever an override is used — Section 7: "the Apply
    // button stays disabled until staff has both acknowledged the warning
    // and typed a non-empty safetyOverrideReason."
    if (overrides.length && !(body.safetyOverrideReason && body.safetyOverrideReason.trim())) {
      res.status(400).json({ error: 'bad_request', detail: 'safetyOverrideReason is required when tierASafetyFiltersOverridden is non-empty' });
      return;
    }

    const applyResult = await trailSwapService.applyOverride({
      swapRequestId: swapRequestId || '',
      bookingId,
      newTrailId,
      reviewedBy,
      staffNotes: body.staffNotes || '',
      tierASafetyFiltersOverridden: overrides,
      safetyOverrideReason: body.safetyOverrideReason || '',
    });

    if (!applyResult || applyResult.ok !== true) {
      res.status(500).json({ error: 'apply_failed', detail: applyResult });
      return;
    }

    // Guest notification — Section 15's "Trail-swap resolution" send.
    // Section 7: for a system-generated row the guest may not know anything
    // needed a second look yet; staff's own judgment call, exposed here as
    // an explicit opt-out rather than this endpoint silently deciding for
    // them.
    if (!body.skipGuestEmail && applyResult.contactEmail) {
      const tripT3DateStr = body.tripDate ? addDaysToDateString(body.tripDate, -3) : null;
      const html = renderTrailSwapResolutionEmail({
        logoUrl: process.env.BOOKING_CONFIRMATION_LOGO_URL || '',
        guestName: applyResult.contactName,
        newTrailName: body.newTrailName || newTrailId,
        overviewBlurb: body.overviewBlurb || '',
        entryFeeFragment: body.entryFeeFragment || '',
        adventurePrepLink: body.adventurePrepLink || 'https://www.palmspringsadventureclub.com/complete-adventure-prep',
        t3DateFormatted: formatDate(tripT3DateStr) || 'your trail day',
      });
      const emailResult = await sendEmail({ to: applyResult.contactEmail, subject: "We've updated your trail", html });
      if (emailResult.status === 'failed') {
        // Never fail the override itself over an email problem — the trail
        // change is already real and saved. Surface as an engineering note.
        // eslint-disable-next-line no-console
        console.error('write-manual-trail-override: guest email failed', bookingId, emailResult.error);
      }
    }

    res.status(200).json({ ok: true, bookingId, selectedTrailId: newTrailId });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('write-manual-trail-override failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
