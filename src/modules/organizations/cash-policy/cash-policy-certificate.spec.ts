import { renderCertificatePdf } from '../operating-mode/operating-mode-certificate';
import {
  buildCashPolicyCertificateContent,
  cashPolicyChangeLabel,
} from './cash-policy-certificate';

const input = {
  organization: {
    id: 'org-1',
    name: 'TSV Musterstadt e.V.',
    address: { street: 'Sportplatz 1', zip: '12345', city: 'Musterstadt' },
  },
  country: 'DE',
  since: new Date('2026-11-01T10:00:00Z'),
  issuedAt: new Date('2026-11-02T08:30:00Z'),
  version: '1.8.0',
  operator: {
    name: 'LUXCODE by Lukas Lukic-Spitznagel',
    addressLines: ['Musterweg 1', '12345 Musterstadt'],
    email: 'hello@openeos.de',
  },
  timeZone: 'Europe/Berlin',
  history: [
    {
      at: new Date('2026-10-01T10:00:00Z'),
      kind: 'country' as const,
      fromValue: null,
      toValue: 'DE',
      reason: null,
      bySupport: false,
    },
    {
      at: new Date('2026-11-01T10:00:00Z'),
      kind: 'policy' as const,
      fromValue: 'legacy',
      toValue: 'country',
      reason: 'Freiwilliger Wechsel durch die Organisation',
      bySupport: false,
    },
  ],
};

function allText(): string {
  const c = buildCashPolicyCertificateContent(input);
  return [
    c.title,
    c.subtitle,
    ...c.facts.flat(),
    ...c.sections.flatMap((s) => [
      s.heading,
      ...s.paragraphs,
      ...(s.bullets ?? []),
    ]),
    ...c.history.rows.flat(),
    ...c.footer,
  ].join('\n');
}

describe('certificate "Deutschland ohne Bargeld"', () => {
  it('states that cash cannot be recorded or activated by the organization', () => {
    const text = allText();
    expect(text).toContain('keine Barzahlungen erfassen oder abwickeln');
    expect(text).toContain(
      'Die Organisation kann die Erfassung von Bargeld nicht selbst aktivieren',
    );
    expect(text).toContain('ausschließlich durch den Hersteller');
    expect(text).toContain('01.11.2026, 11:00 Uhr');
  });

  it('says card payments are recorded and cash runs through an open cash box outside', () => {
    const text = allText();
    expect(text).toContain('Unbare Zahlungen erfasst OpenEOS weiterhin');
    expect(text).toContain('Kartenzahlungen');
    expect(text).toContain('offenen Ladenkasse');
    expect(text).toContain('„Ohne Zahlung abschließen“');
    expect(text).toContain('weder eine Zahlung noch ein bezahlter Betrag');
  });

  it('lists the blocked cash paths and the history', () => {
    const c = buildCashPolicyCertificateContent(input);
    const enforcement = c.sections.find(
      (s) => s.heading === 'Technische Durchsetzung',
    );
    expect(enforcement?.bullets?.join(' ')).toMatch(/Kassenlade/);
    expect(enforcement?.bullets?.join(' ')).toMatch(/Pfand-Auszahlungen/);
    expect(c.history.rows).toHaveLength(2);
    expect(c.history.rows[1][1]).toBe(
      'Bargeld-Regel: Bestandsschutz (wie bisher) zu Regel des Landes',
    );
    expect(c.history.rows[1][2]).toBe(
      'Freiwilliger Wechsel durch die Organisation',
    );
  });

  it('labels country changes', () => {
    expect(
      cashPolicyChangeLabel({
        at: new Date(),
        kind: 'country',
        fromValue: 'DE',
        toValue: 'AT',
        reason: 'x',
        bySupport: true,
      }),
    ).toBe('Land DE zu AT');
  });

  it('renders as a PDF', async () => {
    const pdf = await renderCertificatePdf(
      buildCashPolicyCertificateContent(input),
    );
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
