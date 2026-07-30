/* ============================================
   PSAC — Save booking to the Bookings & Operations sheet
   Vercel serverless function. Thin proxy in front of the Google Apps
   Script Web App bound to the "PSAC Bookings & Operations" sheet — keeps
   the Apps Script URL and shared secret server-side only, never exposed
   to the browser.

   The Apps Script side owns the actual logic: finding-or-creating the
   Person row by email, appending the Experience Booking row, and
   generating the Gear Check Log item rows.

   Never blocks a guest on this: the payment already succeeded by the time
   this is called, so a persistence hiccup here should be logged and
   surfaced softly, not turned into a dead end for someone who already
   paid.
   ============================================ */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.BOOKINGS_WEBAPP_URL || !process.env.BOOKINGS_WEBAPP_SECRET) {
    console.error('Missing BOOKINGS_WEBAPP_URL or BOOKINGS_WEBAPP_SECRET env var');
    // Soft failure — booking payment already succeeded, so we don't want
    // to block the guest on this. Caller shows the closing screen either
    // way and this just gets logged for manual follow-up.
    res.status(200).json({ ok: false, error: 'Booking record keeping is not configured yet.' });
    return;
  }

  try {
    var body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    var payload = Object.assign({}, body, {
      action: 'saveBooking',
      secret: process.env.BOOKINGS_WEBAPP_SECRET
    });

    var sheetRes = await fetch(process.env.BOOKINGS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    var text = await sheetRes.text();
    var data;
    try { data = JSON.parse(text); } catch (e) { data = { ok: false, error: 'Unexpected response from booking sheet.', raw: text.slice(0, 300) }; }

    if (!sheetRes.ok || data.ok === false) {
      console.error('Apps Script save-booking error:', data);
      res.status(200).json({ ok: false, error: data.error || 'Could not save booking record.' });
      return;
    }

    res.status(200).json({
      ok: true,
      personId: data.personId || null,
      bookingId: data.bookingId || null,
      gearLogRowsCreated: data.gearLogRowsCreated || 0
    });
  } catch (err) {
    console.error('save-booking error:', err);
    res.status(200).json({ ok: false, error: 'Server error saving booking record.' });
  }
};
