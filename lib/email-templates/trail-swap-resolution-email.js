/**
 * lib/email-templates/trail-swap-resolution-email.js
 *
 * Operations UX PRD Section 15, "Trail-swap resolution" — sent once staff
 * applies a new trail via api/write-manual-trail-override.js. Rendered
 * against the Base shell (routine, no urgency).
 *
 * Per Section 7's guest-notification note: for a system-generated row (no
 * guest complaint yet), staff should use judgment about whether this send
 * is even appropriate before the guest has seen a thin result at all — that
 * judgment call belongs to whoever clicks Apply in the ops app, not this
 * template. api/write-manual-trail-override.js sends this unconditionally
 * when called; a `skipGuestEmail` flag is exposed on the endpoint for staff
 * to suppress it for exactly that system-generated, guest-hasn't-seen-it-
 * yet case (see that file's own header note).
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
 * @param {string} opts.newTrailName
 * @param {string} [opts.overviewBlurb]
 * @param {string} [opts.entryFeeFragment] - Agua Caliente entry-fee note, if applicable
 * @param {string} opts.adventurePrepLink
 * @param {string} opts.t3DateFormatted - the date by which the guest can still switch back
 * @returns {string} full HTML document
 */
function renderTrailSwapResolutionEmail({ logoUrl, guestName, newTrailName, overviewBlurb, entryFeeFragment, adventurePrepLink, t3DateFormatted }) {
  const greetingName = guestName ? escapeHtml(guestName) : 'there';
  const trailName = escapeHtml(newTrailName || 'your new trail');
  const preheader = `We've updated your trail to ${newTrailName || 'a new pick'}.`;

  const bodyHtml = `
    <p>Hi ${greetingName},</p>
    <p>Based on what you told us, we've moved you to ${trailName}. ${overviewBlurb ? escapeHtml(overviewBlurb) : ''} ${entryFeeFragment ? escapeHtml(entryFeeFragment) : ''}</p>
    <p>This is your new pick, but your original options are still there too. If you'd rather go back to one of those, just head to your adventure prep page and switch anytime before ${escapeHtml(t3DateFormatted || 'your trail day')}.</p>
    <p>Let us know if anything else comes up before your trail day.</p>
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
            <td class="psac-px" style="padding: 40px 48px 16px 48px;">

              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.25em; text-transform: uppercase; color: #F58271; padding-bottom: 12px;">
                YOUR TRAIL
              </div>

              <h1 class="psac-headline" style="font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size: 2rem; font-weight: 300; line-height: 1.2; color: #2A4747; margin: 0 0 20px 0;">
                We've updated <em>your trail.</em>
              </h1>

              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 300; line-height: 1.8; color: #2A4747;">
                ${bodyHtml}
              </div>

            </td>
          </tr>

          <tr>
            <td class="psac-px" align="left" style="padding: 4px 48px 40px 48px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${adventurePrepLink}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="5%" fillcolor="#F58271" stroke="f">
              <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">VIEW YOUR ADVENTURE PREP</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="${adventurePrepLink}" style="display:inline-block; background-color:#F58271; color:#FFFFFF; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; padding: 15px 32px; border-radius: 2px; text-decoration: none;">
                VIEW YOUR ADVENTURE PREP
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
                Questions? Reply to this email or reach us at reservations@palmspringsadventureclub.com
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

module.exports = { renderTrailSwapResolutionEmail };
