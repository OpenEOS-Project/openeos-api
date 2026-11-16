import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../config/where-values';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  CashPointClosing,
  Category,
  Event,
  OnlineOrderSession,
  Order,
  OrderEvent,
  OrderItem,
  Organization,
  Payment,
  Product,
  QrCode,
  Refund,
  ShopCheckout,
  TseTransaction,
  TseUnit,
  User,
  UserOrganization,
} from '../../database/entities';
import type { CronLockService } from '../../common/redis/cron-lock.service';
import { EventsShopCheckoutController } from '../events/events-shop-checkout.controller';
import { OnlinePaymentMethod } from '../online-orders/dto';
import { OnlineOrdersService } from '../online-orders/online-orders.service';
import { SumUpApiService } from '../sumup/sumup-api.service';
import { SumUpService } from '../sumup/sumup.service';
import { OrderHistoryService } from '../refunds/order-history.service';
import { RefundsService, type RefundActor } from '../refunds/refunds.service';
import { clientIdForOrganization } from '../tse/tse-process-data';
import { TseSigningService } from '../tse/tse-signing.service';
import { rowsOf } from '../tse/tse-sql.util';
import type { TseConfig } from '../tse/tse.config';
import type { TseUnitService } from '../tse/tse-unit.service';
import { CashPointClosingService } from './cash-point-closing.service';
import { parseCsv } from './dsfinvk-format';
import { validateZip } from './dsfinvk-validator';
import { readZip } from './dsfinvk-zip';

/**
 * Online-Vorkasse mit Cloud-TSE (Steuerberater 2026-11-10, Frage 20) gegen
 * ein echtes Postgres: die bezahlte Shop-Bestellung wird mit dem echten
 * TseSigningService (Swissbit gestellt) als Kassenbeleg signiert, die
 * Erstattung als Gegenbeleg mit Verweis; beides landet im Kassenabschluss
 * und im DSFinV-K-Export (ZAHLART_TYP `ElZahlungsdienstleister`), den die
 * eigene Pruefung ohne Fehler abnimmt. Nur mit Wegwerf-Datenbank, z. B.
 *
 *   TEST_DSFINVK_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:55470/openeos_online_test pnpm test online-prepayment.db
 *
 * (`TEST_ORDERS_DATABASE_URL` geht auch). Name muss auf `_test` oder
 * `_scratch` enden. Mit `DSFINVK_SPEC_ZIP_DIR=<ordner>` bleibt der Export
 * fuer `pnpm dsfinvk:validate <zip>` liegen.
 */
const TEST_DB =
  process.env.TEST_DSFINVK_DATABASE_URL ?? process.env.TEST_ORDERS_DATABASE_URL;

type Row = Record<string, string | null>;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('Online prepayment with Cloud-TSE against Postgres', () => {
  let ds: DataSource;
  let exportDir: string;
  let closings: CashPointClosingService;
  let signing: TseSigningService;
  let refunds: RefundsService;
  const orgIds: string[] = [];
  const admin = { id: randomUUID(), isSuperAdmin: true } as User;
  const print = {
    handleOrderCreated: jest.fn(() => Promise.resolve()),
    handlePaymentReceived: jest.fn(() => Promise.resolve()),
    printRefundReceipt: jest.fn(() => Promise.resolve(true)),
    printCancellationTickets: jest.fn(() => Promise.resolve()),
  };
  const gateway = {
    notifyOrderCreated: jest.fn(),
    notifyOrderUpdated: jest.fn(),
    notifyOrderItemStatusChanged: jest.fn(),
    notifyKitchenOrderCancelled: jest.fn(),
    notifyProductUpdated: jest.fn(),
    sendOpenCashDrawer: jest.fn(),
  };
  const sql = async (text: string, params: unknown[] = []): Promise<Row[]> =>
    rowsOf<Row>(await ds.query(text, params));

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name))
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    ds = new DataSource({
      invalidWhereValuesBehavior: INVALID_WHERE_VALUES_BEHAVIOR,
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();
    exportDir = mkdtempSync(path.join(tmpdir(), 'dsfinvk-online-'));

    // Swissbit gestellt: fortlaufende Transaktionsnummern und Zaehler.
    let counter = 100;
    const response = () => ({
      value: {
        transactionNumber: counter,
        signatureCreationTime: Math.floor(Date.now() / 1000),
        signatureCounter: ++counter,
        signatureValue: Buffer.from(`sig-${counter}`).toString('base64'),
      },
      requestId: `req-${counter}`,
      durationMs: 1,
    });
    const client = {
      startTransaction: jest.fn(() => Promise.resolve(response())),
      finishTransaction: jest.fn(() => Promise.resolve(response())),
    };
    signing = new TseSigningService(
      ds.getRepository(TseTransaction),
      ds.getRepository(TseUnit),
      ds.getRepository(Payment),
      ds.getRepository(Order),
      ds.getRepository(Organization),
      // Aktive TSE aus der Datenbank, wie TseUnitCache sie liefert.
      {
        get: async (organizationId: string) => {
          const unit = await ds
            .getRepository(TseUnit)
            .findOneBy({ organizationId, state: 'active' } as never);
          return unit
            ? {
                unit,
                credentials: {
                  serialNumber: unit.serialNumber,
                  accessToken: 't',
                },
              }
            : null;
        },
        invalidate: jest.fn(),
      } as never,
      { client } as never,
      {
        recordFailure: jest.fn(() => Promise.resolve()),
        recordSuccess: jest.fn(() => Promise.resolve()),
      } as never,
      {
        settings: {
          timeouts: { transactionMs: 5000, signBudgetMs: 8000, adminMs: 15000 },
        },
      } as never,
    );
    closings = new CashPointClosingService(
      ds,
      ds.getRepository(CashPointClosing),
      ds.getRepository(Organization),
      {
        assertAdmin: async (id: string) =>
          ds.getRepository(Organization).findOneByOrFail({ id }),
        audit: jest.fn(),
      } as unknown as TseUnitService,
      { settings: { exportDir } } as unknown as TseConfig,
      {
        runExclusive: async (_n: string, job: () => Promise<void>) => {
          await job();
          return true;
        },
      } as unknown as CronLockService,
    );
    refunds = new RefundsService(
      ds,
      ds.getRepository(UserOrganization),
      ds.getRepository(Refund),
      ds.getRepository(OrderEvent),
      ds.getRepository(Order),
      { refundTransaction: jest.fn() } as never,
      print as never,
      gateway as never,
      new OrderHistoryService(
        ds.getRepository(Order),
        ds.getRepository(OrderItem),
        ds.getRepository(Payment),
        ds.getRepository(Refund),
        ds.getRepository(OrderEvent),
      ),
      signing,
    );
  }, 120_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) {
      if (orgIds.length) {
        // Abschluesse sind absichtlich nicht loeschbar — fuer den Testabbau
        // den Schutz kurz aussetzen.
        await sql(
          `ALTER TABLE cash_point_closings DISABLE TRIGGER cash_point_closings_immutable`,
        );
        for (const table of [
          'cash_point_closings',
          'tse_transactions',
          'tse_units',
          'cash_registers',
          'refunds',
          'shop_checkouts',
        ]) {
          await sql(
            `DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`,
            [orgIds],
          );
        }
        await sql(
          `ALTER TABLE cash_point_closings ENABLE TRIGGER cash_point_closings_immutable`,
        );
        await sql(
          `DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await sql(
          `DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await sql(
          `DELETE FROM orders WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(
          `DELETE FROM online_order_sessions WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(
          `DELETE FROM qr_codes WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      await ds.destroy();
    }
    rmSync(exportDir, { recursive: true, force: true });
  });

  /** Verein mit aktiver Cloud-TSE, Shop mit Bratwurst (7 %) und Bier (19 %). */
  async function world() {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await sql(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode, tse_active)
       VALUES ($1, 'TSV Musterdorf e. V.', $2, '123456', $3, 'DE', 'full', true)`,
      [
        orgId,
        `tsv-${orgId}`,
        JSON.stringify({
          currency: 'EUR',
          vatExempt: false,
          taxNumber: '12/345/67890',
          contact: {
            address: 'Sportplatzweg 1',
            zipCode: '12345',
            city: 'Musterdorf',
          },
          sumup: { apiKey: 'sup_sk_test', merchantCode: 'MCODE' },
          integrations: { tse: { enabled: true }, sumup: { enabled: true } },
          legal: {
            imprintUrl: 'https://tsv.example/impressum',
            privacyUrl: 'https://tsv.example/datenschutz',
          },
        }),
      ],
    );
    await sql(
      `INSERT INTO tse_units (organization_id, state, serial_number, product_type, client_id, trigger, public_key,
         signature_algorithm, log_time_format, certificate, activated_at)
       VALUES ($1, 'active', $2, '850007', $3, 'manual', 'BHhWOeisRpPBTGQ1W4VUH95TXx2GARf8e2NYZXJoInjtGqnxJ8sZ3CQpYgjI+LYEmW5A37sLWHsyU7nSJUBemyU=',
               'ecdsa-plain-SHA256', 'unixTime', 'MIIB', now())`,
      [
        orgId,
        randomUUID().replace(/-/g, '').repeat(2),
        clientIdForOrganization(orgId),
      ],
    );
    const [event] = await sql(
      `INSERT INTO events (organization_id, name, status, settings)
       VALUES ($1, 'Sommerfest', 'active', '{"shop": {"enabled": true}}') RETURNING id`,
      [orgId],
    );
    const [category] = await sql(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Grill') RETURNING id`,
      [event.id],
    );
    const [wurst] = await sql(
      `INSERT INTO products (event_id, category_id, name, price, tax_rate)
       VALUES ($1, $2, 'Bratwurst', 4.5, 7) RETURNING id`,
      [event.id, category.id],
    );
    const [bier] = await sql(
      `INSERT INTO products (event_id, category_id, name, price, tax_rate)
       VALUES ($1, $2, 'Bier', 4, 19) RETURNING id`,
      [event.id, category.id],
    );
    return {
      orgId,
      eventId: event.id!,
      wurstId: wurst.id!,
      bierId: bier.id!,
    };
  }

  function shopController(): EventsShopCheckoutController {
    return new EventsShopCheckoutController(
      ds.getRepository(Event),
      ds.getRepository(Organization),
      ds.getRepository(Product),
      ds.getRepository(Category),
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      ds.getRepository(Payment),
      ds.getRepository(ShopCheckout),
      {} as never,
      { sendShopOrderConfirmationEmail: jest.fn() } as never,
      print as never,
      { get: (_k: string, fallback: unknown) => fallback } as never,
      gateway as never,
      undefined,
      signing,
    );
  }

  function rowsIn(zip: Buffer, file: string): Record<string, string>[] {
    const entry = readZip(zip).find((e) => e.name === file)!;
    const [header, ...records] = parseCsv(entry.data.toString('utf8')).records;
    return records.map((r) =>
      Object.fromEntries(header.values.map((h, i) => [h, r.values[i]])),
    );
  }

  function keep(zip: Buffer, name: string): void {
    const dir = process.env.DSFINVK_SPEC_ZIP_DIR;
    if (dir) writeFileSync(path.join(dir, name), zip);
  }

  it('signs the paid shop order as a receipt, the refund as a referenced counter-receipt, and exports both (ElZahlungsdienstleister)', async () => {
    const w = await world();
    const checkoutId = randomUUID();
    await sql(
      `INSERT INTO shop_checkouts (id, organization_id, event_id, email, customer_name, items, total_amount,
         service_fee, fulfillment_type, currency, sumup_checkout_id, sumup_checkout_url, status)
       VALUES ($1, $2, $3, 'gast@example.org', '{"firstName": "Max", "lastName": "Muster"}', $4, 17,
               0, 'counter_pickup', 'EUR', 'sumup-chk-db-1', 'https://pay.sumup.example/x', 'pending')`,
      [
        checkoutId,
        w.orgId,
        w.eventId,
        JSON.stringify([
          {
            productId: w.wurstId,
            name: 'Bratwurst',
            quantity: 2,
            unitPrice: 4.5,
          },
          { productId: w.bierId, name: 'Bier', quantity: 2, unitPrice: 4 },
        ]),
      ],
    );
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'PAID' }),
      } as Response),
    );

    const shop = shopController();
    // Rueckkehrseite und Webhook gleichzeitig, danach noch einmal.
    await Promise.all([
      shop.verifyCheckout(checkoutId),
      shop.checkoutWebhook(checkoutId),
    ]);
    const settled = await shop.verifyCheckout(checkoutId);
    fetchSpy.mockRestore();
    expect(settled.data.status).toBe('paid');

    const [order] = await sql(
      `SELECT o.id, o.payment_status, p.id AS payment_id, p.payment_method
         FROM orders o JOIN payments p ON p.order_id = o.id
        WHERE o.organization_id = $1`,
      [w.orgId],
    );
    expect(order).toMatchObject({
      payment_status: 'paid',
      payment_method: 'sumup_online',
    });

    const receipts = await sql(
      `SELECT id, kind, status, process_type, process_data, payment_id, order_id
         FROM tse_transactions WHERE organization_id = $1`,
      [w.orgId],
    );
    expect(receipts).toEqual([
      expect.objectContaining({
        kind: 'receipt',
        status: 'signed',
        process_type: 'Kassenbeleg-V1',
        // 2 × 4,50 zu 7 %, 2 × 4,00 zu 19 %, unbar.
        process_data: 'Beleg^8.00_9.00_0.00_0.00_0.00^17.00:Unbar',
        payment_id: order.payment_id,
        order_id: order.id,
      }),
    ]);
    // Der Kassenbon bekam die Signatur.
    expect(print.handlePaymentReceived).toHaveBeenCalledTimes(1);
    const printed = (
      print.handlePaymentReceived.mock.calls[0] as unknown as [
        string,
        { tse: { id: string; status: string } | null },
      ]
    )[1];
    expect(printed.tse).toMatchObject({ id: receipts[0].id, status: 'signed' });

    // Erstattung der Online-Zahlung: zurueck an den Anbieter (nie bar),
    // Gegenbeleg mit Verweis auf den Online-Beleg.
    const actor: RefundActor = {
      organizationId: w.orgId,
      deviceId: null,
      deviceName: null,
      userId: null,
      actorName: 'Verwaltung',
      cashDrawerPrinterId: null,
    };
    const outcome = await refunds.createRefund(actor, order.id!, {
      mode: 'amount',
      amount: 4,
      reasonCode: 'other',
    });
    expect(outcome.refunds[0]).toMatchObject({
      paymentMethod: 'sumup_online',
      status: 'manual',
    });
    expect(gateway.sendOpenCashDrawer).not.toHaveBeenCalled();
    const [refundTx] = await sql(
      `SELECT kind, status, process_data, references_tse_transaction_id
         FROM tse_transactions WHERE organization_id = $1 AND kind = 'refund'`,
      [w.orgId],
    );
    expect(refundTx).toMatchObject({
      status: 'signed',
      references_tse_transaction_id: receipts[0].id,
    });
    expect(refundTx.process_data).toMatch(/^Beleg\^.*\^-4\.00:Unbar$/);

    // Kassenabschluss und DSFinV-K-Export.
    const created = await closings.closeUpTo(w.orgId, new Date(), {
      trigger: 'manual',
    });
    expect(created).toHaveLength(1);
    const file = await closings.exportZip(
      w.orgId,
      admin,
      { zFrom: created[0].zNr, zTo: created[0].zNr },
      {},
    );
    keep(file.data, `online-prepayment-${w.orgId.slice(0, 8)}.zip`);
    const result = validateZip(file.data);
    expect(
      result.errors.map((e) => `${e.code} ${e.file ?? ''} ${e.message}`),
    ).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stats).toMatchObject({ closings: 1, transactions: 2 });

    const transactions = rowsIn(file.data, 'transactions.csv');
    expect(transactions.map((t) => t.BON_TYP)).toEqual(['Beleg', 'Beleg']);
    const payments = rowsIn(file.data, 'datapayment.csv');
    expect(payments.map((p) => [p.ZAHLART_TYP, p.BASISWAEH_BETRAG])).toEqual([
      ['ElZahlungsdienstleister', '17,00'],
      ['ElZahlungsdienstleister', '-4,00'],
    ]);
    // Umsatz je Position zum Zeitpunkt der Zahlung (§ 13 Abs. 1 Nr. 1
    // Buchst. a Satz 4 UStG), keine Anzahlung.
    const gvTypes = rowsIn(file.data, 'lines.csv').map((l) => l.GV_TYP);
    expect(gvTypes).toContain('Umsatz');
    expect(gvTypes).not.toContain('Anzahlungseinstellung');
    expect(gvTypes).not.toContain('Anzahlungsaufloesung');
    // Erstattung verweist auf den Online-Beleg.
    expect(rowsIn(file.data, 'references.csv')).toHaveLength(1);
    const closing = rowsIn(file.data, 'cashpointclosing.csv')[0];
    expect(closing).toMatchObject({
      Z_SE_ZAHLUNGEN: '13,00',
      Z_SE_BARZAHLUNGEN: '0,00',
    });
  });

  it('shop service fee: its own line at 19 % in receipt, TSE and DSFinV-K', async () => {
    const w = await world();
    const checkoutId = randomUUID();
    await sql(
      `INSERT INTO shop_checkouts (id, organization_id, event_id, email, items, total_amount,
         service_fee, fulfillment_type, currency, sumup_checkout_id, status)
       VALUES ($1, $2, $3, 'gast@example.org', $4, 9.5, 0.5, 'counter_pickup', 'EUR', 'sumup-chk-db-2', 'pending')`,
      [
        checkoutId,
        w.orgId,
        w.eventId,
        JSON.stringify([
          {
            productId: w.wurstId,
            name: 'Bratwurst',
            quantity: 2,
            unitPrice: 4.5,
          },
        ]),
      ],
    );
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'PAID' }),
      } as Response),
    );
    await shopController().verifyCheckout(checkoutId);
    fetchSpy.mockRestore();

    const [receipt] = await sql(
      `SELECT process_data FROM tse_transactions WHERE organization_id = $1`,
      [w.orgId],
    );
    // Ware 9,00 zu 7 %, die Servicegebuehr 0,50 als eigene Leistung zu 19 %.
    expect(receipt.process_data).toBe(
      'Beleg^0.50_9.00_0.00_0.00_0.00^9.50:Unbar',
    );
    const [order] = await sql(
      `SELECT service_fee, service_fee_tax_rate, tax_total FROM orders WHERE organization_id = $1`,
      [w.orgId],
    );
    // 9,00 × 7/107 = 0,59 + 0,50 × 19/119 = 0,08.
    expect(order).toMatchObject({
      service_fee: '0.50',
      service_fee_tax_rate: '19.00',
      tax_total: '0.67',
    });
    const created = await closings.closeUpTo(w.orgId, new Date(), {
      trigger: 'manual',
    });
    const file = await closings.exportZip(
      w.orgId,
      admin,
      { zFrom: created[0].zNr, zTo: created[0].zNr },
      {},
    );
    keep(file.data, `online-prepayment-fee-${w.orgId.slice(0, 8)}.zip`);
    const result = validateZip(file.data);
    expect(
      result.errors.map((e) => `${e.code} ${e.file ?? ''} ${e.message}`),
    ).toEqual([]);
    expect(
      rowsIn(file.data, 'datapayment.csv').map((p) => p.ZAHLART_TYP),
    ).toEqual(['ElZahlungsdienstleister']);
    // Eigene Position „Servicegebühr“ mit USt-Schluessel 1 (19 %).
    const lines = rowsIn(file.data, 'lines.csv');
    const vat = rowsIn(file.data, 'lines_vat.csv');
    expect(
      lines.map((l) => [
        l.ARTIKELTEXT,
        l.GV_TYP,
        vat.find((v) => v.POS_ZEILE === l.POS_ZEILE)?.UST_SCHLUESSEL,
        vat.find((v) => v.POS_ZEILE === l.POS_ZEILE)?.POS_BRUTTO,
      ]),
    ).toEqual([
      ['Bratwurst', 'Umsatz', '2', '9,00'],
      ['Servicegebühr', 'Umsatz', '1', '0,50'],
    ]);
  });

  it('QR table order paid with Google Pay (SumUp): webhook books, signs and exports it once', async () => {
    const w = await world();
    await sql(
      `INSERT INTO qr_codes (organization_id, event_id, code, type, table_number)
       VALUES ($1, $2, $3, 'table', '7')`,
      [w.orgId, w.eventId, `T7-${w.orgId.slice(0, 8)}`],
    );
    const config = {
      get: (key: string) =>
        key === 'API_PUBLIC_URL' ? 'https://api.example.org' : undefined,
    };
    const qr = new OnlineOrdersService(
      ds.getRepository(OnlineOrderSession),
      ds.getRepository(QrCode),
      ds.getRepository(Product),
      ds.getRepository(Category),
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      ds.getRepository(Organization),
      ds.getRepository(Payment),
      {} as never,
      new SumUpService(
        ds.getRepository(Organization),
        {} as never,
        new SumUpApiService(),
        config as never,
        ds.getRepository(Event),
      ),
      config as never,
      print as never,
      { ...gateway, notifyPaymentReceived: jest.fn() } as never,
      undefined,
      signing,
    );

    // Nachgebauter SumUp: Checkout anlegen, danach Stand abfragen.
    let sumupStatus = 'PENDING';
    let reference = '';
    let returnUrl = '';
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(init.body as string) as Record<
            string,
            string
          >;
          reference = body.checkout_reference;
          returnUrl = body.return_url;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                id: 'chk-qr-1',
                hosted_checkout_url: 'https://pay.sumup.example/chk-qr-1',
              }),
          } as Response);
        }
        expect(String(input)).toContain('/v0.1/checkouts/chk-qr-1');
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: 'chk-qr-1',
              status: sumupStatus,
              amount: 8.5,
              currency: 'EUR',
              checkout_reference: reference,
            }),
        } as Response);
      });
    print.handlePaymentReceived.mockClear();
    print.handleOrderCreated.mockClear();

    const { sessionToken } = await qr.startSession({
      code: `T7-${w.orgId.slice(0, 8)}`,
    });
    await qr.addToCart(sessionToken, { productId: w.wurstId, quantity: 1 });
    await qr.addToCart(sessionToken, { productId: w.bierId, quantity: 1 });
    await qr.submitOrder(sessionToken, {});
    const started = (await qr.initiatePayment(sessionToken, {
      paymentMethod: OnlinePaymentMethod.GOOGLE_PAY,
    })) as { data: { paymentId: string } };
    const paymentId = started.data.paymentId;
    expect(returnUrl).toBe(
      `https://api.example.org/api/public/order/pay/${paymentId}/webhook`,
    );

    // Vor der Zahlung: nichts gebucht, nichts signiert.
    await qr.handleSumUpWebhook(paymentId);
    let [row] = await sql(
      `SELECT p.status, o.payment_status FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1`,
      [paymentId],
    );
    expect(row).toMatchObject({ status: 'pending', payment_status: 'unpaid' });

    // Bezahlt: Webhook und Rueckkehrseite gleichzeitig.
    sumupStatus = 'PAID';
    await Promise.all([
      qr.handleSumUpWebhook(paymentId),
      qr.confirmPayment(sessionToken, paymentId),
      qr.handleSumUpWebhook(paymentId),
    ]);
    fetchSpy.mockRestore();

    [row] = await sql(
      `SELECT p.status, p.payment_method, o.payment_status, o.paid_amount
         FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1`,
      [paymentId],
    );
    expect(row).toMatchObject({
      status: 'captured',
      payment_method: 'google_pay',
      payment_status: 'paid',
      paid_amount: '8.50',
    });
    const receipts = await sql(
      `SELECT kind, status, process_data FROM tse_transactions
        WHERE organization_id = $1 AND payment_id = $2`,
      [w.orgId, paymentId],
    );
    expect(receipts).toEqual([
      expect.objectContaining({
        kind: 'receipt',
        status: 'signed',
        // Bratwurst 4,50 zu 7 %, Bier 4,00 zu 19 %, unbar.
        process_data: 'Beleg^4.00_4.50_0.00_0.00_0.00^8.50:Unbar',
      }),
    ]);
    expect(print.handleOrderCreated).toHaveBeenCalledTimes(1);
    expect(print.handlePaymentReceived).toHaveBeenCalledTimes(1);

    const created = await closings.closeUpTo(w.orgId, new Date(), {
      trigger: 'manual',
    });
    const file = await closings.exportZip(
      w.orgId,
      admin,
      { zFrom: created[0].zNr, zTo: created[0].zNr },
      {},
    );
    keep(file.data, `online-prepayment-qr-${w.orgId.slice(0, 8)}.zip`);
    const result = validateZip(file.data);
    expect(
      result.errors.map((e) => `${e.code} ${e.file ?? ''} ${e.message}`),
    ).toEqual([]);
    expect(
      rowsIn(file.data, 'datapayment.csv').map((p) => [
        p.ZAHLART_TYP,
        p.ZAHLART_NAME,
        p.BASISWAEH_BETRAG,
      ]),
    ).toEqual([['ElZahlungsdienstleister', 'Google Pay', '8,50']]);
  });
});
