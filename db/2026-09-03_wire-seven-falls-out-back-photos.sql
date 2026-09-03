-- Migration: wire real photos into TRAIL-035 (Seven Falls Out & Back)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so seven-falls-out-back-01.jpg
-- (the falls/pool) is the one that renders in the hero card today. The
-- other 2 are stored for a future photo-gallery/focal-point pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/seven-falls-out-back/seven-falls-out-back-01.jpg,/images/trails/seven-falls-out-back/seven-falls-out-back-02.jpg,/images/trails/seven-falls-out-back/seven-falls-out-back-03.jpg'
WHERE trail_id = 'TRAIL-035';

COMMIT;
