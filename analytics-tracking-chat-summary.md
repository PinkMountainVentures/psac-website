# Analytics Tracking — Chat Summary

**Date:** August 3, 2026

## Problem

No analytics currently on the PSAC site. Need to see client usage across the site and completion of the booking flow.

## Key context surfaced during the chat

- Site is static HTML/CSS on Vercel, GitHub repo `PinkMountainVentures/psac-website`.
- Booking flow is **not** JotForm (JotForm was the original assumption but is not being used). It's a **custom JS-powered flow**, built in a separate chat, with **Stripe payments integrated at the end**.
- Because the flow is custom JS in the same DOM (not an iframe), event tracking can be added directly in the flow's own code — no iframe/postMessage workaround needed.

## Recommendation: PostHog

Chosen over GA4 / Plausible / Fathom because it's the only option that covers both needs in one free tool:

- **Site-wide usage** — autocapture (pageviews, traffic sources, referrers) with no extra code.
- **Flow completion** — custom funnel + session replay, purpose-built for seeing where users drop off in a multi-step flow.

Free tier (1M events/month) comfortably covers PSAC's traffic level.

### Planned instrumentation

Add `posthog.capture()` calls at each step of the custom flow:

1. `modal_opened`
2. `step_2`, `step_3`, ... (each step advanced)
3. `checkout_started`
4. `payment_succeeded` — fired from the **Stripe success confirmation**, not just a client-side submit click, so completion counts reflect actual paid bookings rather than abandoned checkouts.

These chain into a PostHog funnel to see exact step-by-step drop-off, plus session recordings to watch it happen.

### Also recommended

Tag concierge/QR/leave-behind links with UTM parameters so funnel completion can eventually be split by acquisition channel (concierge vs. Instagram vs. organic).

## Status / next steps

- [ ] Airey to sign up for PostHog (free, no card required) and get the project API key + JS snippet
- [x] `psac-website` folder connected for direct file access
- [ ] Locate the custom flow code and Stripe success handler in the repo
- [ ] Add PostHog snippet to site `<head>`
- [ ] Add `posthog.capture()` calls at each flow step and at Stripe success
- [ ] Build the funnel report in PostHog once events are flowing
