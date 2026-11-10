import { escapeHtml } from '../email/email-template';
import { blocksToHtml } from './receipt-html';
import { blocksToText, type ReceiptBlock } from './receipt-blocks';

/**
 * Beleg-Mail an einen Gast. Absender ist der Verein (Anzeigename), die
 * Adresse bleibt die Versandadresse von OpenEOS; Antworten gehen an die
 * Kontaktadresse des Vereins, wenn er eine hinterlegt hat. Der Beleg
 * steht im Text und haengt als PDF an.
 */
export interface ReceiptMailInput {
  organizationName: string;
  /** Je Beleg die Bausteine (wie Seite und PDF). */
  receipts: ReceiptBlock[][];
  /** „Kassenbeleg“ oder „Bewirtungsbeleg“. */
  label: string;
  linkUrl: string;
  linkExpiresAt: Date;
  imprintUrl?: string | null;
  privacyUrl?: string | null;
}

const FONT = 'Arial, Helvetica, sans-serif';

function date(value: Date): string {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(value);
}

export function receiptMail(
  input: ReceiptMailInput,
  qrCid: (value: string) => string | null,
): { subject: string; html: string; text: string } {
  const org = escapeHtml(input.organizationName);
  const subject = `Dein ${input.label} von ${input.organizationName}`;
  const until = date(input.linkExpiresAt);
  const legalLinks = [
    input.imprintUrl
      ? `<a href="${escapeHtml(input.imprintUrl)}" style="color:#1e5433">Impressum</a>`
      : null,
    input.privacyUrl
      ? `<a href="${escapeHtml(input.privacyUrl)}" style="color:#1e5433">Datenschutz</a>`
      : null,
  ]
    .filter(Boolean)
    .join(' &middot; ');
  const receipts = input.receipts
    .map(
      (blocks) =>
        `<div style="border:1px solid #e3ded1;border-radius:8px;padding:16px 18px;margin:0 0 16px;background:#ffffff">${blocksToHtml(blocks, qrCid)}</div>`,
    )
    .join('');
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f2ea">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f2ea"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width:560px;max-width:100%">
<tr><td style="font-family:${FONT};font-size:22px;font-weight:bold;color:#14180f;padding:0 0 8px">Dein ${escapeHtml(input.label)}</td></tr>
<tr><td style="font-family:${FONT};font-size:15px;line-height:1.55;color:#4a4f47;padding:0 0 16px">Hier ist dein ${escapeHtml(input.label)} von <strong>${org}</strong>. Das PDF hängt an. Online kannst du ihn bis ${until} ansehen und herunterladen: <a href="${escapeHtml(input.linkUrl)}" style="color:#1e5433">Beleg öffnen</a></td></tr>
<tr><td>${receipts}</td></tr>
<tr><td style="font-family:${FONT};font-size:12px;line-height:1.6;color:#6b7068;padding:8px 0 0">
Den Beleg hat dir ${org} über OpenEOS geschickt. Deine E-Mail-Adresse wurde nur für diesen Versand verwendet und nicht gespeichert.${legalLinks ? `<br>${org}: ${legalLinks}` : ''}
</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
  const text = [
    `Dein ${input.label} von ${input.organizationName}`,
    '',
    `Das PDF hängt an. Online bis ${until}: ${input.linkUrl}`,
    '',
    ...input.receipts.map((blocks) => blocksToText(blocks) + '\n'),
    `Den Beleg hat dir ${input.organizationName} über OpenEOS geschickt. Deine E-Mail-Adresse wurde nur für diesen Versand verwendet und nicht gespeichert.`,
  ].join('\n');
  return { subject, html, text };
}
