-- Migration: wire real photos into TRAIL-041 (West Fork Loop)
-- Additive/update-only: touches exactly one existing row, no schema
-- changes, no other trails affected. Safe to run once.
--
-- photo_references is comma-separated; app code (lib/booking-detail-
-- service.js, lib/run-trail-assignment.js, etc.) always takes the FIRST
-- entry as the trail's displayed photo, so west-fork-loop-01.jpg (the
-- autumn wash/stream shot) is the one that renders in the hero card
-- today. The other 3 are stored for a future photo-gallery/focal-point
-- pass.

BEGIN;

UPDATE trails
SET photo_references = '/images/trails/west-fork-loop/west-fork-loop-01.jpg,/images/trails/west-fork-loop/west-fork-loop-02.jpg,/images/trails/west-fork-loop/west-fork-loop-03.jpg,/images/trails/west-fork-loop/west-fork-loop-04.jpg'
WHERE trail_id = 'TRAIL-041';

COMMIT;
