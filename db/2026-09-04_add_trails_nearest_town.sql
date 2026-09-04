-- Adds trails.nearest_town: a real, Google-geocodable Coachella Valley
-- town name (one of Palm Springs, Cathedral City, Rancho Mirage, Palm
-- Desert, Indian Wells, La Quinta, Indio, Coachella, Desert Hot Springs,
-- Thousand Palms) used by lib/weather-service.js as the lookup key into
-- its hardcoded town -> lat/lng table for the Google Maps Platform
-- Weather API. See claude/psac-adventure-hub-lifecycle-alerts-proposal-
-- 2026-09-03.md for why this is a town and not the exact trailhead
-- coordinate: the Weather API's documented coverage gap excludes "remote
-- locations... deserts, mountain tops", and trailhead_gps is sparse
-- (most seeded trails have it NULL) and stored as a '33.7890° N,
-- 116.5214° W' display string anyway, not a decimal float pair -- neither
-- makes it a safe direct input to a lat/lng-based API.
--
-- Deliberately a NEW column rather than reusing nearest_neighborhood:
-- that column holds finer-grained values ('South Palm Springs', 'North
-- Palm Springs') that read as real places but aren't reliably the town
-- name Google's Weather API (or this service's own coordinate table)
-- would key on, and conflating "which neighborhood is this trail near"
-- with "which town's weather represents this trail" would make
-- nearest_neighborhood harder to use for its original purpose too.
--
-- Best-effort backfill below infers nearest_town from area/
-- nearest_neighborhood text where an obvious Coachella Valley town name
-- appears in either, defaulting everything else to 'Palm Springs' (every
-- one of the 38 seeded trails sampled while designing this migration
-- mentions Palm Springs specifically, or a Palm-Springs-adjacent area, in
-- one of those two columns). This is a starting point, not a verified
-- dataset -- Airey should review/correct per-trail via the Trails ops
-- page (Location & access section), which this same change adds a
-- "Nearest town" field to.

ALTER TABLE trails ADD COLUMN IF NOT EXISTS nearest_town TEXT;

UPDATE trails
SET nearest_town = CASE
  WHEN area ILIKE '%coachella%' OR nearest_neighborhood ILIKE '%coachella%' THEN 'Coachella'
  WHEN area ILIKE '%thousand palms%' OR nearest_neighborhood ILIKE '%thousand palms%' THEN 'Thousand Palms'
  WHEN area ILIKE '%desert hot springs%' OR nearest_neighborhood ILIKE '%desert hot springs%' THEN 'Desert Hot Springs'
  WHEN area ILIKE '%indio%' OR nearest_neighborhood ILIKE '%indio%' THEN 'Indio'
  WHEN area ILIKE '%la quinta%' OR nearest_neighborhood ILIKE '%la quinta%' THEN 'La Quinta'
  WHEN area ILIKE '%indian wells%' OR nearest_neighborhood ILIKE '%indian wells%' THEN 'Indian Wells'
  WHEN area ILIKE '%palm desert%' OR nearest_neighborhood ILIKE '%palm desert%' THEN 'Palm Desert'
  WHEN area ILIKE '%rancho mirage%' OR nearest_neighborhood ILIKE '%rancho mirage%' THEN 'Rancho Mirage'
  WHEN area ILIKE '%cathedral city%' OR nearest_neighborhood ILIKE '%cathedral city%' THEN 'Cathedral City'
  ELSE 'Palm Springs'
END
WHERE nearest_town IS NULL;
