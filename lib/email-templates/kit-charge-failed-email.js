/**
 * lib/email-templates/kit-charge-failed-email.js
 *
 * Guest-facing charge-failure notice — Operations UX PRD Section 15
 * ("Charge-failure notice"), rendered against the Action Needed shell
 * (claude/psac-email-template-action-needed.html), the same shell used for
 * anything time-boxed or requiring the guest to act. This is a NEW file:
 * lib/finalize-kit-change.js previously had nowhere to send this from at
 * all (see that file's own updated comment on the gap this closes).
 *
 * Self-contained rather than built on a shared base-template loader — if a
 * shared renderActionNeededEmail()-style helper already exists elsewhere in
 * lib/email-templates/ (the booking-confirmation and signer-invite emails
 * suggest one might), swap this file's body to call it instead; the output
 * below matches the Action Needed shell's markup exactly so the visual
 * result is the same either way.
 *
 * Draft copy only, matching Section 15's draft — not legal-reviewed, not
 * final, same caveat as every other guest-facing send in this project.
 * Brand voice: never "PSAC," always "Palm Springs Adventure Club," no em
 * dashes, never "consultation," never "hiking"/"hike."
 */

'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {object} opts
 * @param {string} opts.logoUrl
 * @param {string} opts.guestName
 * @param {number} opts.amount - refundOrChargeAmount from finalize-kit-change.js
 * @returns {string} full HTML document
 */
function renderKitChargeFailedEmail({ logoUrl, guestName, amount }) {
  const greetingName = guestName ? escapeHtml(guestName) : 'there';
  const amountDisplay = '$' + Number(amount || 0).toFixed(2);
  const preheader = "We couldn't process the charge for your updated gear kit count.";
  const bodyHtml = `
    <p>Hi ${greetingName},</p>
    <p>We tried to charge the card on file ${amountDisplay} for the updated gear kit count on your upcoming adventure, but the charge didn't go through.</p>
    <p>Please update your payment method or reply to this email so we can get it resolved before your trail day. If we can't reach you before your gear gets packed, we may not be able to include the added kit.</p>
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
                ACTION NEEDED
              </div>
            </td>
          </tr>

          <tr>
            <td class="psac-px" style="padding: 32px 48px 16px 48px;">

              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.25em; text-transform: uppercase; color: #F58271; padding-bottom: 12px;">
                GEAR KIT CHANGE
              </div>

              <h1 class="psac-headline" style="font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size: 2rem; font-weight: 300; line-height: 1.2; color: #2A4747; margin: 0 0 20px 0;">
                We couldn't process your gear kit change
              </h1>

              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 300; line-height: 1.8; color: #2A4747;">
                ${bodyHtml}
              </div>

            </td>
          </tr>

          <tr>
            <td class="psac-px" align="left" style="padding: 28px 48px 40px 48px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="mailto:reservations@palmspringsadventureclub.com" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="5%" fillcolor="#F58271" stroke="f">
              <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">REPLY TO THIS EMAIL</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="mailto:reservations@palmspringsadventureclub.com" style="display:inline-block; background-color:#F58271; color:#FFFFFF; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; padding: 15px 32px; border-radius: 2px; text-decoration: none;">
                REPLY TO THIS EMAIL
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

module.exports = { renderKitChargeFailedEmail };
