import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Herstellerbescheinigung fuer Organisationen in Deutschland in den
 * Betriebsarten „Nur Bons“ (`orders_only`) und „Bargeldlos“ (`cashless`).
 *
 * Laut BMF-Antwort (2026-10) hat eine Software eine Kassenfunktion, sobald
 * sie Bargeld erfassen kann — auch wenn der Verein das nur selbst
 * einschalten koennte. In beiden Betriebsarten kann OpenEOS kein Bargeld
 * erfassen, und Bargeld (Betriebsart „Alle Funktionen“) ist in Deutschland
 * nur mit aktiver zertifizierter TSE waehlbar — das belegt diese
 * Bescheinigung fuer die Verfahrensdokumentation. Dieses Modul baut den
 * Inhalt (rein, testbar) und setzt ihn mit pdfkit als A4-PDF.
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
  reason: string | null;
  bySupport: boolean;
}

export type CertificateMode = 'orders_only' | 'cashless';

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
  mode: CertificateMode;
  country: string;
  tseActive: boolean;
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

/** Name der Betriebsart wie in der Oberflaeche, fuer Verlauf und Text. */
export function modeShortLabel(mode: string): string {
  switch (mode) {
    case 'orders_only':
      return '„Nur Bons“';
    case 'cashless':
      return '„Bargeldlos“';
    case 'full':
      return '„Alle Funktionen“';
    case 'full_legacy':
      return '„Alle Funktionen (Bestand)“';
    default:
      return mode;
  }
}

export function modeLabel(mode: string): string {
  if (mode === 'orders_only') {
    return '„Nur Bons“ (ohne Preise und Zahlungen, ohne Bargeld)';
  }
  if (mode === 'cashless') {
    return '„Bargeldlos“ (Karte und Online-Zahlung, ohne Bargeld)';
  }
  return modeShortLabel(mode);
}

function historyReason(entry: CertificateHistoryEntry): string {
  if (!entry.bySupport) return entry.reason ?? 'Durch die Organisation';
  return entry.reason ? `${entry.reason} (OpenEOS-Support)` : 'OpenEOS-Support';
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
  const ordersOnly = input.mode === 'orders_only';
  const name = modeShortLabel(input.mode);

  const sections: CertificateSection[] = [
    {
      heading: 'Bescheinigung',
      paragraphs: [
        `Der Hersteller bescheinigt, dass für die oben genannte Organisation seit dem ${since} die Betriebsart ${name} eingestellt ist. Bargeld kann in dieser Organisation nicht erfasst werden; Bargeld ist ausschließlich mit aktiver zertifizierter TSE möglich.`,
        `Die Organisation kann selbst zwischen den Betriebsarten „Nur Bons“ und „Bargeldlos“ wechseln – in beiden gibt es in OpenEOS kein Bargeld. Die Betriebsart „Alle Funktionen“, die Bargeld erfasst, lässt sich für Organisationen in Deutschland nur einstellen, wenn für die Organisation eine zertifizierte Cloud-TSE aktiv ist. Weder die Organisation noch der Hersteller können Bargeld ohne aktive TSE einschalten${input.tseActive ? '.' : '; derzeit ist für die Organisation keine TSE aktiv.'} Das Land der Organisation, an dem diese Regel hängt, kann die Organisation nach dem ersten Festlegen nicht selbst ändern.`,
        'Jeder Wechsel der Betriebsart wird mit Zeitpunkt, handelnder Person, alter und neuer Betriebsart (beim Hersteller zusätzlich mit Grund) protokolliert; der Verlauf ist unten abgedruckt.',
      ],
    },
    {
      heading: 'Technische Durchsetzung',
      paragraphs: [
        ordersOnly
          ? 'Die Sperre wirkt auf dem OpenEOS-Server, nicht nur in der Oberfläche. In der Betriebsart „Nur Bons“ weist der Server jeden Vorgang ab, der eine Zahlung erfasst oder abwickelt, insbesondere:'
          : 'Die Sperre wirkt auf dem OpenEOS-Server, nicht nur in der Oberfläche. Der Server weist jeden Vorgang ab, der Bargeld erfasst oder auszahlt, insbesondere:',
      ],
      bullets: ordersOnly
        ? [
            'Barzahlungen sowie Kartenzahlungen an der Kasse (auch über ein angebundenes SumUp-Terminal),',
            'Teil-, Sammel- und Tischzahlungen, Trinkgeld, Rabatte und Gutscheine,',
            'Online-Vorkasse im Online-Shop und bei der Bestellung per QR-Code,',
            'Erstattungen an der Kasse und Auszahlungen aus der Kasse,',
            'Pfand und Pfand-Auszahlungen sowie das Öffnen der Kassenlade.',
          ]
        : [
            'Barzahlungen an der Kasse und in der Verwaltung (einzeln, geteilt, gesammelt und mit Trinkgeld),',
            'Erstattungen auf Barzahlungen und Auszahlungen in bar,',
            'Pfand-Auszahlungen in bar (Pfand lässt sich nur mit einer Bestellung verrechnen),',
            'das Öffnen der Kassenlade.',
          ],
    },
    ordersOnly
      ? {
          heading: 'Weiterhin verfügbare Funktionen',
          paragraphs: [
            'OpenEOS dient der Organisation in dieser Betriebsart als Bestellsystem ohne Preise und Beträge:',
          ],
          bullets: [
            'Erfassung von Bestellungen an Geräten, im Tischbetrieb und an der Theke,',
            'Weiterleitung an Küche und Ausgabestationen (Bons und Bildschirme, jeweils ohne Preise),',
            'Status „in Zubereitung“, „fertig“, „ausgegeben/serviert“ und Abschluss der Bestellung ohne Zahlung („Abgeholt“ bzw. „Tisch abschließen“),',
            'Berichte mit Mengen, ohne Umsätze.',
          ],
        }
      : {
          heading: 'Erfasste Zahlungen',
          paragraphs: [
            'Unbare Zahlungen erfasst OpenEOS weiterhin: Kartenzahlungen an der Kasse (über ein angebundenes SumUp-Terminal oder ein eigenes Kartengerät) sowie Online-Zahlungen und Vorkasse im Online-Shop oder bei der Bestellung per QR-Code. Erstattungen sind nur auf diese unbaren Zahlungen möglich.',
          ],
        },
    {
      heading: 'Bargeld außerhalb von OpenEOS',
      paragraphs: [
        ordersOnly
          ? 'Kassiert wird außerhalb von OpenEOS, zum Beispiel über eine offene Ladenkasse oder mit Wertmarken. Die dafür geltenden Aufzeichnungspflichten liegen bei der Organisation.'
          : 'Bargeldumsätze außerhalb von OpenEOS, zum Beispiel in einer offenen Ladenkasse, erfasst OpenEOS nicht. Die dafür geltenden Aufzeichnungspflichten liegen bei der Organisation.',
      ],
    },
  ];

  return {
    title: 'Herstellerbescheinigung',
    subtitle: `OpenEOS in der Betriebsart ${name} – Bargeld kann nicht erfasst werden`,
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
      ['Land', input.country === 'DE' ? 'Deutschland (DE)' : input.country],
      ['Betriebsart', modeLabel(input.mode)],
      [
        'TSE',
        input.tseActive
          ? 'aktiv (in dieser Betriebsart wird kein Bargeld erfasst)'
          : 'keine aktive TSE – Bargeld gesperrt',
      ],
      ['Gültig seit', since],
    ],
    sections,
    history: {
      heading: 'Verlauf der Betriebsart',
      columns: ['Zeitpunkt', 'Wechsel', 'Grund'],
      rows: input.history.map((h) => [
        formatDateTime(h.at, tz),
        `${modeShortLabel(h.fromMode)} zu ${modeShortLabel(h.toMode)}`,
        historyReason(h),
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
