-- Migration: wire real photos into TRAIL-038 (East Fork Out & Back)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- These 8 photos were supplied as covering both East Fork Out & Back
-- (TRAIL-038) and East Fork Loop (TRAIL-039), which share a trailhead.
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so east-fork-out-back-01.jpg
-- (the palm oasis at the end of the sandy trail) is the one that
-- renders in the hero card today. The other 7 are stored for a future
-- photo-gallery/focal-point pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/east-fork-out-back/east-fork-out-back-01.jpg,/images/trails/east-fork-out-back/east-fork-out-back-02.jpg,/images/trails/east-fork-out-back/east-fork-out-back-03.jpg,/images/trails/east-fork-out-back/east-fork-out-back-04.jpg,/images/trails/east-fork-out-back/east-fork-out-back-05.jpg,/images/trails/east-fork-out-back/east-fork-out-back-06.jpg,/images/trails/east-fork-out-back/east-fork-out-back-07.jpg,/images/trails/east-fork-out-back/east-fork-out-back-08.jpg'
WHERE trail_id = 'TRAIL-038';

COMMIT;
