import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import type { ReceiptBlock } from './receipt-blocks';

/**
 * PDF eines oder mehrerer digitaler Belege: A4, je Beleg eine Seite, der
 * Beleg als schmale Spalte in der Mitte (wie der Bon). Standardschriften
 * (Helvetica/Courier, WinAnsi mit Umlauten und €), keine eingebetteten
 * Fremdschriften.
 */
export interface ReceiptPdfPage {
  blocks: ReceiptBlock[];
}

const PAGE = { width: 595.28, height: 841.89 };
const COLUMN = 300;
const LEFT = (PAGE.width - COLUMN) / 2;
const TOP = 48;
const BOTTOM = PAGE.height - 48;

/** Zeichen ausserhalb von WinAnsi (Emoji o. Ae.) ersetzt pdfkit sonst falsch. */
function safe(text: string): string {
  const map: Record<number, string> = {
    0x2013: '-',
    0x2014: '-',
    0x201e: '"',
    0x201c: '"',
    0x201d: '"',
    0x2018: "'",
    0x2019: "'",
    0x201a: "'",
    0x2026: '...',
  };
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (map[code]) out += map[code];
    else if (
      code === 10 ||
      (code >= 32 && code <= 126) ||
      (code >= 160 && code <= 255) ||
      code === 0x20ac
    )
      out += ch;
    else out += '?';
  }
  return out;
}

async function qrPng(value: string): Promise<Buffer> {
  return QRCode.toBuffer(value, {
    errorCorrectionLevel: 'Q',
    margin: 1,
    width: 360,
  });
}

export async function renderReceiptPdf(
  pages: ReceiptPdfPage[],
  meta: { title: string; author: string },
): Promise<Buffer> {
  // QR-Codes vorab erzeugen (pdfkit zeichnet synchron).
  const qr = new Map<string, Buffer>();
  for (const page of pages) {
    for (const b of page.blocks) {
      if (b.type === 'qr' && !qr.has(b.value))
        qr.set(b.value, await qrPng(b.value));
    }
  }

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: TOP, bottom: 0, left: LEFT, right: LEFT },
    info: {
      Title: safe(meta.title),
      Author: safe(meta.author),
      Creator: 'OpenEOS',
    },
    autoFirstPage: false,
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const ensure = (height: number) => {
    if (doc.y + height > BOTTOM) {
      doc.addPage();
      doc.y = TOP;
    }
  };

  for (const page of pages) {
    doc.addPage();
    doc.y = TOP;
    for (const b of page.blocks) {
      switch (b.type) {
        case 'banner': {
          ensure(26);
          const y = doc.y;
          doc.rect(LEFT, y, COLUMN, 22).fill('#14180f');
          doc
            .fillColor('#ffffff')
            .font('Helvetica-Bold')
            .fontSize(11)
            .text(safe(b.text), LEFT, y + 6, {
              width: COLUMN,
              align: 'center',
            });
          doc.fillColor('#000000');
          doc.y = y + 28;
          break;
        }
        case 'heading':
          ensure(24);
          doc.font('Helvetica-Bold').fontSize(16);
          doc.text(safe(b.text), LEFT, doc.y, {
            width: COLUMN,
            align: 'center',
          });
          doc.moveDown(0.2);
          break;
        case 'title':
          ensure(22);
          doc.moveDown(0.3);
          doc.font('Helvetica-Bold').fontSize(14);
          doc.text(safe(b.text), LEFT, doc.y, {
            width: COLUMN,
            align: 'center',
          });
          doc.moveDown(0.3);
          break;
        case 'center':
          ensure(14);
          doc
            .font('Helvetica')
            .fontSize(9.5)
            .fillColor(b.muted ? '#555555' : '#000000')
            .text(safe(b.text), LEFT, doc.y, {
              width: COLUMN,
              align: 'center',
            });
          doc.fillColor('#000000');
          break;
        case 'text':
          ensure(14);
          doc
            .font(b.bold ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(10)
            .fillColor(b.muted ? '#555555' : '#000000')
            .text(safe(b.text), LEFT, doc.y, { width: COLUMN });
          doc.fillColor('#000000');
          break;
        case 'note':
          ensure(14);
          doc
            .font('Helvetica')
            .fontSize(8)
            .fillColor('#555555')
            .text(safe(b.text), LEFT, doc.y, { width: COLUMN });
          doc.fillColor('#000000');
          break;
        case 'row': {
          ensure(14);
          const y = doc.y;
          doc
            .font(b.bold ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(b.bold ? 11 : 10);
          const valueWidth = Math.min(
            COLUMN * 0.6,
            doc.widthOfString(safe(b.value)) + 2,
          );
          doc.text(safe(b.value), LEFT + COLUMN - valueWidth, y, {
            width: valueWidth,
            align: 'right',
          });
          const after = doc.y;
          doc.text(safe(b.label), LEFT, y, { width: COLUMN - valueWidth - 8 });
          doc.y = Math.max(after, doc.y);
          break;
        }
        case 'item': {
          ensure(14);
          const y = doc.y;
          doc.font('Helvetica').fontSize(10);
          const amountWidth = 70;
          doc.text(safe(b.qty), LEFT, y, { width: 30 });
          doc.text(safe(b.amount), LEFT + COLUMN - amountWidth, y, {
            width: amountWidth,
            align: 'right',
          });
          doc.text(safe(b.name), LEFT + 32, y, {
            width: COLUMN - 32 - amountWidth - 6,
          });
          break;
        }
        case 'rule': {
          ensure(10);
          const y = doc.y + 4;
          doc
            .moveTo(LEFT, y)
            .lineTo(LEFT + COLUMN, y)
            .lineWidth(0.6)
            .stroke('#000000');
          if (b.double) {
            doc
              .moveTo(LEFT, y + 2)
              .lineTo(LEFT + COLUMN, y + 2)
              .stroke('#000000');
          }
          doc.y = y + (b.double ? 8 : 6);
          break;
        }
        case 'mono':
          ensure(24);
          if (b.label) {
            doc
              .font('Helvetica')
              .fontSize(9)
              .text(`${safe(b.label)}:`, LEFT, doc.y, {
                width: COLUMN,
              });
          }
          doc.font('Courier').fontSize(8).text(safe(b.text), LEFT, doc.y, {
            width: COLUMN,
            lineBreak: true,
          });
          break;
        case 'qr': {
          const size = 110;
          ensure(size + 20);
          const png = qr.get(b.value);
          if (png)
            doc.image(png, LEFT + (COLUMN - size) / 2, doc.y + 4, {
              width: size,
            });
          doc.y += size + 8;
          if (b.caption) {
            doc
              .font('Helvetica')
              .fontSize(8)
              .text(safe(b.caption), LEFT, doc.y, {
                width: COLUMN,
                align: 'center',
              });
          }
          break;
        }
        case 'fill': {
          ensure(18 + 20 * b.lines);
          doc.moveDown(0.4);
          doc
            .font('Helvetica')
            .fontSize(10)
            .text(`${safe(b.label)}:`, LEFT, doc.y, {
              width: COLUMN,
            });
          for (let i = 0; i < b.lines; i++) {
            const y = doc.y + 16;
            doc
              .moveTo(LEFT, y)
              .lineTo(LEFT + COLUMN, y)
              .lineWidth(0.5)
              .dash(1.5, { space: 2 })
              .stroke('#000000')
              .undash();
            doc.y = y + 2;
          }
          doc.moveDown(0.3);
          break;
        }
      }
    }
  }
  doc.end();
  return done;
}
