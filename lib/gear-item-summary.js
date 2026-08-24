/**
 * lib/gear-item-summary.js
 *
 * Tiny shared helper: turns a list of Damaged/Missing gear items into the
 * `item` and `conditionNote` strings the deposit-notice email templates
 * expect (deposit-partial-capture-email.js, deposit-full-hold-no-charge-
 * email.js, deposit-capture-exceeding-hold-email.js all take a single
 * `item` string, written for the common one-item case but not restricted
 * to it). Shared between api/reconcile-gear-deposit.js and
 * api/charge-gear-shortfall.js rather than duplicated, since both need the
 * exact same join logic against the exact same item shape.
 */

'use strict';

/**
 * @param {Array<{itemName: string, condition: string}>} items - already
 *   filtered to Damaged/still-Missing items only (never Good/Recovered)
 * @returns {{itemsLabel: string, conditionNote: string}}
 */
function summarizeItems(items) {
  items = items || [];
  const itemsLabel = items.length
    ? items.map((i) => i.itemName).join(', ')
    : 'an item from your gear kit';

  const hasDamaged = items.some((i) => i.condition === 'Damaged');
  const hasMissing = items.some((i) => i.condition === 'Missing');
  let conditionNote = 'wear';
  if (hasDamaged && hasMissing) conditionNote = 'damage, and one or more items being missing,';
  else if (hasDamaged) conditionNote = 'damage';
  else if (hasMissing) conditionNote = 'being missing';

  return { itemsLabel, conditionNote };
}

module.exports = { summarizeItems };
