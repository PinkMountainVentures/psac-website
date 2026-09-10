-- 2026-09-10: dedup columns for the two new crons that wire up the
-- previously-unwired gear-on-its-way (T-1 evening) and trail-day (T-0
-- morning) email templates -- both had zero live callers before this
-- (confirmed by grep across api/ and apps-script/). Trail-day's own cron
-- also sends the new T-0 "Heading Out" SMS prompt, but that ships inside
-- the same trail_day_message_sent_at marker below rather than a separate
-- column of its own -- one booking-level send per stage, same as every
-- other cadence marker in this schema.
--
-- Same plain-nullable-timestamp idempotency pattern as
-- deposit_heads_up_sent_at (see api/send-deposit-hold-heads-up.js's header
-- comment): each new cron fires on a repeating 15-minute window, not a
-- single fixed instant, so without a per-booking marker a slow tick or a
-- lingering booking would be re-sent on every remaining tick in that
-- window.

ALTER TABLE experience_bookings
  ADD COLUMN IF NOT EXISTS gear_on_its_way_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trail_day_message_sent_at TIMESTAMPTZ;
