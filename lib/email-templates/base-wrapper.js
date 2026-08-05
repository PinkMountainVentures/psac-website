/* ============================================
   PSAC — Shared "base" transactional email wrapper
   Matches claude/psac-email-template-base.html's structure exactly (see that file
   for the full annotated reference, brand-color rules, and the DETAIL ROW pattern).
   Use for anything routine, not urgent: booking confirmation, Trip Prep "finish
   setting up" reminder, light deposit reminder, "gear is on its way", trail-day
   message, return instructions, deposit release notice, feedback request,
   membership mention.

   For anything urgent or requiring guest action under time pressure (T-3 hard
   deadline, T-1 deposit heads-up, deposit capture/partial-capture notices,
   grace-period missing item notice), use action-needed-wrapper.js instead.

   Plain string-substitution, no templating engine, no npm dependency — same
   dependency-free convention as the rest of this repo (see
   api/create-payment-intent.js's header comment).

   Unlike the raw HTML file (hand-edited, so it warns "delete the CTA block or
   you get a visible empty button"), this wrapper is real JS: the detail block
   and CTA button are only inserted into the HTML at all when their tokens are
   supplied, so callers don't have to think about it.
   ============================================ */

var TEMPLATE_HTML = '<!DOCTYPE html>\n' +
'<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<meta http-equiv="X-UA-Compatible" content="IE=edge">\n' +
'<meta name="color-scheme" content="light">\n' +
'<meta name="supported-color-schemes" content="light">\n' +
'<title>Palm Springs Adventure Club</title>\n' +
'<!--[if mso]>\n' +
'<noscript>\n' +
'<xml>\n' +
'<o:OfficeDocumentSettings>\n' +
'<o:PixelsPerInch>96</o:PixelsPerInch>\n' +
'</o:OfficeDocumentSettings>\n' +
'</xml>\n' +
'</noscript>\n' +
'<![endif]-->\n' +
'<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Montserrat:wght@300;400;600;700&display=swap" rel="stylesheet">\n' +
'<style>\n' +
'  body, table, td { margin: 0; padding: 0; }\n' +
'  body { background-color: #F8F1E9; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }\n' +
'  img { border: 0; display: block; }\n' +
'  a { text-decoration: none; }\n' +
'  @media only screen and (max-width: 600px) {\n' +
'    .psac-container { width: 100% !important; }\n' +
'    .psac-px { padding-left: 24px !important; padding-right: 24px !important; }\n' +
'    .psac-headline { font-size: 1.6rem !important; }\n' +
'  }\n' +
'</style>\n' +
'</head>\n' +
'<body style="margin:0; padding:0; background-color:#F8F1E9;">\n' +
'  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">\n' +
'    {{preheader}}\n' +
'  </div>\n' +
'  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F8F1E9;">\n' +
'    <tr>\n' +
'      <td align="center" style="padding: 32px 16px;">\n' +
'        <table role="presentation" class="psac-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; background-color:#FFFFFF; border-radius:4px; overflow:hidden;">\n' +
'          <tr>\n' +
'            <td align="center" style="background-color:#2A4747; padding: 24px;">\n' +
'              <img src="{{logo_url}}" alt="Palm Springs Adventure Club" width="240" style="display:block; width:240px; max-width:240px; height:auto; border:0;">\n' +
'            </td>\n' +
'          </tr>\n' +
'          <tr>\n' +
'            <td class="psac-px" style="padding: 40px 48px 16px 48px;">\n' +
'              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.25em; text-transform: uppercase; color: #F58271; padding-bottom: 12px;">\n' +
'                {{eyebrow}}\n' +
'              </div>\n' +
'              <h1 class="psac-headline" style="font-family: \'Cormorant Garamond\', Georgia, \'Times New Roman\', serif; font-size: 2rem; font-weight: 300; line-height: 1.2; color: #2A4747; margin: 0 0 20px 0;">\n' +
'                {{headline}}\n' +
'              </h1>\n' +
'              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 300; line-height: 1.8; color: #2A4747;">\n' +
'                {{body_html}}\n' +
'              </div>\n' +
'            </td>\n' +
'          </tr>\n' +
'          {{detail_section}}' +
'          {{cta_section}}' +
'          <tr>\n' +
'            <td align="center" style="background-color:#2A4747; padding: 28px 24px;">\n' +
'              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: rgba(248,241,233,0.6); padding-bottom: 8px;">\n' +
'                Palm Springs Adventure Club\n' +
'              </div>\n' +
'              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 11px; color: rgba(248,241,233,0.35); line-height: 1.8;">\n' +
'                Pink Mountain Ventures LLC &nbsp;&middot;&nbsp; palmspringsadventureclub.com<br>\n' +
'                Questions about your reservation? Reply to this email or reach us at reservations@palmspringsadventureclub.com\n' +
'              </div>\n' +
'            </td>\n' +
'          </tr>\n' +
'        </table>\n' +
'      </td>\n' +
'    </tr>\n' +
'  </table>\n' +
'</body>\n' +
'</html>\n';

function renderDetailRow(row) {
  row = row || {};
  return '<tr class="detail-row">\n' +
    '  <td style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; color: #7a8a8a; border-bottom: 1px solid rgba(42,71,71,0.08);">' + (row.label || '') + '</td>\n' +
    '  <td align="right" style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 600; color: #2A4747; border-bottom: 1px solid rgba(42,71,71,0.08);">' + (row.value || '') + '</td>\n' +
    '</tr>\n';
}

function detailSection(detailRows) {
  if (!detailRows || !detailRows.length) return '';
  return '<tr>\n' +
    '  <td class="psac-px" style="padding: 8px 48px 8px 48px;">\n' +
    '    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid rgba(42,71,71,0.12); border-bottom: 1px solid rgba(42,71,71,0.12);">\n' +
    detailRows.map(renderDetailRow).join('') +
    '    </table>\n' +
    '  </td>\n' +
    '</tr>\n';
}

// Omitted entirely when ctaText/ctaUrl aren't both supplied — deliberately, so a
// message with no call to action never renders a visible, empty, unlabeled button.
function ctaSection(ctaText, ctaUrl) {
  if (!ctaText || !ctaUrl) return '';
  return '<tr>\n' +
    '  <td class="psac-px" align="left" style="padding: 28px 48px 40px 48px;">\n' +
    '    <!--[if mso]>\n' +
    '    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="' + ctaUrl + '" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="5%" fillcolor="#F58271" stroke="f">\n' +
    '    <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">' + ctaText + '</center>\n' +
    '    </v:roundrect>\n' +
    '    <![endif]-->\n' +
    '    <!--[if !mso]><!-->\n' +
    '    <a href="' + ctaUrl + '" style="display:inline-block; background-color:#F58271; color:#FFFFFF; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; padding: 15px 32px; border-radius: 2px; text-decoration: none;">\n' +
    '      ' + ctaText + '\n' +
    '    </a>\n' +
    '    <!--<![endif]-->\n' +
    '  </td>\n' +
    '</tr>\n';
}

/**
 * @param {object} tokens
 * @param {string} tokens.logoUrl
 * @param {string} tokens.preheader - hidden inbox preview text, 40-90 chars
 * @param {string} tokens.eyebrow - small label above the headline
 * @param {string} tokens.headline - can include <em> for the Mountain Pink italic clause
 * @param {string} tokens.bodyHtml - one or more <p> (or <ul>/<li>) already formatted, dropped in directly
 * @param {Array<{label: string, value: string}>} [tokens.detailRows] - omit for no detail block
 * @param {string} [tokens.ctaText]
 * @param {string} [tokens.ctaUrl] - both ctaText and ctaUrl are required together, or neither renders
 */
function renderBaseEmail(tokens) {
  tokens = tokens || {};
  return TEMPLATE_HTML
    .replace(/{{logo_url}}/g, tokens.logoUrl || '')
    .replace(/{{preheader}}/g, tokens.preheader || '')
    .replace(/{{eyebrow}}/g, tokens.eyebrow || '')
    .replace(/{{headline}}/g, tokens.headline || '')
    .replace(/{{body_html}}/g, tokens.bodyHtml || '')
    .replace('{{detail_section}}', detailSection(tokens.detailRows))
    .replace('{{cta_section}}', ctaSection(tokens.ctaText, tokens.ctaUrl));
}

module.exports = { renderBaseEmail, renderDetailRow };
