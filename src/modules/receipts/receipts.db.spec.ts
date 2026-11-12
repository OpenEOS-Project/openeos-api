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
import { ReceiptLinksJob } from '../retention/jobs/receipt-links.job';
import type { RetentionRunContext } from '../retention/retention.types';
import { ReceiptsService, receiptTokenHash } from './receipts.service';

/**
 * Digitaler Beleg gegen ein echtes Postgres: Link mit Ablauf, nur der
 * Hash des Tokens in der Tabelle, Loeschlauf, Versandgrenze ueber den
 * Verlauf, keine Mailadresse in der Datenbank.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5544/openeos_receipt_scratch pnpm test receipts.db
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('ReceiptsService against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const email = { sendEmail: jest.fn(() => Promise.resolve(true)) };
  const print = {
    receiptPayload: jest.fn(
      (_org: string, data: { orderId: string; orderNumber: string }) =>
        Promise.resolve({
          order_id: data.orderId,
          order_number: data.orderNumber,
          created_at: new Date(),
          organization: { name: 'TSV' },
          items: [{ quantity: 1, name: 'Bratwurst', total: 3.5 }],
          total: 3.5,
          paid_amount: 3.5,
          payment_method: 'cash',
          payment_label: 'Bar',
          is_test: false,
          tse: null,
        }),
    ),
  };
  let service: ReceiptsService;

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
    service = new ReceiptsService(
      ds.getRepository(ReceiptLink),
      ds.getRepository(Order),
      ds.getRepository(Payment),
      ds.getRepository(Organization),
      ds.getRepository(PrintTemplate),
      ds.getRepository(OrderEvent),
      ds.getRepository(HospitalityReceipt),
      print as unknown as OrderPrintService,
      email as unknown as EmailService,
      { platformLegal: { imprintUrl: null, privacyUrl: null } } as never,
      new ConfigService({ RECEIPT_EMAIL_DEVICE_LIMIT_PER_HOUR: '3' }),
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

  async function world(mode: 'full' | 'orders_only' = 'full') {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode)
       VALUES ($1, 'TSV', $2, '123456', '{}', 'AT', $3)`,
      [orgId, `tsv-${orgId}`, mode],
    );
    const [event] = await ds.query<{ id: string }[]>(
      `INSERT INTO events (organization_id, name, status) VALUES ($1, 'Fest', 'active') RETURNING id`,
      [orgId],
    );
    const [device] = await ds.query<{ id: string }[]>(
      `INSERT INTO devices (organization_id, name, type, status, device_token)
       VALUES ($1, 'Kasse 1', 'pos', 'verified', $2) RETURNING id`,
      [orgId, randomUUID()],
    );
    const orders: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const [order] = await ds.query<{ id: string }[]>(
        `INSERT INTO orders (organization_id, event_id, order_number, daily_number, subtotal, total,
           paid_amount, payment_status, status)
         VALUES ($1, $2, $3, $4, 3.5, 3.5, 3.5, 'paid', 'completed') RETURNING id`,
        [orgId, event.id, `20261111-000${i}`, i],
      );
      await ds.query(
        `INSERT INTO payments (order_id, amount, payment_method, payment_provider, status)
         VALUES ($1, 3.5, 'cash', 'CASH', 'captured')`,
        [order.id],
      );
      orders.push(order.id);
    }
    return { orgId, deviceId: device.id, orders };
  }

  it('stores a link with only the token hash and resolves it until it expires', async () => {
    const w = await world();
    const actor = {
      organizationId: w.orgId,
      deviceId: w.deviceId,
      userId: null,
    };
    const link = await service.createLink(actor, w.orders);
    const token = link.url.split('/beleg/')[1];
    const rows = await ds.query<{ token_hash: string; order_ids: string[] }[]>(
      `SELECT token_hash, order_ids FROM receipt_links WHERE organization_id = $1`,
      [w.orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(receiptTokenHash(token));
    expect(JSON.stringify(rows)).not.toContain(token);

    const view = await service.publicView(token);
    expect(view.receipts.map((r) => r.orderNumber)).toEqual([
      '20261111-0001',
      '20261111-0002',
    ]);
    const pdf = await service.publicPdf(token);
    expect(pdf.filename).toBe('Beleg-20261111-0001.pdf');

    await ds.query(
      `UPDATE receipt_links SET expires_at = now() - interval '1 second' WHERE organization_id = $1`,
      [w.orgId],
    );
    await expect(service.publicView(token)).rejects.toMatchObject({
      response: { code: 'RECEIPT_LINK_NOT_FOUND' },
    });

    const events = await ds.query<{ type: string }[]>(
      `SELECT type FROM order_events WHERE order_id = ANY($1::uuid[])`,
      [w.orders],
    );
    expect(events.map((e) => e.type)).toEqual([
      'receipt_link_created',
      'receipt_link_created',
    ]);
  });

  it('refuses links in the orders-only mode', async () => {
    const w = await world('orders_only');
    await expect(
      service.createLink(
        { organizationId: w.orgId, deviceId: w.deviceId, userId: null },
        w.orders,
      ),
    ).rejects.toMatchObject({ response: { code: 'RECEIPT_NOT_AVAILABLE' } });
  });

  it('never stores the e-mail address and limits mails per device', async () => {
    const w = await world();
    const actor = {
      organizationId: w.orgId,
      deviceId: w.deviceId,
      userId: null,
    };
    for (let i = 0; i < 3; i++) {
      await service.sendEmail(actor, [w.orders[i % 2]], `gast${i}@example.org`);
    }
    await expect(
      service.sendEmail(actor, [w.orders[0]], 'gast9@example.org'),
    ).rejects.toMatchObject({
      response: { code: 'RECEIPT_EMAIL_RATE_LIMITED' },
    });
    expect(email.sendEmail).toHaveBeenCalledTimes(3);

    // Die Adresse steht in keiner Zeile der beteiligten Tabellen.
    const dump = await ds.query<{ t: string }[]>(
      `SELECT row_to_json(e)::text AS t FROM order_events e WHERE organization_id = $1
       UNION ALL SELECT row_to_json(l)::text FROM receipt_links l WHERE organization_id = $1`,
      [w.orgId],
    );
    const text = dump.map((r) => r.t).join('\n');
    expect(text).toContain('receipt_emailed');
    expect(text).not.toMatch(/gast\d@example\.org/);
    expect(text).not.toContain('example.org');
  });

  it('retention job deletes expired links only', async () => {
    const w = await world();
    const actor = {
      organizationId: w.orgId,
      deviceId: w.deviceId,
      userId: null,
    };
    await service.createLink(actor, [w.orders[0]]);
    await service.createLink(actor, [w.orders[1]]);
    await ds.query(
      `UPDATE receipt_links SET expires_at = now() - interval '1 day'
        WHERE organization_id = $1 AND order_ids = ARRAY[$2::uuid]`,
      [w.orgId, w.orders[0]],
    );
    const counts: Record<string, number> = {};
    const run = async (dryRun: boolean) =>
      ds.transaction(async (manager) => {
        await new ReceiptLinksJob().run({
          now: new Date(),
          dryRun,
          manager,
          config: {} as never,
          removed: (key: string, n: number) => {
            counts[key] = (counts[key] ?? 0) + n;
          },
          note: () => undefined,
        } as unknown as RetentionRunContext);
      });
    await run(true);
    expect(counts.receiptLinksDeleted).toBeGreaterThanOrEqual(1);
    const [{ n }] = await ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM receipt_links WHERE organization_id = $1`,
      [w.orgId],
    );
    expect(n).toBe(2);
    await run(false);
    const left = await ds.query<{ order_ids: string[] }[]>(
      `SELECT order_ids FROM receipt_links WHERE organization_id = $1`,
      [w.orgId],
    );
    expect(left).toHaveLength(1);
    expect(left[0].order_ids).toEqual([w.orders[1]]);
  });
});
