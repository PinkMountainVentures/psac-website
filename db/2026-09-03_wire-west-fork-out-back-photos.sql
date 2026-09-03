-- Migration: wire real photos into TRAIL-040 (West Fork Out & Back)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so west-fork-out-back-01.jpg
-- (the rocky overlook vista) is the one that renders in the hero card
-- today. The other 2 are stored for a future photo-gallery/focal-point
-- pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/west-fork-out-back/west-fork-out-back-01.jpg,/images/trails/west-fork-out-back/west-fork-out-back-02.jpg,/images/trails/west-fork-out-back/west-fork-out-back-03.jpg'
WHERE trail_id = 'TRAIL-040';

COMMIT;
