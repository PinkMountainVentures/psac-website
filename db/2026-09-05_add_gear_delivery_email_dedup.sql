-- Dedup markers for the two new gear-delivery-card-triggered guest emails
-- (api/send-gear-out-for-delivery.js, and the synchronous send in
-- api/checkout-gear.js's markDeliveredFinal branch). Same plain-nullable-
-- timestamp idempotency pattern as deposit_heads_up_sent_at/
-- t3_cutoff_processed_at -- see those columns' own comments in this
-- schema for why (a repeating cron window, or a staff action a person
-- could click twice, must never double-email a guest).
--
-- gear_out_for_delivery_sent_at: set once the "your gear is out for
-- delivery" email has gone out for this booking. Independent of
-- delivery_status itself, which describes the actual gear-ops delivery
-- state machine (ready_for_delivery -> delivery_scheduled -> delivered),
-- not whether any particular email has been sent for it.
--
-- gear_delivered_email_sent_at: same idea, for the "your gear has
-- arrived" confirmation sent the moment delivery_status reaches
-- 'delivered'. A dedup guard here, not a cron dedup -- that email is
-- event-driven (sent synchronously inside markDeliveredFinal), but a
-- staff member could still click Mark Delivered more than once.

ALTER TABLE experience_bookings ADD COLUMN IF NOT EXISTS gear_out_for_delivery_sent_at TIMESTAMPTZ;
ALTER TABLE experience_bookings ADD COLUMN IF NOT EXISTS gear_delivered_email_sent_at TIMESTAMPTZ;
