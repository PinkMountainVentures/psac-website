/**
 * lib/email-templates/adventure-prep-t7-nudge-email.js
 *
 * ============================================================================
 * RESOLVED, Aug 2026 build-review follow-up — checked for a duplicate send,
 * found none. Safe to wire in as the actual, only implementation.
 * ============================================================================
 *
 * Operations UX PRD Section 3's escalation table calls the T-7 send "the
 * existing T-7 'finish setting up your adventure' send (Adventure Prep's
 * 1.1, this PRD only fires it)" — originally flagged here as a risk of
 * duplicating a real send this session never had visibility into (no repo
 * access to the Adventure Prep codebase).
 *
 * Follow-up check: `claude/psac-email-sms-infrastructure-setup-guide.md`'s
 * own "What's left after this section" list names "the Adventure Prep
 * reminder" explicitly as one of several already-drafted touchpoints still
 * on the NOT-YET-WIRED list ("blocked on the same Resend/Twilio accounts...
 * no new decisions needed for any of them"), alongside T-3, T-1, gear-is-on-
 * its-way, and others. That confirms the PRD's word "existing" describes an
 * already-decided/drafted concept, not a deployed send anywhere in this
 * stack today — nothing else in any reviewed doc or codebase actually fires
 * a T-7 email right now. There's no live implementation this file's send
 * could collide with. This file, once wired into
 * `api/check-adventure-prep-cadence.js`, becomes the first and only real
 * implementation of this touchpoint, not a second copy of an existing one.
 *
 * Worth a final sanity check only if Adventure Prep's own build has since
 * shipped its own send independently of this project's tracked docs — but
 * nothing found this session suggests that's happened. Same posture as the
 * RideWithGPS placeholder (apps-script/t3-cutoff-actions.gs) and the Uber
 * Direct field-name caveat (Operations UX PRD Section 10/16): documented as
 * a reconstruction, not silently passed off as verified-original copy.
 *
 * Rendered against the Base shell (claude/psac-email-template-base.html) —
 * T-7 is routine, not urgent, same category as "Adventure Prep reminder" in
 * the email template guide's own base-vs-action-needed split.
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
 * @param {string} opts.adventurePrepLink
 * @returns {string} full HTML document
 */
function renderAdventurePrepT7NudgeEmail({ logoUrl, guestName, tripDateFormatted, adventurePrepLink }) {
  const greetingName = guestName ? escapeHtml(guestName) : 'there';
  const dateText = escapeHtml(tripDateFormatted || 'your trail day');
  const preheader = `A few quick steps left before your trail day on ${tripDateFormatted || ''}.`;

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
                YOUR ADVENTURE PREP
              </div>

              <h1 class="psac-headline" style="font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size: 2rem; font-weight: 300; line-height: 1.2; color: #2A4747; margin: 0 0 20px 0;">
                Let's finish setting up <em>your adventure.</em>
              </h1>

              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 300; line-height: 1.8; color: #2A4747;">
                <p style="margin:0 0 16px 0;">Hi ${greetingName},</p>
                <p style="margin:0;">Your trail day is coming up on ${dateText}. Whenever you get a few minutes, head to your Adventure Prep page to confirm your details, get your waiver signed, and let us know where to deliver your gear.</p>
              </div>

            </td>
          </tr>

          <tr>
            <td class="psac-px" align="left" style="padding: 4px 48px 40px 48px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${adventurePrepLink}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="5%" fillcolor="#F58271" stroke="f">
              <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">FINISH ADVENTURE PREP</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="${adventurePrepLink}" style="display:inline-block; background-color:#F58271; color:#FFFFFF; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; padding: 15px 32px; border-radius: 2px; text-decoration: none;">
                FINISH ADVENTURE PREP
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

module.exports = { renderAdventurePrepT7NudgeEmail };
