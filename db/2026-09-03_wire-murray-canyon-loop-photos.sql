-- Migration: wire real photos into TRAIL-033 (Murray Canyon Loop)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so murray-canyon-loop-01.jpg is
-- the one that renders in the hero card today. The other 2 are stored
-- for a future photo-gallery/focal-point pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/murray-canyon-loop/murray-canyon-loop-01.jpg,/images/trails/murray-canyon-loop/murray-canyon-loop-02.jpg,/images/trails/murray-canyon-loop/murray-canyon-loop-03.jpg'
WHERE trail_id = 'TRAIL-033';

COMMIT;
