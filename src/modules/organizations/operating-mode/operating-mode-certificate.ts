import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Herstellerbescheinigung fuer den Betriebsmodus „Nur Bestellen“.
 *
 * Laut BMF-Antwort (2026-10) faellt ein Bestellsystem ohne Kassenmodul
 * nicht unter § 146a AO, wenn der Verein das Kassenmodul nicht selbst
 * einschalten kann — nachzuweisen in der Systemdokumentation, z. B. mit
 * einer Bescheinigung des Herstellers. Dieses Modul baut den Inhalt (rein,
 * testbar) und setzt ihn mit pdfkit als A4-PDF.
 *
 * Der Text beschreibt nur die technische Konfiguration; die steuerliche
 * Beurteilung bleibt beim Finanzamt. Keine Unterschrift, kein Siegel:
 * maschinell erstellt.
 */

export interface CertificateOperator {
  name: string;
  addressLines: string[];
  email: string | null;
}

export interface CertificateHistoryEntry {
  at: Date;
  fromMode: string;
  toMode: string;
  reason: string;
}

export interface CertificateInput {
  organization: {
    id: string;
    name: string;
    address?: {
      street?: string;
      zip?: string;
      city?: string;
      country?: string;
    } | null;
  };
  since: Date;
  issuedAt: Date;
  version: string;
  operator: CertificateOperator;
  timeZone: string;
  history: CertificateHistoryEntry[];
}

export interface CertificateSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface CertificateContent {
  title: string;
  subtitle: string;
  operator: { label: string; lines: string[] };
  organization: { label: string; lines: string[] };
  facts: [string, string][];
  sections: CertificateSection[];
  history: {
    heading: string;
    columns: [string, string, string];
    rows: [string, string, string][];
  };
  footer: string[];
}

export const DEFAULT_OPERATOR_NAME = 'LUXCODE by Lukas Lukic-Spitznagel';
export const DEFAULT_OPERATOR_EMAIL = 'hello@openeos.de';

/**
 * Herstellerangaben aus der Umgebung (wie das Impressum der Website):
 * `OPERATOR_NAME`, `OPERATOR_ADDRESS` (Zeilen mit „|“ oder „\n“ getrennt),
 * `OPERATOR_EMAIL`.
 */
export function operatorFromEnv(
  get: (key: string) => string | undefined,
): CertificateOperator {
  const name = get('OPERATOR_NAME')?.trim() || DEFAULT_OPERATOR_NAME;
  const addressLines = (get('OPERATOR_ADDRESS') ?? '')
    .split(/\\n|\n|\|/)
    .map((line) => line.trim())
    .filter(Boolean);
  const email = get('OPERATOR_EMAIL')?.trim() || DEFAULT_OPERATOR_EMAIL;
  return { name, addressLines, email };
}

/** Kurzform fuer die Verlaufstabelle. */
export function modeShortLabel(mode: string): string {
  if (mode === 'order_only') return '„Nur Bestellen“';
  if (mode === 'pos') return '„Kasse“';
  return mode;
}

export function modeLabel(mode: string): string {
  if (mode === 'order_only') return '„Nur Bestellen“ (ohne Kassenmodul)';
  if (mode === 'pos') return '„Kasse“ (mit Kassen- und Zahlungsmodul)';
  return mode;
}

function formatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('de-DE', { timeZone, ...options });
  } catch {
    return new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      ...options,
    });
  }
}

export function formatDate(date: Date, timeZone: string): string {
  return formatter(timeZone, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

export function formatDateTime(date: Date, timeZone: string): string {
  return `${formatDate(date, timeZone)}, ${formatter(timeZone, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)} Uhr`;
}

export function addressLines(
  address: CertificateInput['organization']['address'],
): string[] {
  if (!address) return [];
  const lines: string[] = [];
  if (address.street?.trim()) lines.push(address.street.trim());
  const place = [address.zip, address.city]
    .map((v) => v?.trim())
    .filter(Boolean)
    .join(' ');
  if (place) lines.push(place);
  const country = address.country?.trim();
  if (country && !/^(de|deu|deutschland|germany)$/i.test(country)) {
    lines.push(country);
  }
  return lines;
}

export function buildCertificateContent(
  input: CertificateInput,
): CertificateContent {
  const tz = input.timeZone;
  const since = formatDateTime(input.since, tz);
  const operatorLines = [
    input.operator.name,
    ...input.operator.addressLines,
    ...(input.operator.email ? [input.operator.email] : []),
  ];
  const orgAddress = addressLines(input.organization.address);

  return {
    title: 'Herstellerbescheinigung',
    subtitle:
      'OpenEOS in der Betriebsart „Nur Bestellen“ – ohne Kassen- und Zahlungsmodul',
    operator: { label: 'Hersteller', lines: operatorLines },
    organization: {
      label: 'Organisation',
      lines: [
        input.organization.name,
        ...(orgAddress.length ? orgAddress : ['(keine Anschrift hinterlegt)']),
      ],
    },
    facts: [
      ['Software', 'OpenEOS (Bestell- und Kassensystem, Cloud-Dienst)'],
      ['Version', input.version],
      ['Organisations-ID', input.organization.id],
      ['Betriebsart', modeLabel('order_only')],
      ['Gültig seit', since],
    ],
    sections: [
      {
        heading: 'Bescheinigung',
        paragraphs: [
          `Der Hersteller bescheinigt, dass für die oben genannte Organisation seit dem ${since} die Betriebsart „Nur Bestellen“ eingestellt ist. In diesem Modus ist das Kassen- und Zahlungsmodul von OpenEOS für die Organisation deaktiviert.`,
          'Die Organisation kann das Kassen- und Zahlungsmodul nicht selbst aktivieren. Weder die Verwaltungsoberfläche noch die Schnittstellen (API, Geräte, Integrationen) bieten der Organisation eine solche Einstellung. Eine Umschaltung ist ausschließlich durch den Hersteller (OpenEOS-Support) auf dokumentierten Antrag möglich. Jede Umschaltung wird mit Zeitpunkt, handelnder Person und Grund protokolliert; der Verlauf ist unten abgedruckt.',
        ],
      },
      {
        heading: 'Technische Durchsetzung',
        paragraphs: [
          'Die Sperre wirkt auf dem OpenEOS-Server, nicht nur in der Oberfläche. In der Betriebsart „Nur Bestellen“ weist der Server jeden Vorgang ab, der eine Zahlung erfasst oder abwickelt, insbesondere:',
        ],
        bullets: [
          'Barzahlungen sowie Kartenzahlungen an der Kasse (auch über ein angebundenes SumUp-Terminal),',
          'Teil-, Sammel- und Tischzahlungen sowie Trinkgeld,',
          'Erstattungen an der Kasse und Auszahlungen aus der Kasse,',
          'das Öffnen der Kassenlade und Pfand-Auszahlungen in bar.',
        ],
      },
      {
        heading: 'Weiterhin verfügbare Funktionen',
        paragraphs: [
          'OpenEOS dient der Organisation in diesem Modus als Bestellsystem:',
        ],
        bullets: [
          'Erfassung von Bestellungen an Geräten, im Tischbetrieb und an der Theke,',
          'Weiterleitung an Küche und Ausgabestationen (Bons und Bildschirme),',
          'Status „in Zubereitung“, „fertig“, „ausgegeben/serviert“ und Abschluss der Bestellung ohne Zahlung,',
          'Storno von Bestellungen ohne Erstattung.',
        ],
      },
      {
        heading: 'Bezahlung',
        paragraphs: [
          'Zahlungen vor Ort wickelt die Organisation außerhalb von OpenEOS ab, zum Beispiel über eine offene Ladenkasse. Die dafür geltenden Aufzeichnungspflichten liegen bei der Organisation.',
          'Vorkasse im Online-Shop: Bezahlen Gäste bereits bei einer Online-Bestellung (Online-Shop oder Bestellung per QR-Code) unbar über einen Online-Zahlungsdienst (PayPal oder SumUp Online), erfasst OpenEOS diese Online-Zahlung weiterhin. Sie läuft nicht über eine Kasse vor Ort; Bargeld wird dabei nicht angenommen. Erstattungen sind in diesem Modus nur auf solche Online-Zahlungen möglich.',
        ],
      },
    ],
    history: {
      heading: 'Verlauf der Betriebsart',
      columns: ['Zeitpunkt', 'Umschaltung', 'Grund'],
      rows: input.history.map((h) => [
        formatDateTime(h.at, tz),
        `${modeShortLabel(h.fromMode)} zu ${modeShortLabel(h.toMode)}`,
        h.reason,
      ]),
    },
    footer: [
      `Ausgestellt am ${formatDateTime(input.issuedAt, tz)} von ${input.operator.name}.`,
      'Dieses Dokument wurde maschinell erstellt und trägt deshalb keine Unterschrift.',
      'Die Bescheinigung beschreibt die technische Konfiguration von OpenEOS für die Organisation. Die steuerliche Beurteilung im Einzelfall obliegt dem zuständigen Finanzamt.',
    ],
  };
}

function resolveLogoPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'assets/logo_dark.png'),
    path.resolve(__dirname, '../../../../assets/logo_dark.png'),
    path.resolve(__dirname, '../../../../../assets/logo_dark.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const INK = '#111111';
const MUTE = '#555555';
const LINE = '#CCCCCC';

/** Setzt den Inhalt als A4-PDF (Hochformat). */
export function renderCertificatePdf(
  content: CertificateContent,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `${content.title} – ${content.organization.lines[0]}`,
        Author: content.operator.lines[0],
        Creator: 'OpenEOS',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const left = doc.page.margins.left;
      const width =
        doc.page.width - doc.page.margins.left - doc.page.margins.right;

      const logo = resolveLogoPath();
      if (logo) {
        doc.image(logo, left, 40, { height: 22 });
        doc.y = 76;
      } else {
        doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text('OpenEOS');
        doc.moveDown(0.5);
      }

      doc
        .font('Helvetica-Bold')
        .fontSize(20)
        .fillColor(INK)
        .text(content.title);
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(11).fillColor(MUTE).text(content.subtitle);
      doc.moveDown(1);

      // Hersteller und Organisation nebeneinander
      const top = doc.y;
      const colWidth = (width - 24) / 2;
      const block = (x: number, label: string, lines: string[]) => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTE);
        doc.text(label.toUpperCase(), x, top, { width: colWidth });
        doc.font('Helvetica').fontSize(10).fillColor(INK);
        for (const line of lines) doc.text(line, x, doc.y, { width: colWidth });
        return doc.y;
      };
      const endA = block(left, content.operator.label, content.operator.lines);
      const endB = block(
        left + colWidth + 24,
        content.organization.label,
        content.organization.lines,
      );
      doc.x = left;
      doc.y = Math.max(endA, endB) + 14;

      // Eckdaten
      for (const [label, value] of content.facts) {
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(10).fillColor(INK);
        doc.text(label, left, y, { width: 120 });
        doc
          .font('Helvetica')
          .text(value, left + 125, y, { width: width - 125 });
        doc.x = left;
        doc.moveDown(0.15);
      }
      doc.moveDown(0.6);

      for (const section of content.sections) {
        doc.font('Helvetica-Bold').fontSize(12).fillColor(INK);
        doc.text(section.heading, left, doc.y, { width });
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(9.5).fillColor(INK);
        for (const p of section.paragraphs) {
          doc.text(p, left, doc.y, { width, align: 'justify' });
          doc.moveDown(0.35);
        }
        if (section.bullets?.length) {
          doc.list(section.bullets, left + 8, doc.y, {
            width: width - 8,
            bulletRadius: 1.6,
            textIndent: 12,
          });
          doc.x = left;
          doc.moveDown(0.3);
        }
        doc.moveDown(0.2);
      }

      // Verlauf als einfache Tabelle
      doc.font('Helvetica-Bold').fontSize(12).fillColor(INK);
      doc.text(content.history.heading, left, doc.y, { width });
      doc.moveDown(0.3);
      const widths = [115, 150, width - 265];
      const row = (cells: string[], bold: boolean) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
        const heights = cells.map((c, i) =>
          doc.heightOfString(c, { width: widths[i] - 6 }),
        );
        const h = Math.max(...heights) + 6;
        if (doc.y + h > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
        }
        const y = doc.y;
        let x = left;
        cells.forEach((c, i) => {
          doc.fillColor(INK).text(c, x + 3, y + 3, { width: widths[i] - 6 });
          x += widths[i];
        });
        doc
          .moveTo(left, y + h)
          .lineTo(left + width, y + h)
          .strokeColor(LINE)
          .lineWidth(0.5)
          .stroke();
        doc.x = left;
        doc.y = y + h;
      };
      row([...content.history.columns], true);
      if (content.history.rows.length === 0) {
        row(['–', '–', '–'], false);
      }
      for (const r of content.history.rows) row(r, false);
      doc.moveDown(0.8);

      doc.font('Helvetica').fontSize(8).fillColor(MUTE);
      for (const line of content.footer) {
        doc.text(line, left, doc.y, { width });
        doc.moveDown(0.15);
      }
    } catch (err) {
      reject(err as Error);
      return;
    }

    doc.end();
  });
}
