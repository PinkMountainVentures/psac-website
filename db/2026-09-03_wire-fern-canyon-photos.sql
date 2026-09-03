-- Migration: wire real photos into TRAIL-037 (Fern Canyon Loop)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so fern-canyon-01.jpg is the one
-- that actually renders in the hero card today. The other 5 are stored
-- for a future photo-gallery/focal-point pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/fern-canyon/fern-canyon-01.jpg,/images/trails/fern-canyon/fern-canyon-02.jpg,/images/trails/fern-canyon/fern-canyon-03.jpg,/images/trails/fern-canyon/fern-canyon-04.jpg,/images/trails/fern-canyon/fern-canyon-05.jpg,/images/trails/fern-canyon/fern-canyon-06.jpg'
WHERE trail_id = 'TRAIL-037';

COMMIT;
