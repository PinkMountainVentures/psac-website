-- Migration: fix park value for TRAIL-051 and TRAIL-052 to match the
-- actual seeded park_access sub-park name.
--
-- Additive/update-only: touches exactly two existing rows, no schema
-- changes, no other trails affected. Safe to run once.
--
-- TRAIL-051 (McCallum Pond Loop) and TRAIL-052 (Mumawet and Andreas
-- Fault) were seeded (2026-09-03_add_trails_039-052.sql) with
-- park = 'Coachella Valley Preserve', but park_access has no row under
-- that exact name -- only the more specific sub-park names
-- 'Coachella Valley Preserve: Thousand Palms Oasis' and
-- 'Coachella Valley Preserve: Pushawalla & Willis Palms' (db/seed.sql).
-- checkParkDateAvailability() (lib/trail-selection-engine.js) matches
-- trails.park to park_access.park by exact (trimmed, case-insensitive)
-- string and fails CLOSED when nothing matches, so with the wrong
-- value these two trails could never pass the park/date availability
-- check on any date -- meaning trail assignment could never actually
-- select them, and the open-days date picker
-- (lib/booking-open-days-service.js) would never reflect their real
-- hours either.
--
-- Confirmed by Airey (2026-09-03): both trails are in
-- "Coachella Valley Preserve: Thousand Palms Oasis" (consistent with
-- both trails' parking_notes referencing Thousand Palms Canyon Road).

BEGIN;

UPDATE trails
SET park = 'Coachella Valley Preserve: Thousand Palms Oasis'
WHERE trail_id IN ('TRAIL-051', 'TRAIL-052');

COMMIT;
