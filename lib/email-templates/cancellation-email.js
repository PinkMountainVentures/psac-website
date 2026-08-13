/**
 * lib/email-templates/cancellation-email.js
 *
 * Guest-facing cancellation notice — Operations UX PRD Section 15
 * ("Cancellation notice"), covering all four cancellation reasons with one
 * flexible bracket. Rendered against the Action Needed shell
 * (claude/psac-email-template-action-needed.html).
 *
 * Draft-quality, matching Section 15's draft — not legal-reviewed. Airey's
 * own Section 18 item 4 note: legal should see this copy alongside the
 * deposit and waiver language already queued for review; this ships as
 * draft, not final.
 */

'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Section 5's bracketed-reason mapping. `reasons` is the array passed to
// api/cancel-and-refund-booking.js; the leading (first) reason is what the
// PRD says to cite, per Section 5 ("the endpoint below only needs to know
// that at least one fired, and which one(s), for the cancellation notice's
// wording" / "the three checks run in a fixed order ... purely so the
// cancellation notice cites a single, clear leading reason").
var REASON_PHRASES = {
  'no_1.2a': 'the adventure details we need',
  zero_waivers: 'your waiver signed',
  no_address: 'a delivery address on file',
  hold_never_cleared: 'your gear hold cleared in time',
};

function leadingReasonPhrase(reasons) {
  var first = Array.isArray(reasons) ? reasons[0] : reasons;
  return REASON_PHRASES[first] || 'everything we needed';
}

/**
 * @param {object} opts
 * @param {string} opts.logoUrl
 * @param {string} opts.guestName
 * @param {string[]} opts.reasons - e.g. ['no_1.2a']
 * @param {number} opts.refundAmount
 * @returns {string} full HTML document
 */
function renderCancellationEmail({ logoUrl, guestName, reasons, refundAmount }) {
  const greetingName = guestName ? escapeHtml(guestName) : 'there';
  const amountDisplay = '$' + Number(refundAmount || 0).toFixed(2);
  const reasonPhrase = escapeHtml(leadingReasonPhrase(reasons));
  const preheader = 'Your Palm Springs Adventure Club reservation has been cancelled and refunded.';
  const bodyHtml = `
    <p>Hi ${greetingName},</p>
    <p>We weren't able to get ${reasonPhrase} in time to plan your trail day, so we've cancelled your upcoming reservation and issued a full refund of ${amountDisplay} to the card on file. You should see it back in 5 to 10 business days, depending on your bank.</p>
    <p>We'd love to have you back on the trail whenever the timing works better. Head to palmspringsadventureclub.com whenever you're ready to book again.</p>
    <p>Questions? Just reply here.</p>
  `;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Palm Springs Adventure Club</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Montserrat:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>
  body, table, td { margin: 0; padding: 0; }
  body { background-color: #F8F1E9; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  img { border: 0; display: block; }
  a { text-decoration: none; }
  @media only screen and (max-width: 600px) {
    .psac-container { width: 100% !important; }
    .psac-px { padding-left: 24px !important; padding-right: 24px !important; }
    .psac-headline { font-size: 1.6rem !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:#F8F1E9;">

  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    ${escapeHtml(preheader)}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F8F1E9;">
    <tr>
      <td align="center" style="padding: 32px 16px;">

        <table role="presentation" class="psac-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; background-color:#FFFFFF; border-radius:4px; overflow:hidden;">

          <tr>
            <td align="center" style="background-color:#2A4747; padding: 24px;">
              <img src="${logoUrl || ''}" alt="Palm Springs Adventure Club" width="240" style="display:block; width:240px; max-width:240px; height:auto; border:0;">
            </td>
          </tr>

          <tr>
            <td style="background-color:#E76F51; padding: 12px 48px;">
              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: #FFFFFF;">
                RESERVATION CANCELLED
              </div>
            </td>
          </tr>

          <tr>
            <td class="psac-px" style="padding: 32px 48px 16px 48px;">

              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.25em; text-transform: uppercase; color: #F58271; padding-bottom: 12px;">
                YOUR RESERVATION
              </div>

              <h1 class="psac-headline" style="font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size: 2rem; font-weight: 300; line-height: 1.2; color: #2A4747; margin: 0 0 20px 0;">
                Your reservation has been cancelled
              </h1>

              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 300; line-height: 1.8; color: #2A4747;">
                ${bodyHtml}
              </div>

            </td>
          </tr>

          <tr>
            <td class="psac-px" align="left" style="padding: 28px 48px 40px 48px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="https://www.palmspringsadventureclub.com" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="5%" fillcolor="#F58271" stroke="f">
              <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">BOOK AGAIN</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="https://www.palmspringsadventureclub.com" style="display:inline-block; background-color:#F58271; color:#FFFFFF; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; padding: 15px 32px; border-radius: 2px; text-decoration: none;">
                BOOK AGAIN
              </a>
              <!--<![endif]-->
            </td>
          </tr>

          <tr>
            <td align="center" style="background-color:#2A4747; padding: 28px 24px;">
              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: rgba(248,241,233,0.6); padding-bottom: 8px;">
                Palm Springs Adventure Club
              </div>
              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 11px; color: rgba(248,241,233,0.35); line-height: 1.8;">
                Pink Mountain Ventures LLC &nbsp;&middot;&nbsp; palmspringsadventureclub.com<br>
                Questions about your reservation? Reply to this email or reach us at reservations@palmspringsadventureclub.com
              </div>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

module.exports = { renderCancellationEmail };
