-- Migration: wire real photos into TRAIL-036 (Seven Falls Loop)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so seven-falls-loop-01.jpg (the
-- wide canyon-oasis overlook) is the one that renders in the hero card
-- today. The other 4 are stored for a future photo-gallery/focal-point
-- pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/seven-falls-loop/seven-falls-loop-01.jpg,/images/trails/seven-falls-loop/seven-falls-loop-02.jpg,/images/trails/seven-falls-loop/seven-falls-loop-03.jpg,/images/trails/seven-falls-loop/seven-falls-loop-04.jpg,/images/trails/seven-falls-loop/seven-falls-loop-05.jpg'
WHERE trail_id = 'TRAIL-036';

COMMIT;
