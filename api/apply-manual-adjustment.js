/**
 * api/apply-manual-adjustment.js
 *
 * Operations UX PRD Section 8/13: "a constrained form for the three
 * off-system playbooks, a fixed set of adjustment types ... each calling
 * the new api/apply-manual-adjustment.js endpoint below, not an open-ended
 * cell edit." Consolidated action-dispatched file (same Vercel-12-function
 * consolidation as api/adventure-prep.js), one of four fixed `type` values:
 *
 *   - 'kit_count_correction'      (Section 8a)
 *   - 'gear_check_log_adjustment' (Section 8a)
 *   - 'change_log_note'           (Section 8a)
 *   - 'gear_returned_uncleaned'   (Section 8c)
 *
 * Note Section 8b (post-T-3 trail re-issuance) is deliberately NOT one of
 * these four — that playbook reuses api/write-manual-trail-override.js
 * directly (Section 8b: "staff uses the same Trail Swap Requests page and
 * api/write-manual-trail-override.js endpoint from Section 7"), not this
 * file. This endpoint's fixed set matches Section 13's own list exactly,
 * not Section 8's full playbook count.
 *
 * `staffNotes` is required on every type — this is inherently an audit-
 * trail action (Section 8's whole point is that off-system steps still
 * leave a record), so an adjustment with no explanation defeats the
 * purpose of the endpoint existing at all.
 *
 * Shared-secret pattern (server-to-server, called by the internal ops
 * app's own backend, same as api/resolve-ops-alert.js), its own dedicated
 * env var: MANUAL_ADJUSTMENT_SHARED_SECRET.
 */

'use strict';

const { callBookingsWebApp } = require('../lib/apps-script-client');

const VALID_TYPES = [
  'kit_count_correction',
  'gear_check_log_adjustment',
  'change_log_note',
  'gear_returned_uncleaned',
];

function checkSecret(payload) {
  return payload && payload.secret === process.env.MANUAL_ADJUSTMENT_SHARED_SECRET;
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

    const { type, bookingId, staffNotes } = body;
    if (!bookingId) {
      res.status(400).json({ error: 'bad_request', detail: 'bookingId is required' });
      return;
    }
    if (VALID_TYPES.indexOf(type) === -1) {
      res.status(400).json({ error: 'bad_request', detail: `type must be one of: ${VALID_TYPES.join(', ')}` });
      return;
    }
    if (!staffNotes || !staffNotes.trim()) {
      res.status(400).json({ error: 'bad_request', detail: 'staffNotes is required for every manual adjustment' });
      return;
    }

    let result;
    if (type === 'kit_count_correction') {
      if (body.newConfirmedKitCount == null || isNaN(Number(body.newConfirmedKitCount))) {
        res.status(400).json({ error: 'bad_request', detail: 'newConfirmedKitCount (a number) is required for kit_count_correction' });
        return;
      }
      result = await callBookingsWebApp('manualAdjustment_kitCountCorrection', {
        bookingId, newConfirmedKitCount: Number(body.newConfirmedKitCount), staffNotes,
      });
    } else if (type === 'gear_check_log_adjustment') {
      if (!Array.isArray(body.kitNumbersToRemove) || !body.kitNumbersToRemove.length) {
        res.status(400).json({ error: 'bad_request', detail: 'kitNumbersToRemove (non-empty array) is required for gear_check_log_adjustment' });
        return;
      }
      result = await callBookingsWebApp('manualAdjustment_gearCheckLogAdjustment', {
        bookingId, kitNumbersToRemove: body.kitNumbersToRemove, staffNotes,
      });
    } else if (type === 'change_log_note') {
      result = await callBookingsWebApp('manualAdjustment_changeLogNote', {
        bookingId, changeType: body.changeType || 'kit_count', staffNotes,
      });
    } else if (type === 'gear_returned_uncleaned') {
      result = await callBookingsWebApp('manualAdjustment_gearReturnedUncleaned', {
        bookingId, staffNotes,
      });
    }

    if (!result || result.ok !== true) {
      res.status(500).json({ error: 'adjustment_failed', detail: result });
      return;
    }

    res.status(200).json(Object.assign({ ok: true, type }, result));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('apply-manual-adjustment failed', err);
    res.status(500).json({ error: 'engineering_error', detail: err.message });
  }
};
