import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../config/where-values';
import { pfandLegacyBalance } from './pfand-legacy-balance';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PfandReturn, PfandType, Organization } from '../../database/entities';
import type { GatewayService } from '../gateway/gateway.service';
import type { OrderPrintService } from '../print-jobs/order-print.service';
import type { TseSigningService } from '../tse/tse-signing.service';
import { PfandReturnsService } from './pfand-returns.service';

/**
 * Pfand-Auszahlung als Beleg gegen ein echtes Postgres: Belegnummer je
 * Tag, Satz der Pfandart als Snapshot, MwSt-Zeilen, Druck nach der Regel
 * des Kassenbons, Bestand bleibt unveraendert.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5544/openeos_history_scratch pnpm test pfand-returns.db
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('PfandReturnsService against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const gateway = {
    sendOpenCashDrawer: jest.fn(),
    notifyPfandReturned: jest.fn(),
  };
  const print = {
    autoPrintsReceipts: jest.fn(() => Promise.resolve(false)),
    printPfandReturnReceipt: jest.fn(() => Promise.resolve(true)),
  };
  const tse = {
    signPfandReturn: jest.fn(() => Promise.resolve(null)),
    forPfandReturn: jest.fn(() => Promise.resolve(null)),
  };
  let service: PfandReturnsService;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    }
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
    service = new PfandReturnsService(
      ds.getRepository(PfandReturn),
      ds.getRepository(PfandType),
      gateway as unknown as GatewayService,
      tse as unknown as TseSigningService,
      undefined,
      print as unknown as OrderPrintService,
    );
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      await ds.destroy();
    }
  });

  beforeEach(() => jest.clearAllMocks());

  async function world(vatExempt: boolean) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode)
       VALUES ($1, 'Verein', $2, '123456', $3, 'AT', 'full')`,
      [orgId, `verein-${orgId}`, JSON.stringify({ vatExempt })],
    );
    // Becher ohne Angabe: Standard 19 % aus der Migration.
    const [becher] = await ds.query<{ id: string; vat_rate: string }[]>(
      `INSERT INTO pfand_types (organization_id, name, amount) VALUES ($1, 'Becher', 2)
       RETURNING id, vat_rate`,
      [orgId],
    );
    const [teller] = await ds.query<{ id: string }[]>(
      `INSERT INTO pfand_types (organization_id, name, amount, vat_rate) VALUES ($1, 'Teller', 0.5, 7)
       RETURNING id`,
      [orgId],
    );
    return {
      orgId,
      becherId: becher.id,
      becherRate: Number(becher.vat_rate),
      tellerId: teller.id,
    };
  }

  it('numbers the receipt per day, snapshots the rate and stores negative VAT lines', async () => {
    const w = await world(false);
    expect(w.becherRate).toBe(19);
    // Auszahlung von vor der Umstellung: ohne Nummer, ohne Satz.
    await ds.query(
      `INSERT INTO pfand_returns (organization_id, total_amount, lines) VALUES ($1, 2, $2)`,
      [
        w.orgId,
        JSON.stringify([
          {
            pfandTypeId: w.becherId,
            name: 'Becher',
            unitAmount: 2,
            quantity: 1,
          },
        ]),
      ],
    );

    const first = await service.create(
      w.orgId,
      {
        lines: [
          { pfandTypeId: w.becherId, quantity: 3 },
          { pfandTypeId: w.tellerId, quantity: 2 },
        ],
      },
      { deviceName: 'Kasse 1' },
    );
    const second = await service.create(w.orgId, {
      lines: [{ pfandTypeId: w.becherId, quantity: 1 }],
    });

    expect(first.returnNumber).toMatch(/^P-\d{8}-0001$/);
    expect(second.returnNumber).toBe(first.returnNumber!.replace(/1$/, '2'));
    expect(Number(first.totalAmount)).toBe(7);
    expect(first.lines.map((l) => [l.name, l.vatRate])).toEqual([
      ['Becher', 19],
      ['Teller', 7],
    ]);
    expect(first.taxLines).toEqual([
      { rate: 19, gross: -6, tax: -0.96, net: -5.04 },
      { rate: 7, gross: -1, tax: -0.07, net: -0.93 },
    ]);
    expect(first.printed).toBe(false);
    expect(print.printPfandReturnReceipt).not.toHaveBeenCalled();

    // Satz der Pfandart aendern: gilt nur fuer neue Auszahlungen.
    await ds.query(`UPDATE pfand_types SET vat_rate = 7 WHERE id = $1`, [
      w.becherId,
    ]);
    const stored = await ds.getRepository(PfandReturn).find({
      where: { organizationId: w.orgId },
      order: { createdAt: 'ASC' },
    });
    expect(stored.map((r) => r.returnNumber)).toEqual([
      null,
      first.returnNumber,
      second.returnNumber,
    ]);
    // Bestand unveraendert: kein Satz, keine MwSt-Zeilen.
    expect(stored[0].lines[0].vatRate).toBeUndefined();
    expect(stored[0].taxLines).toEqual([]);
    expect(stored[1].lines[0].vatRate).toBe(19);
  });

  /** Verkauf vor der Umstellung: Pfand ohne Satz (deposit_tax_rate NULL). */
  async function legacySale(
    orgId: string,
    quantity: number,
    options: { isTest?: boolean } = {},
  ) {
    const [event] = await ds.query<{ id: string }[]>(
      `INSERT INTO events (organization_id, name, status) VALUES ($1, 'Fest 2025', 'inactive') RETURNING id`,
      [orgId],
    );
    const [category] = await ds.query<{ id: string }[]>(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Getränke') RETURNING id`,
      [event.id],
    );
    const [product] = await ds.query<{ id: string }[]>(
      `INSERT INTO products (event_id, category_id, name, price, tax_rate) VALUES ($1, $2, 'Bier', 3, 19) RETURNING id`,
      [event.id, category.id],
    );
    const [order] = await ds.query<{ id: string }[]>(
      `INSERT INTO orders (organization_id, event_id, order_number, daily_number, status, payment_status,
         subtotal, total, paid_amount, pfand_total, is_test)
       VALUES ($1, $2, $3, 1, 'completed', 'paid', $4, $5, $5, $6, $7) RETURNING id`,
      [
        orgId,
        event.id,
        `ALT-${randomUUID().slice(0, 8)}`,
        3 * quantity,
        5 * quantity,
        2 * quantity,
        options.isTest === true,
      ],
    );
    await ds.query(
      `INSERT INTO order_items (order_id, product_id, category_id, product_name, category_name, quantity, unit_price, tax_rate,
         total_price, status, deposit_amount, sort_order)
       VALUES ($1, $2, $3, 'Bier', 'Getränke', $4, 3, 19, $5, 'delivered', 2, 0)`,
      [order.id, product.id, category.id, quantity, 3 * quantity],
    );
  }

  it('Pfand transition (Frage 2): returns consume the Altsaldo first (no VAT reduction), then the pfand type rate', async () => {
    const w = await world(false);
    // Vor der Umstellung: 5 Becher à 2 € ohne Satz verkauft (bezahlt) …
    await legacySale(w.orgId, 5);
    // … ein Testverkauf zaehlt nicht, eine alte Auszahlung ohne Satz schon.
    await legacySale(w.orgId, 1, { isTest: true });
    await ds.query(
      `INSERT INTO pfand_returns (organization_id, total_amount, lines) VALUES ($1, 2, $2)`,
      [
        w.orgId,
        JSON.stringify([
          {
            pfandTypeId: w.becherId,
            name: 'Becher',
            unitAmount: 2,
            quantity: 1,
          },
        ]),
      ],
    );
    expect(await pfandLegacyBalance(ds, w.orgId)).toEqual({
      chargedCents: 1000,
      returnedCents: 200,
      remainingCents: 800,
    });

    // 3 Becher (6 €): ganz gegen den Altsaldo — keine MwSt-Minderung.
    const first = await service.create(w.orgId, {
      lines: [{ pfandTypeId: w.becherId, quantity: 3 }],
    });
    expect(first.lines[0]).toMatchObject({ vatRate: 19, legacyCents: 600 });
    expect(first.taxLines).toEqual([]);
    // 3 weitere: 2 € Rest-Altsaldo, 4 € mit 19 %.
    const second = await service.create(w.orgId, {
      lines: [{ pfandTypeId: w.becherId, quantity: 3 }],
    });
    expect(second.lines[0]).toMatchObject({ vatRate: 19, legacyCents: 200 });
    expect(second.taxLines).toEqual([
      { rate: 19, gross: -4, tax: -0.64, net: -3.36 },
    ]);
    // Aufgebraucht: ab jetzt voller Satz.
    const third = await service.create(w.orgId, {
      lines: [{ pfandTypeId: w.becherId, quantity: 1 }],
    });
    expect(third.lines[0].legacyCents).toBeUndefined();
    expect(third.taxLines).toEqual([
      { rate: 19, gross: -2, tax: -0.32, net: -1.68 },
    ]);
    expect((await pfandLegacyBalance(ds, w.orgId)).remainingCents).toBe(0);
  });

  it('Pfand transition: no Altsaldo consumption for Kleinunternehmer (no tax effect)', async () => {
    const w = await world(true);
    await legacySale(w.orgId, 1);
    const result = await service.create(w.orgId, {
      lines: [{ pfandTypeId: w.becherId, quantity: 1 }],
    });
    expect(result.lines[0].legacyCents).toBeUndefined();
    expect(result.taxLines).toEqual([]);
  });

  it('VAT-exempt organization: no VAT lines; prints when receipts are printed automatically', async () => {
    const w = await world(true);
    print.autoPrintsReceipts.mockResolvedValueOnce(true);
    const result = await service.create(
      w.orgId,
      { lines: [{ pfandTypeId: w.becherId, quantity: 2 }] },
      { deviceId: null, deviceName: 'Kasse 2' },
    );
    expect(result.taxLines).toEqual([]);
    expect(result.lines[0].vatRate).toBe(19);
    expect(result.printed).toBe(true);
    expect(print.printPfandReturnReceipt).toHaveBeenCalledWith(
      w.orgId,
      expect.objectContaining({
        deviceName: 'Kasse 2',
        tse: null,
        pfandReturn: expect.objectContaining({
          id: result.id,
        }) as unknown as PfandReturn,
      }),
    );

    // Nachdruck von der Kasse: gespeicherte Daten, Vermerk NACHDRUCK.
    const again = await service.printReceipt(w.orgId, result.id, {
      deviceId: null,
      deviceName: 'Kasse 3',
      reprint: true,
    });
    expect(again).toEqual({ printed: true });
    expect(print.printPfandReturnReceipt).toHaveBeenLastCalledWith(
      w.orgId,
      expect.objectContaining({ reprint: true, deviceName: 'Kasse 3' }),
    );
    expect(tse.forPfandReturn).toHaveBeenCalledWith(result.id);
    await expect(
      service.printReceipt(randomUUID(), result.id),
    ).rejects.toMatchObject({
      response: { reason: 'DEPOSIT_RETURN_NOT_FOUND' },
    });
  });

  it('keeps the organization in the numbering (no clash between clubs)', async () => {
    const a = await world(false);
    const b = await world(false);
    const ra = await service.create(a.orgId, {
      lines: [{ pfandTypeId: a.becherId, quantity: 1 }],
    });
    const rb = await service.create(b.orgId, {
      lines: [{ pfandTypeId: b.becherId, quantity: 1 }],
    });
    expect(ra.returnNumber).toMatch(/-0001$/);
    expect(rb.returnNumber).toMatch(/-0001$/);
    expect(
      await ds.getRepository(Organization).count({
        where: [{ id: a.orgId }, { id: b.orgId }],
      }),
    ).toBe(2);
  });
});
