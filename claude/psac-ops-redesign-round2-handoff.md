# Ops App Redesign — Build Handoff (Round 2 complete)

**Date:** August 27, 2026
**Repo:** `PinkMountainVentures/psac-website`, branch `main`
**Delivery method:** this session cannot push to your GitHub repo directly — see "How to get this into your repo" at the bottom. Everything below is real, working code, already committed locally in this session; it just needs one `git am`/`git apply` step on your end (or a dev's) to land in `main`.

This closes out all 10 items from the original kickoff. What follows is the honest built-vs-stubbed picture, the two things you specifically asked to have spelled out end-to-end, and everything this build found that needs a decision from you before it's fully production-ready.

## Your five answers, applied

1. **Custom Tier** — confirmed out of scope for this build (handled entirely offline via email + manual Stripe charge), but you flagged a real gap: there's currently no way to get that booking back into the system afterward. See "Custom Tier's re-entry gap" below — this needs a scoping decision before it gets built, not silently guessed at.
2. **Standard sweep time locked to 9:00pm** — done, the display text now reads exactly "9:00pm" everywhere it appears (was "after 9:00pm tonight"). Your separate guest-facing pickup-instructions work (location type, time, freeform note) isn't built here — see the forward-compat note below on how it should slot into what already exists.
3. **Low-stock thresholds** — no change, confirmed fine as-is for now.
4. **All 3 remaining Manual Adjustment types now auto-log their own Change Log row** — done. `kit_count_correction`, `gear_check_log_adjustment`, and `update_delivery_address` each write their own entry now, matching the other 5 types. All 8 types self-log; the Adjustment Type filter no longer has a "won't show anything" caveat for any of them.
5. **Git push access** — noted, being handled in the main coordinating chat. No action taken here; the patch-file delivery below still stands as the fallback either way.

---

## 1. Status per item

| # | Item | Status |
|---|---|---|
| 1 | All Bookings | **Built.** New page + new Apps Script aggregation query (`allBookings_listAll`). Real new backend work — this view didn't exist before. |
| 2 | Ops Alerts expansion | **Built.** New producers, tiers, banner, category filter, label mapping. Real new backend work (5 new alert types, computed live, never stored). |
| 3 | Stalled Bookings | **Built.** New page + backend (`stalled_listAll`, `stalled_markCalled`). Real new backend work — was a dead nav item with zero backend before. |
| 4 | Cancellations | **Built.** New page + backend (`cancellations_listAll`). Enum values were never renamed — translated at render time only, per your instruction. |
| 5 | Gear Assembly & Checkout extensions | **Built.** 3-state delivery flow, bulk "Confirm all remaining," Retry Allocation fix, Loading state. |
| 6 | Return Check-In extensions | **Built.** Pickup default+override, new pipeline states, bulk "Mark all remaining Good," Missing photo→note fix. |
| 7 | Gear Units extensions | **Built.** Mark Repaired, collapsed Add Unit, jump-to-item-type. |
| 8 | Manual Adjustment extensions | **Built.** 3 new types, filters, system-entry toggle. |
| 9 | Trail Swap Requests | **Verified already correct**, one real gap fixed (difficultyRating display). |
| 10 | Shared shell | **Built and applied everywhere** — all 10 nav-item pages now run on one shared `ops-shell.js`/`ops-shell.css`, not copy-pasted boilerplate. |

Nothing in this list is a stub dressed up as done. Where something genuinely isn't finished, it's called out below, not silently worked around.

---

## 2. The two things you asked to have spelled out end-to-end

### Custom Tier's two-step status — confirmed out of scope, but with a real re-entry gap

Confirmed by exhaustive grep across the whole codebase (Node + Apps Script): **there is no Custom Tier intake anywhere in this system**, and per your answer, that's by design — the booking flow redirects multi-day inquiries to email, you handle pricing and the Stripe charge manually offline. That part is fine as-is.

**The gap is what happens next.** Once you've charged a guest for a Custom Tier trip, there's currently no way to get that booking into Experience Bookings as a real row — which means it can't flow into gear allocation, trail assignment, delivery scheduling, or any of the ops surfaces this whole redesign just built. Confirmed via the same grep: no "create a booking manually" action exists anywhere in this codebase, for any tier.

This needs a scoping decision, not a guess: what's the minimal set of fields a manually-entered Custom Tier booking needs (contact info, trail day, party size/roster, gear kit count, delivery address, some marker that its payment already happened outside Stripe's normal booking-flow path so downstream deposit-hold logic doesn't try to charge it again)? Building this without confirming the shape first risks a form that doesn't match how you actually work the offline process — flagging it here rather than guessing at a form and shipping it.

### Return Check-In's pickup default+override — exact end-to-end behavior

1. **Default (the common case, zero staff action):** the moment a booking's gear is delivered, it appears in the Return Check-In queue with `returnStatus` blank. Opening it shows a confirmed-looking card: *"✓ Default — no action needed. Same address as delivery ({address}) · standard nightly sweep, 9:00pm."* Staff only ever has to pick **Pickup Service** (PSAC Staff / Uber Direct) and click **Schedule Pickup** — nothing else to fill in.
2. **Override:** a collapsed "Need a different pickup time or location?" toggle reveals an editable **Return Address** (pre-filled to the delivery address) and a free-text **Return Time note** (not a rigid picker — real constraints like "host asks no visitors after 8pm" don't fit a dropdown). Both fields are blank unless staff actually types something; blank on submit = default, no matter whether the toggle was opened.
3. Clicking **Schedule Pickup** calls `gearOps_schedulePickup`, writing `returnStatus: 'pickup_scheduled'` plus whatever service/override values were set.
4. **Picked Up is optional and skippable** — a "Mark Picked Up" button is offered but never required; the real, required gate is **Mark Returned** (`gearOps_markReturned`, sets `returnStatus: 'returned'`), which is what actually reveals the per-item condition-assessment view.
5. Once every trackable item on the booking has a saved condition, the server sets `returnStatus: 'checked_in'` **automatically** — not a button. This happens via a best-effort call (`gearOps_syncReturnStatusIfSettled`) fired right after every individual item check-in; a sync failure there never masks the check-in write itself, and the next check-in (or a manual glance) catches it.

**9:00pm is now locked in** as the displayed standard sweep time (was "after 9:00pm tonight"). It's a display string only — the default write path still leaves the actual time field blank rather than writing a literal "9:00pm" value, so this stays a one-line text change if it ever needs to move.

**On your separate guest-facing pickup-instructions work:** once that's built (pickup location type — front desk / front door / front gate / hand delivery — pickup time, and a freeform note, submitted by the guest), the natural integration point is this override panel: `pickupAddressOverride`/`pickupTimeNote` would get pre-filled from whatever the guest already submitted in Adventure Prep instead of starting blank, so staff sees "here's what the guest asked for, confirm or adjust" rather than a from-scratch form. `pickupServiceType` (PSAC Staff vs. Uber Direct) stays a staff-only operational decision either way — not something a guest would pick. This is flagged in code (`gearOps_schedulePickup`'s own comment in `ops-redesign-round2-actions.gs`) so whoever builds the guest-facing side sees the intended seam.

---

## 3. Real, disclosed bugs found and fixed this round (not part of the original 10-item list)

1. **`lib/trail-selection-engine.js`** — a genuine, pre-existing bug in the `refresh` operation: a `manual_override` trail candidate used to be preserved across a trail-day-change refresh with **zero re-validation** against the new date's Tier A safety filters. Fixed to re-check `bookable`/`park_date_availability`/`seasonal_safety` for the new date, dropping and flagging (never silently keeping or silently reverting) if it no longer passes. This was required to build item 8's "Trail day/date change" adjustment type correctly — found by reading the live code rather than trusting the spec's "confirmed by Airey" framing.
2. **`manualAdjustment_trailDayChange`** (new this round, in `ops-redesign-round2-actions.gs`) originally wrote **no Change Log row at all** — unlike its two sibling new types (Swap an allocated unit, Post-delivery cancellation), which each log their own entry inline. Caught while building the Manual Adjustment page's own Adjustment Type filter (a trail day change would have been literally invisible in the audit table). Fixed to log a `trail_day_change` entry the same way its siblings do.
3. **Retry Allocation, Gear Assembly & Checkout** — the old precondition (`if (!allocation.length || !anyAllocated)`) could never actually surface the Retry button for a real partial-shortage booking (as soon as one item allocated, it looked "done enough"). Fixed to a proper "does anything still lack a unit" check.
4. **Missing item photo requirement, Return Check-In** — previously required a photo for Missing items exactly like Damaged, even though there's nothing to photograph for an item that isn't there. Fixed (this fix predates this specific handoff but is worth restating): Missing now requires a text note instead; Damaged is untouched.
5. **Manual Adjustment's 3 non-self-logging types** — per your direct instruction (item 4 above), `manualAdjustment_kitCountCorrection`, `manualAdjustment_gearCheckLogAdjustment`, and `manualAdjustment_updateDeliveryAddress` (all in `manual-adjustment-actions.gs`) now each write their own Change Log row (`kit_count_correction`, `gear_check_log_adjustment`, `update_delivery_address` respectively), reversing their original "no auto-log, staff runs Change log note separately" design. All 8 Manual Adjustment types now self-log consistently.

---

## 4. Judgment calls and assumptions baked into this build — worth a look before you trust the numbers

- **`depositStatus` → Hold Status mapping**: `refunded` is mapped to "Released" (net capture is zero) and `shortfall_charge_in_progress` (a brief in-flight lock state) to "Captured (partial)" — neither is in the originally-approved 6-value list; both are reasonable but not spec'd. See the header comment on `opsRedesign_holdStatusBucket_` in `ops-redesign-round1-actions.gs`.
- **Payment Status "Failed" is currently unreachable in live data** — confirmed via `api/save-booking.js`, which refuses to write any booking whose PaymentIntent isn't `succeeded`/`processing`. The bucket exists in the UI for completeness, not because it can currently fire.
- **Cancellation-awareness window defaults to 7 days** — not explicitly spec'd, a reasonable default, flagged in `ops-redesign-round1-actions.gs`.
- **Low-stock gear thresholds** (`OPS_ALERT_LOW_STOCK_THRESHOLDS_`) — confirmed fine as-is for now (your answer above); will need updating as inventory and booking volume grow.
- **The stalled-bookings call script wording is my own unreviewed draft** — flagged inline in `ops-stalled-bookings.html`, not represented as Airey-approved copy.
- **Delivery Time slot options** are hard-coded to 4 fixed 30-minute slots per window (e.g. 7:00/7:30/8:00/8:30pm for the 7-9pm window), matching the approved mockup exactly — not derived from any configurable interval.

---

## 5. What this build genuinely needs from you before it's production-ready

1. **Custom Tier re-entry into the system** — needs a scoping decision on what a manually-entered post-offline booking record requires (see section 2 above) before it gets built. Not yet built.
2. **Git push access** — being handled in the main coordinating chat, per your note. This session's GitHub App install still doesn't include `PinkMountainVentures/psac-website` in its authorized repo set (403 on push); the patch-file delivery below is the fallback until that's resolved.
3. **Guest-facing pickup instructions** (location type, time, freeform note) — your own separate build; this session left a clear integration seam for it in `gearOps_schedulePickup`'s comments (see section 2) but didn't build it.

---

## 6. How to get this into your repo

This session cannot push directly. Attached to this handoff:

- **`ops-redesign-round2-frontend-and-fixes.patch`** — a `git format-patch` file (everything in this round, as one commit on top of your current `main`). On a machine with a real clone of the repo and push access:

  ```
  git checkout main && git pull
  git am ops-redesign-round2-frontend-and-fixes.patch
  git push origin main
  ```

  `git am` applies it as a normal commit, preserving the commit message and authorship. If `git am` complains about a conflict (it shouldn't — this patch is built directly on the current `main` tip), `git apply ops-redesign-round2-frontend-and-fixes.patch` applies just the diff without a commit, so you can review and commit it yourself instead.

---

## 7. Apps Script — exact paste-in steps (unchanged mechanism, two new files this round)

Two new `.gs` files are attached: **`ops-redesign-round1-actions.gs`** (items 1–4) and **`ops-redesign-round2-actions.gs`** (items 5–9's backend). Do these **in order** — Round 2 reuses helpers Round 1 doesn't touch, but both independently require the existing patches (`adventure-prep-actions.gs`, `gear-inventory-actions.gs`, `manual-adjustment-actions.gs`, `cadence-actions.gs`, `ops-alerts-actions.gs`) already pasted into your live Apps Script project — they should be, from earlier rounds.

### Step 1 — Round 1 (`ops-redesign-round1-actions.gs`)

1. Open the Apps Script editor on your "PSAC Bookings & Operations" project. Create a new script file (or paste into `Code.gs`) and paste in the **entire contents** of `ops-redesign-round1-actions.gs`.
2. In your existing `doPost(e)` dispatcher, add these six branches (put them anywhere in the existing `else if` chain):

   ```js
   } else if (body.action === 'allBookings_listAll') {
     out = allBookings_listAll(body);
   } else if (body.action === 'opsAlerts_listExpanded') {
     out = opsAlerts_listExpanded(body);
   } else if (body.action === 'stalled_listAll') {
     out = stalled_listAll(body);
   } else if (body.action === 'stalled_markCalled') {
     out = stalled_markCalled(body);
   } else if (body.action === 'cancellations_listAll') {
     out = cancellations_listAll(body);
   ```

3. From the Apps Script editor, run `opsRedesignRound1_setup()` once (select it from the function dropdown, click Run). Safe to re-run — it's additive-only.

### Step 2 — Round 2 (`ops-redesign-round2-actions.gs`)

1. Create another new script file and paste in the **entire contents** of `ops-redesign-round2-actions.gs`.
2. Add these eleven branches to the same `doPost(e)` dispatcher:

   ```js
   } else if (body.action === 'gearOps_markReadyForDelivery') {
     out = gearOps_markReadyForDelivery(body);
   } else if (body.action === 'gearOps_scheduleDelivery') {
     out = gearOps_scheduleDelivery(body);
   } else if (body.action === 'gearOps_markDeliveredFinal') {
     out = gearOps_markDeliveredFinal(body);
   } else if (body.action === 'gearOps_schedulePickup') {
     out = gearOps_schedulePickup(body);
   } else if (body.action === 'gearOps_markPickedUp') {
     out = gearOps_markPickedUp(body);
   } else if (body.action === 'gearOps_markReturned') {
     out = gearOps_markReturned(body);
   } else if (body.action === 'gearOps_getReturnContext') {
     out = gearOps_getReturnContext(body);
   } else if (body.action === 'gearOps_getCheckinQueueV2') {
     out = gearOps_getCheckinQueueV2(body);
   } else if (body.action === 'gearOps_syncReturnStatusIfSettled') {
     out = gearOps_syncReturnStatusIfSettled(body);
   } else if (body.action === 'manualAdjustment_trailDayChange') {
     out = manualAdjustment_trailDayChange(body);
   } else if (body.action === 'manualAdjustment_swapAllocatedUnit') {
     out = manualAdjustment_swapAllocatedUnit(body);
   } else if (body.action === 'manualAdjustment_postDeliveryCancellation') {
     out = manualAdjustment_postDeliveryCancellation(body);
   ```

3. Run `opsRedesignRound2_setup()` once. Also safe to re-run.
4. Save and re-deploy the web app (Deploy → Manage deployments → edit the existing deployment → New version) so the new actions are live at your existing webapp URL.

No new environment variables or secrets are needed for either file — everything reuses `GEAR_OPS_SHARED_SECRET`, `MANUAL_ADJUSTMENT_SHARED_SECRET`, and `TRAIL_OVERRIDE_SHARED_SECRET`, all already configured from earlier rounds.

---

## 8. What's in the code delivery (patch + bundle)

Full file list, all already committed locally as one commit on top of your current `main`:

**New:** `ops-shell.js`, `ops-shell.css`, `ops-all-bookings.html`, `ops-cancellations.html`, `ops-stalled-bookings.html`, `apps-script/ops-redesign-round1-actions.gs`, `apps-script/ops-redesign-round2-actions.gs`.

**Rewritten or extended:** `ops-alerts.html`, `ops-gear-checkout.html`, `ops-gear-checkin.html`, `ops-gear-units.html`, `ops-manual-adjustment.html`, `ops-trail-swap-requests.html`, `ops-reconciliation-review.html`, `api/checkout-gear.js`, `api/check-in-gear-item.js`, `api/manage-gear-units.js`, `api/apply-manual-adjustment.js`, `api/ops-proxy.js`, `lib/trail-selection-engine.js`, `apps-script/manual-adjustment-actions.gs` (already live in your Apps Script project from an earlier round — see the note below on re-pasting it).

**Important — `manual-adjustment-actions.gs` needs re-pasting, not just the two new files.** Unlike the two new `.gs` files below, this one already exists in your live Apps Script project from an earlier round. This build changed 3 of its functions (the auto-logging fix, item 4 above) — you'll need to replace its contents in the Apps Script editor with the updated version attached here, then save and re-deploy. No new dispatch-chain wiring or setup() call needed for this one; it's the same action names as before, just with an added Change Log write inside each.

Every file above was read against the live codebase before being changed — nothing here was built against the spec docs alone.
