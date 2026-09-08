-- Post-Adventure Check-in feedback storage (2026-09-08). See
-- claude/psac-post-adventure-phase3-final-spec-2026-09-08.md, section 6,
-- for the full Phase 3 ("Returning") build this table backs.

-- New table: feedback ----------------------------------------------------

-- One row per signer per booking: the booker gets their own row, and
-- each participant/guardian who submits their own Check-in card gets
-- theirs. Never a running average or an upsert-in-place -- a second
-- submission from the same signer on the same booking is a data question
-- for later, not something this table's shape needs to solve now, since
-- the Check-in card's own trigger (this signer hasn't submitted feedback
-- yet) already keeps a signer from being shown the card twice.
--
-- Storage only, per the Operations UX PRD's own locked decision -- no
-- dashboard, no routing-quality analysis layer. Written from both
-- api/adventure-prep.js (booker) and api/waiver.js (every Surface B
-- signer variant) via lib/feedback-service.js's submitFeedback(), never
-- read back by any guest-facing code path.
CREATE TABLE IF NOT EXISTS feedback (
  feedback_id       TEXT PRIMARY KEY,   -- FB-XXXXXXXX
  booking_id        TEXT NOT NULL REFERENCES experience_bookings(booking_id),
  participant_id    TEXT REFERENCES booking_participants(participant_id), -- null for the booker (no booking_participants row of their own)
  reported_by_role  TEXT NOT NULL,      -- 'booker' | 'participant' | 'participant_guardian' | 'guardian_only'
  overall_rating    INTEGER NOT NULL,   -- 1-5, every persona has this
  trail_rating      INTEGER,            -- booker only ("How was the trail we picked for your group?")
  gear_rating       INTEGER,            -- booker + attending participant/guardian only, optional ("How was your gear kit?")
  booking_rating    INTEGER,            -- booker only ("How was getting booked and ready with us?")
  checkin_rating    INTEGER,            -- guardian_only only ("How was staying in the loop while [child] was out there?"), optional
  note              TEXT,               -- optional free text, every persona
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_booking ON feedback(booking_id);
