-- Full roster return check-in + "Not everyone's back" guest experience
-- (2026-09-08). See claude/psac-trail-checkin-return-roster-and-sar-
-- experience-proposal-2026-09-08.md for the full design and the six
-- rounds of review behind it. Replaces the single-tap "I'm Back" design
-- from earlier the same day (trail_checkin_at itself is kept, same
-- column, its meaning is unchanged: a roster-confirm submission
-- happened, whichever outcome).

-- adventure_prep additions -------------------------------------------

-- trail_return_roster_json: snapshot of who's confirmed back vs. not at
-- check-in time, same shape as trail_day_roster_json
-- ([{participantId, name, present}]). showPostAdventure (adventure-prep-
-- form.js) checks this alongside trail_checkin_at: only a CLEAN roster
-- (everyone present) actually flips the hub to the post-adventure/gear-
-- return experience. An unclean roster routes into the incident-report
-- flow instead (trail_checkin_incidents below), never silently treated
-- as "done."
ALTER TABLE adventure_prep ADD COLUMN IF NOT EXISTS trail_return_roster_json JSONB;

-- guest_revised_return_at: the live, self-reported revised finish time
-- from the "running longer, everyone's fine" branch. Deliberately kept
-- SEPARATE from expected_return_at (2026-09-04's original, conservative,
-- full-roster-easy-pace computation from Heading Out) rather than
-- overwriting it -- expected_return_at stays the audit-grade baseline,
-- this is what the Underway hero card actually displays once set, and
-- what any future SAR-clock logic should treat as current. The one
-- genuinely mutable/overwritable field this whole build adds, every
-- other Phase 2.5/trail-checkin field on this table is write-once.
ALTER TABLE adventure_prep ADD COLUMN IF NOT EXISTS guest_revised_return_at TIMESTAMPTZ;

-- trails additions -----------------------------------------------------

-- Land-manager contact, settled by Airey's own direction: many trails
-- cross multiple stewards, model the trailhead's own land owner as the
-- one call to make, not full multi-jurisdiction tracking -- "it will
-- naturally escalate from there without the need for significant
-- process." Populate only for what PSAC's own Emergency & Check-In
-- Protocol already names directly (BLM Palm Springs-South Coast Field
-- Office, the Agua Caliente Tribal Ranger) as the trail-by-trail
-- jurisdiction audit (see PSAC_Master_Outreach_Tracker.md and
-- claude/psac-trail-jurisdiction-preliminary-notes.md) confirms each
-- trail's trailhead -- left NULL elsewhere rather than guessed at, that
-- audit is explicitly still unconfirmed GIS-wise. This is a real,
-- ongoing data-entry task independent of this migration, not something
-- this build backfills from preliminary research.
ALTER TABLE trails ADD COLUMN IF NOT EXISTS land_manager_name TEXT;
ALTER TABLE trails ADD COLUMN IF NOT EXISTS land_manager_phone TEXT;

-- New table: trail_checkin_incidents ------------------------------------

-- Backs the "What's going on?" triage (injury / lost_separated /
-- heat_illness / running_longer / overdue_unknown / other) reachable
-- from every surface with hub access: Surface A (the booker), Surface B
-- attending signers (a plain participant or a participant who's also a
-- guardian), and Surface B's non-attending guardian path. One Open
-- incident per booking at a time, upserted rather than duplicated --
-- see lib/trail-checkin-incident-service.js for the one-way tier rule
-- (a submission can only move the incident's urgency UP, never down;
-- a staff member resolving it from the ops side is the only way to
-- close or downgrade one) and the revision_count-driven backstop (a
-- second running_longer report on the same booking triggers an
-- outbound SMS to the group and bumps the incident to Critical, asking
-- staff to place the actual phone call per Protocol Section 3).
--
-- Never read by any guest-facing code path -- adventure-prep-form.js and
-- waiver-signer-form.js write to this table and never read it back, so
-- nothing a guest reports here (a personal description, a medical note)
-- can surface to any guest, including a non-attending guardian on the
-- same booking. Staff-only, read from the ops side; PSAC decides what,
-- if anything, to relay to SAR or a land manager, matching the
-- Protocol's own model of PSAC as the coordinating "Trusted Contact,"
-- not an automatic pass-through.
CREATE TABLE IF NOT EXISTS trail_checkin_incidents (
  incident_id                   TEXT PRIMARY KEY,   -- INC-XXXXXXXX
  booking_id                    TEXT NOT NULL REFERENCES experience_bookings(booking_id),
  category                      TEXT NOT NULL,      -- 'injury' | 'lost_separated' | 'heat_illness' | 'running_longer' | 'overdue_unknown' | 'other'
  category_detail               TEXT,                -- e.g. heat-illness symptom detail (informational only, never gated the 911 instruction), or the 'other' free text
  affected_participant_ids      JSONB,               -- which roster members this concerns
  personal_description          TEXT,                -- what they were wearing, non-PSAC gear (emergency branches only)
  medical_note                  TEXT,
  vehicle_description            TEXT,
  reported_new_finish_estimate  TIMESTAMPTZ,          -- running-longer branch's revised finish time
  reported_remaining_distance    TEXT,                -- running-longer branch's rough remaining-distance choice
  other_notes                    TEXT,                -- also where a tier-non-winning follow-up submission gets appended, timestamped, rather than lost
  reported_by_participant_id     TEXT REFERENCES booking_participants(participant_id), -- null when reported by the booker (no booking_participants row of their own)
  reported_by_role                TEXT,                -- 'booker' | 'participant' | 'participant_guardian' | 'guardian_only'
  revision_count                  INTEGER NOT NULL DEFAULT 0, -- consecutive running_longer submissions on this row; >=2 fires the SMS+Critical backstop
  reported_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                           TEXT NOT NULL DEFAULT 'Open',
  resolved_at                     TIMESTAMPTZ,
  resolved_by                     TEXT,
  staff_notes                      TEXT                -- PSAC-internal only, never read by guest-facing code
);

CREATE INDEX IF NOT EXISTS idx_trail_checkin_incidents_booking ON trail_checkin_incidents(booking_id);
CREATE INDEX IF NOT EXISTS idx_trail_checkin_incidents_status ON trail_checkin_incidents(status);
