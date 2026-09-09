-- After the Trail: Golden Hour photo infrastructure (2026-09-09).
--
-- Adds four new optional photo-URL slots to `trails`, alongside the one
-- that already exists (photo_references, the "first URL wins" field that
-- powers every hero card today). These are separate, single-purpose
-- columns rather than more first-URL-wins text blobs, because each slot
-- has a distinct intended use: photo_hero_url is a vertical/full-bleed
-- shot for the guest-facing post-adventure "Golden Hour" moment
-- (Peaks to Pools hero card); the other three (trailhead, overlook,
-- detail) are the remaining shots in the per-trail shot list documented
-- in claude/psac-post-adventure-phase3-final-spec-2026-09-08.md's After
-- the Trail follow-up, held for the future Shareable build. None of
-- these are required content yet (see ops-trails.html's
-- REQUIRED_CONTENT_FIELDS, deliberately unchanged by this migration).
ALTER TABLE trails ADD COLUMN IF NOT EXISTS photo_hero_url TEXT;
ALTER TABLE trails ADD COLUMN IF NOT EXISTS photo_trailhead_url TEXT;
ALTER TABLE trails ADD COLUMN IF NOT EXISTS photo_overlook_url TEXT;
ALTER TABLE trails ADD COLUMN IF NOT EXISTS photo_detail_url TEXT;
