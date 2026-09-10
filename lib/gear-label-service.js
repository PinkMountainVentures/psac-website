/**
 * lib/gear-label-service.js
 *
 * QR code generation for gear unit labels (Gear Inventory PRD Section 6).
 *
 * Decision, 2026-09-10 (finally wiring the thing Section 6 always asked
 * for -- see claude/psac-gear-inventory-fresh-start-2026-09-02.md's own
 * "finding worth carrying into the QR/auto-ID build"): the QR encodes a
 * URL keyed to the unit's `qr_token` (https://.../ops-gear-units.html?
 * unit={qrToken}), NOT the plain unit_id. Two reasons, confirmed with
 * Airey rather than defaulted: (1) any phone's stock camera app opens a
 * URL-shaped QR straight to that unit's record, not just plain text --
 * real ad-hoc-scanning value the bare-ID scheme never had; (2) qr_token
 * is already a random, non-sequential value (lib/ids.js's genId()), so it
 * doesn't let someone enumerate the inventory by incrementing PL-0001,
 * PL-0002... the way a bare unit ID would. Neither matters for the
 * per-request auth boundary -- every ops page sits behind
 * requireStaffSession regardless of what the QR encodes -- so this is
 * upside with no real security trade either way.
 *
 * gear-service.js's confirmCheckoutScan() was updated alongside this to
 * match on `unit_id = $1 OR qr_token = $1`, so a scanned qr_token URL and
 * a hand-typed human-readable unit ID (the manual-entry fallback) both
 * resolve correctly through the exact same code path -- no separate
 * "legacy" or "manual" branch to keep in sync.
 *
 * Uses the `qrcode` npm package (pure JS, no native deps -- safe in
 * Vercel's serverless runtime, same "no native-binary dependency"
 * posture as everything else in this stack) to render the QR as inline
 * SVG markup: a vector stays crisp at any print resolution, unlike a
 * fixed-size PNG, and needs no canvas/node-canvas on the server.
 */

'use strict';

const QRCode = require('qrcode');
const { getSiteUrl } = require('./site-url');

/** The URL a QR label for this unit should encode. Exported separately so callers (and tests) can predict it without generating a full label. */
function labelUrlFor(qrToken) {
  return `${getSiteUrl()}/ops-gear-units.html?unit=${encodeURIComponent(qrToken)}`;
}

/**
 * Builds everything the Gear Units page needs to show and print a label
 * for one unit: the deep-link URL, and the QR itself as inline SVG markup
 * (a string of raw `<svg>...</svg>` markup, safe to drop straight into
 * innerHTML -- it's server-generated from a value we control, not
 * user-supplied HTML).
 */
async function buildUnitLabel({ unitId, itemType, qrToken }) {
  if (!qrToken) throw new Error('buildUnitLabel: unit has no qr_token — cannot generate a label');
  const labelUrl = labelUrlFor(qrToken);
  const qrSvg = await QRCode.toString(labelUrl, {
    type: 'svg',
    margin: 1,
    width: 300,
    errorCorrectionLevel: 'M',
  });
  return { unitId, itemType, qrToken, labelUrl, qrSvg };
}

module.exports = { labelUrlFor, buildUnitLabel };
