import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailService } from '../email/email.service';
import type { OrderPrintService } from '../print-jobs/order-print.service';
import type { TsePrintBlock } from '../tse/tse-view';
import { blocksToText, receiptBlocks } from './receipt-blocks';
import { receiptDocumentFromPayload } from './receipt-document';
import { blocksToHtml } from './receipt-html';
import { receiptMail } from './receipt-mail';
import { renderReceiptPdf } from './receipt-pdf';
import {
  ReceiptsService,
  isPlausibleEmail,
  isReceiptToken,
  newReceiptToken,
  receiptTokenHash,
} from './receipts.service';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { TargetLimitService } from '../../common/rate-limit/target-limit.service';

const TSE: TsePrintBlock = {
  status: 'signed',
  failed: false,
  training: false,
  notice: null,
  process_type: 'Kassenbeleg-V1',
  serial_number: 'a1b2c3d4e5f6',
  client_id: 'OE-1234',
  bon_number: 42,
  transaction_number: 815,
  signature_counter: 4711,
  start_time: '2026-11-11T13:00:00.000Z',
  finish_time: '2026-11-11T13:00:02.000Z',
  signature: 'SIGNATUR==',
  signature_algorithm: 'ecdsa-plain-SHA384',
  log_time_format: 'unixTime',
  public_key: 'PUB',
  qr_code: 'V0;OE-1234;Kassenbeleg-V1;...',
  late_signature: null,
  order_start_time: null,
};

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: 'o-1',
    order_number: '20261111-0007',
    daily_number: 7,
    table_number: 'A5',
    customer_name: 'Erika Mustermann',
    created_at: new Date('2026-11-11T13:00:00Z'),
    waiter_name: 'Tom',
    organization: {
      name: 'TSV Musterdorf',
      address: 'Hauptstr. 1, 12345 Musterdorf',
      phone: '0123',
    },
    items: [
      { quantity: 2, name: 'Bratwurst', total: 7, notes: 'für Erika' },
      { quantity: 1, name: 'Apfelschorle', total: 3, notes: null },
    ],
    subtotal: 10,
    pfand_total: 2,
    discount_amount: 0,
    tax_lines: [{ rate: 19, net: 10.08, tax: 1.92, gross: 12 }],
    total: 12,
    paid_amount: 12,
    change: 8,
    payment_method: 'cash',
    payment_label: 'Bar',
    is_test: false,
    tse: TSE,
    ...over,
  };
}

describe('digital receipt document', () => {
  it('mirrors the printed receipt without guest data', () => {
    const doc = receiptDocumentFromPayload(payload(), { showWaiter: false });
    expect(doc.items).toEqual([
      { quantity: 2, name: 'Bratwurst', total: 7 },
      { quantity: 1, name: 'Apfelschorle', total: 3 },
    ]);
    expect(doc.pfand).toBe(2);
    expect(doc.discount).toBeNull();
    expect(doc.payment).toEqual({
      method: 'cash',
      label: 'Bar',
      paidAmount: 12,
      change: 8,
    });
    expect(doc.waiterName).toBeNull();
    const text = blocksToText(receiptBlocks(doc, 'Europe/Berlin')).replace(
      /\u00a0/g,
      ' ',
    );
    expect(text).not.toContain('Erika');
    expect(text).toContain('Bestellung #20261111-0007');
    expect(text).toContain('Datum: 11.11.2026 14:00');
    expect(text).toContain('Tisch: A5');
    expect(text).toContain('enth. MwSt 19 %: 1,92 €');
    expect(text).toContain('GESAMT: 12,00 €');
    expect(text).toContain('Rückgeld: 8,00 €');
    // TSE-Block wie auf dem Bon
    for (const part of [
      'Kassen-ID: OE-1234',
      'Beleg-Nr.: 42',
      'TSE-Seriennummer: a1b2c3d4e5f6',
      'TSE-Transaktion: 815',
      'Signaturzähler: 4711',
      'Start: 2026-11-11T13:00:00.000Z',
      'Signatur: SIGNATUR==',
    ]) {
      expect(text).toContain(part);
    }
    expect(receiptBlocks(doc).some((b) => b.type === 'qr')).toBe(true);
  });

  it('shows the server only when the receipt template prints it', () => {
    const doc = receiptDocumentFromPayload(payload(), { showWaiter: true });
    expect(blocksToText(receiptBlocks(doc))).toContain('Bedienung: Tom');
  });

  it('marks test orders and training bookings', () => {
    const doc = receiptDocumentFromPayload(
      payload({ is_test: true, tse: { ...TSE, training: true } }),
      { showWaiter: false },
    );
    const text = blocksToText(receiptBlocks(doc));
    expect(text).toContain('*** TESTMODUS ***');
    expect(text).toContain('TRAININGSBUCHUNG – KEIN VERKAUF');
  });

  it('prints the outage notice instead of a signature when the TSE failed', () => {
    const doc = receiptDocumentFromPayload(
      payload({
        tse: {
          ...TSE,
          failed: true,
          status: 'failed',
          signature: null,
          qr_code: null,
        },
      }),
      { showWaiter: false },
    );
    const blocks = receiptBlocks(doc);
    const text = blocksToText(blocks);
    expect(text).toContain('TSE nicht erreichbar');
    expect(text).not.toContain('Signatur:');
    expect(blocks.some((b) => b.type === 'qr')).toBe(false);
  });

  it('has no VAT lines for VAT-exempt clubs and no TSE block without TSE', () => {
    const doc = receiptDocumentFromPayload(
      payload({ tax_lines: undefined, tse: null }),
      {
        showWaiter: false,
      },
    );
    const text = blocksToText(receiptBlocks(doc));
    expect(text).not.toContain('MwSt');
    expect(text).not.toContain('Kassen-ID');
  });

  it('escapes HTML in the mail', () => {
    const doc = receiptDocumentFromPayload(
      payload({
        items: [{ quantity: 1, name: '<script>x</script>', total: 1 }],
      }),
      { showWaiter: false },
    );
    const html = blocksToHtml(receiptBlocks(doc), () => 'cid-1');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('cid:cid-1');
    const mail = receiptMail(
      {
        organizationName: 'TSV <Musterdorf>',
        receipts: [receiptBlocks(doc)],
        label: 'Kassenbeleg',
        linkUrl: 'https://app.example/beleg/abc',
        linkExpiresAt: new Date('2027-02-09T12:00:00Z'),
        imprintUrl: 'https://tsv.example/impressum',
      },
      () => null,
    );
    expect(mail.subject).toBe('Dein Kassenbeleg von TSV <Musterdorf>');
    expect(mail.html).toContain('TSV &lt;Musterdorf&gt;');
    expect(mail.html).toContain('09.02.2027');
    expect(mail.html).toContain('nicht gespeichert');
    expect(mail.text).toContain('https://app.example/beleg/abc');
  });

  it('renders a PDF with one page per receipt', async () => {
    const doc = receiptDocumentFromPayload(payload(), { showWaiter: false });
    const pdf = await renderReceiptPdf(
      [{ blocks: receiptBlocks(doc) }, { blocks: receiptBlocks(doc) }],
      { title: 'Kassenbeleg', author: 'TSV' },
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? [];
    expect(pages).toHaveLength(2);
  });
});

describe('receipt tokens', () => {
  it('are 128 bit random, base64url, and only the hash is stored', () => {
    const tokens = new Set(
      Array.from({ length: 500 }, () => newReceiptToken()),
    );
    expect(tokens.size).toBe(500);
    for (const token of tokens) {
      expect(isReceiptToken(token)).toBe(true);
      expect(Buffer.from(token, 'base64url')).toHaveLength(16);
    }
    const token = [...tokens][0];
    expect(receiptTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptTokenHash(token)).not.toContain(token);
    expect(isReceiptToken('short')).toBe(false);
    expect(isReceiptToken('a'.repeat(21) + '/')).toBe(false);
  });

  it('validates e-mail addresses', () => {
    expect(isPlausibleEmail('gast@example.org')).toBe(true);
    expect(isPlausibleEmail('gast@example')).toBe(false);
    expect(isPlausibleEmail('a b@example.org')).toBe(false);
    expect(isPlausibleEmail(`${'a'.repeat(250)}@example.org`)).toBe(false);
  });
});

describe('ReceiptsService', () => {
  const ORG = {
    id: 'org-1',
    name: 'TSV Musterdorf',
    country: 'DE',
    operatingMode: 'full',
    settings: {
      timezone: 'Europe/Berlin',
      contact: { email: 'kasse@tsv.example' },
      legal: { imprintUrl: 'https://tsv.example/impressum' },
    },
  };
  const ORDER = {
    id: 'o-1',
    orderNumber: '20261111-0007',
    organizationId: 'org-1',
    paymentStatus: 'paid',
  };
  const PAYMENT = {
    id: 'p-1',
    amount: 12,
    paymentMethod: 'cash',
    metadata: { amountReceived: 20 },
  };

  function setup(
    options: {
      org?: Record<string, unknown>;
      payment?: unknown;
      recentMails?: number;
      perOrder?: { orderId: string; n: number }[];
      sendOk?: boolean;
      targetLimits?: TargetLimitService;
    } = {},
  ) {
    const saved: unknown[] = [];
    const links = {
      insert: jest.fn((row: unknown) => {
        saved.push(row);
        return Promise.resolve();
      }),
      findOne: jest.fn(),
      delete: jest.fn(() => Promise.resolve({ affected: 3 })),
    };
    const events = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn((rows: unknown) => {
        saved.push(rows);
        return Promise.resolve(rows);
      }),
      count: jest.fn(() => Promise.resolve(options.recentMails ?? 0)),
      createQueryBuilder: jest.fn(() => {
        const qb = {
          select: () => qb,
          addSelect: () => qb,
          where: () => qb,
          andWhere: () => qb,
          groupBy: () => qb,
          getRawMany: () => Promise.resolve(options.perOrder ?? []),
        };
        return qb;
      }),
    };
    const email = {
      sendEmail: jest.fn((mail: unknown) => {
        void mail;
        return Promise.resolve(options.sendOk ?? true);
      }),
    };
    const print = {
      receiptPayload: jest.fn(() => Promise.resolve(payload())),
    };
    const service = new ReceiptsService(
      links as never,
      { find: jest.fn(() => Promise.resolve([ORDER])) } as never,
      {
        findOne: jest.fn(() =>
          Promise.resolve(
            options.payment === undefined ? PAYMENT : options.payment,
          ),
        ),
      } as never,
      {
        findOne: jest.fn(() => Promise.resolve({ ...ORG, ...options.org })),
      } as never,
      { findOne: jest.fn(() => Promise.resolve(null)) } as never,
      events as never,
      { findOne: jest.fn(() => Promise.resolve(null)) } as never,
      print as unknown as OrderPrintService,
      email as unknown as EmailService,
      { platformLegal: { imprintUrl: null, privacyUrl: null } } as never,
      new ConfigService({ APP_URL: 'https://app.example/' }),
      { forPayment: jest.fn(() => Promise.resolve(null)) } as never,
      options.targetLimits,
    );
    const actor = { organizationId: 'org-1', deviceId: 'dev-1', userId: null };
    return { service, links, events, email, print, saved, actor };
  }

  it('creates a link that expires after 90 days and stores only the token hash', async () => {
    const { service, links, actor, events } = setup();
    const before = Date.now();
    const result = await service.createLink(actor, ['o-1']);
    const token = result.url.split('/beleg/')[1];
    expect(result.url).toBe(`https://app.example/beleg/${token}`);
    expect(isReceiptToken(token)).toBe(true);
    const row = links.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.tokenHash).toBe(receiptTokenHash(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const days = (new Date(result.expiresAt).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(89.99);
    expect(days).toBeLessThan(90.01);
    expect(events.save).toHaveBeenCalled();
  });

  it('refuses receipts in the orders-only mode and without payment', async () => {
    await expect(
      setup({ org: { operatingMode: 'orders_only' } }).service.createLink(
        { organizationId: 'org-1', deviceId: 'd', userId: null },
        ['o-1'],
      ),
    ).rejects.toMatchObject({ response: { code: 'RECEIPT_NOT_AVAILABLE' } });
    await expect(
      setup({ payment: null }).service.createLink(
        { organizationId: 'org-1', deviceId: 'd', userId: null },
        ['o-1'],
      ),
    ).rejects.toMatchObject({ response: { code: 'RECEIPT_NOT_AVAILABLE' } });
  });

  it('sends the receipt by e-mail without storing or logging the address', async () => {
    const { service, actor, email, saved } = setup();
    await service.sendEmail(actor, ['o-1'], ' Gast@Example.org ');
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    const mail = email.sendEmail.mock.calls[0][0] as Record<string, unknown> & {
      attachments: { filename: string; contentType: string }[];
    };
    expect(mail.to).toBe('Gast@Example.org');
    expect(mail.redactRecipient).toBe(true);
    expect(mail.fromName).toBe('TSV Musterdorf');
    expect(mail.replyTo).toBe('kasse@tsv.example');
    expect(mail.attachments[0]).toMatchObject({
      filename: 'Beleg-20261111-0007.pdf',
      contentType: 'application/pdf',
    });
    // Nichts, was gespeichert wurde, enthaelt die Adresse (auch nicht klein).
    const stored = JSON.stringify(saved).toLowerCase();
    expect(stored).not.toContain('gast@example.org');
    expect(stored).toContain('receipt_emailed');
    expect(stored).toContain('"status":"sent"');
  });

  it('records a failed send without the address and reports 502', async () => {
    const { service, actor, saved } = setup({ sendOk: false });
    await expect(
      service.sendEmail(actor, ['o-1'], 'gast@example.org'),
    ).rejects.toMatchObject({
      response: { code: 'RECEIPT_EMAIL_FAILED' },
    });
    const stored = JSON.stringify(saved);
    expect(stored).toContain('"status":"failed"');
    expect(stored).not.toContain('gast@example.org');
  });

  it('limits e-mails per device and per order', async () => {
    const perDevice = setup({ recentMails: 30 });
    const err = await perDevice.service
      .sendEmail(perDevice.actor, ['o-1'], 'gast@example.org')
      .catch((e: HttpException) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(perDevice.email.sendEmail).not.toHaveBeenCalled();

    const perOrder = setup({ perOrder: [{ orderId: 'o-1', n: 5 }] });
    await expect(
      perOrder.service.sendEmail(perOrder.actor, ['o-1'], 'gast@example.org'),
    ).rejects.toMatchObject({
      response: { code: 'RECEIPT_EMAIL_RATE_LIMITED' },
    });
  });

  it('limits e-mails per recipient address across tills', async () => {
    const storage = new ThrottlerStorageService();
    const targetLimits = new TargetLimitService(storage);
    const { service, actor, email } = setup({ targetLimits });
    for (let i = 0; i < 10; i += 1) {
      await service.assertMailAllowed(
        { ...actor, deviceId: `dev-${i}` },
        ['o-1'],
        'gast@example.org',
      );
    }
    const err = await service
      .sendEmail(actor, ['o-1'], 'Gast@example.org')
      .catch((e: HttpException) => e);
    storage.onApplicationShutdown();

    expect((err as HttpException).getStatus()).toBe(429);
    expect(err).toMatchObject({
      response: { code: 'RECEIPT_EMAIL_RATE_LIMITED' },
    });
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('rejects invalid addresses before anything else', async () => {
    const { service, actor, email, events } = setup();
    await expect(
      service.sendEmail(actor, ['o-1'], 'kein-at'),
    ).rejects.toMatchObject({
      response: { reason: 'RECEIPT_EMAIL_INVALID' },
    });
    expect(events.count).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('answers unknown, malformed and expired tokens with 404', async () => {
    const { service, links } = setup();
    await expect(service.publicView('../etc')).rejects.toMatchObject({
      response: { code: 'RECEIPT_LINK_NOT_FOUND' },
    });
    expect(links.findOne).not.toHaveBeenCalled();
    links.findOne.mockResolvedValueOnce(null);
    await expect(service.publicView(newReceiptToken())).rejects.toMatchObject({
      response: { code: 'RECEIPT_LINK_NOT_FOUND' },
    });
  });

  it('shows the receipt for a valid token, without guest data', async () => {
    const { service, links } = setup();
    links.findOne.mockResolvedValueOnce({
      organizationId: 'org-1',
      orderIds: ['o-1'],
      expiresAt: new Date(Date.now() + 1000),
    });
    const view = await service.publicView(newReceiptToken());
    expect(view.organizationName).toBe('TSV Musterdorf');
    expect(view.receipts).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain('Erika');
    expect(view.legal.imprintUrl).toBe('https://tsv.example/impressum');
  });

  it('turns a link to a deleted order into 404', async () => {
    const { service, links } = setup({ payment: null });
    links.findOne.mockResolvedValueOnce({
      organizationId: 'org-1',
      orderIds: ['o-1'],
      expiresAt: new Date(Date.now() + 1000),
    });
    await expect(service.publicView(newReceiptToken())).rejects.toMatchObject({
      response: { code: 'RECEIPT_LINK_NOT_FOUND' },
    });
  });
});
