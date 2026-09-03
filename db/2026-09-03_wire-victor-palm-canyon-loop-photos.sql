-- Migration: wire a real photo into TRAIL-044 (Victor - Palm Canyon Loop)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/victor-palm-canyon-loop/victor-palm-canyon-loop-01.jpg'
WHERE trail_id = 'TRAIL-044';

COMMIT;
