-- ============================================================
-- PSAC Relational Database Migration — schema.sql
-- Built from claude/psac-relational-database-migration-prd-v1.md, Section 4
-- (target schema), Section 6 (guardian hybrid model), and the pre-build
-- fullPayloadJson key audit performed in this build chat.
--
-- Run this once, in full, against a fresh Neon database (or any Postgres
-- 14+). Idempotent-ish: uses CREATE TABLE IF NOT EXISTS / CREATE TYPE ...
-- guarded, safe to re-run against a database that already has some of
-- these objects, EXCEPT the enum-creation DO blocks, which are already
-- guarded against duplicates.
-- ============================================================

-- ---------- Enums ----------

DO $$ BEGIN
  CREATE TYPE age_bucket_t AS ENUM ('under_14','14_17','18_24','25_34','35_44','45_54','55_64','65_plus');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE role_on_booking_t AS ENUM ('owner','attendee','guardian_only');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE pack_size_t AS ENUM ('standard','plus');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CORRECTED (2026-08-31, Task 10 Kit-sync build, per Airey's explicit
-- direction): this enum originally read ('subscribed','unsubscribed',
-- 'unknown') -- a collapsed two-value summary of Kit's own five
-- subscriber states. Airey's call: "we should map them 1:1, otherwise the
-- status' will be out of sync between kit and this system." Widened to
-- store Kit's own states verbatim, plus 'unknown' for a person who has
-- never appeared in a Kit sync result at all (see lib/kit-sync-
-- service.js's own header for the full mapping rationale and the
-- defensive fallback for any future Kit state this enum hasn't been
-- widened for yet).
DO $$ BEGIN
  CREATE TYPE email_list_status_t AS ENUM ('active','cancelled','bounced','complained','inactive','unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CORRECTED (2026-08-31, gear-ops migration build): this enum's original
-- value set ('available','checked_out','delivered','returned','cleaning',
-- 'deep_clean_due','retired') was authored before apps-script/gear-
-- inventory-actions.gs's actual Gear Units status machine had been read in
-- detail, and did not match it at all. The real, live status values
-- (confirmed against gearOps_allocateUnits, gearOps_confirmCheckoutScan,
-- gearOps_checkInItem, gearOps_markClean/markDeepCleaned/retireUnit) are
-- 'available' -> 'allocated' (Section 3/4, picked for a booking but not yet
-- scanned out) -> 'checked_out' (out with the guest) -> on return,
-- 'needs_cleaning' / 'needs_deep_clean' / 'damaged_pending_repair'
-- (Section 5) -> back to 'available' (Mark Clean/Mark Deep-Cleaned/Mark
-- Repaired) or 'retired'. Fixed here rather than left mismatched, since no
-- real gear inventory has been entered against this schema yet (confirmed:
-- the only seed rows use 'available') — see the gear-ops migration build's
-- own handoff notes for the full mismatch list this pass found and fixed.
DO $$ BEGIN
  CREATE TYPE gear_unit_status_t AS ENUM ('available','allocated','checked_out','needs_cleaning','needs_deep_clean','damaged_pending_repair','retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE gear_item_type_t AS ENUM ('backpack_standard','backpack_plus','bottle','poles','first_aid_kit','duffel');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CORRECTED (2026-08-31, gear-ops migration build): same issue as
-- gear_unit_status_t above — the real wire values written and compared
-- throughout gear-inventory-actions.gs and api/check-in-gear-item.js
-- (VALID_CONDITIONS) are Title-Case ('Good','Damaged','Missing',
-- 'Recovered'), not lowercase. This is an established, closed contract
-- already baked into the deployed check-in UI (ops-gear-return-checkin.html
-- sends these exact strings) that this migration must not silently
-- renormalize — fixed the enum's casing to match the real contract instead.
DO $$ BEGIN
  CREATE TYPE gear_condition_t AS ENUM ('Good','Damaged','Missing','Recovered');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CORRECTED (2026-08-31, gear-ops migration build): added 'refunded'
-- (gearOps_recordRefund's new terminal status once every captured/charged
-- dollar on a booking has been fully refunded — payment-review Medium #35)
-- and 'shortfall_charge_in_progress' (gearOps_beginShortfallCharge's
-- compare-and-swap claim state, guarding api/charge-gear-shortfall.js
-- against a concurrent double-charge — payment-review High #17). Both are
-- real, load-bearing values the existing gear-ops logic writes and reads;
-- neither was in this enum's original value set.
-- CORRECTED AGAIN (2026-08-31, deposit-hold engine build session): added
-- 'skipped' -- api/create-deposit-hold.js's own Custom-tier branch ("no
-- deposit hold for this tier") writes this literal value, and has since
-- before this migration began; it was simply never in this enum's value
-- set at all. Every Custom Experience booking's deposit-hold placement
-- attempt would have failed at the DB layer the moment this file's
-- Postgres port ran, with no seed/live data depending on the old value
-- set -- safe to add now, same reasoning as the two corrections above.
DO $$ BEGIN
  CREATE TYPE deposit_status_t AS ENUM (
    'scheduled_t1','held','failed','unavailable','requires_action','skipped',
    'released','partial_capture','full_capture','full_capture_pending_review','shortfall_charged',
    'refunded','shortfall_charge_in_progress'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE booking_status_t AS ENUM ('active','cancelled_no_adventure_prep','cancelled_with_adventure_prep','completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE staff_role_t AS ENUM ('admin','ops');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- People ----------

CREATE TABLE IF NOT EXISTS people (
  person_id           TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  phone               TEXT,
  stripe_customer_id  TEXT UNIQUE,
  membership_tier     TEXT,
  member_since        TIMESTAMPTZ,
  renewal_date        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sms_consent         BOOLEAN NOT NULL DEFAULT false,
  sms_consent_at      TIMESTAMPTZ,
  sms_consent_text    TEXT,
  -- Cached, one-way-synced FROM Kit only (Section 4.1). Never written back to Kit.
  kit_subscriber_id   TEXT,
  email_list_status   email_list_status_t
);

-- ---------- Pricing / catalog / staff (Section 4.13) ----------

CREATE TABLE IF NOT EXISTS pricing_tiers (
  tier_id                    TEXT PRIMARY KEY,      -- 'trail', 'peaks_to_pools', 'custom'
  name                       TEXT NOT NULL,
  booking_price_cents        INTEGER NOT NULL,
  gear_price_per_person_cents INTEGER NOT NULL,
  effective_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = uncapped. Membership tiers with a hard spot limit (Founding
  -- Member: 50 spots, confirmed by Airey 2026-08-31) set this; remaining
  -- capacity is deliberately NOT a cached counter here -- compute it live
  -- with `SELECT count(*) FROM membership_bookings WHERE tier_id = ...`
  -- against capacity_total, matching this codebase's existing "derive
  -- from the actual data, don't cache a number that can drift" posture
  -- (see bookings-code.gs's handleGetBookingByPaymentIntentId comment).
  capacity_total             INTEGER
);

CREATE TABLE IF NOT EXISTS gear_item_catalog (
  item_type              gear_item_type_t PRIMARY KEY,
  display_name           TEXT NOT NULL,
  replacement_cost_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_users (
  email         TEXT PRIMARY KEY,
  display_name  TEXT,
  role          staff_role_t NOT NULL DEFAULT 'ops',
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Trails / Park Access (Section 4.11 — seeds as real data) ----------

CREATE TABLE IF NOT EXISTS trails (
  trail_id                TEXT PRIMARY KEY,   -- TRAIL-001 .. TRAIL-999
  trail_name              TEXT NOT NULL,
  alternate_names         TEXT,
  desert_riders_trail     BOOLEAN,
  bookable                BOOLEAN NOT NULL DEFAULT false,
  area                    TEXT,
  park                    TEXT,
  trailhead_name          TEXT,
  trailhead_gps           TEXT,
  parking_notes           TEXT,
  distance_mi             NUMERIC(5,2),
  elevation_gain_ft       INTEGER,
  highest_point_ft        INTEGER,
  est_time_easy_pace      TEXT,
  est_time_strong_pace    TEXT,
  difficulty              INTEGER CHECK (difficulty BETWEEN 1 AND 5),
  activity_type           TEXT,
  route_type              TEXT,
  technical_rating        INTEGER CHECK (technical_rating BETWEEN 1 AND 5),
  optimal_season          TEXT[],
  viable_season           TEXT[],
  avoid_season            TEXT[],
  heat_considerations     TEXT,
  water_sources_on_trail  TEXT,
  kid_friendly            BOOLEAN,
  min_age_rec             TEXT,
  dog_friendly            TEXT,
  good_for_beginners      BOOLEAN,
  good_for_athletes       BOOLEAN,
  opening_description     TEXT,
  what_makes_it_special   TEXT,
  best_for_attributes     TEXT[],
  trail_day_tip           TEXT,
  ridewithgps_link        TEXT,
  strava_link             TEXT,
  garmin_connect_link     TEXT,
  gpx_file_location       TEXT,
  photo_references        TEXT,
  known_hazards           TEXT,
  cell_coverage           TEXT,
  emergency_egress_notes  TEXT,
  nearest_neighborhood    TEXT,
  nearest_town            TEXT,
  drive_time_from_downtown_ps TEXT,
  entry_fee_required      BOOLEAN,
  guided_eligible         BOOLEAN
);

CREATE TABLE IF NOT EXISTS trail_landmarks (
  trail_id     TEXT NOT NULL REFERENCES trails(trail_id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 5),
  name         TEXT,
  mile         NUMERIC(5,2),
  description  TEXT,
  PRIMARY KEY (trail_id, seq)
);

CREATE TABLE IF NOT EXISTS trail_waypoints (
  waypoint_id     BIGSERIAL PRIMARY KEY,
  trail_id        TEXT NOT NULL REFERENCES trails(trail_id) ON DELETE CASCADE,
  waypoint_num    INTEGER NOT NULL,
  mile_marker     NUMERIC(5,2),
  description     TEXT,
  gps_coordinates TEXT,
  notes           TEXT,
  UNIQUE (trail_id, waypoint_num)
);

CREATE TABLE IF NOT EXISTS park_access (
  park_access_id           BIGSERIAL PRIMARY KEY,
  park                     TEXT NOT NULL,
  season                   TEXT,
  applicable_days          TEXT[],
  opening_time             TEXT,
  closing_time             TEXT,
  adult_fee                TEXT,
  child_fee                TEXT,
  discount_eligibility_notes TEXT,
  payment_method           TEXT
);

-- ---------- Experience Bookings (Section 4.3) ----------

CREATE TABLE IF NOT EXISTS experience_bookings (
  booking_id                 TEXT PRIMARY KEY,             -- BK-XXXXXXXX
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  person_id                  TEXT NOT NULL REFERENCES people(person_id),
  contact_name               TEXT,
  contact_email              TEXT,
  contact_phone              TEXT,
  tier                       TEXT NOT NULL REFERENCES pricing_tiers(tier_id),
  date                       DATE,
  time_preference            TEXT,
  gear_kit_count             INTEGER NOT NULL DEFAULT 0,
  duffel_count               INTEGER NOT NULL DEFAULT 0,
  total                      NUMERIC(10,2),
  main_payment_intent_id     TEXT,
  deposit_payment_intent_id  TEXT,
  deposit_status             deposit_status_t,
  -- NEW (2026-08-31, bookingDetail_get rewrite): api/save-booking.js's
  -- verifyChargeAgainstStripe() has always computed body.paymentStatus
  -- (the verified Stripe PaymentIntent's real 'succeeded'/'processing'
  -- status) for every trail/p2p booking, but saveBooking() never had a
  -- column to persist it to -- the value was computed, used only to gate
  -- whether the booking write should proceed at all, then silently
  -- dropped. This closes that gap: a real, persisted Payment Status
  -- signal for All Bookings/Ops Alerts/Booking Detail to bucket on,
  -- instead of needing to re-derive it live from Stripe (or, as the old
  -- Apps Script version did, from a fullPayloadJson blob this schema
  -- deliberately doesn't have -- see Finding #8). Custom-tier bookings
  -- skip Stripe verification entirely and always default to 'succeeded'
  -- here -- the exact same fallback opsRedesign_paymentStatusBucket_'s own
  -- .gs source already used for rows saved before this field existed;
  -- applied here for the same reason (nothing to verify/read), not a new
  -- invention.
  payment_status             TEXT,
  sms_consent                BOOLEAN NOT NULL DEFAULT false,
  sms_consent_at             TIMESTAMPTZ,
  sms_consent_text           TEXT,
  adventure_prep_token       TEXT UNIQUE,
  booking_status             TEXT,          -- kept TEXT not enum: live values include
                                             -- 'cancelled_no_adventure_prep' and other
                                             -- free-form states seen live; tighten to
                                             -- booking_status_t once the full live value
                                             -- set is confirmed (see handoff notes).
  cancelled_at               TIMESTAMPTZ,
  refund_id                  TEXT,
  refund_amount              NUMERIC(10,2),
  cancellation_reasons       TEXT,
  t3_cutoff_processed_at     TIMESTAMPTZ,
  adventure_prep_stalled_flag BOOLEAN,
  phone_fallback_due         BOOLEAN,
  reconciled_at              TIMESTAMPTZ,
  reconciled_amount_cents    INTEGER,
  gear_shortfall_cents       INTEGER,
  shortfall_charge_id        TEXT,
  shortfall_charged_amount_cents INTEGER,
  shortfall_charged_at       TIMESTAMPTZ,
  shortfall_charge_lock_at   TIMESTAMPTZ,
  shortfall_staff_notes      TEXT,
  deposit_refund_id          TEXT,
  deposit_refund_amount_cents INTEGER,
  shortfall_refund_id        TEXT,
  shortfall_refund_amount_cents INTEGER,
  refunded_at                TIMESTAMPTZ,
  refund_staff_notes         TEXT,
  deposit_hold_renewed_at    TIMESTAMPTZ,
  -- NEW (Airey's direct request, 2026-09-02): dedup marker for
  -- api/send-deposit-hold-heads-up.js -- set once the T-1 noon Pacific
  -- "your gear deposit hold is coming" email has gone out for this
  -- booking, same plain nullable-timestamp idempotency pattern as
  -- t3_cutoff_processed_at/deposit_hold_renewed_at above. Independent of
  -- deposit_status (that field tracks the actual Stripe hold's own
  -- lifecycle; this one only tracks whether the heads-up EMAIL was sent).
  deposit_heads_up_sent_at   TIMESTAMPTZ,
  gear_delivered_at          TIMESTAMPTZ,
  gear_delivered_by          TEXT,
  stalled_called_at          TIMESTAMPTZ,
  stalled_called_by          TEXT,
  delivery_status            TEXT,
  delivery_service_type      TEXT,
  delivery_time_slot         TEXT,
  delivery_scheduled_at      TIMESTAMPTZ,
  delivery_ready_at          TIMESTAMPTZ,
  -- NEW (2026-09-05): dedup markers for the two gear-delivery-card-
  -- triggered guest emails ("out for delivery", "delivered") -- see
  -- db/2026-09-05_add_gear_delivery_email_dedup.sql's own comment.
  gear_out_for_delivery_sent_at TIMESTAMPTZ,
  gear_delivered_email_sent_at  TIMESTAMPTZ,
  return_status              TEXT,
  pickup_service_type        TEXT,
  pickup_scheduled_at        TIMESTAMPTZ,
  pickup_address_override    TEXT,
  pickup_time_note           TEXT,
  picked_up_at               TIMESTAMPTZ,
  gear_returned_at           TIMESTAMPTZ,
  shortfall_charge_pending_payment_intent_id TEXT,
  -- NEW, added by this build's fullPayloadJson audit (PRD Section 11 item 5,
  -- Section 4.2's "open verification item"). These keys existed in the live
  -- fullPayloadJson blob and mapped to no schema column anywhere; rather than
  -- silently drop them, they land here. See handoff notes for the reasoning
  -- on each:
  tax_amount                 NUMERIC(10,2),      -- was computed but never a live column
  policies_agreed            BOOLEAN,            -- refund/terms/privacy checkbox
  policy_versions_agreed     JSONB,              -- {"refund":"2026-07-29","terms":"2026-07-29","privacy":"2026-07-29"}
  -- Pre-tier-launch intake data (q1/q5-q14/dietary_preferences/includeAfterTrail):
  -- these only exist because the booking form already collects them for the
  -- not-yet-launched Peaks to Pools / Custom tiers (gated in code, per the
  -- guest journey map). None of it is roster data and none of it has a
  -- natural named column yet, so it lands in one JSONB bucket rather than
  -- either dropping it or inventing typed columns for an unlaunched tier.
  -- Flagged in the handoff for Airey to confirm this is the right call.
  intake_json                JSONB
);

CREATE INDEX IF NOT EXISTS idx_experience_bookings_person ON experience_bookings(person_id);
CREATE INDEX IF NOT EXISTS idx_experience_bookings_date ON experience_bookings(date);

-- UNIQUE, not a plain index (PRD Section 7's planned replacement for the
-- Apps Script "non-JSON interstitial page" recovery dance -- see
-- lib/booking-service.js): lets saveBooking use a single atomic
-- `INSERT ... ON CONFLICT (main_payment_intent_id) DO NOTHING RETURNING *`
-- for race-free dedup, instead of a separate pre-check + a post-failure
-- recovery lookup. Partial (WHERE ... IS NOT NULL) because Custom-tier
-- bookings never have a PaymentIntent (see api/save-booking.js's own
-- verifyChargeAgainstStripe()) and must store NULL, never '', so multiple
-- Custom bookings don't collide with each other under this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_experience_bookings_main_pi_unique
  ON experience_bookings(main_payment_intent_id) WHERE main_payment_intent_id IS NOT NULL;

-- ---------- Marquee / Social / Membership bookings (Section 4.4 — sketched, not built) ----------

CREATE TABLE IF NOT EXISTS marquee_bookings (
  booking_id            TEXT PRIMARY KEY,
  person_id             TEXT NOT NULL REFERENCES people(person_id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_name            TEXT,
  event_date            DATE,
  tier                  TEXT,
  price_cents           INTEGER,
  registration_opens_at TIMESTAMPTZ,
  capacity              INTEGER
);

CREATE TABLE IF NOT EXISTS social_bookings (
  booking_id   TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(person_id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_name   TEXT,
  event_date   DATE,
  capacity     INTEGER
);

CREATE TABLE IF NOT EXISTS membership_bookings (
  booking_id   TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(person_id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  tier_id      TEXT REFERENCES pricing_tiers(tier_id),
  price_cents  INTEGER
);

CREATE TABLE IF NOT EXISTS guest_passes (
  pass_id              TEXT PRIMARY KEY,
  person_id            TEXT NOT NULL REFERENCES people(person_id),
  issued_via_booking_id TEXT REFERENCES membership_bookings(booking_id),
  used_on_booking_id    TEXT REFERENCES experience_bookings(booking_id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Booking Participants (Section 4.2 — the roster join table) ----------

CREATE TABLE IF NOT EXISTS booking_participants (
  participant_id          TEXT PRIMARY KEY,        -- PART-XXXXXXXX
  experience_booking_id   TEXT REFERENCES experience_bookings(booking_id),
  marquee_booking_id      TEXT REFERENCES marquee_bookings(booking_id),
  social_booking_id       TEXT REFERENCES social_bookings(booking_id),
  membership_booking_id   TEXT REFERENCES membership_bookings(booking_id),
  person_id               TEXT REFERENCES people(person_id),
  roster_index            INTEGER NOT NULL,
  display_name            TEXT NOT NULL,
  email                    TEXT,
  phone                    TEXT,
  age_bucket               age_bucket_t,
  role_on_booking          role_on_booking_t NOT NULL,
  is_participating         BOOLEAN NOT NULL DEFAULT true,
  -- NEW (2026-08-31, roster/gear-kit ID-link fix): mapRosterEntry() in
  -- lib/booking-service.js has computed this value since the booking-core
  -- rewrite, but the INSERT never wrote it -- there was no column to write
  -- it to. This closes that gap: a real, persisted signal for "did this
  -- specific roster member request a personal gear kit," letting
  -- gear_check_log.participant_id (below) be populated at booking time
  -- instead of only ever carrying a denormalized person_name string.
  gear_kit                 BOOLEAN NOT NULL DEFAULT false,
  guardian_person_id       TEXT REFERENCES people(person_id),
  guardian_verified_at     TIMESTAMPTZ,
  pack_size_preference     pack_size_t,
  -- NEW, added during the booking+payment core rewrite (2026-08-31): the
  -- live booking form (adventure-form.js's roster step) collects a
  -- free-text fitness level per roster member ("Easygoing pace" /
  -- "Comfortable hiker" / "Strong / experienced") that has no column
  -- anywhere in Section 4.2's original booking_participants design.
  -- age_bucket above covers the roster's other per-person field (age
  -- range); this is the same "preserve rather than silently drop guest-
  -- submitted data" call already made for experience_bookings.intake_json.
  -- FLAG FOR AIREY: unclear whether this per-person value is read by
  -- anything downstream (trail assignment reads Adventure Prep's own
  -- booking-level technicalComfort/heatComfort instead, collected later,
  -- not this earlier per-roster-member field) -- confirm whether it's
  -- purely informational or should feed something.
  fitness_level            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_exactly_one_booking CHECK (
    (CASE WHEN experience_booking_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN marquee_booking_id    IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN social_booking_id     IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN membership_booking_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);

-- roster_index is unique PER BOOKING, not globally — enforce via four
-- partial unique indexes, one per booking-type column, since a plain
-- UNIQUE(experience_booking_id, roster_index) would allow duplicate NULLs
-- to collide across booking types under the polymorphic design above.
CREATE UNIQUE INDEX IF NOT EXISTS uq_participants_roster_exp
  ON booking_participants(experience_booking_id, roster_index) WHERE experience_booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_participants_roster_marquee
  ON booking_participants(marquee_booking_id, roster_index) WHERE marquee_booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_participants_roster_social
  ON booking_participants(social_booking_id, roster_index) WHERE social_booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_participants_roster_membership
  ON booking_participants(membership_booking_id, roster_index) WHERE membership_booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_participants_person ON booking_participants(person_id);
CREATE INDEX IF NOT EXISTS idx_participants_guardian ON booking_participants(guardian_person_id);

-- ---------- Waiver Versions / Waiver Signatures / Emergency Contact (Section 4.6 / 4.7) ----------

-- New table (approved by Airey 2026-08-31, not in the original PRD draft):
-- the live system today keeps the waiver's legal text in Script Properties
-- (see adventurePrep_getWaiverContent_ in adventure-prep-actions.gs) with no
-- versioned history -- a signature just stamps a free-text `waiver_version`
-- string. This table makes that a real, queryable version history: exactly
-- one row has is_current = true at any time, waiver_signatures.waiver_version
-- FKs into it, and re-pointing which version is current is a single UPDATE
-- rather than an edit to Script Properties.
CREATE TABLE IF NOT EXISTS waiver_versions (
  version       TEXT PRIMARY KEY,       -- e.g. 'v1.5'
  status_tag    TEXT,                   -- free-text label, e.g. 'active'
  body_html     TEXT NOT NULL,
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_current    BOOLEAN NOT NULL DEFAULT false
);

-- Enforce "exactly one current version" at the database level rather than
-- relying on application code to maintain it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_waiver_versions_one_current
  ON waiver_versions((is_current)) WHERE is_current = true;

CREATE TABLE IF NOT EXISTS waiver_signatures (
  signature_id               TEXT PRIMARY KEY,   -- SIG-XXXXXXXX
  booking_id                 TEXT NOT NULL REFERENCES experience_bookings(booking_id),
  person_id                  TEXT REFERENCES people(person_id),
  participant_id             TEXT REFERENCES booking_participants(participant_id),
  signer_token                TEXT UNIQUE,
  role                        TEXT,
  signer_name                 TEXT,
  signer_email                 TEXT,
  signer_phone                 TEXT,
  sms_consent                  BOOLEAN,
  sms_consent_at                TIMESTAMPTZ,
  sms_consent_text              TEXT,
  is_guardian                  BOOLEAN NOT NULL DEFAULT false,
  guardian_for_children_json    JSONB,
  waiver_version                TEXT REFERENCES waiver_versions(version),
  participants_covered_json     JSONB,
  ip_address                    TEXT,
  status                        TEXT,
  sent_at                       TIMESTAMPTZ,
  opened_at                     TIMESTAMPTZ,
  signed_at                     TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  details_confirmed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_waiver_signatures_booking ON waiver_signatures(booking_id);
CREATE INDEX IF NOT EXISTS idx_waiver_signatures_participant ON waiver_signatures(participant_id);

CREATE TABLE IF NOT EXISTS emergency_contact (
  contact_id     TEXT PRIMARY KEY,   -- EC-XXXXXXXX
  booking_id     TEXT NOT NULL REFERENCES experience_bookings(booking_id),
  person_id      TEXT REFERENCES people(person_id),
  participant_id TEXT REFERENCES booking_participants(participant_id),
  contact_name   TEXT,
  contact_phone  TEXT,
  contact_email  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emergency_contact_booking ON emergency_contact(booking_id);

-- ---------- Gear Units / Gear Check Log (Section 4.8) ----------

-- NOTE (found during this build's seed-data pull): the live TEST unitId
-- scheme was not globally unique -- GP-0001..GP-0004 were reused identically
-- across both backpack_standard AND backpack_plus. This is test data only
-- (confirmed by Airey 2026-08-31): the real gear inventory is being entered
-- fresh next week, at which point all current gear_units/gear_check_log rows
-- get deleted and replaced. unit_id is therefore kept as a simple global
-- primary key -- the seed data's colliding IDs are disambiguated at the seed
-- level (see seed.sql) rather than by widening the schema's key for a
-- collision that won't exist once real gear replaces the test rows.
CREATE TABLE IF NOT EXISTS gear_units (
  unit_id                TEXT PRIMARY KEY,   -- GP-0001, HF-0001, LK-0001, FA-0001, RM-0001
  item_type              gear_item_type_t NOT NULL,
  status                 gear_unit_status_t NOT NULL DEFAULT 'available',
  current_booking_id     TEXT REFERENCES experience_bookings(booking_id),
  replacement_cost_cents INTEGER NOT NULL,
  acquired_at            TIMESTAMPTZ,
  retired_at             TIMESTAMPTZ,
  retired_reason         TEXT,
  qr_token               TEXT UNIQUE,
  uses_since_deep_clean  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gear_check_log (
  item_row_id     TEXT PRIMARY KEY,     -- bare 8-hex, no prefix (matches live convention)
  booking_id      TEXT NOT NULL REFERENCES experience_bookings(booking_id),
  kit_number      INTEGER,
  person_name     TEXT,                 -- denormalized display snapshot, kept alongside person_id
  person_id       TEXT REFERENCES people(person_id),
  participant_id  TEXT REFERENCES booking_participants(participant_id),
  item_name       TEXT,
  item_cost       NUMERIC(10,2),
  checked_out_at  TIMESTAMPTZ,
  checked_in_at   TIMESTAMPTZ,
  condition       gear_condition_t,
  grace_deadline  TIMESTAMPTZ,
  recovered_at    TIMESTAMPTZ,
  notes           TEXT,
  unit_id         TEXT REFERENCES gear_units(unit_id),
  photo_url       TEXT
);

CREATE INDEX IF NOT EXISTS idx_gear_check_log_booking ON gear_check_log(booking_id);
CREATE INDEX IF NOT EXISTS idx_gear_check_log_unit ON gear_check_log(unit_id);

-- ---------- Adventure Prep (Section 4.9) ----------

CREATE TABLE IF NOT EXISTS adventure_prep (
  booking_id                   TEXT PRIMARY KEY REFERENCES experience_bookings(booking_id),
  is_participating             BOOLEAN,
  confirmed_kit_count          INTEGER,
  pending_kit_count            INTEGER,
  pending_since                TIMESTAMPTZ,
  technical_comfort            TEXT,
  heat_comfort                 TEXT,
  best_for_attributes          TEXT[],
  selected_trail_id            TEXT REFERENCES trails(trail_id),
  assigned_at                  TIMESTAMPTZ,
  assignment_method            TEXT,
  property_type                TEXT,
  delivery_address_line1       TEXT,
  delivery_address_line2       TEXT,
  delivery_city                TEXT,
  delivery_state               TEXT,
  delivery_zip                 TEXT,
  delivery_lat                 NUMERIC(9,6),
  delivery_lng                 NUMERIC(9,6),
  delivery_address_validated   BOOLEAN,
  delivery_address_raw         TEXT,
  delivery_window               TEXT,
  return_preference             TEXT,
  all_waivers_complete           BOOLEAN,
  adventure_prep_stalled_flag    BOOLEAN,
  phone_fallback_due             BOOLEAN,
  t3_cutoff_processed_at         TIMESTAMPTZ,
  delivery_note                  TEXT,
  return_same_as_delivery        BOOLEAN,
  return_address_line1           TEXT,
  return_location                TEXT,
  return_window                  TEXT,
  return_note                    TEXT,
  -- NEW (Section 8.5): real placeholder column, replacing the literal
  -- 'PENDING_REAL_INTEGRATION:<trailId>:<timestamp>' string written today.
  -- No real RideWithGPS integration exists yet or is built by this migration.
  ride_with_gps_experience_access TEXT,
  -- NEW (Phase 2.5 Trail Day, claude/psac-trail-day-phase-proposal-2026-09-04.md,
  -- 2026-09-04) -- see db/2026-09-04_add_trail_day_fields.sql for the full
  -- reasoning on each of these four columns.
  heading_out_at          TIMESTAMPTZ,
  expected_return_at      TIMESTAMPTZ,
  trail_day_roster_json   JSONB,
  guide_first_opened_at   TIMESTAMPTZ
);

-- participatingRosterRef (live column) is deliberately DROPPED here, same
-- reasoning as reconfirmedRosterJson (Section 4.9): booking_participants.
-- is_participating is now the one canonical "who's actually on this trip"
-- signal — a second free-text tracker of the same fact is exactly the kind
-- of parallel-roster-representation drift Section 5 eliminates.

-- ---------- Candidate Trails (Section 4.9) ----------

CREATE TABLE IF NOT EXISTS candidate_trails (
  candidate_trail_id    BIGSERIAL PRIMARY KEY,
  experience_booking_id TEXT NOT NULL REFERENCES experience_bookings(booking_id),
  rank                  INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 4),
  source                TEXT NOT NULL CHECK (source IN ('rules_v1','manual_override')),
  trail_id              TEXT NOT NULL REFERENCES trails(trail_id),
  matched_attributes     TEXT[],
  difficulty_rating      INTEGER,
  technical_rating       INTEGER,
  distance               NUMERIC(5,2),
  elevation              INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (experience_booking_id, rank)
);

-- ---------- Booking Cadence Log (Section 4.3) ----------

CREATE TABLE IF NOT EXISTS booking_cadence_log (
  booking_id  TEXT NOT NULL REFERENCES experience_bookings(booking_id),
  stage       TEXT NOT NULL,     -- e.g. 't7','t5','t3','midwindow'
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, stage)
);

-- ---------- Audit Log (Section 4.10, was Adventure Prep Change Log) ----------

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id                          TEXT PRIMARY KEY,   -- AUDIT-XXXXXXXX
  booking_id                        TEXT REFERENCES experience_bookings(booking_id),
  change_type                       TEXT NOT NULL,
  "timestamp"                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  before_t3_cutoff                  BOOLEAN,
  old_value_json                    JSONB,
  new_value_json                    JSONB,
  delta                             NUMERIC(10,2),
  refund_or_charge_amount           NUMERIC(10,2),
  stripe_transaction_id             TEXT,
  staff_notes                       TEXT,     -- ONE column, fixes the live duplicate-staffNotes bug
  triggering_input                  TEXT,
  tier_a_safety_filters_overridden  TEXT[],
  safety_override_reason            TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_booking ON audit_log(booking_id);

-- ---------- Ops Alerts / Trail Swap Requests (Section 4.12) ----------

CREATE TABLE IF NOT EXISTS ops_alerts (
  alert_id            TEXT PRIMARY KEY,   -- ALERT-XXXXXXXX
  booking_id          TEXT REFERENCES experience_bookings(booking_id),
  alert_type          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount              NUMERIC(10,2),
  stripe_error_detail TEXT,
  status              TEXT NOT NULL DEFAULT 'Open',
  resolved_at         TIMESTAMPTZ,
  resolved_by         TEXT,
  notes               TEXT,
  urgency             TEXT
);

CREATE INDEX IF NOT EXISTS idx_ops_alerts_booking ON ops_alerts(booking_id);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_status ON ops_alerts(status);

CREATE TABLE IF NOT EXISTS trail_swap_requests (
  swap_request_id                    TEXT PRIMARY KEY,  -- SWAP-XXXXXXXX
  booking_id                         TEXT NOT NULL REFERENCES experience_bookings(booking_id),
  guest_concern_summary               TEXT,
  received_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                              TEXT NOT NULL DEFAULT 'Open',
  reviewed_by                         TEXT,
  new_trail_id                        TEXT REFERENCES trails(trail_id),
  staff_notes                         TEXT,
  resolved_at                         TIMESTAMPTZ,
  -- FIXED (2026-08-31, Task 8 ops-proxy migration): was BOOLEAN, but the
  -- real write (trailSwap_applyOverride in apps-script/trail-swap-
  -- actions.gs, and now lib/trail-swap-service.js's applyOverride) has
  -- always been a JSON-stringified ARRAY of filter names (e.g.
  -- ['difficulty_ceiling','family_tier']) -- which filters were
  -- overridden, not just whether any were. audit_log's own column of the
  -- exact same name is correctly typed TEXT[] (see below) -- this table's
  -- BOOLEAN never agreed with either its own real writer or its sibling
  -- column, and nothing live has ever written to it (Trail Swap Requests
  -- was never migrated off Apps Script before this turn), so safe to
  -- correct now.
  tier_a_safety_filters_overridden     TEXT[],
  safety_override_reason              TEXT
);

CREATE INDEX IF NOT EXISTS idx_trail_swap_requests_booking ON trail_swap_requests(booking_id);

-- ---------- Job locks (Section 8.5 — replaces PropertiesService run-lock) ----------

CREATE TABLE IF NOT EXISTS job_locks (
  job_name   TEXT PRIMARY KEY,
  locked_at  TIMESTAMPTZ,
  locked_by  TEXT
);

-- ============================================================
-- End of schema.sql
-- ============================================================
