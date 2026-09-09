/**
 * lib/trail-photo-upload.js
 *
 * Vercel Blob upload for trail photos, used by the Ops UX Trails
 * dashboard (Ops App Redesign — Trails/Parks CRUD, 2026-09-03). Mirrors
 * lib/gear-photo-upload.js's exact pattern (same @vercel/blob dependency,
 * already installed and provisioned for that feature — no new env var or
 * package needed) rather than generalizing that file, matching this
 * project's established small-per-file convention over a shared/parameterized
 * helper (see lib/gear-service.js's own header for why).
 *
 * Stored as a public blob; the URL is written directly into
 * trails.photo_references (a plain TEXT column — a single photo per
 * trail today, matching every existing read site's
 * `photo_references.split(/[\n,;]/)[0]` "first URL wins" convention. A
 * trail with more than one photo can still store multiple URLs
 * newline/comma-separated in that same column; this uploader always
 * returns one new URL, and the Trails page decides how to combine it with
 * whatever was already there (append vs. replace — see ops-trails.html).
 */

'use strict';

const { put } = require('@vercel/blob');

/**
 * @param {object} opts
 * @param {string} opts.dataUrl - a "data:image/jpeg;base64,...." string
 *   (what a browser's FileReader.readAsDataURL produces directly).
 * @param {string} [opts.contentType]
 * @param {string} opts.trailId
 * @param {string} [opts.slot] - which photo slot this upload is for
 *   (Golden Hour photo infrastructure, 2026-09-09) -- 'hero', 'trailhead',
 *   'overlook', or 'detail'. Purely cosmetic (folds into the blob
 *   pathname so the Vercel Blob store stays readable when browsed
 *   directly); omitted entirely it falls back to the original
 *   pathname shape, matching the pre-existing single-photo upload.
 * @returns {Promise<string>} the public URL of the uploaded photo
 */
async function uploadTrailPhoto({ dataUrl, contentType, trailId, slot }) {
  if (!dataUrl) throw new Error('uploadTrailPhoto: dataUrl is required');
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not configured — attach a Vercel Blob store to this project (Storage -> Blob) and redeploy');
  }

  const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl);
  const mime = contentType || (match ? match[1] : 'image/jpeg');
  const base64Body = match ? match[2] : dataUrl;
  const buffer = Buffer.from(base64Body, 'base64');
  const ext = (mime.split('/')[1] || 'jpg').split('+')[0];

  const safeTrailId = String(trailId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
  const safeSlot = slot ? String(slot).replace(/[^a-zA-Z0-9_-]/g, '') : '';
  const pathname = safeSlot
    ? `trails/${safeTrailId}-${safeSlot}-${Date.now()}.${ext}`
    : `trails/${safeTrailId}-${Date.now()}.${ext}`;

  const blob = await put(pathname, buffer, {
    access: 'public',
    contentType: mime,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });

  return blob.url;
}

module.exports = { uploadTrailPhoto };
