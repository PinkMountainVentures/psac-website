/**
 * lib/email-templates/adventure-prep-stall-reminder-email.js
 *
 * Operations UX PRD Section 15, "Stall reminder, unified across all
 * outstanding tracks" — the single reminder family that replaced three
 * separate per-track templates per Airey's direct correction: one message
 * per check, dynamically listing whichever of the three tracks (1.2a,
 * waiver, address) are still outstanding, never a stack of separate emails.
 *
 * Used for THREE of this cadence job's checks (Section 3/4): T-5 (normal
 * cadence), the compressed-cadence midpoint, and T-3 morning. NOT used for
 * the T-7 unconditional send — see adventure-prep-t7-nudge-email.js's own
 * header for why that one is a separate, pre-existing send this PRD only
 * triggers, not copy this PRD owns.
 *
 * Two variants, matching Section 15's own subject-line split:
 *   'reminder'      — T-5 / midwindow. Base shell (claude/psac-email-
 *                      template-base.html), routine framing.
 *   'action_needed' — T-3 morning. Action Needed shell (claude/psac-email-
 *                      template-action-needed.html), hard-deadline framing.
 *
 * Draft-quality, matching Section 15's own draft — flagged there (Section
 * 18, item 11) for the same cross-PRD copy/UX review as everything else in
 * that section, not legal- or design-reviewed here.
 */

'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Fixed order per Section 15: 1.2a, then waiver, then address — "using the
// fragment that applies," joined naturally, never a separate send per item.
function outstandingTrackPhrases(tracks) {
  var phrases = [];
  if (tracks.assignedAtMissing) phrases.push('finish setting up your adventure');
  if (tracks.waiverIncomplete) phrases.push('get your waiver signed');
  if (tracks.addressMissing) phrases.push('get a delivery address on file');
  return phrases;
}

// Same join-style pattern as the cancellation notice's bracketed reasons:
// one item reads as a plain sentence fragment, more than one joins with
// commas and "and".
function joinNaturally(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return items[0] + ' and ' + items[1];
  return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
}

/**
 * @param {object} opts
 * @param {string} opts.logoUrl
 * @param {string} opts.guestName
 * @param {string} opts.tripDateFormatted - e.g. "Saturday, September 12"
 * @param {string} opts.adventurePrepLink
 * @param {'reminder'|'action_needed'} opts.variant
 * @param {object} opts.tracks - { assignedAtMissing, waiverIncomplete, addressMissing }
 * @param {boolean} [opts.waiverGroupNote] - if the waiver track specifically
 *   is outstanding, note other signers in the group may also still need to
 *   finish theirs (Section 15's own italicized caveat)
 * @returns {string} full HTML document
 */
function renderStallReminderEmail({ logoUrl, guestName, tripDateFormatted, adventurePrepLink, variant, tracks, waiverGroupNote }) {
  const greetingName = guestName ? escapeHtml(guestName) : 'there';
  const phrases = outstandingTrackPhrases(tracks || {});
  const listText = escapeHtml(joinNaturally(phrases) || 'finish a few last details');
  const dateText = escapeHtml(tripDateFormatted || 'your trail day');
  const isActionNeeded = variant === 'action_needed';

  const subject = isActionNeeded
    ? 'Action needed by 10pm tonight to keep your reservation'
    : 'Still a few things needed before your trail day';

  const closeLine = isActionNeeded
    ? `<p style="margin:16px 0 0 0;">We need this by 10pm tonight, or we won't be able to hold your reservation.</p>`
    : `<p style="margin:16px 0 0 0;">It only takes a few minutes, and the sooner it's done, the better we can get your adventure right.</p>`;

  // BUG FIX (independent bug pass, Aug 2026): em dash removed to match this
  // project's established brand-voice convention of avoiding em dashes in
  // guest-facing copy.
  const waiverNote = (tracks && tracks.waiverIncomplete && waiverGroupNote)
    ? `<p style="margin:16px 0 0 0; font-size: 13px; color: #7a8a8a;">If others in your group still need to sign their own waivers, they can do that from their own links. No need to track that down separately.</p>`
    : '';

  const preheader = isActionNeeded
    ? 'Action needed by 10pm tonight to keep your Palm Springs Adventure Club reservation.'
    : `A few things still needed before your trail day on ${tripDateFormatted || ''}.`;

  const bodyHtml = `
    <p>Hi ${greetingName},</p>
    <p>Your trail day is coming up on ${dateText}, and we still need you to ${listText}. Finish here: <a href="${adventurePrepLink}" style="color:#F58271;">${escapeHtml(adventurePrepLink)}</a></p>
    ${closeLine}
    ${waiverNote}
  `;

  // Shell selection: Action Needed adds the orange urgency banner between
  // the header and the eyebrow; Base omits it entirely (not merely blank —
  // an absent element, matching psac-booking-confirmation-email.html's own
  // "no CTA block" pattern of removing rather than leaving empty).
  const urgencyBanner = isActionNeeded
    ? `<tr>
        <td style="background-color:#E76F51; padding: 12px 48px;">
          <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: #FFFFFF;">
            ACTION NEEDED
          </div>
        </td>
      </tr>`
    : '';

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

          ${urgencyBanner}

          <tr>
            <td class="psac-px" style="padding: 32px 48px 16px 48px;">

              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.25em; text-transform: uppercase; color: #F58271; padding-bottom: 12px;">
                YOUR ADVENTURE PREP
              </div>

              <h1 class="psac-headline" style="font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size: 2rem; font-weight: 300; line-height: 1.2; color: #2A4747; margin: 0 0 20px 0;">
                ${isActionNeeded ? 'A few things still stand between you and your trail day' : "Let's get your adventure squared away"}
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

module.exports = { renderStallReminderEmail, subjectFor: (variant) => (variant === 'action_needed' ? 'Action needed by 10pm tonight to keep your reservation' : 'Still a few things needed before your trail day') };
