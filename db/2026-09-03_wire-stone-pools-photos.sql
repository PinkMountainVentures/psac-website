-- Migration: wire a real photo into TRAIL-043 (Stone Pools Out and Back)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/stone-pools/stone-pools-01.jpg'
WHERE trail_id = 'TRAIL-043';

COMMIT;
