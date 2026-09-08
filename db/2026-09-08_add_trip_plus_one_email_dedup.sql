-- Trip +1 "How was it?" email dedup columns (Post-Adventure Check-in,
-- 2026-09-08). See claude/psac-post-adventure-phase3-final-spec-
-- 2026-09-08.md, section 6/7, and lib/email-templates/trip-plus-one-
-- email.js. Sent trip date + 1, 9am Pacific -- api/send-trip-plus-one-
-- email.js's own cron.

-- Booker dedup -- one email per booking, same plain-nullable-timestamp
-- idempotency pattern as gear_out_for_delivery_sent_at above.
ALTER TABLE experience_bookings ADD COLUMN IF NOT EXISTS trip_plus_one_booker_email_sent_at TIMESTAMPTZ;

-- Per-signer dedup -- every Surface B signer (participant,
-- participant_guardian, guardian_only) gets their own T+1 email, and
-- each needs its own dedup, hence a column on waiver_signatures itself
-- rather than a single booking-level flag.
ALTER TABLE waiver_signatures ADD COLUMN IF NOT EXISTS trip_plus_one_email_sent_at TIMESTAMPTZ;
