import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../config/where-values';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  HospitalityReceipt,
  Order,
  OrderEvent,
  Organization,
  Payment,
  PrintTemplate,
  ReceiptLink,
} from '../../database/entities';
import type { EmailService } from '../email/email.service';
import type { OrderPrintService } from '../print-jobs/order-print.service';
import { FISCAL_ORDER_IDS_SQL } from '../retention/retention-sql';
import { HospitalityReceiptsService } from './hospitality-receipts.service';
import { ReceiptsService } from './receipts.service';

/**
 * Bewirtungsbelege gegen ein echtes Postgres: lueckenlose Nummern je
 * Organisation und Jahr (auch gleichzeitig), unveraenderlicher Datensatz,
 * Bestellungen mit Beleg lassen sich nicht loeschen, Testbelege gehen mit
 * ihren Testbestellungen, Steuerarchiv haelt die Bestellungen.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://…/openeos_receipt_scratch pnpm test hospitality.db
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('Bewirtungsbelege against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  let service: HospitalityReceiptsService;
  const print = {
    receiptPayload: jest.fn(
      (
        _org: string,
        data: { orderId: string; orderNumber: string; order: Order },
      ) =>
        Promise.resolve({
          order_id: data.orderId,
          order_number: data.orderNumber,
          created_at: new Date(),
          organization: { name: 'TSV' },
          items: [{ quantity: 1, name: 'Bratwurst', total: 3.5 }],
          tax_lines: [{ rate: 7, net: 3.27, tax: 0.23, gross: 3.5 }],
          total: 3.5,
          paid_amount: 3.5,
          payment_method: 'cash',
          payment_label: 'Bar',
          is_test: data.order.isTest === true,
          tse: null,
        }),
    ),
    printHospitalityReceipt: jest.fn(() => Promise.resolve(true)),
  };

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
      extra: { max: 30 },
    });
    await ds.initialize();
    const receipts = new ReceiptsService(
      ds.getRepository(ReceiptLink),
      ds.getRepository(Order),
      ds.getRepository(Payment),
      ds.getRepository(Organization),
      ds.getRepository(PrintTemplate),
      ds.getRepository(OrderEvent),
      ds.getRepository(HospitalityReceipt),
      print as unknown as OrderPrintService,
      {
        sendEmail: jest.fn(() => Promise.resolve(true)),
      } as unknown as EmailService,
      { platformLegal: { imprintUrl: null, privacyUrl: null } } as never,
      new ConfigService({}),
    );
    service = new HospitalityReceiptsService(
      ds.getRepository(HospitalityReceipt),
      ds.getRepository(OrderEvent),
      ds,
      receipts,
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

  async function world(orders: number, options: { test?: boolean } = {}) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode)
       VALUES ($1, 'TSV', $2, '123456', $3, 'AT', 'full')`,
      [
        orgId,
        `tsv-${orgId}`,
        JSON.stringify({
          vatExempt: false,
          legalName: 'TSV Musterdorf e.V.',
          taxNumber: '12/345/67890',
          address: {
            street: 'Weg 1',
            zip: '12345',
            city: 'Musterdorf',
            country: 'AT',
          },
        }),
      ],
    );
    const [event] = await ds.query<{ id: string }[]>(
      `INSERT INTO events (organization_id, name, status) VALUES ($1, 'Fest', 'active') RETURNING id`,
      [orgId],
    );
    const ids: string[] = [];
    for (let i = 1; i <= orders; i++) {
      const [order] = await ds.query<{ id: string }[]>(
        `INSERT INTO orders (organization_id, event_id, order_number, daily_number, subtotal, total,
           paid_amount, payment_status, status, is_test)
         VALUES ($1, $2, $3, $4, 3.5, 3.5, 3.5, 'paid', 'completed', $5) RETURNING id`,
        [
          orgId,
          event.id,
          `20261111-${String(i).padStart(4, '0')}`,
          i,
          options.test === true,
        ],
      );
      await ds.query(
        `INSERT INTO payments (order_id, amount, payment_method, payment_provider, status)
         VALUES ($1, 3.5, 'cash', 'CASH', 'captured')`,
        [order.id],
      );
      ids.push(order.id);
    }
    return { orgId, eventId: event.id, orders: ids };
  }

  const actor = (organizationId: string) => ({
    organizationId,
    deviceId: null,
    userId: null,
  });

  it('numbers gaplessly per organization and year, also when issued concurrently', async () => {
    const a = await world(20);
    const b = await world(2);
    const year = new Date().getFullYear();
    const results = await Promise.all(
      a.orders.map((id) => service.issue(actor(a.orgId), { orderIds: [id] })),
    );
    const numbers = results.map((r) => r.receipt.number).sort();
    expect(numbers).toEqual(
      Array.from(
        { length: 20 },
        (_, i) => `B-${year}-${String(i + 1).padStart(4, '0')}`,
      ),
    );
    // Eigene Folge je Organisation.
    const other = await service.issue(actor(b.orgId), {
      orderIds: [b.orders[0]],
    });
    expect(other.receipt.number).toBe(`B-${year}-0001`);

    // Rollt das Einfuegen zurueck, rollt die Nummer zurueck (keine Luecke).
    await expect(
      ds.transaction(async (m) => {
        await m.query(
          `INSERT INTO hospitality_receipts (organization_id, service_date, total, snapshot)
           VALUES ($1, current_date, 1, '{}')`,
          [b.orgId],
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const next = await service.issue(actor(b.orgId), {
      orderIds: [b.orders[1]],
    });
    expect(next.receipt.number).toBe(`B-${year}-0002`);
  }, 60_000);

  it('returns the existing receipt for the same orders and refuses overlaps, also concurrently', async () => {
    const w = await world(2);
    const [first, second] = await Promise.allSettled([
      service.issue(actor(w.orgId), { orderIds: [w.orders[0]] }),
      service.issue(actor(w.orgId), { orderIds: [w.orders[0]] }),
    ]);
    const ok = [first, second].filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const [{ n }] = await ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM hospitality_receipts WHERE organization_id = $1`,
      [w.orgId],
    );
    // Die verlorene Einfuegung rollt komplett zurueck — auch ihre Nummer.
    expect(n).toBe(1);
    const again = await service.issue(actor(w.orgId), {
      orderIds: [w.orders[0]],
    });
    expect(again.existing).toBe(true);
    await expect(
      service.issue(actor(w.orgId), { orderIds: [w.orders[0], w.orders[1]] }),
    ).rejects.toMatchObject({
      response: { code: 'HOSPITALITY_RECEIPT_EXISTS' },
    });
  });

  it('is immutable and keeps its orders', async () => {
    const w = await world(1);
    const { receipt } = await service.issue(actor(w.orgId), {
      orderIds: [w.orders[0]],
      recipientName: 'Muster GmbH',
    });
    await expect(
      ds.query(
        `UPDATE hospitality_receipts SET recipient_name = 'X' WHERE id = $1`,
        [receipt.id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      ds.query(`DELETE FROM hospitality_receipts WHERE id = $1`, [receipt.id]),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      ds.query(`DELETE FROM orders WHERE id = $1`, [w.orders[0]]),
    ).rejects.toThrow(/cannot be deleted/);
    // Das Steuerarchiv zaehlt die Bestellung (Loeschen der Organisation).
    const fiscal = await ds.query<{ order_id: string }[]>(
      FISCAL_ORDER_IDS_SQL,
      [w.orgId],
    );
    expect(fiscal.map((r) => r.order_id)).toContain(w.orders[0]);
  });

  it('marks copies from the second output on', async () => {
    const w = await world(1);
    const { receipt } = await service.issue(actor(w.orgId), {
      orderIds: [w.orders[0]],
    });
    expect(await service.print(actor(w.orgId), receipt.id)).toEqual({
      printed: true,
      copy: false,
    });
    expect(await service.print(actor(w.orgId), receipt.id)).toEqual({
      printed: true,
      copy: true,
    });
    const link = await service.link(actor(w.orgId), receipt.id);
    expect(link.copy).toBe(true);
    const blocks = (
      print.printHospitalityReceipt.mock.calls as unknown as [
        string,
        { blocks: { type: string; text?: string }[] },
      ][]
    ).map(([, data]) =>
      data.blocks.some((b) => b.type === 'banner' && b.text === 'KOPIE'),
    );
    expect(blocks.slice(-2)).toEqual([false, true]);
  });

  it('test receipts have no number and disappear with their test orders', async () => {
    const w = await world(1, { test: true });
    const { receipt } = await service.issue(actor(w.orgId), {
      orderIds: [w.orders[0]],
    });
    expect(receipt.isTest).toBe(true);
    expect(receipt.number).toBeNull();
    await ds.query(`DELETE FROM orders WHERE id = $1`, [w.orders[0]]);
    const rows = await ds.query<{ id: string }[]>(
      `SELECT id FROM hospitality_receipts WHERE id = $1`,
      [receipt.id],
    );
    expect(rows).toHaveLength(0);
  });
});
