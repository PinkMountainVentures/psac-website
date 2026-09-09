-- Booking calendar blackout dates (2026-09-09). Airey's request: a way to
-- block the booking flow's date picker from offering dates he's out of
-- town and can't fulfill gear rental operations (delivery, checkout
-- packing, or return check-in/pickup around a trail day -- not just the
-- trail day itself). Three locked design decisions this table backs:
--   1. Blocked dates are entered as exact dates Airey types himself (no
--      auto-expansion with a delivery/return buffer -- his call, since he
--      knows his own actual unavailability window better than a fixed
--      offset would guess it).
--   2. Managed via a small dedicated ops page (ops-availability.html), not
--      direct DB edits.
--   3. Adding a blackout window scans existing bookings and raises an Ops
--      Alert (reusing the existing generic ops_alerts table, same posture
--      as gear_issue/trail_checkin_missing) for any already-booked date
--      caught inside the new window -- see lib/blackout-dates-service.js's
--      createBlackoutDate().
--
-- Deliberately its own table, not a repurposed park_access row: park_access
-- models park/ecological hours (a property of the land), this models
-- operator availability (a property of Airey/PSAC) -- two independent
-- reasons a date can be unbookable, and lib/booking-open-days-service.js's
-- getOpenDaysForMonth() checks both, never conflating one into the other.
--
-- BIGSERIAL PK matches park_access's own convention (not genId()'s
-- prefixed-hex convention) -- like park_access, no blackout_id is ever
-- exposed in a URL, token, or QR code; it only ever appears inside the ops
-- app's own list/delete calls.
CREATE TABLE IF NOT EXISTS booking_blackout_dates (
  blackout_id   BIGSERIAL PRIMARY KEY,
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT   -- staff email, forced server-side from the ops session (api/ops-proxy.js), never accepted from the client
);

CREATE INDEX IF NOT EXISTS idx_booking_blackout_dates_range ON booking_blackout_dates(start_date, end_date);
