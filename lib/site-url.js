/**
 * lib/site-url.js
 *
 * Resolves the base URL to use for guest-facing links (adventure-prep,
 * waiver-signer, payment-update) and for server-to-server calls this
 * deployment makes to its own other API routes (T-3 cutoff cancellation,
 * hold-clearance cancellation, deposit-hold creation).
 *
 * Before this, several files hardcoded the production domain
 * ('https://www.palmspringsadventureclub.com') as a literal constant.
 * That meant every non-production environment (Preview in particular)
 * still generated production links and still called production endpoints
 * from its own crons — silently wrong for guests, and untestable for the
 * cancellation/hold-creation cron paths (2026-09-01 finding, surfaced
 * while validating the T-3 cutoff cron against Preview).
 *
 * Resolution order:
 *   1. SITE_URL env var, if explicitly set. Set this on the Production
 *      environment in Vercel to pin the canonical
 *      https://www.palmspringsadventureclub.com domain (avoids ever
 *      depending on Vercel's own URL naming for prod). Leave it unset on
 *      Preview/Development so step 2 takes over automatically.
 *   2. VERCEL_URL, which Vercel auto-populates on every deployment
 *      (Production, Preview, Development) to that deployment's own unique
 *      URL. This makes Preview self-consistent with zero extra config.
 *   3. A hardcoded production fallback, only reached in environments
 *      where Vercel doesn't set VERCEL_URL (e.g. plain local dev without
 *      `vercel dev`) and SITE_URL hasn't been set either.
 */
function getSiteUrl() {
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return 'https://www.palmspringsadventureclub.com';
}

module.exports = { getSiteUrl };
