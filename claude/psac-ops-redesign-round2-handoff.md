# Ops App Redesign — Build Handoff (Round 2 complete)

**Date:** August 27, 2026
**Repo:** `PinkMountainVentures/psac-website`, branch `main`
**Delivery method:** this session cannot push to your GitHub repo directly — see "How to get this into your repo" at the bottom. Everything below is real, working code, already committed locally in this session; it just needs one `git am`/`git apply` step on your end (or a dev's) to land in `main`.

This closes out all 10 items from the original kickoff. What follows is the honest built-vs-stubbed picture, the two things you specifically asked to have spelled out end-to-end, and everything this build found that needs a decision from you before it's fully production-ready.

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

### Custom Tier's two-step status — **not built, this is a real blocker**

Confirmed by exhaustive grep across the whole codebase (Node + Apps Script), re-confirmed again this round: **there is no Custom Tier intake anywhere in this system.** No form, no Sheet columns, no backend action. Every place this build needed to reference it (Ops Alerts' tier grouping, All Bookings' tier column) had to render a visible "Custom Tier intake doesn't exist yet" note rather than pretend it works. If Custom Tier bookings are coming in today, they're being handled entirely outside this app — worth confirming that's actually true, because if it isn't, those bookings have no ops visibility at all right now.

### Return Check-In's pickup default+override — exact end-to-end behavior

1. **Default (the common case, zero staff action):** the moment a booking's gear is delivered, it appears in the Return Check-In queue with `returnStatus` blank. Opening it shows a confirmed-looking card: *"✓ Default — no action needed. Same address as delivery ({address}) · standard nightly sweep, after 9:00pm tonight."* Staff only ever has to pick **Pickup Service** (PSAC Staff / Uber Direct) and click **Schedule Pickup** — nothing else to fill in.
2. **Override:** a collapsed "Need a different pickup time or location?" toggle reveals an editable **Return Address** (pre-filled to the delivery address) and a free-text **Return Time note** (not a rigid picker — real constraints like "host asks no visitors after 8pm" don't fit a dropdown). Both fields are blank unless staff actually types something; blank on submit = default, no matter whether the toggle was opened.
3. Clicking **Schedule Pickup** calls `gearOps_schedulePickup`, writing `returnStatus: 'pickup_scheduled'` plus whatever service/override values were set.
4. **Picked Up is optional and skippable** — a "Mark Picked Up" button is offered but never required; the real, required gate is **Mark Returned** (`gearOps_markReturned`, sets `returnStatus: 'returned'`), which is what actually reveals the per-item condition-assessment view.
5. Once every trackable item on the booking has a saved condition, the server sets `returnStatus: 'checked_in'` **automatically** — not a button. This happens via a best-effort call (`gearOps_syncReturnStatusIfSettled`) fired right after every individual item check-in; a sync failure there never masks the check-in write itself, and the next check-in (or a manual glance) catches it.

**One number in this flow is still yours to lock down:** the "standard nightly sweep" pickup time is displayed as "after 9:00pm tonight" everywhere in this build, matching the journey map's own working assumption — but the map itself says explicitly "the exact figure is still Airey's to lock down." It's a display string only right now (the default write path leaves the actual time blank, meaning "use whatever the standing default is" — nothing downstream currently reads or enforces a specific clock time), so changing the displayed number later is a one-line text edit, not a schema change.

---

## 3. Real, disclosed bugs found and fixed this round (not part of the original 10-item list)

1. **`lib/trail-selection-engine.js`** — a genuine, pre-existing bug in the `refresh` operation: a `manual_override` trail candidate used to be preserved across a trail-day-change refresh with **zero re-validation** against the new date's Tier A safety filters. Fixed to re-check `bookable`/`park_date_availability`/`seasonal_safety` for the new date, dropping and flagging (never silently keeping or silently reverting) if it no longer passes. This was required to build item 8's "Trail day/date change" adjustment type correctly — found by reading the live code rather than trusting the spec's "confirmed by Airey" framing.
2. **`manualAdjustment_trailDayChange`** (new this round, in `ops-redesign-round2-actions.gs`) originally wrote **no Change Log row at all** — unlike its two sibling new types (Swap an allocated unit, Post-delivery cancellation), which each log their own entry inline. Caught while building the Manual Adjustment page's own Adjustment Type filter (a trail day change would have been literally invisible in the audit table). Fixed to log a `trail_day_change` entry the same way its siblings do.
3. **Retry Allocation, Gear Assembly & Checkout** — the old precondition (`if (!allocation.length || !anyAllocated)`) could never actually surface the Retry button for a real partial-shortage booking (as soon as one item allocated, it looked "done enough"). Fixed to a proper "does anything still lack a unit" check.
4. **Missing item photo requirement, Return Check-In** — previously required a photo for Missing items exactly like Damaged, even though there's nothing to photograph for an item that isn't there. Fixed (this fix predates this specific handoff but is worth restating): Missing now requires a text note instead; Damaged is untouched.

---

## 4. Judgment calls and assumptions baked into this build — worth a look before you trust the numbers

- **`depositStatus` → Hold Status mapping**: `refunded` is mapped to "Released" (net capture is zero) and `shortfall_charge_in_progress` (a brief in-flight lock state) to "Captured (partial)" — neither is in the originally-approved 6-value list; both are reasonable but not spec'd. See the header comment on `opsRedesign_holdStatusBucket_` in `ops-redesign-round1-actions.gs`.
- **Payment Status "Failed" is currently unreachable in live data** — confirmed via `api/save-booking.js`, which refuses to write any booking whose PaymentIntent isn't `succeeded`/`processing`. The bucket exists in the UI for completeness, not because it can currently fire.
- **Cancellation-awareness window defaults to 7 days** — not explicitly spec'd, a reasonable default, flagged in `ops-redesign-round1-actions.gs`.
- **Low-stock gear thresholds** (`OPS_ALERT_LOW_STOCK_THRESHOLDS_`) are taken as literally-confirmed figures from the spec doc — worth a final sanity check against real inventory before relying on the alert.
- **The stalled-bookings call script wording is my own unreviewed draft** — flagged inline in `ops-stalled-bookings.html`, not represented as Airey-approved copy.
- **Manual Adjustment's Adjustment Type filter**: 3 of the original 5 types (Kit count correction, Gear Check Log adjustment, Update delivery address) don't write their own dedicated Change Log row today — by original design, their audit trail is the separate "Change log note" step staff run afterward. Filtering to one of those 3 will correctly show nothing unless that separate note was also logged. This isn't a bug introduced this round; it's existing logging behavior surfacing through a new filter. Worth deciding whether that's the right long-term behavior or whether those 3 should get their own auto-logged row too, matching the 3 new Round 2 types (all of which do log automatically).
- **Delivery Time slot options** are hard-coded to 4 fixed 30-minute slots per window (e.g. 7:00/7:30/8:00/8:30pm for the 7-9pm window), matching the approved mockup exactly — not derived from any configurable interval.

---

## 5. What this build genuinely needs from you before it's production-ready

1. **Custom Tier intake** — confirm whether it's truly out of scope right now, or whether Custom Tier bookings need real handling this build should have covered.
2. **Standard pickup sweep time** — lock down the actual figure ("9:00pm" vs. "after 9:00pm, no fixed end" vs. a window like delivery's).
3. **Low-stock thresholds** — sanity-check the numbers this build assumed against your real inventory counts.
4. **Manual Adjustment's 3 non-self-logging types** — decide if that's staying as-is or should change.
5. **Git push access** — this session's GitHub App install doesn't include `PinkMountainVentures/psac-website` in its authorized repo set (403 on push, unchanged from earlier flags this build). See below for the workaround used this round.

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

**Rewritten or extended:** `ops-alerts.html`, `ops-gear-checkout.html`, `ops-gear-checkin.html`, `ops-gear-units.html`, `ops-manual-adjustment.html`, `ops-trail-swap-requests.html`, `ops-reconciliation-review.html`, `api/checkout-gear.js`, `api/check-in-gear-item.js`, `api/manage-gear-units.js`, `api/apply-manual-adjustment.js`, `api/ops-proxy.js`, `lib/trail-selection-engine.js`.

Every file above was read against the live codebase before being changed — nothing here was built against the spec docs alone.
