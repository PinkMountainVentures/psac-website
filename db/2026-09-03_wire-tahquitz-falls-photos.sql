-- Migration: wire real photos into TRAIL-047 (Tahquitz Falls)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so tahquitz-falls-01.jpg (the
-- falls pool itself) is the one that renders in the hero card today.
-- The second is stored for a future photo-gallery/focal-point pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/tahquitz-falls/tahquitz-falls-01.jpg,/images/trails/tahquitz-falls/tahquitz-falls-02.jpg'
WHERE trail_id = 'TRAIL-047';

COMMIT;
