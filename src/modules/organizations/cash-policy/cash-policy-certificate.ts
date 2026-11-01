import {
  addressLines,
  formatDateTime,
  type CertificateContent,
  type CertificateInput,
} from '../operating-mode/operating-mode-certificate';

/**
 * Herstellerbescheinigung fuer die Bargeld-Regel „Deutschland ohne
 * Bargeld“ (cash-policy.util.ts).
 *
 * Laut BMF-Antwort (2026-10) hat eine Software eine Kassenfunktion, sobald
 * sie Bargeld erfassen kann — auch wenn der Verein das nur selbst
 * einschalten koennte. Ohne TSE muss deshalb belegt sein, dass die
 * Organisation Bargeld nicht aktivieren kann; das leistet diese
 * Bescheinigung fuer die Verfahrensdokumentation. Gesetzt wird sie mit
 * demselben Layout wie die Bescheinigung fuer „Nur Bestellen“
 * (renderCertificatePdf).
 */

export interface CashPolicyHistoryEntry {
  at: Date;
  kind: 'country' | 'policy';
  fromValue: string | null;
  toValue: string;
  reason: string | null;
  bySupport: boolean;
}

export type CashPolicyCertificateInput = Omit<CertificateInput, 'history'> & {
  country: string;
  history: CashPolicyHistoryEntry[];
};

function policyLabel(value: string | null): string {
  if (value === 'legacy') return 'Bestandsschutz (wie bisher)';
  if (value === 'country') return 'Regel des Landes';
  return value ?? '–';
}

export function cashPolicyChangeLabel(entry: CashPolicyHistoryEntry): string {
  if (entry.kind === 'country') {
    return entry.fromValue
      ? `Land ${entry.fromValue} zu ${entry.toValue}`
      : `Land festgelegt: ${entry.toValue}`;
  }
  return `Bargeld-Regel: ${policyLabel(entry.fromValue)} zu ${policyLabel(entry.toValue)}`;
}

function changeReason(entry: CashPolicyHistoryEntry): string {
  const who = entry.bySupport ? 'OpenEOS-Support' : 'Organisation';
  return entry.reason ? `${entry.reason} (${who})` : who;
}

export function buildCashPolicyCertificateContent(
  input: CashPolicyCertificateInput,
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
      'OpenEOS mit der Bargeld-Regel „Deutschland ohne Bargeld“ – Bargeld kann nicht erfasst werden',
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
      [
        'Bargeld-Regel',
        '„Deutschland ohne Bargeld“ (Bargeld gesperrt, durch die Organisation nicht aktivierbar)',
      ],
      ['Gültig seit', since],
    ],
    sections: [
      {
        heading: 'Bescheinigung',
        paragraphs: [
          `Der Hersteller bescheinigt, dass für die oben genannte Organisation seit dem ${since} die Bargeld-Regel „Deutschland ohne Bargeld“ gilt. Mit dieser Regel kann OpenEOS für die Organisation keine Barzahlungen erfassen oder abwickeln.`,
          'Die Organisation kann die Erfassung von Bargeld nicht selbst aktivieren. Weder die Verwaltungsoberfläche noch die Schnittstellen (API, Geräte, Integrationen) bieten der Organisation eine solche Einstellung. Auch das Land der Organisation, an dem die Regel hängt, kann die Organisation nach dem ersten Festlegen nicht selbst ändern. Eine Änderung ist ausschließlich durch den Hersteller (OpenEOS-Support) auf dokumentierten Antrag möglich. Jede Änderung wird mit Zeitpunkt, handelnder Person und Grund protokolliert; der Verlauf ist unten abgedruckt.',
        ],
      },
      {
        heading: 'Technische Durchsetzung',
        paragraphs: [
          'Die Sperre wirkt auf dem OpenEOS-Server, nicht nur in der Oberfläche. Der Server weist jeden Vorgang ab, der Bargeld erfasst oder auszahlt, insbesondere:',
        ],
        bullets: [
          'Barzahlungen an der Kasse und in der Verwaltung (einzeln, geteilt, gesammelt und mit Trinkgeld),',
          'Erstattungen auf Barzahlungen und Auszahlungen in bar,',
          'Pfand-Auszahlungen in bar (Pfand lässt sich nur mit einer Bestellung verrechnen),',
          'das Öffnen der Kassenlade.',
        ],
      },
      {
        heading: 'Erfasste Zahlungen',
        paragraphs: [
          'Unbare Zahlungen erfasst OpenEOS weiterhin: Kartenzahlungen an der Kasse (über ein angebundenes SumUp-Terminal oder ein eigenes Kartengerät) sowie Online-Zahlungen und Vorkasse im Online-Shop oder bei der Bestellung per QR-Code. Erstattungen sind nur auf diese unbaren Zahlungen möglich.',
        ],
      },
      {
        heading: 'Bargeld außerhalb von OpenEOS',
        paragraphs: [
          'Nimmt die Organisation Bargeld an, wickelt sie es außerhalb von OpenEOS ab, zum Beispiel in einer offenen Ladenkasse. Die zugehörige Bestellung schließt sie in OpenEOS mit „Ohne Zahlung abschließen“ ab: Dabei entsteht in OpenEOS weder eine Zahlung noch ein bezahlter Betrag. Die Aufzeichnungspflichten für die offene Ladenkasse liegen bei der Organisation.',
        ],
      },
    ],
    history: {
      heading: 'Verlauf von Land und Bargeld-Regel',
      columns: ['Zeitpunkt', 'Änderung', 'Grund'],
      rows: input.history.map((h) => [
        formatDateTime(h.at, tz),
        cashPolicyChangeLabel(h),
        changeReason(h),
      ]),
    },
    footer: [
      `Ausgestellt am ${formatDateTime(input.issuedAt, tz)} von ${input.operator.name}.`,
      'Dieses Dokument wurde maschinell erstellt und trägt deshalb keine Unterschrift.',
      'Die Bescheinigung beschreibt die technische Konfiguration von OpenEOS für die Organisation. Die steuerliche Beurteilung im Einzelfall obliegt dem zuständigen Finanzamt.',
    ],
  };
}
