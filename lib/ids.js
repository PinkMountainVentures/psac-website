/**
 * lib/ids.js
 *
 * Generates this codebase's existing prefixed-hex ID convention
 * (PER-XXXXXXXX, BK-XXXXXXXX, etc.) -- unchanged by the Postgres
 * migration (PRD Section 4's ID-format decision): these IDs already
 * appear in URLs, tokens, and QR codes throughout the live system, so
 * switching to UUIDs/serials would be a second migration hiding inside
 * this one.
 *
 * Matches the exact generation the Apps Script code used --
 * Utilities.getUuid().slice(0, 8).toUpperCase() -- just via Node's
 * built-in crypto.randomUUID() instead of the Apps Script equivalent.
 */

'use strict';

const crypto = require('crypto');

function genId(prefix) {
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return prefix ? `${prefix}-${hex}` : hex;
}

module.exports = { genId };
