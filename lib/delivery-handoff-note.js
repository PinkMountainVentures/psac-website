/* ============================================
   PSAC — Property-type handoff/pickup phrasing
   Shared by the T-1 evening "gear is on its way" email
   (lib/email-templates/gear-on-its-way-email.js) and the T-0 trail-day
   message (lib/email-templates/trail-day-email.js), both wired for the
   first time 2026-09-10 (previously dead code, no live caller). Neither
   template branched on property type before this — gear-on-its-way took
   a raw handoffNote string, trail-day took a raw pickupArrangement string,
   both left for the caller to build. This is that caller-side logic,
   written once so the two new crons (api/send-gear-on-its-way.js,
   api/send-trail-day-message.js) can't drift on the wording.

   adventure_prep.property_type's three real values, confirmed against the
   booking-flow frontend (adventure-prep-form.js PROPERTY_OPTS): 'Hotel /
   resort', 'Vacation rental (Airbnb/VRBO)', 'Private residence'. Fallback
   phrase below ("with your property's front desk") matches the generic
   default adventure-prep-form.js itself already falls back to (line
   ~1972) when no more specific location is on file — not a new invention.

   Deliberately does NOT reuse return-instructions-email.js's own
   PICKUP_LINE_BY_PROPERTY_TYPE map: that file keys off short internal
   labels ('hotel'/'airbnb'/'privateHome') it invents itself and has zero
   live callers (confirmed separately, this session) — this helper keys
   directly off the real adventure_prep.property_type column values so the
   two new crons don't need a second translation layer.
   ============================================ */

'use strict';

var PROPERTY_HANDOFF_PHRASES = {
  'Hotel / resort': 'with the front desk',
  'Vacation rental (Airbnb/VRBO)': 'wherever you arranged with your host',
  'Private residence': 'at your front door'
};

var DEFAULT_HANDOFF_PHRASE = 'with your property\'s front desk';

/** Short phrase for "Leave the duffel ___" / "We'll leave it ___." */
function handoffPhraseFor(propertyType) {
  return PROPERTY_HANDOFF_PHRASES[propertyType] || DEFAULT_HANDOFF_PHRASE;
}

/**
 * Full sentence for gear-on-its-way's handoffNote token (delivery drop-off).
 * @param {string} propertyType
 * @param {string} [deliveryNote] - adventure_prep.delivery_note, staff/guest free text
 */
function buildHandoffNote(propertyType, deliveryNote) {
  var note = 'We\'ll leave it ' + handoffPhraseFor(propertyType) + '.';
  if (deliveryNote) note += ' ' + deliveryNote;
  return note;
}

/**
 * Short phrase for trail-day's pickupArrangement token (return pickup).
 * Prefers adventure_prep.return_note over delivery_note when both exist —
 * return_note describes the actual pickup arrangement, delivery_note
 * describes the original drop-off, and the two aren't guaranteed to match
 * (a guest can be picked up somewhere other than where gear was dropped).
 * @param {string} propertyType
 * @param {string} [note] - return_note preferred, delivery_note as fallback
 */
function buildPickupArrangement(propertyType, note) {
  var phrase = handoffPhraseFor(propertyType);
  return note ? phrase + ' (' + note + ')' : phrase;
}

module.exports = {
  PROPERTY_HANDOFF_PHRASES,
  DEFAULT_HANDOFF_PHRASE,
  handoffPhraseFor,
  buildHandoffNote,
  buildPickupArrangement
};
