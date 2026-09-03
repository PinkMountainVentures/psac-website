-- Migration: wire real photos into TRAIL-050 (East Fork - Stone Pools Loop)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- No new photos were supplied for this trail -- per instruction, it
-- reuses images already wired for TRAIL-043 (Stone Pools Out and Back)
-- and TRAIL-038/TRAIL-039 (East Fork Out & Back / East Fork Loop),
-- since this loop combines both destinations. No new image files are
-- added by this migration; it only references existing paths already
-- committed under images/trails/stone-pools/ and images/trails/
-- east-fork-out-back/ and images/trails/east-fork-loop/.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so the Stone Pools shot is the
-- one that renders in the hero card today, since it's the feature this
-- trail is literally named for.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/stone-pools/stone-pools-01.jpg,/images/trails/east-fork-loop/east-fork-loop-01.jpg,/images/trails/east-fork-out-back/east-fork-out-back-01.jpg,/images/trails/east-fork-out-back/east-fork-out-back-03.jpg,/images/trails/east-fork-loop/east-fork-loop-05.jpg'
WHERE trail_id = 'TRAIL-050';

COMMIT;
