/* ============================================
   Throwaway test script — not meant to ship. Delete this file (or add it to
   .gitignore) once you're done testing. Exercises the real
   lib/send-booking-confirmation.js code path with fake booking data, sent
   to your own inbox, without touching save-booking.js or the real
   Bookings & Operations sheet.

   Usage (from the repo root, with your real env vars loaded):
     set -a; source .env.local; set +a
     node test-confirmation-email.js
   ============================================ */

var { sendBookingConfirmationEmail } = require('./lib/send-booking-confirmation');

var fakeBooking = {
  date: '2026-09-12',
  headcount: 3,
  gearKitsSelected: 2,
  total: 230, // matches trail.booking (100) + trail.gear (65) * 2 kits
  contact: {
    name: 'Airey Test',
    email: 'airey@palmspringsadventureclub.com'
  }
};

sendBookingConfirmationEmail(fakeBooking).then(function (result) {
  console.log('Result:', result);
  if (result.status !== 'sent') {
    process.exitCode = 1;
  }
}).catch(function (err) {
  console.error('Threw:', err);
  process.exitCode = 1;
});
