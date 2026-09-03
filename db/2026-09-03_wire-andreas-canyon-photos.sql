-- Migration: wire real photos into TRAIL-032 (Andreas Canyon)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so andreas-canyon-01.jpg is the
-- one that renders in the hero card today. The other 3 are stored for a
-- future photo-gallery/focal-point pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/andreas-canyon/andreas-canyon-01.jpg,/images/trails/andreas-canyon/andreas-canyon-02.jpg,/images/trails/andreas-canyon/andreas-canyon-03.jpg,/images/trails/andreas-canyon/andreas-canyon-04.jpg'
WHERE trail_id = 'TRAIL-032';

COMMIT;
