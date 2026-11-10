import type { TsePrintBlock } from '../tse/tse-view';
import { blocksToText } from './receipt-blocks';
import {
  collectiveItemNames,
  hospitalityBlocks,
  hospitalitySnapshot,
  isCollectiveItemName,
  missingIssuerData,
  printableBlocks,
  type HospitalityIssuer,
} from './hospitality';
import { HospitalityReceiptsService } from './hospitality-receipts.service';
import {
  receiptDocumentFromPayload,
  type ReceiptDocument,
} from './receipt-document';
import type { ReceiptsService } from './receipts.service';

const TSE: TsePrintBlock = {
  status: 'signed',
  failed: false,
  training: false,
  notice: null,
  process_type: 'Kassenbeleg-V1',
  serial_number: 'abc123serial',
  client_id: 'OE-1',
  bon_number: 7,
  transaction_number: 4412,
  signature_counter: 99,
  start_time: '2026-11-11T18:00:00.000Z',
  finish_time: '2026-11-11T18:01:00.000Z',
  signature: 'SIG',
  signature_algorithm: 'ecdsa-plain-SHA384',
  log_time_format: 'unixTime',
  public_key: 'P',
  qr_code: 'V0;OE-1;...',
  late_signature: null,
  order_start_time: null,
};

const ISSUER: HospitalityIssuer = {
  legalName: 'TSV Musterdorf e.V.',
  street: 'Sportplatzweg 3',
  zip: '12345',
  city: 'Musterdorf',
  taxNumber: '12/345/67890',
  vatId: '',
};

function doc(over: Record<string, unknown> = {}): ReceiptDocument {
  return receiptDocumentFromPayload(
    {
      order_id: 'o-1',
      order_number: '20261111-0001',
      created_at: '2026-11-11T18:00:00Z',
      organization: { name: 'TSV' },
      items: [
        { quantity: 2, name: 'Bratwurst', total: 7 },
        { quantity: 2, name: 'Apfelschorle', total: 5 },
      ],
      tax_lines: [
        { rate: 19, net: 4.2, tax: 0.8, gross: 5 },
        { rate: 7, net: 6.54, tax: 0.46, gross: 7 },
      ],
      total: 12,
      payment_label: 'Karte (SumUp)',
      payment_method: 'sumup_terminal',
      is_test: false,
      tse: TSE,
      ...over,
    },
    { showWaiter: false },
  );
}

const text = (blocks: ReturnType<typeof hospitalityBlocks>) =>
  blocksToText(blocks).replace(/\u00a0/g, ' ');

describe('Bewirtungsbeleg: rules', () => {
  it('needs name and address always, tax number or VAT id only above 250 €', () => {
    expect(missingIssuerData(ISSUER, 300)).toEqual([]);
    expect(missingIssuerData({ ...ISSUER, taxNumber: '' }, 250)).toEqual([]);
    expect(missingIssuerData({ ...ISSUER, taxNumber: '' }, 250.01)).toEqual([
      'taxNumber',
    ]);
    expect(
      missingIssuerData(
        { ...ISSUER, taxNumber: '', vatId: 'DE123456789' },
        900,
      ),
    ).toEqual([]);
    expect(
      missingIssuerData(
        { ...ISSUER, legalName: '', street: '', zip: '', city: '' },
        10,
      ),
    ).toEqual(['legalName', 'street', 'zip', 'city']);
  });

  it('rejects collective terms but accepts specific names like „Menü 1“', () => {
    for (const name of [
      'Speisen und Getränke',
      'Speisen & Getränke',
      'Getränke',
      'Speisen',
      'Essen und Trinken',
      'Verzehr',
      'Diverses',
      ' ',
    ]) {
      expect(isCollectiveItemName(name)).toBe(true);
    }
    for (const name of [
      'Menü 1',
      'Tagesgericht 2',
      'Lunch-Buffet',
      'Bratwurst',
      'Getränkebon 2 €',
    ]) {
      expect(isCollectiveItemName(name)).toBe(false);
    }
    expect(collectiveItemNames(['Bratwurst', 'Getränke', 'Getränke'])).toEqual([
      'Getränke',
    ]);
  });
});

describe('Bewirtungsbeleg: content', () => {
  const snapshot = hospitalitySnapshot({
    issuer: ISSUER,
    vatExempt: false,
    cashlessOnly: false,
    documents: [
      doc({ total: 14, tip_amount: 2 }),
      doc({
        order_number: '20261111-0002',
        total: 13,
        tip_amount: 1,
        tse: { ...TSE, transaction_number: 4413 },
      }),
    ],
    payments: [{ reference: null }, { reference: null }],
  });
  const record = {
    number: 'B-2026-0001',
    issuedAt: '2026-11-11T18:05:00Z',
    serviceDate: '2026-11-11',
    recipientName: 'Muster GmbH',
    recipientAddress: 'Industriestraße 12\n12345 Musterstadt',
    snapshot,
  };

  it('merges orders, VAT per rate and tips', () => {
    expect(snapshot.total).toBe(27);
    expect(snapshot.tip).toBe(3);
    expect(snapshot.items).toHaveLength(4);
    expect(snapshot.taxLines).toEqual([
      { rate: 19, net: 8.4, tax: 1.6, gross: 10 },
      { rate: 7, net: 13.08, tax: 0.92, gross: 14 },
    ]);
  });

  it('prints every mandatory field (§ 14 UStG, § 33 UStDV, BMF 19.11.2025)', () => {
    const t = text(
      hospitalityBlocks(record, { copy: false, timeZone: 'Europe/Berlin' }),
    );
    for (const part of [
      'TSV Musterdorf e.V.',
      'Sportplatzweg 3, 12345 Musterdorf',
      'Steuernummer: 12/345/67890',
      'BEWIRTUNGSBELEG',
      'Rechnungsnummer: B-2026-0001',
      'Rechnungsdatum: 11.11.2026',
      'Tag der Bewirtung: 11.11.2026',
      'Bestellungen: #20261111-0001, #20261111-0002',
      'Muster GmbH',
      'Industriestraße 12',
      '2x Bratwurst  7,00 €',
      'Netto 19 %: 8,40 €',
      'USt 19 %: 1,60 €',
      'Netto 7 %: 13,08 €',
      'USt 7 %: 0,92 €',
      'Trinkgeld  3,00 €',
      'Ohne Umsatzsteuer: 3,00 €',
      'Rechnungsbetrag brutto: 27,00 €',
      'Zahlungsart: Karte (SumUp)',
      'TSE-Transaktion: 4412',
      'TSE-Transaktion: 4413',
      'TSE-Seriennummer: abc123serial',
      'Anlass der Bewirtung',
      'Bewirtete Personen (Namen)',
      'Unterschrift des Bewirtenden',
      'Höhe der Aufwendungen: 27,00 €',
    ]) {
      expect(t).toContain(part);
    }
    expect(t).not.toContain('KOPIE');
    expect(t).not.toContain('Steuerfrei');
  });

  it('marks copies', () => {
    expect(text(hospitalityBlocks(record, { copy: true }))).toContain(
      '*** KOPIE ***',
    );
  });

  it('shows no VAT at all for small businesses (§ 19 UStG, § 14c risk)', () => {
    const exempt = hospitalitySnapshot({
      issuer: ISSUER,
      vatExempt: true,
      cashlessOnly: false,
      documents: [doc()],
      payments: [{ reference: null }],
    });
    expect(exempt.taxLines).toEqual([]);
    const t = text(
      hospitalityBlocks({ ...record, snapshot: exempt }, { copy: false }),
    );
    expect(t).toContain('Steuerfrei nach § 19 Abs. 1 UStG (Kleinunternehmer)');
    expect(t).not.toMatch(/USt \d|Netto|MwSt/);
    expect(t).not.toContain('Trinkgeld');
  });

  it('notes cashless-only payment with the payment reference', () => {
    const cashless = hospitalitySnapshot({
      issuer: ISSUER,
      vatExempt: false,
      cashlessOnly: true,
      documents: [doc({ tse: null })],
      payments: [{ reference: 'TX-42' }],
    });
    const t = text(
      hospitalityBlocks({ ...record, snapshot: cashless }, { copy: false }),
    );
    expect(t).toContain('Zahlungsreferenz: TX-42');
    expect(t).toContain('Ausschließlich unbare Zahlung');
    expect(t).not.toContain('Kassen-ID');
  });

  it('marks test receipts and TSE outages', () => {
    const test = hospitalitySnapshot({
      issuer: ISSUER,
      vatExempt: false,
      cashlessOnly: false,
      documents: [
        doc({ is_test: true, tse: { ...TSE, failed: true, status: 'failed' } }),
      ],
      payments: [{ reference: null }],
    });
    const t = text(
      hospitalityBlocks(
        { ...record, number: null, snapshot: test },
        { copy: false },
      ),
    );
    expect(t).toContain('TESTBELEG – KEIN BEWIRTUNGSBELEG');
    expect(t).toContain('Rechnungsnummer: TEST');
    expect(t).toContain('TSE nicht erreichbar');
  });

  it('prints ASCII for the receipt printer', () => {
    const blocks = printableBlocks(hospitalityBlocks(record, { copy: false }));
    const t = blocksToText(blocks);
    expect(t).toContain('Hoehe der Aufwendungen: 27,00 EUR');
    expect(t).toContain('Industriestrasse 12');
    // QR-Inhalt bleibt unveraendert.
    expect(blocks.find((b) => b.type === 'qr')).toMatchObject({
      value: 'V0;OE-1;...',
    });
    for (const b of blocks) {
      if (b.type === 'qr') continue;
      expect(JSON.stringify(b)).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});

describe('HospitalityReceiptsService.issue', () => {
  beforeAll(() => {
    jest.useFakeTimers({
      now: new Date('2026-11-12T10:00:00Z'),
      advanceTimers: true,
    });
  });
  afterAll(() => jest.useRealTimers());

  function setup(
    options: {
      total?: number;
      issuer?: Partial<HospitalityIssuer>;
      items?: { quantity: number; name: string; total: number }[];
      existing?: { id: string; orders: string[] } | null;
    } = {},
  ) {
    const total = options.total ?? 12;
    const documents = [
      doc({
        total,
        items: options.items ?? [{ quantity: 1, name: 'Bratwurst', total }],
      }),
    ];
    const receipts = {
      documents: jest.fn(() =>
        Promise.resolve({
          organization: {
            id: 'org-1',
            name: 'TSV',
            country: 'DE',
            operatingMode: 'full',
            operatingModeLegacy: true,
            billingAddress: null,
            settings: {
              vatExempt: false,
              legalName: options.issuer?.legalName ?? ISSUER.legalName,
              taxNumber: options.issuer?.taxNumber ?? ISSUER.taxNumber,
              address: {
                street: options.issuer?.street ?? ISSUER.street,
                zip: ISSUER.zip,
                city: ISSUER.city,
                country: 'DE',
              },
            },
          },
          timeZone: 'Europe/Berlin',
          documents,
          payments: [{ providerTransactionId: null }],
        }),
      ),
    };
    const queries: unknown[][] = [];
    const saved: unknown[] = [];
    const manager = {
      create: jest.fn((_e: unknown, row: unknown) => row),
      save: jest.fn((row: unknown) => {
        saved.push(row);
        return Promise.resolve({ ...(row as object), id: 'h-1' });
      }),
      query: jest.fn(() => Promise.resolve([])),
      findOneOrFail: jest.fn(() =>
        Promise.resolve({
          id: 'h-1',
          number: 'B-2026-0001',
          isTest: false,
          issuedAt: new Date(),
          serviceDate: '2026-11-11',
          recipientName: null,
          total: String(total),
          tip: '0',
        }),
      ),
    };
    const dataSource = {
      query: jest.fn((sql: string, params: unknown[]) => {
        queries.push([sql, params]);
        if (sql.includes('SELECT DISTINCT hospitality_receipt_id')) {
          return Promise.resolve(
            options.existing
              ? [{ hospitality_receipt_id: options.existing.id }]
              : [],
          );
        }
        if (sql.includes('SELECT order_id FROM hospitality_receipt_orders')) {
          return Promise.resolve(
            (options.existing?.orders ?? []).map((order_id) => ({ order_id })),
          );
        }
        return Promise.resolve([]);
      }),
      transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)),
    };
    const repository = {
      findOne: jest.fn(() =>
        Promise.resolve({
          id: options.existing?.id,
          number: 'B-2026-0007',
          isTest: false,
          issuedAt: new Date(),
          serviceDate: '2026-11-11',
          recipientName: null,
          total: '12',
          tip: '0',
        }),
      ),
    };
    const service = new HospitalityReceiptsService(
      repository as never,
      { count: jest.fn(() => Promise.resolve(0)) } as never,
      dataSource as never,
      receipts as unknown as ReceiptsService,
      {} as never,
    );
    const actor = { organizationId: 'org-1', deviceId: 'dev-1', userId: null };
    return { service, actor, saved, manager };
  }

  it('issues a receipt with the default service date', async () => {
    const { service, actor, saved } = setup();
    const result = await service.issue(actor, { orderIds: ['o-1'] });
    expect(result.existing).toBe(false);
    expect(result.receipt.number).toBe('B-2026-0001');
    const row = saved[0] as {
      serviceDate: string;
      total: string;
      snapshot: { issuer: HospitalityIssuer };
    };
    expect(row.serviceDate).toBe('2026-11-11');
    expect(row.total).toBe('12.00');
    expect(row.snapshot.issuer.taxNumber).toBe('12/345/67890');
  });

  it('requires the host above 250 €', async () => {
    const { service, actor } = setup({ total: 250.01 });
    await expect(
      service.issue(actor, { orderIds: ['o-1'] }),
    ).rejects.toMatchObject({
      response: { reason: 'HOSPITALITY_RECIPIENT_REQUIRED' },
    });
    await expect(
      setup({ total: 250 }).service.issue(actor, { orderIds: ['o-1'] }),
    ).resolves.toMatchObject({ existing: false });
    await expect(
      setup({ total: 300 }).service.issue(actor, {
        orderIds: ['o-1'],
        recipientName: 'Muster GmbH',
      }),
    ).resolves.toMatchObject({ existing: false });
  });

  it('refuses without the club master data', async () => {
    const { service, actor } = setup({ issuer: { legalName: '', street: '' } });
    await expect(
      service.issue(actor, { orderIds: ['o-1'] }),
    ).rejects.toMatchObject({
      response: {
        code: 'HOSPITALITY_MASTER_DATA_REQUIRED',
        params: { missing: 'legalName,street' },
      },
    });
    const noTax = setup({ total: 300, issuer: { taxNumber: '' } });
    await expect(
      noTax.service.issue(noTax.actor, {
        orderIds: ['o-1'],
        recipientName: 'X',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'HOSPITALITY_MASTER_DATA_REQUIRED',
        params: { missing: 'taxNumber' },
      },
    });
  });

  it('refuses collective item names', async () => {
    const { service, actor } = setup({
      items: [{ quantity: 1, name: 'Speisen und Getränke', total: 12 }],
    });
    await expect(
      service.issue(actor, { orderIds: ['o-1'] }),
    ).rejects.toMatchObject({
      response: { code: 'HOSPITALITY_ITEMS_NOT_SPECIFIC' },
    });
  });

  it('checks the service date range', async () => {
    const { service, actor } = setup();
    await expect(
      service.issue(actor, { orderIds: ['o-1'], serviceDate: '2026-11-01' }),
    ).rejects.toMatchObject({
      response: { reason: 'HOSPITALITY_SERVICE_DATE_INVALID' },
    });
    await expect(
      service.issue(actor, { orderIds: ['o-1'], serviceDate: '2026-11-10' }),
    ).resolves.toMatchObject({ existing: false });
  });

  it('returns an existing receipt for the same orders and refuses overlaps', async () => {
    const same = setup({ existing: { id: 'h-7', orders: ['o-1'] } });
    await expect(
      same.service.issue(same.actor, { orderIds: ['o-1'] }),
    ).resolves.toMatchObject({
      existing: true,
      receipt: { number: 'B-2026-0007' },
    });
    const overlap = setup({ existing: { id: 'h-7', orders: ['o-1', 'o-2'] } });
    await expect(
      overlap.service.issue(overlap.actor, { orderIds: ['o-1'] }),
    ).rejects.toMatchObject({
      response: { code: 'HOSPITALITY_RECEIPT_EXISTS' },
    });
  });
});
