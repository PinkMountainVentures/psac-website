-- Migration: wire real photos into TRAIL-039 (East Fork Loop)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- These 8 photos were supplied as covering both East Fork Loop
-- (TRAIL-039) and East Fork Out & Back (TRAIL-038), which share a
-- trailhead. Same 8 photos as TRAIL-038 but reordered so the loop's
-- hero image differs: photo_references is comma-separated and app code
-- always takes the FIRST entry, so east-fork-loop-01.jpg (the canyon
-- view opening onto the snow-capped San Jacinto peaks) is the one that
-- renders in the hero card today. The other 7 are stored for a future
-- photo-gallery/focal-point pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/east-fork-loop/east-fork-loop-01.jpg,/images/trails/east-fork-loop/east-fork-loop-02.jpg,/images/trails/east-fork-loop/east-fork-loop-03.jpg,/images/trails/east-fork-loop/east-fork-loop-04.jpg,/images/trails/east-fork-loop/east-fork-loop-05.jpg,/images/trails/east-fork-loop/east-fork-loop-06.jpg,/images/trails/east-fork-loop/east-fork-loop-07.jpg,/images/trails/east-fork-loop/east-fork-loop-08.jpg'
WHERE trail_id = 'TRAIL-039';

COMMIT;
