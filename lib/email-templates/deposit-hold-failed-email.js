/**
 * lib/email-templates/deposit-hold-failed-email.js
 *
 * Operations UX PRD Section 15, "Gear hold failed, 2-hour deadline" — sent
 * immediately when the fixed 9am Pacific T-1 deposit-hold attempt returns
 * anything other than `succeeded`. Action Needed shell (urgent, hard
 * deadline). Two clocks, per Section 6: the guest is told 11am Pacific; the
 * system's own decision doesn't run until noon (api/check-hold-clearance-
 * deadline.js) — this template only ever states the guest-facing 11am
 * number, never the internal noon buffer.
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
 * @param {string} opts.tripDateFormatted
 * @param {string} opts.updatePaymentLink
 * @param {string} [opts.deadlineTimeFormatted] - Lower-confidence #2 fix:
 *   the actual "2 hours from now" clock time, computed by the caller from
 *   the real send time rather than assumed to always be 9am. Falls back to
 *   the old fixed "11:00am Pacific" only if the caller doesn't supply one.
 * @returns {string} full HTML document
 */
function renderDepositHoldFailedEmail({ logoUrl, guestName, tripDateFormatted, updatePaymentLink, deadlineTimeFormatted }) {
  const greetingName = guestName ? escapeHtml(guestName) : 'there';
  const dateText = escapeHtml(tripDateFormatted || 'today');
  // BUG FIX (independent bug pass, Aug 2026): em dash removed to match this
  // project's established brand-voice convention of avoiding em dashes in
  // guest-facing copy.
  const preheader = 'Action needed within 2 hours: your gear hold didn’t go through.';
  // BUG FIX (payment-review, Aug 2026, Lower-confidence #2): this used to
  // hardcode "11:00am Pacific" regardless of when the email actually sent.
  // trigger-deposit-holds.js's own 9am target is a gate on the FIRST tick
  // allowed to act, not a guarantee the alert fires at exactly 9:00:00 -
  // a delayed cron tick, a retry, or any processing lag between the failed
  // hold attempt and this send would state a deadline that's already wrong
  // (too late, or in the rare worst case already past) relative to the
  // real 2-hour buffer this design intends. Now computed by the caller
  // from the actual send time and passed in.
  const deadlineText = escapeHtml(deadlineTimeFormatted || '11:00am Pacific');

  const bodyHtml = `
    <p>Hi ${greetingName},</p>
    <p>We tried to place the hold on your card on file for your gear this morning, but it didn't go through. Your trail day is ${dateText}, and we need this fixed by ${deadlineText} today, just 2 hours from now, to get your gear scheduled for delivery.</p>
    <p>Please update your payment method here: <a href="${updatePaymentLink}" style="color:#F58271;">${escapeHtml(updatePaymentLink)}</a> or reply to this email right away. If we don't hear from you in time, we won't be able to schedule your gear for delivery today.</p>
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
                ACTION NEEDED WITHIN 2 HOURS
              </div>
            </td>
          </tr>

          <tr>
            <td class="psac-px" style="padding: 32px 48px 16px 48px;">

              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.25em; text-transform: uppercase; color: #F58271; padding-bottom: 12px;">
                YOUR GEAR HOLD
              </div>

              <h1 class="psac-headline" style="font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size: 2rem; font-weight: 300; line-height: 1.2; color: #2A4747; margin: 0 0 20px 0;">
                Your gear hold <em>didn't go through.</em>
              </h1>

              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 300; line-height: 1.8; color: #2A4747;">
                ${bodyHtml}
              </div>

            </td>
          </tr>

          <tr>
            <td class="psac-px" align="left" style="padding: 4px 48px 40px 48px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${updatePaymentLink}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="5%" fillcolor="#F58271" stroke="f">
              <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">UPDATE PAYMENT METHOD</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="${updatePaymentLink}" style="display:inline-block; background-color:#F58271; color:#FFFFFF; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; padding: 15px 32px; border-radius: 2px; text-decoration: none;">
                UPDATE PAYMENT METHOD
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

module.exports = { renderDepositHoldFailedEmail };
