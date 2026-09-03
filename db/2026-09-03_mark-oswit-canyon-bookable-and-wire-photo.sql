-- Migration: mark TRAIL-029 (Oswit Canyon) bookable and wire a real photo
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- Oswit Canyon was seeded with bookable = FALSE. Per confirmation this
-- trail is in fact bookable, so this flips that flag in addition to
-- setting photo_references. bookable is read dynamically off the trail
-- row everywhere in the codebase (lib/trail-selection-engine.js,
-- lib/run-trail-assignment.js, etc.) -- there is no hardcoded trail-ID
-- allowlist to update elsewhere, so this one UPDATE is sufficient to
-- make the trail assignable.

BEGIN;

UPDATE trails
SET bookable = TRUE,
    photo_references = '/images/trails/oswit-canyon/oswit-canyon-01.jpg'
WHERE trail_id = 'TRAIL-029';

COMMIT;
