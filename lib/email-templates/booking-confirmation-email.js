/* ============================================
   PSAC — Booking confirmation email template
   Plain string-substitution template ({{token}} placeholders), matching the
   convention documented in psac-email-template-guide.md for the rest of the
   transactional templates. No templating engine, no npm dependency — kept
   as a plain JS string so it bundles with the function with no extra build
   step, matching this repo's "fetch only, no external packages" convention
   (see api/create-payment-intent.js's header comment).
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
"    Your Palm Springs Adventure Club trail day is booked. Here's what happens next.\n" +
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
'                YOUR RESERVATION\n' +
'              </div>\n' +
'              <h1 class="psac-headline" style="font-family: \'Cormorant Garamond\', Georgia, \'Times New Roman\', serif; font-size: 2rem; font-weight: 300; line-height: 1.2; color: #2A4747; margin: 0 0 20px 0;">\n' +
'                Your adventure is <em>already taking shape.</em>\n' +
'              </h1>\n' +
'              <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 300; line-height: 1.8; color: #2A4747;">\n' +
'                <p style="margin:0 0 16px 0;">Thanks for booking with Palm Springs Adventure Club. Your trail day is reserved, and your gear kit is already being planned.</p>\n' +
"                <p style=\"margin:0;\">Here's what happens between now and your trail day: we'll follow up with a short Trip Prep step to confirm your delivery address and a few last details. Your gear kit, packed and ready, gets delivered to your door the evening before you go. Nothing else for you to plan.</p>\n" +
'              </div>\n' +
'            </td>\n' +
'          </tr>\n' +
'          <tr>\n' +
'            <td class="psac-px" style="padding: 8px 48px 8px 48px;">\n' +
'              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid rgba(42,71,71,0.12); border-bottom: 1px solid rgba(42,71,71,0.12);">\n' +
'                <tr class="detail-row">\n' +
'                  <td style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; color: #7a8a8a; border-bottom: 1px solid rgba(42,71,71,0.08);">Trail date</td>\n' +
'                  <td align="right" style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 600; color: #2A4747; border-bottom: 1px solid rgba(42,71,71,0.08);">{{trail_date}}</td>\n' +
'                </tr>\n' +
'                <tr class="detail-row">\n' +
'                  <td style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; color: #7a8a8a; border-bottom: 1px solid rgba(42,71,71,0.08);">Party size</td>\n' +
'                  <td align="right" style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 600; color: #2A4747; border-bottom: 1px solid rgba(42,71,71,0.08);">{{party_size}}</td>\n' +
'                </tr>\n' +
'                <tr class="detail-row">\n' +
'                  <td style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; color: #7a8a8a; border-bottom: 1px solid rgba(42,71,71,0.08);">Gear kits</td>\n' +
'                  <td align="right" style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 600; color: #2A4747; border-bottom: 1px solid rgba(42,71,71,0.08);">{{gear_kits}}</td>\n' +
'                </tr>\n' +
'                {{sales_tax_row}}' +
'                <tr class="detail-row">\n' +
'                  <td style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; color: #7a8a8a;">Total paid</td>\n' +
'                  <td align="right" style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 600; color: #2A4747;">{{total_paid}}</td>\n' +
'                </tr>\n' +
'              </table>\n' +
'            </td>\n' +
'          </tr>\n' +
'          <tr><td style="padding: 12px 0;"></td></tr>\n' +
'          {{adventure_prep_cta}}\n' +
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

// NEW (Aug 2026): the "Finish setting up your adventure" CTA (PRD Section
// 11's locked guest-facing name and URL path for Surface A). Built as its
// own full <tr> rather than a placeholder inside a fixed row, so a booking
// with no adventurePrepUrl yet (adventurePrep_ensureToken soft-failed on
// the Apps Script side) renders nothing here at all instead of an empty
// gap. The supporting line and button copy are a first draft — unlike the
// rest of this template, this text hasn't gone through
// psac-copy-drafts.md review yet, worth a look before treating it as
// final.
// NEW (Aug 2026): CA sales tax line item, per
// psac-tax-and-stripe-implementation.md Section 5 step 3 ("show the total
// tax line item on the booking confirmation and receipt"). Omitted
// entirely (not shown as $0) when no tax amount is passed — covers Custom
// Experience bookings, which aren't charged through create-payment-intent.js
// and so never have a real tax figure to show.
function buildSalesTaxRow(salesTax) {
  if (!salesTax) return '';
  return '' +
    '<tr class="detail-row">\n' +
    '  <td style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; color: #7a8a8a; border-bottom: 1px solid rgba(42,71,71,0.08);">CA sales tax</td>\n' +
    '  <td align="right" style="padding: 12px 0; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 600; color: #2A4747; border-bottom: 1px solid rgba(42,71,71,0.08);">' + salesTax + '</td>\n' +
    '</tr>\n';
}

function buildAdventurePrepCta(url) {
  if (!url) return '';
  return '' +
    '<tr>\n' +
    '  <td class="psac-px" align="center" style="padding: 8px 48px 32px 48px;">\n' +
    '    <div style="font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 300; line-height: 1.7; color: #2A4747; margin: 0 0 16px 0;">\n' +
    "      A few more details whenever you're ready: delivery address, waivers, and your gear kit.\n" +
    '    </div>\n' +
    '    <a href="' + url + '" style="display:inline-block; background-color:#F58271; color:#FFFFFF; font-family: Montserrat, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 600; letter-spacing: 0.02em; text-decoration:none; padding: 14px 28px; border-radius: 8px;">Finish setting up your adventure &rarr;</a>\n' +
    '  </td>\n' +
    '</tr>';
}

function renderBookingConfirmationEmail(tokens) {
  tokens = tokens || {};
  return TEMPLATE_HTML
    .replace(/{{logo_url}}/g, tokens.logoUrl || '')
    .replace(/{{trail_date}}/g, tokens.trailDate || '')
    .replace(/{{party_size}}/g, tokens.partySize || '')
    .replace(/{{gear_kits}}/g, tokens.gearKits || '')
    .replace(/{{sales_tax_row}}/g, buildSalesTaxRow(tokens.salesTax))
    .replace(/{{total_paid}}/g, tokens.totalPaid || '')
    .replace(/{{adventure_prep_cta}}/g, buildAdventurePrepCta(tokens.adventurePrepUrl));
}

module.exports = { renderBookingConfirmationEmail };
