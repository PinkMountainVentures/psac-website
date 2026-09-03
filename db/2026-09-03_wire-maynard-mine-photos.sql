-- Migration: wire real photos into TRAIL-045 (Maynard Mine Trail)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so maynard-mine-01.jpg (the
-- actual mine relic/generator) is the one that renders in the hero card
-- today. The other 4 are stored for a future photo-gallery/focal-point
-- pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/maynard-mine/maynard-mine-01.jpg,/images/trails/maynard-mine/maynard-mine-02.jpg,/images/trails/maynard-mine/maynard-mine-03.jpg,/images/trails/maynard-mine/maynard-mine-04.jpg,/images/trails/maynard-mine/maynard-mine-05.jpg'
WHERE trail_id = 'TRAIL-045';

COMMIT;
