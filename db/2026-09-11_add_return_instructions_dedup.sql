-- 2026-09-11: dedup column for api/send-return-instructions.js, which
-- wires up the previously-unwired lib/email-templates/return-instructions-
-- email.js -- zero live callers before this (confirmed by grep across
-- api/ and apps-script/, part of this session's email/SMS audit follow-
-- up, see claude/psac-email-sms-sinek-godin-miller-audit-2026-09-10.md).
--
-- Same plain-nullable-timestamp idempotency pattern as
-- trail_day_message_sent_at/gear_on_its_way_sent_at (see
-- db/2026-09-10_add_gear_on_its_way_and_trail_day_dedup.sql): the cron
-- polls on a repeating short window rather than firing once at a single
-- instant, so without a per-booking marker a booking sitting past its
-- expected_return_at would be re-sent on every remaining tick.
--
-- NOTE for Airey: api/send-return-instructions.js is written but
-- deliberately NOT registered in vercel.json yet -- see that file's
-- header comment for why (the trigger-timing call is a real product
-- decision, not something to default silently). This migration is safe
-- to run regardless of that decision; it only adds a column.

ALTER TABLE experience_bookings
  ADD COLUMN IF NOT EXISTS return_instructions_sent_at TIMESTAMPTZ;
