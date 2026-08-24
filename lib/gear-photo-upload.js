/**
 * lib/gear-photo-upload.js
 *
 * Vercel Blob upload for gear check-in photos (Damaged/Missing items,
 * Gear Inventory PRD Section 5/10 — "photo upload to Vercel Blob,
 * confirmed choice"). Stored as a public blob, its URL written onto the
 * Gear Check Log row's new `photoUrl` column — a URL by reference, matching
 * this project's existing "URL by reference, not binary in the Sheet"
 * convention already used for the email logo image.
 *
 * DEPENDENCY NOTE — a deliberate, flagged exception to this repo's
 * established "no SDK, raw fetch only" convention (Stripe, Resend, and
 * every other integration in this project talk to a documented plain REST
 * endpoint directly, per each of those files' own header comments).
 * Vercel Blob's actual wire protocol is not a stable, publicly documented
 * plain-REST contract the way Stripe's or Resend's is — reverse-engineering
 * it here would be unverified and fragile, worse than the thing this
 * convention is trying to avoid. The @vercel/blob package is Vercel's own
 * first-party SDK for its own product, so it's used directly instead. This
 * means, called out again in this build's final handoff summary:
 *   1. `npm install @vercel/blob` needs to run once against this repo
 *      (added to package.json's dependencies by this same patch, version
 *      not verified against the live npm registry from this session — no
 *      network fetch was attempted — run `npm install @vercel/blob@latest`
 *      to get a real, current, lockfile-pinned version rather than trust
 *      the placeholder range committed here).
 *   2. A Vercel Blob store needs to be created and attached to this
 *      project (Vercel dashboard -> Storage -> Blob), which provisions the
 *      BLOB_READ_WRITE_TOKEN env var automatically — nothing to
 *      hand-generate or paste into .env.example.
 */

'use strict';

const { put } = require('@vercel/blob');

/**
 * @param {object} opts
 * @param {string} opts.dataUrl - a "data:image/jpeg;base64,...." string
 *   (what a browser's FileReader.readAsDataURL produces directly — see
 *   ops-gear-return-checkin.html's photo-capture JS), or a bare base64
 *   string with opts.contentType supplied separately.
 * @param {string} [opts.contentType]
 * @param {string} opts.bookingId
 * @param {string} opts.unitId
 * @returns {Promise<string>} the public URL of the uploaded photo
 */
async function uploadGearPhoto({ dataUrl, contentType, bookingId, unitId }) {
  if (!dataUrl) throw new Error('uploadGearPhoto: dataUrl is required');
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not configured — attach a Vercel Blob store to this project (Storage -> Blob) and redeploy');
  }

  const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl);
  const mime = contentType || (match ? match[1] : 'image/jpeg');
  const base64Body = match ? match[2] : dataUrl;
  const buffer = Buffer.from(base64Body, 'base64');
  const ext = (mime.split('/')[1] || 'jpg').split('+')[0];

  // Sanitized into the path rather than trusted raw — these ultimately
  // become a public blob URL segment.
  const safeBookingId = String(bookingId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
  const safeUnitId = String(unitId || 'unit').replace(/[^a-zA-Z0-9_-]/g, '') || 'unit';
  const pathname = `gear-checkin/${safeBookingId}/${safeUnitId}-${Date.now()}.${ext}`;

  const blob = await put(pathname, buffer, {
    access: 'public',
    contentType: mime,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });

  return blob.url;
}

module.exports = { uploadGearPhoto };
