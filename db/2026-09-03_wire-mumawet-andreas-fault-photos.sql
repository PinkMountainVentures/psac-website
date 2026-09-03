-- Migration: wire real photos into TRAIL-052 (Mumawet and Andreas Fault)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so mumawet-andreas-fault-01.jpg
-- (the boardwalk through the palm oasis) is the one that renders in the
-- hero card today. The other 4 are stored for a future photo-gallery/
-- focal-point pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/mumawet-andreas-fault/mumawet-andreas-fault-01.jpg,/images/trails/mumawet-andreas-fault/mumawet-andreas-fault-02.jpg,/images/trails/mumawet-andreas-fault/mumawet-andreas-fault-03.jpg,/images/trails/mumawet-andreas-fault/mumawet-andreas-fault-04.jpg,/images/trails/mumawet-andreas-fault/mumawet-andreas-fault-05.jpg'
WHERE trail_id = 'TRAIL-052';

COMMIT;
