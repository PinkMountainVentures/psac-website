-- Phase 2.5 Trail Day (claude/psac-trail-day-phase-proposal-2026-09-04.md).
-- Four new columns on adventure_prep, all nullable/idempotent:
--
-- heading_out_at: the real trail-day start timestamp, written once when
-- the guest confirms "Heading Out" on the hub (or, per that same
-- proposal, an eventual SMS STARTED reply -- not built by this migration,
-- see the proposal's own "What this depends on" section). Doubles as the
-- state signal for which Trail Day card to show: null -- morning-of,
-- set -- Underway.
--
-- expected_return_at: computed and written at the same moment, from
-- trails.est_time_easy_pace (see lib/trail-selection-engine.js's
-- parseEstTimeHours -- already the codebase's own conservative,
-- upper-bound reading of that free-text column) applied to the FULL
-- roster, never the confirmed/toggled headcount -- Airey's explicit,
-- deliberate call (most conservative view, most time for the group to
-- actually finish). This is what the return check-in nudges (already
-- scoped in claude/psac-adventure-hub-lifecycle-alerts-proposal-2026-09-03.md,
-- not built by this migration) will eventually fire against.
--
-- trail_day_roster_json: a snapshot of who's actually out today, taken at
-- Heading Out time -- [{participantId, name, present}]. Deliberately
-- separate from booking_participants.is_participating, which answers a
-- different, earlier question ("is this person on the booking at all").
-- This is "who actually showed up this morning," which can differ (a
-- last-minute no-show) and needs its own record for the eventual "who's
-- back" return check-in card.
--
-- guide_first_opened_at: set the first time a guest ever taps Get Guide.
-- "Downloaded" itself isn't observable from the backend (happens inside
-- RideWithGPS, on the guest's own phone) -- this is the honest proxy the
-- proposal calls for, first-tap-wins (never overwritten after it's set).
ALTER TABLE adventure_prep ADD COLUMN IF NOT EXISTS heading_out_at TIMESTAMPTZ;
ALTER TABLE adventure_prep ADD COLUMN IF NOT EXISTS expected_return_at TIMESTAMPTZ;
ALTER TABLE adventure_prep ADD COLUMN IF NOT EXISTS trail_day_roster_json JSONB;
ALTER TABLE adventure_prep ADD COLUMN IF NOT EXISTS guide_first_opened_at TIMESTAMPTZ;
