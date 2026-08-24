# Gear Inventory, Checkout & Deposit Reconciliation — build handoff

Build date: 2026-08-19. Fourth and final post-booking build (bucket 2.5-2.9), closing out the biggest remaining item on the checklist. Everything below is real code in this repo, written to the exact conventions the existing app already uses. Nothing here has been run against a live Sheet, Stripe, or Vercel deployment — that's the verification you'll need to do once you've pasted in the Apps Script and set the env vars below.

## What's actually built and deployed vs. stubbed or untested

**Written, syntax-checked (`node --check` on every file), cross-referenced (every `opsCall` in the four new pages matches an `ops-proxy.js` route; every Apps Script action called from Node exists in the `.gs` patch) — but not run against live infrastructure:**

- All 9 new API endpoints, all wired into `ops-proxy.js`.
- The Apps Script patch, `apps-script/gear-inventory-actions.gs`.
- The `bookings-code.gs` diff (first aid kit gear row + cost).
- All four new ops pages, wired to real endpoints (not the mockups' static HTML).
- The hold-renewal cron, registered in `vercel.json`.

**Genuinely untested, because doing so requires your live Sheet, Stripe test mode, and a deployment:**

- Every Stripe call path (hold creation reuse, capture, cancel, off-session charge, refund) — the logic mirrors already-live patterns exactly, but this specific new code has run zero times against Stripe's API.
- The QR scan flow's `BarcodeDetector` branch — I could not test camera access in this environment. The manual entry fallback (always present, equally weighted, not degraded) is the one path I'm confident works mechanically, since it's just a form field.
- Vercel Blob photo upload — new dependency, never invoked.
- The Apps Script functions themselves — Apps Script's own runtime (`SpreadsheetApp`, `LockService`, etc.) doesn't exist outside the Apps Script editor, so nothing here could be executed, only read closely against the same helper functions the already-live `adventure-prep-actions.gs` code uses successfully.

## What you need to do before this is live

1. **Paste `apps-script/gear-inventory-actions.gs` into the Apps Script project.** Full install instructions are in that file's own header comment, including the exact `doPost` dispatch branches to add. Then run `gearOps_setup()` once, then `gearOps_seedInitialInventory()` once (it refuses to run a second time if the tab already has data, so it can't double-seed by accident).
2. **Paste in the `bookings-code.gs` diff** — I edited the live copy in this repo directly (`ITEM_COSTS` gets a `'Hard-Shell First Aid Kit': 9.99` entry, `buildGearLogRows()` gets one more `gearRow(...)` push per kit). Diff it against whatever's currently in the Sheet's script editor and paste the changes in. The `unitId`/`photoUrl` columns on `Gear Check Log` are handled separately, by `gearOps_setup()` — not by this diff.
3. **Set `GEAR_OPS_SHARED_SECRET` in Vercel** (any long random string). One shared secret across every new endpoint this round, a deliberate deviation from the project's usual one-secret-per-endpoint convention — documented in `.env.example`, easy to split later if that matters more than the convenience.
4. **Create a Vercel Blob store and attach it to the project** (dashboard → Storage → Blob). This provisions `BLOB_READ_WRITE_TOKEN` automatically — nothing to hand-generate.
5. **Run `npm install @vercel/blob`** — the one new npm dependency this build adds (`lib/gear-photo-upload.js`'s header explains why: Vercel Blob's wire protocol isn't a documented plain-REST contract the way Stripe's and Resend's are, so this uses Vercel's own first-party SDK rather than reverse-engineering it). The version pinned in `package.json` (`^0.27.0`) was not checked against the live npm registry — run `npm install @vercel/blob@latest` to get a real current version.
6. **Confirm `DEPOSIT_HOLD_SHARED_SECRET` is set in Vercel Production** — the hold-renewal cron reuses it in-process, with zero changes to `create-deposit-hold.js` itself.
7. **Confirm you (or whoever needs it) have direct access to the "PSAC Bookings & Operations" Sheet and its Apps Script project** — I can't paste code in myself.

## The reconciliation logic's test coverage against all four Stripe scenarios

Not run live — here's the mapping from spec to code so you can verify it by hand or with a test booking:

| Scenario | Condition | Stripe action | `depositStatus` written |
|---|---|---|---|
| 1 | itemized = $0 | Cancel the PaymentIntent | `released` |
| 2 | $0 < itemized < hold | Capture `amount_to_capture = itemized` | `partial_capture` |
| 3 | itemized = hold | Capture the full hold | `full_capture` |
| 4 | itemized > hold | Capture the full hold, flag shortfall | `full_capture_pending_review` |

The hold amount is always read back from Stripe's own PaymentIntent (`pi.amount`), never trusted from a stored figure. `api/reconcile-gear-deposit.js` also self-heals: if a previous call's Stripe action succeeded but the write-back then failed (so the Sheet still shows `held`), a retry reads the PaymentIntent's real terminal status (`canceled` or `succeeded`) and recovers from it instead of attempting a second capture, which Stripe would reject anyway. Scenario 4 sends no guest email at reconciliation time — only the hold gets captured, the shortfall charge hasn't happened yet — that email only fires from `api/charge-gear-shortfall.js` on an actual successful charge, since its copy is written in the past tense ("we've charged an additional $X").

## The hold-renewal cron

`api/renew-deposit-hold.js`, gated to 1pm Pacific, runs after the existing 9am hold trigger and noon clearance check so it never races either over the same day's T-1 hold. On a clean renewal: it calls `create-deposit-hold.js`'s own handler in-process (zero changes to that file), and only cancels the old hold *after* the new one succeeds — so a failed renewal never leaves a booking with no hold at all. On a failed renewal: raises a `hold_renewal_failed` Ops Alert with the days-open count and leaves the old hold untouched, and does not record a renewal (so it retries the next day). One thing worth flagging: I picked the 3-day threshold and the 1pm gate as reasonable defaults, not something explicitly re-confirmed with you this round beyond the original PRD's "3 days, corrected down from ~3.5" instruction.

## The QR scan-to-record flow, including the mismatch case

Content is a URL to `ops-gear-units.html?unit={qrToken}` — **a pragmatic adaptation of the PRD's literal `ops.palmspringsadventureclub.com/units/{qrToken}`**, since this site has no dynamic server-side routing; a static page with a query param is the closest real equivalent. Scanning uses the browser's native `BarcodeDetector` API (no library dependency) when available, with manual unit-ID entry always present as an equally-weighted path, not a degraded fallback. On scan or manual entry, `api/checkout-gear.js`'s `confirmScan` action returns a structured `mismatch` object with one of five reasons (`unit_not_found`, `retired`, `allocated_elsewhere`, `not_allocated`, `no_gear_log_row`) rather than a bare error, rendered inline on the page — this was the one piece the design pass explicitly flagged as real and expected but never fully designed, so I designed and built real handling for it rather than leaving it silently unhandled.

## The refund/partial-refund action

New `api/refund-gear-charge.js`, following `cancel-and-refund-booking.js`'s exact Stripe pattern (never trust a caller-supplied amount as authoritative, self-heal on a retried "already refunded" error, best-effort Ops Alert if the write-back fails after Stripe already moved money). `refundTarget` distinguishes reversing the deposit capture from reversing the Scenario 4 shortfall charge — each gets its own pair of refund columns on `Experience Bookings` so a booking can show both if both ever happened. Staff entry point lives on the Reconciliation Review page, always available (not gated to Scenario 4 only), since a recovered item can need a refund regardless of which scenario the booking landed in.

## Things I found that need your input, not decided here

- **The $531 vs $540.99 guest-facing copy gap.** The hard-shell first aid kit's $9.99 replacement cost is now in `ITEM_COSTS`/`GEAR_ITEM_TYPE_CONFIG`, but the guest-facing "full kit retail value $531" copy predates it and doesn't include it. True sum is $540.99. Nothing breaks mechanically (Scenarios 3/4 already tolerate itemized totals exceeding the hold), but the copy is now technically inaccurate by $9.99. Your call whether to update it.
- **`packSizePreference` still doesn't exist on Adventure Prep's roster schema.** `gearOps_resolveBackpackType_()` tries to read it from `reconfirmedRosterJson`, matched by `personName` (a documented fragility — that's a plain string, not a stable roster reference), and falls back to `backpack_standard` when it's absent, which today is always. This is a stub per the original instruction not to block on it, not a bug — but allocation will size-match nothing until that field lands elsewhere.
- **The `refundId` discrepancy on `Experience Bookings`.** A build-review doc claims `refundId` was added to `EXPERIENCE_BOOKINGS_NEW_COLUMNS` in `adventure-prep-actions.gs`; the live array is actually `['adventurePrepToken', 'bookingStatus', 'cancelledAt', 'refundAmount', 'cancellationReasons']` — no `refundId`. Not something this build touches or fixes, just flagging the gap since I found it while cross-referencing helper functions.
- **One shared secret (`GEAR_OPS_SHARED_SECRET`) instead of one per endpoint.** Matches what the kickoff prompt itself named as an example, but is a real deviation from the project's established one-secret-per-endpoint pattern. Flagged, not silently done.
- **`check-gear-availability.js`'s conservative counting.** Units tied to a past-trip booking that hasn't been checked in yet are reported separately (`pendingReturn`), not counted toward `assemblableKits`. This is a judgment call, not a spec'd algorithm — if you want a more optimistic projection once check-in is reliably fast, that's a one-line change.
- **Poles will cap `assemblableKits` at 0 or 1 almost always**, since real inventory is 1 pair total until the ~Sept 7 restock. That's correct, not a bug — flagged so it doesn't look broken in a demo.

## Files touched

New: `apps-script/gear-inventory-actions.gs`, `api/check-gear-availability.js`, `api/allocate-gear-units.js`, `api/checkout-gear.js`, `api/check-in-gear-item.js`, `api/reconcile-gear-deposit.js`, `api/charge-gear-shortfall.js`, `api/refund-gear-charge.js`, `api/renew-deposit-hold.js`, `api/manage-gear-units.js`, `lib/gear-photo-upload.js`, `lib/gear-item-summary.js`, `lib/email-templates/gear-shortfall-charge-failed-email.js`, `lib/email-templates/gear-refund-confirmation-email.js`, `ops-gear-units.html`, `ops-gear-checkout.html`, `ops-gear-checkin.html`, `ops-reconciliation-review.html`.

Edited: `apps-script/bookings-code.gs` (first aid kit cost + gear row), `api/ops-proxy.js` (new action routing), `vercel.json` (renewal cron), `package.json` (`@vercel/blob` dependency), `.env.example` (new secrets), `ops-alerts.html` / `ops-trail-swap-requests.html` / `ops-manual-adjustment.html` (sidebar nav updated to enable and link the four new pages).
