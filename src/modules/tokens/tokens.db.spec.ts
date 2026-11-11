import { randomUUID } from 'crypto';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CashbookEntry,
  Category,
  Device,
  Order,
  OrderEvent,
  OrderItem,
  Organization,
  Payment,
  PfandReturn,
  PrintJob,
  Printer,
  Product,
  Refund,
  StockMovement,
  TokenTransaction,
  TokenType,
  User,
  UserOrganization,
} from '../../database/entities';
import { resetTseStatus, tseStatus } from '../../common/utils/tse.util';
import { CashbookService, ALL_DEVICES } from '../dsfinvk/cashbook.service';
import { businessDateOf } from '../dsfinvk/dsfinvk-master';
import type { GatewayService } from '../gateway/gateway.service';
import { PaymentsBatchService } from '../payments/payments-batch.service';
import type { OrderPrintService } from '../print-jobs/order-print.service';
import { OrderHistoryService } from '../refunds/order-history.service';
import { RefundsService } from '../refunds/refunds.service';
import { ReportsService } from '../reports/reports.service';
import type { SumUpApiService } from '../sumup/sumup-api.service';
import type { TseSigningService } from '../tse/tse-signing.service';
import { WaiterSettlementsService } from '../waiters/waiter-settlements.service';
import { TokenTransactionsService } from './token-transactions.service';
import { TokenTypesService } from './token-types.service';

/**
 * Wertmarken gegen ein echtes Postgres: Markentypen (Einzweck-Pruefung,
 * Sperre nach Gebrauch), Verkauf/Ruecktausch (Nummer, Betriebsart, Bestand),
 * Einloesung beim Kassieren (Split mit Bar, Ueberzahlung, Artikelauswahl),
 * Rueckgabe bei Storno, Kassenbuch, Kellnerabrechnung, Berichte.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5544/openeos_tokens_scratch pnpm test tokens.db
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('Wertmarken against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const gateway = {
    sendOpenCashDrawer: jest.fn(),
    notifyOrderUpdated: jest.fn(),
    notifyPaymentReceived: jest.fn(),
    notifyOrderItemStatusChanged: jest.fn(),
    notifyKitchenOrderCancelled: jest.fn(),
    notifyProductUpdated: jest.fn(),
  };
  const print = {
    autoPrintsReceipts: jest.fn(() => Promise.resolve(false)),
    printTokenReceipt: jest.fn(() => Promise.resolve(true)),
    handlePaymentReceived: jest.fn(() => Promise.resolve(true)),
    printRefundReceipt: jest.fn(() => Promise.resolve(true)),
    printCancellationTickets: jest.fn(() => Promise.resolve()),
  };
  const tse = {
    signTokenTransaction: jest.fn(() => Promise.resolve(null)),
    forTokenTransaction: jest.fn(() => Promise.resolve(null)),
  };
  let types: TokenTypesService;
  let txs: TokenTransactionsService;
  let batch: PaymentsBatchService;
  let refunds: RefundsService;
  let cashbook: CashbookService;
  let settlements: WaiterSettlementsService;
  let reports: ReportsService;
  const userId = randomUUID();
  const user = { id: userId } as User;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    }
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();
    await ds.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name)
       VALUES ($1, $2, 'x', 'Kim', 'Kasse')`,
      [userId, `marken-${userId}@example.org`],
    );
    types = new TokenTypesService(
      ds.getRepository(TokenType),
      ds.getRepository(UserOrganization),
    );
    txs = new TokenTransactionsService(
      ds.getRepository(TokenTransaction),
      ds.getRepository(TokenType),
      ds.getRepository(UserOrganization),
      gateway as unknown as GatewayService,
      tse as unknown as TseSigningService,
      undefined,
      print as unknown as OrderPrintService,
    );
    batch = new PaymentsBatchService(
      ds,
      gateway as unknown as GatewayService,
      print as unknown as OrderPrintService,
    );
    const history = new OrderHistoryService(
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      ds.getRepository(Payment),
      ds.getRepository(Refund),
      ds.getRepository(OrderEvent),
    );
    refunds = new RefundsService(
      ds,
      ds.getRepository(UserOrganization),
      ds.getRepository(Refund),
      ds.getRepository(OrderEvent),
      ds.getRepository(Order),
      {} as SumUpApiService,
      print as unknown as OrderPrintService,
      gateway as unknown as GatewayService,
      history,
    );
    cashbook = new CashbookService(
      ds,
      ds.getRepository(CashbookEntry),
      ds.getRepository(Organization),
      {} as TseSigningService,
    );
    settlements = new WaiterSettlementsService(ds);
    reports = new ReportsService(
      ds.getRepository(Order),
      ds.getRepository(OrderItem),
      ds.getRepository(Payment),
      ds.getRepository(Product),
      ds.getRepository(Category),
      ds.getRepository(StockMovement),
      ds.getRepository(PfandReturn),
      ds.getRepository(UserOrganization),
      ds.getRepository(Device),
      ds.getRepository(Printer),
      ds.getRepository(PrintJob),
      { get: () => undefined } as never,
      ds.getRepository(Organization),
    );
  }, 120_000);

  afterAll(async () => {
    resetTseStatus();
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await ds.query(
          `DELETE FROM token_transactions WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      await ds.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await ds.destroy();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetTseStatus();
  });

  async function q<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return await ds.query(sql, params);
  }

  interface World {
    orgId: string;
    eventId: string;
    deviceId: string;
    waiterId: string;
    getraenke: string;
    speisen: string;
    bier: string;
    wurst: string;
  }

  async function world(
    options: {
      country?: string;
      mode?: 'full' | 'cashless' | 'orders_only';
      vatExempt?: boolean;
      legacy?: boolean;
    } = {},
  ): Promise<World> {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await q(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country,
         operating_mode, operating_mode_legacy)
       VALUES ($1, 'Verein', $2, '123456', $3, $4, $5, $6)`,
      [
        orgId,
        `verein-${orgId}`,
        JSON.stringify({ vatExempt: options.vatExempt ?? false }),
        options.country ?? 'AT',
        options.mode ?? 'full',
        options.legacy === true,
      ],
    );
    await q(
      `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`,
      [userId, orgId],
    );
    const [event] = await q<{ id: string }>(
      `INSERT INTO events (organization_id, name, status) VALUES ($1, 'Fest', 'active') RETURNING id`,
      [orgId],
    );
    const [getraenke] = await q<{ id: string }>(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Getränke') RETURNING id`,
      [event.id],
    );
    const [speisen] = await q<{ id: string }>(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Speisen') RETURNING id`,
      [event.id],
    );
    const [bier] = await q<{ id: string }>(
      `INSERT INTO products (event_id, category_id, name, price, tax_rate)
       VALUES ($1, $2, 'Bier', 4, 19) RETURNING id`,
      [event.id, getraenke.id],
    );
    const [wurst] = await q<{ id: string }>(
      `INSERT INTO products (event_id, category_id, name, price, tax_rate)
       VALUES ($1, $2, 'Wurst', 3, 7) RETURNING id`,
      [event.id, speisen.id],
    );
    const [device] = await q<{ id: string }>(
      `INSERT INTO devices (organization_id, name, type, device_token, settings)
       VALUES ($1, 'Zentralkasse', 'pos', $2, '{}') RETURNING id`,
      [orgId, `tok-${randomUUID()}`],
    );
    const [waiter] = await q<{ id: string }>(
      `INSERT INTO waiters (organization_id, name) VALUES ($1, 'Sam') RETURNING id`,
      [orgId],
    );
    return {
      orgId,
      eventId: event.id,
      deviceId: device.id,
      waiterId: waiter.id,
      getraenke: getraenke.id,
      speisen: speisen.id,
      bier: bier.id,
      wurst: wurst.id,
    };
  }

  let daily = 0;
  /** Unbezahlte Bestellung: `beer` x Bier (4 €, 19 %) + `sausage` x Wurst (3 €, 7 %). */
  async function order(
    w: World,
    beer: number,
    sausage: number,
    pfand = 0,
  ): Promise<string> {
    daily += 1;
    const subtotal = beer * 4 + sausage * 3;
    const total = subtotal + pfand * beer;
    const [o] = await q<{ id: string }>(
      `INSERT INTO orders (organization_id, event_id, order_number, daily_number,
         subtotal, pfand_total, total, paid_amount, payment_status, status, created_by_device_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'unpaid', 'in_progress', $8) RETURNING id`,
      [
        w.orgId,
        w.eventId,
        `20261111-${String(daily).padStart(4, '0')}`,
        daily,
        subtotal,
        pfand * beer,
        total,
        w.deviceId,
      ],
    );
    if (beer) {
      await q(
        `INSERT INTO order_items (order_id, product_id, category_id, product_name, category_name,
           quantity, unit_price, tax_rate, total_price, status, deposit_amount, deposit_tax_rate, sort_order)
         VALUES ($1, $2, $3, 'Bier', 'Getränke', $4, 4, 19, $5, 'delivered', $6, 19, 0)`,
        [o.id, w.bier, w.getraenke, beer, beer * 4, pfand],
      );
    }
    if (sausage) {
      await q(
        `INSERT INTO order_items (order_id, product_id, category_id, product_name, category_name,
           quantity, unit_price, tax_rate, total_price, status, sort_order)
         VALUES ($1, $2, $3, 'Wurst', 'Speisen', $4, 3, 7, $5, 'delivered', 1)`,
        [o.id, w.wurst, w.speisen, sausage, sausage * 3],
      );
    }
    return o.id;
  }

  async function marke(
    w: World,
    overrides: Partial<Parameters<TokenTypesService['create']>[1]> = {},
  ) {
    return types.create(
      w.orgId,
      { name: '2-€-Marke', value: 2, buybackAllowed: true, ...overrides },
      user,
    );
  }

  const attribution = (w: World) => ({
    waiterId: w.waiterId,
    userId: null,
    name: 'Sam',
  });

  // ---------------------------------------------------------- Markentypen

  it('token types: Mehrzweck by default, Einzweck only with exactly one rate, locked once in use', async () => {
    const w = await world();
    const multi = await marke(w);
    expect(multi).toMatchObject({ kind: 'multi_purpose', vatRate: null });

    // Einzweck fuer alle 19-%-Artikel: ok.
    const drinks = await types.create(
      w.orgId,
      { name: 'Getränkemarke', value: 3, kind: 'single_purpose', vatRate: 19 },
      user,
    );
    expect(Number(drinks.vatRate)).toBe(19);
    // Einzweck fuer Getraenke + Speisen (19 % und 7 %): abgelehnt.
    await expect(
      types.create(
        w.orgId,
        {
          name: 'Festmarke',
          value: 2,
          kind: 'single_purpose',
          vatRate: 19,
          eventId: w.eventId,
          allowedCategoryIds: [w.getraenke, w.speisen],
        },
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: 'TOKEN_SINGLE_PURPOSE_MIXED_RATES' },
    });
    // Artikelauswahl nur mit Veranstaltung.
    await expect(
      types.create(
        w.orgId,
        { name: 'Bier-Marke', value: 4, allowedProductIds: [w.bier] },
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: 'TOKEN_RESTRICTION_REQUIRES_EVENT' },
    });
    // Einzweck nur Getraenke-Kategorie (alle 19 %): ok.
    await types.create(
      w.orgId,
      {
        name: 'Getränke-Kategorie',
        value: 3,
        kind: 'single_purpose',
        vatRate: 19,
        eventId: w.eventId,
        allowedCategoryIds: [w.getraenke],
      },
      user,
    );

    // Verkauft → Nennwert/Art fest, Loeschen gesperrt, Name aenderbar.
    await txs.sell(w.orgId, {
      eventId: w.eventId,
      paymentMethod: 'cash',
      lines: [{ tokenTypeId: multi.id, count: 1 }],
    });
    await expect(
      types.update(w.orgId, multi.id, { value: 2.5 }, user),
    ).rejects.toMatchObject({ response: { reason: 'TOKEN_TYPE_LOCKED' } });
    await expect(types.remove(w.orgId, multi.id, user)).rejects.toMatchObject({
      response: { reason: 'TOKEN_TYPE_IN_USE' },
    });
    const renamed = await types.update(
      w.orgId,
      multi.id,
      { name: 'Festmarke 2 €', color: '#f59e0b' },
      user,
    );
    expect(renamed).toMatchObject({ name: 'Festmarke 2 €', inUse: true });
    // Unbenutzt: loeschbar.
    await types.remove(w.orgId, drinks.id, user);
  });

  it('Kleinunternehmer: no Einzweck tokens', async () => {
    const w = await world({ vatExempt: true });
    await expect(
      types.create(
        w.orgId,
        {
          name: 'Getränkemarke',
          value: 3,
          kind: 'single_purpose',
          vatRate: 19,
        },
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: 'TOKEN_SINGLE_PURPOSE_SMALL_BUSINESS' },
    });
  });

  // ------------------------------------------------------- Betriebsart

  it('mode guards: only „Alle Funktionen“; in Germany only with an active Cloud-TSE (also for legacy orgs)', async () => {
    for (const [options, code] of [
      [{ mode: 'cashless' as const }, 'CASH_PAYMENTS_DISABLED'],
      [{ mode: 'orders_only' as const }, 'ORDER_ONLY_MODE'],
      [{ country: 'DE' }, 'TSE_REQUIRED_FOR_TOKENS'],
      [{ country: 'DE', legacy: true }, 'TSE_REQUIRED_FOR_TOKENS'],
    ] as const) {
      const w = await world(options);
      const t = await marke(w);
      await expect(
        txs.sell(w.orgId, {
          paymentMethod: 'card',
          lines: [{ tokenTypeId: t.id, count: 1 }],
        }),
      ).rejects.toMatchObject({ response: { code } });
      const o = await order(w, 1, 0);
      await expect(
        batch.payBatch(w.orgId, w.deviceId, {
          orderIds: [o],
          paymentMethod: 'tokens' as never,
          tokens: [{ tokenTypeId: t.id, count: 2 }],
        }),
      ).rejects.toMatchObject({ response: { code } });
      // Die Kasse bekommt keine Markentypen angeboten.
      expect(await types.findForDevice(w.orgId, w.eventId)).toEqual([]);
    }
    // Deutschland mit aktiver TSE: erlaubt.
    tseStatus.isActive = () => true;
    const de = await world({ country: 'DE' });
    const t = await marke(de);
    expect(await types.findForDevice(de.orgId, de.eventId)).toHaveLength(1);
    const sold = await txs.sell(de.orgId, {
      paymentMethod: 'card',
      lines: [{ tokenTypeId: t.id, count: 1 }],
    });
    expect(sold.kind).toBe('sale');
  });

  // ---------------------------------------------- Verkauf und Ruecktausch

  it('sale and Rücktausch: numbers, cash book, outstanding stock, idempotent retry', async () => {
    const w = await world();
    const t = await marke(w);
    const noBuyback = await marke(w, {
      name: '5-€-Marke',
      value: 5,
      buybackAllowed: false,
    });
    const requestId = randomUUID();
    const sale = await txs.sell(
      w.orgId,
      {
        eventId: w.eventId,
        paymentMethod: 'cash',
        amountReceived: 50,
        clientRequestId: requestId,
        lines: [
          { tokenTypeId: t.id, count: 20 },
          { tokenTypeId: noBuyback.id, count: 1 },
        ],
      },
      {
        deviceId: w.deviceId,
        waiterId: w.waiterId,
        cashDrawerPrinterId: 'drawer',
      },
    );
    expect(sale.transactionNumber).toMatch(/^W-\d{8}-0001$/);
    expect(Number(sale.totalAmount)).toBe(45);
    expect(sale.taxLines).toEqual([]);
    expect(gateway.sendOpenCashDrawer).toHaveBeenCalledWith(w.orgId, 'drawer');
    expect(tse.signTokenTransaction).toHaveBeenCalledTimes(1);
    // Wiederholung nach Netzfehler: derselbe Vorgang.
    const again = await txs.sell(w.orgId, {
      eventId: w.eventId,
      paymentMethod: 'cash',
      clientRequestId: requestId,
      lines: [{ tokenTypeId: t.id, count: 20 }],
    });
    expect(again.id).toBe(sale.id);

    // Unveraenderlich.
    await expect(
      q(`UPDATE token_transactions SET total_amount = 1 WHERE id = $1`, [
        sale.id,
      ]),
    ).rejects.toThrow(/immutable/);

    // Ruecktausch: nur erlaubte Typen, hoechstens der Bestand.
    await expect(
      txs.buyback(w.orgId, {
        lines: [{ tokenTypeId: noBuyback.id, count: 1 }],
      }),
    ).rejects.toMatchObject({
      response: { reason: 'TOKEN_BUYBACK_NOT_ALLOWED' },
    });
    await expect(
      txs.buyback(w.orgId, { lines: [{ tokenTypeId: t.id, count: 21 }] }),
    ).rejects.toMatchObject({
      response: {
        reason: 'TOKEN_BUYBACK_EXCEEDS_OUTSTANDING',
        params: { max: 20 },
      },
    });
    const back = await txs.buyback(
      w.orgId,
      {
        eventId: w.eventId,
        reason: 'Ende des Festes',
        lines: [{ tokenTypeId: t.id, count: 3 }],
      },
      { deviceId: w.deviceId, waiterId: w.waiterId },
    );
    expect(back.transactionNumber).toMatch(/-0002$/);
    expect(Number(back.totalAmount)).toBe(-6);
    expect(back.paymentMethod).toBe('cash');
    // Ruecktausch-Beleg wird immer gedruckt (Unterschrift).
    expect(print.printTokenReceipt).toHaveBeenCalledTimes(1);

    // Kassenbuch: +45 Verkauf, −6 Ruecktausch.
    const day = businessDateOf(new Date());
    const cash = await cashbook.summary(w.orgId, day, ALL_DEVICES);
    expect(cash.view).toMatchObject({ tokenSales: 45, tokenBuybacks: -6 });
    expect(cash.expectedCents).toBe(3900);

    // Bericht: verkauft 20/1, Ruecktausch 3, im Umlauf 17 x 2 € + 1 x 5 €.
    const report = await txs.report(w.orgId, user, {});
    const two = report.types.find((r) => r.tokenTypeId === t.id)!;
    expect(two).toMatchObject({
      sold: { count: 20, amount: 40 },
      boughtBack: { count: 3, amount: 6 },
      outstanding: { count: 17, amount: 34 },
    });
    expect(report.totals.outstanding.amount).toBe(39);
    expect(report.byEvent).toHaveLength(2);
  });

  it('Einzweck sale stores VAT lines; Kleinunternehmer books every token as Mehrzweck', async () => {
    const w = await world();
    const drinks = await types.create(
      w.orgId,
      { name: 'Getränkemarke', value: 3, kind: 'single_purpose', vatRate: 19 },
      user,
    );
    const sale = await txs.sell(w.orgId, {
      paymentMethod: 'card',
      lines: [{ tokenTypeId: drinks.id, count: 10 }],
    });
    expect(sale.taxLines).toEqual([
      { rate: 19, gross: 30, tax: 4.79, net: 25.21 },
    ]);
    expect(sale.lines[0]).toMatchObject({
      kind: 'single_purpose',
      vatRate: 19,
    });

    const ku = await world();
    const kuType = await types.create(
      ku.orgId,
      { name: 'Getränkemarke', value: 3, kind: 'single_purpose', vatRate: 19 },
      user,
    );
    await q(
      `UPDATE organizations SET settings = '{"vatExempt":true}' WHERE id = $1`,
      [ku.orgId],
    );
    const kuSale = await txs.sell(ku.orgId, {
      paymentMethod: 'cash',
      lines: [{ tokenTypeId: kuType.id, count: 2 }],
    });
    expect(kuSale.lines[0]).toMatchObject({
      kind: 'multi_purpose',
      vatRate: null,
    });
    expect(kuSale.taxLines).toEqual([]);
  });

  // ------------------------------------------------------------ Einloesung

  it('redemption: tokens + cash for the rest, token-only payment, Einzweck only for eligible items', async () => {
    const w = await world();
    const t = await marke(w);
    const drinks = await types.create(
      w.orgId,
      { name: 'Getränkemarke', value: 4, kind: 'single_purpose', vatRate: 19 },
      user,
    );

    // 2 Bier (8) + 2 Wurst (6) = 14: 5 Marken (10) + 4 bar.
    const o1 = await order(w, 2, 2);
    const paid = await batch.payBatch(
      w.orgId,
      w.deviceId,
      {
        orderIds: [o1],
        paymentMethod: 'cash' as never,
        amountReceived: 5,
        tokens: [{ tokenTypeId: t.id, count: 5 }],
      },
      attribution(w),
    );
    expect(paid.payments).toHaveLength(1);
    expect(paid.payments[0]).toMatchObject({
      paymentMethod: 'cash',
      amount: 4,
      tokenAmount: 10,
      tokenLines: [
        expect.objectContaining({ tokenTypeId: t.id, count: 5, amount: 10 }),
      ],
    });
    expect(paid.change).toBe(1);
    const [order1] = await q<{ paid_amount: string; payment_status: string }>(
      `SELECT paid_amount, payment_status FROM orders WHERE id = $1`,
      [o1],
    );
    expect(order1).toEqual({ paid_amount: '14.00', payment_status: 'paid' });

    // Nur Marken: Zahlart `tokens`, kein Geld.
    const o2 = await order(w, 1, 0);
    const onlyTokens = await batch.payBatch(
      w.orgId,
      w.deviceId,
      {
        orderIds: [o2],
        paymentMethod: 'tokens' as never,
        tokens: [{ tokenTypeId: drinks.id, count: 1 }],
      },
      attribution(w),
    );
    expect(onlyTokens.payments[0]).toMatchObject({
      paymentMethod: 'tokens',
      amount: 0,
      tokenAmount: 4,
    });
    expect(onlyTokens.totalPaid).toBe(0);

    // Einzweck-Getraenkemarke fuer Wurst: gilt nicht.
    const o3 = await order(w, 0, 2);
    await expect(
      batch.payBatch(w.orgId, w.deviceId, {
        orderIds: [o3],
        paymentMethod: 'cash' as never,
        tokens: [{ tokenTypeId: drinks.id, count: 1 }],
      }),
    ).rejects.toMatchObject({ response: { reason: 'TOKEN_NOT_ELIGIBLE' } });
    // Nur Marken, aber zu wenig: abgelehnt.
    await expect(
      batch.payBatch(w.orgId, w.deviceId, {
        orderIds: [o3],
        paymentMethod: 'tokens' as never,
        tokens: [{ tokenTypeId: t.id, count: 2 }],
      }),
    ).rejects.toMatchObject({
      response: { reason: 'TOKEN_AMOUNT_INSUFFICIENT' },
    });

    // Ueberzahlung: ohne Bestaetigung abgelehnt, mit als Trinkgeld.
    await expect(
      batch.payBatch(w.orgId, w.deviceId, {
        orderIds: [o3],
        paymentMethod: 'tokens' as never,
        tokens: [{ tokenTypeId: t.id, count: 4 }],
      }),
    ).rejects.toMatchObject({
      response: { reason: 'TOKEN_OVERPAYMENT', params: { excess: 2 } },
    });
    const tipped = await batch.payBatch(
      w.orgId,
      w.deviceId,
      {
        orderIds: [o3],
        paymentMethod: 'tokens' as never,
        tokens: [{ tokenTypeId: t.id, count: 4 }],
        tokenExcessAsTip: true,
      },
      attribution(w),
    );
    expect(tipped.payments[0]).toMatchObject({
      paymentMethod: 'tokens',
      tokenAmount: 8,
      tipAmount: 2,
    });
    const [order3] = await q<{
      tip_amount: string;
      total: string;
      paid_amount: string;
    }>(`SELECT tip_amount, total, paid_amount FROM orders WHERE id = $1`, [o3]);
    expect(order3).toEqual({
      tip_amount: '2.00',
      total: '8.00',
      paid_amount: '8.00',
    });

    // Kassenbuch: nur das Bargeld (4 €), Marken sind kein Bargeld.
    const day = businessDateOf(new Date());
    const cash = await cashbook.summary(w.orgId, day, ALL_DEVICES);
    expect(cash.view.cashSales).toBe(4);
    expect(cash.view.tokenSales).toBe(0);

    // Kellnerabrechnung: angenommene Marken je Typ, nicht im Soll bar.
    const summary = await settlements.summary(
      w.orgId,
      { kind: 'waiter', waiterId: w.waiterId },
      w.eventId,
    );
    expect(summary.totals.cashExpected).toBe(4);
    expect(summary.totals.tokens?.received).toEqual({ count: 10, amount: 22 });
    expect(summary.totals.tokens?.receivedByType).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tokenTypeId: t.id, count: 9, amount: 18 }),
        expect.objectContaining({
          tokenTypeId: drinks.id,
          count: 1,
          amount: 4,
        }),
      ]),
    );
    expect(summary.totals.payments?.cash).toEqual({ count: 1, amount: 4 });
    expect(summary.totals.tips).toBe(2);

    // Bericht Zahlarten: Wertmarken als eigener Posten.
    const byMethod = await reports.getPaymentsReport(w.orgId, {}, user);
    expect(byMethod).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'cash', total: 4 }),
        expect.objectContaining({ method: 'tokens', count: 3, total: 22 }),
      ]),
    );
  });

  it('several orders in one checkout: tokens spread over the orders, Einzweck first', async () => {
    const w = await world();
    const t = await marke(w);
    const drinks = await types.create(
      w.orgId,
      { name: 'Getränkemarke', value: 4, kind: 'single_purpose', vatRate: 19 },
      user,
    );
    const a = await order(w, 0, 2); // 6 € Wurst
    const b = await order(w, 1, 0); // 4 € Bier
    const result = await batch.payBatch(w.orgId, w.deviceId, {
      orderIds: [a, b],
      paymentMethod: 'cash' as never,
      tokens: [
        { tokenTypeId: t.id, count: 2 },
        { tokenTypeId: drinks.id, count: 1 },
      ],
    });
    const byOrder = new Map(result.payments.map((p) => [p.orderId, p]));
    // Getraenkemarke deckt das Bier, die 2-€-Marken die Wurst (4 von 6).
    expect(byOrder.get(b)).toMatchObject({
      paymentMethod: 'tokens',
      tokenAmount: 4,
    });
    expect(byOrder.get(a)).toMatchObject({
      paymentMethod: 'cash',
      amount: 2,
      tokenAmount: 4,
    });
  });

  // ------------------------------------------- Storno mit Marken-Rueckgabe

  it('cancellation of a token-paid order gives tokens back (never cash) and keeps the cash book clean', async () => {
    const w = await world();
    const t = await marke(w);
    const o = await order(w, 1, 1); // 7 €
    const [payment] = (
      await batch.payBatch(w.orgId, w.deviceId, {
        orderIds: [o],
        paymentMethod: 'cash' as never,
        tokens: [{ tokenTypeId: t.id, count: 3 }],
      })
    ).payments;
    expect(payment).toMatchObject({ amount: 1, tokenAmount: 6 });

    const outcome = await refunds.createRefund(
      {
        organizationId: w.orgId,
        deviceId: w.deviceId,
        deviceName: 'Zentralkasse',
        userId: null,
        actorName: null,
        cashDrawerPrinterId: null,
      },
      o,
      {
        mode: 'full',
        cancelItems: true,
        confirmStarted: true,
        reasonCode: 'wrong_order',
      } as never,
    );
    const back = outcome.refunds.map((r) => ({
      method: r.paymentMethod,
      amount: Number(r.amount),
    }));
    expect(back).toEqual(
      expect.arrayContaining([
        { method: 'cash', amount: -1 },
        { method: 'tokens', amount: -6 },
      ]),
    );
    const tokenRefund = outcome.refunds.find(
      (r) => String(r.paymentMethod) === 'tokens',
    )!;
    expect(tokenRefund.metadata.tokenLines).toEqual([
      expect.objectContaining({ tokenTypeId: t.id, count: 3, amount: 6 }),
    ]);

    // Kassenbuch: +1 −1 = 0; die Marken gingen als Marken zurueck.
    const cash = await cashbook.summary(
      w.orgId,
      businessDateOf(new Date()),
      ALL_DEVICES,
    );
    expect(cash.view).toMatchObject({ cashSales: 1, cashRefunds: -1 });
    // Bestand: 3 Marken wieder im Umlauf (Verkauf gab es hier keinen).
    const report = await txs.report(w.orgId, user, {});
    expect(report.types[0]).toMatchObject({
      redeemed: { count: 3, amount: 6 },
      returned: { count: 3, amount: 6 },
    });
  });

  // ----------------------------------------------------------- Umsatzsteuer

  it('VAT report: Mehrzweck sales not taxable, Einzweck taxed at sale and not again at redemption', async () => {
    const w = await world();
    const multi = await marke(w);
    const drinks = await types.create(
      w.orgId,
      { name: 'Getränkemarke', value: 4, kind: 'single_purpose', vatRate: 19 },
      user,
    );
    await txs.sell(w.orgId, {
      eventId: w.eventId,
      paymentMethod: 'cash',
      lines: [
        { tokenTypeId: multi.id, count: 10 },
        { tokenTypeId: drinks.id, count: 5 },
      ],
    });
    // 2 Bier (8 € 19 %) mit 2 Getraenkemarken, 2 Wurst (6 € 7 %) mit 3 Mehrzweckmarken.
    const o = await order(w, 2, 2);
    await batch.payBatch(w.orgId, w.deviceId, {
      orderIds: [o],
      paymentMethod: 'tokens' as never,
      tokens: [
        { tokenTypeId: drinks.id, count: 2 },
        { tokenTypeId: multi.id, count: 3 },
      ],
    });
    const vat = await reports.getVatReport(
      w.orgId,
      { eventId: w.eventId },
      user,
    );
    const r19 = vat.rows.find((r) => r.rate === 19)!;
    const r7 = vat.rows.find((r) => r.rate === 7)!;
    // 19 %: Ware 8 + Einzweck (Verkauf 20 − Einloesung 8) = 20 brutto.
    expect(r19).toMatchObject({
      goods: 8,
      singlePurposeTokens: 12,
      gross: 20,
      tax: 3.19,
    });
    // 7 %: die mit Mehrzweckmarken bezahlte Wurst ist ganz normal Umsatz.
    expect(r7).toMatchObject({
      goods: 6,
      singlePurposeTokens: 0,
      gross: 6,
      tax: 0.39,
    });
    expect(vat.multiPurposeTokens).toEqual({ sold: 20, boughtBack: 0 });
  });
});
