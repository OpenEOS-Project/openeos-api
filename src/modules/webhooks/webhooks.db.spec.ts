/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- JSON-Inhalte der Zustellungen */
import { randomUUID } from 'crypto';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CronLockService } from '../../common/redis/cron-lock.service';
import type { EventPhaseService } from '../events/event-phase.service';
import type { EmailService } from '../email/email.service';
import { rowsOf } from '../tse/tse-sql.util';
import { WebhookDeliveriesJob } from '../retention/jobs/webhook-deliveries.job';
import type { RetentionRunContext } from '../retention/retention.types';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import type { WebhookRequest, WebhookResponse } from './webhook-http';
import { WebhookPhaseTrackerService } from './webhook-phase-tracker.service';
import { verifyWebhookSignature } from './webhook-signature';
import type { LookupAll } from './webhook-url-guard';
import { loadWebhooksConfig } from './webhooks.config';
import { WebhooksService } from './webhooks.service';

/**
 * Webhooks gegen ein echtes Postgres: Trigger (welche Aenderung welches
 * Ereignis erzeugt, und dass ein Fehler nie den Verkauf verhindert),
 * Verteilung auf Endpunkte (Abo, Testbestellungen, Gaestedaten, „Nur
 * Bons“), Zustellung mit Wiederholungen, automatisches Abschalten,
 * Verwaltung (Grenzen, Adresspruefung, Mandantentrennung, Geheimnis
 * erneuern, erneut senden), Aufbewahrung und Phasenwechsel. Nur mit
 * Wegwerf-Datenbank, z. B.
 *
 *   TEST_WEBHOOKS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:55491/openeos_webhooks_test pnpm test webhooks.db
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_WEBHOOKS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

type Row = Record<string, unknown>;

describeWithDb('Webhooks against Postgres', () => {
  let ds: DataSource;
  let service: WebhooksService;
  let dispatcher: WebhookDispatcherService;
  let delivery: WebhookDeliveryService;
  let tracker: WebhookPhaseTrackerService;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const mails: { to: string; url: string; failures: number }[] = [];
  const sent: WebhookRequest[] = [];
  let respond: (req: WebhookRequest) => WebhookResponse;
  const phases = new Map<string, string>();
  const kick = jest.fn();
  const config = loadWebhooksConfig({
    WEBHOOKS_DISABLE_AFTER_FAILURES: '3',
    WEBHOOKS_DISABLE_AFTER_HOURS: '1',
    WEBHOOKS_MAX_ENDPOINTS_PER_ORG: '3',
  });

  const sql = async (text: string, params: unknown[] = []): Promise<Row[]> =>
    rowsOf<Row>(await ds.query(text, params));
  const one = async (text: string, params: unknown[] = []): Promise<Row> =>
    (await sql(text, params))[0];

  const lookup: LookupAll = (hostname) => {
    if (hostname.endsWith('.internal')) {
      return Promise.resolve([{ address: '10.0.0.5', family: 4 }]);
    }
    if (hostname.startsWith('nx.')) {
      const error = new Error('nx') as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      return Promise.reject(error);
    }
    return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name))
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();

    const eventPhase = {
      resolve: (event: { id: string }) =>
        Promise.resolve({ phase: phases.get(event.id) ?? 'test' }),
    } as unknown as EventPhaseService;
    const cronLock = {
      runExclusive: async (_n: string, job: () => Promise<void>) => {
        await job();
        return true;
      },
    } as unknown as CronLockService;
    const email = {
      sendWebhookDisabledEmail: (o: {
        to: string;
        url: string;
        failures: number;
      }) => {
        mails.push({ to: o.to, url: o.url, failures: o.failures });
        return Promise.resolve(true);
      },
    } as unknown as EmailService;

    dispatcher = new WebhookDispatcherService(ds, config, eventPhase);
    delivery = new WebhookDeliveryService(
      ds,
      config,
      dispatcher,
      cronLock,
      email,
    );
    delivery.kick = kick;
    delivery.random = () => 0.5;
    delivery.sender = (req) => {
      sent.push(req);
      return Promise.resolve(respond(req));
    };
    service = new WebhooksService(ds, config, delivery);
    service.lookup = lookup;
    tracker = new WebhookPhaseTrackerService(ds, config, eventPhase, cronLock);
  }, 120_000);

  beforeEach(async () => {
    // Jeder Fall fuer sich: Liegengebliebenes aus anderen Faellen beenden
    // (nur in der Wegwerf-Datenbank).
    await sql(`DELETE FROM webhook_outbox`);
    await sql(
      `UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = NULL WHERE status IN ('pending', 'delivering')`,
    );
    sent.length = 0;
    respond = () => ({
      ok: true,
      responseStatus: 200,
      responseBody: 'ok',
      durationMs: 12,
      error: null,
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await sql(
          `ALTER TABLE cash_point_closings DISABLE TRIGGER cash_point_closings_immutable`,
        );
        await sql(
          `DELETE FROM cash_point_closings WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(
          `ALTER TABLE cash_point_closings ENABLE TRIGGER cash_point_closings_immutable`,
        );
        for (const table of [
          'refunds',
          'pfand_returns',
          'webhook_outbox',
          'admin_audit_logs',
        ]) {
          await sql(
            `DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`,
            [orgIds],
          );
        }
        await sql(
          `DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await sql(
          `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await sql(
          `DELETE FROM orders WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(
          `DELETE FROM products WHERE event_id IN (SELECT id FROM events WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await sql(
          `DELETE FROM categories WHERE event_id IN (SELECT id FROM events WHERE organization_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await sql(
          `DELETE FROM events WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(
          `DELETE FROM user_organizations WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      if (userIds.length) {
        await sql(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
      }
      await ds.destroy();
    }
  });

  // ---------- Fixtures ----------

  async function org(o: { operatingMode?: string } = {}): Promise<string> {
    const id = randomUUID();
    orgIds.push(id);
    await sql(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, operating_mode, country)
       VALUES ($1, 'TSV Musterdorf e. V.', $2, '123456', $3, $4, 'DE')`,
      [
        id,
        `tsv-${id}`,
        JSON.stringify({
          currency: 'EUR',
          timezone: 'Europe/Berlin',
          locale: 'de',
        }),
        o.operatingMode ?? 'cashless',
      ],
    );
    return id;
  }

  async function admin(
    organizationId: string,
  ): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    userIds.push(id);
    const email = `vorstand-${id}@example.test`;
    await sql(
      `INSERT INTO users (id, email, first_name, last_name, password_hash) VALUES ($1, $2, 'Erika', 'Muster', 'hash')`,
      [id, email],
    );
    await sql(
      `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`,
      [id, organizationId],
    );
    return { id, email };
  }

  async function event(organizationId: string) {
    const [{ id: eventId }] = await sql(
      `INSERT INTO events (organization_id, name, start_date, end_date, status)
       VALUES ($1, 'Sommerfest', now(), now() + interval '1 day', 'test') RETURNING id`,
      [organizationId],
    );
    const [{ id: categoryId }] = await sql(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Getränke') RETURNING id`,
      [eventId],
    );
    const [{ id: productId }] = await sql(
      `INSERT INTO products (event_id, category_id, name, price, tax_rate) VALUES ($1, $2, 'Apfelschorle', 2.5, 19) RETURNING id`,
      [eventId, categoryId],
    );
    return {
      eventId: eventId as string,
      productId: productId as string,
      categoryId: categoryId as string,
    };
  }

  async function order(
    organizationId: string,
    ev: { eventId: string; productId: string; categoryId: string },
    o: {
      status?: string;
      paymentStatus?: string;
      source?: string;
      isTest?: boolean;
    } = {},
  ): Promise<string> {
    const [{ id }] = await sql(
      `INSERT INTO orders (organization_id, event_id, order_number, daily_number, customer_name,
                           customer_phone, notes, status, payment_status, source, subtotal, total,
                           paid_amount, is_test)
       VALUES ($1, $2, $3, 1, 'Max Gast', '0170 1234', 'Shop · max@gast.example', $4, $5, $6, 2.5, 2.5, 2.5, $7)
       RETURNING id`,
      [
        organizationId,
        ev.eventId,
        `A-${randomUUID().slice(0, 8)}`,
        o.status ?? 'open',
        o.paymentStatus ?? 'unpaid',
        o.source ?? 'pos',
        o.isTest ?? false,
      ],
    );
    await sql(
      `INSERT INTO order_items (order_id, product_id, category_id, product_name, category_name,
                                quantity, unit_price, total_price, tax_rate, notes)
       VALUES ($1, $2, $3, 'Apfelschorle', 'Getränke', 1, 2.5, 2.5, 19, 'für Max')`,
      [id, ev.productId, ev.categoryId],
    );
    return id as string;
  }

  async function endpoint(
    organizationId: string,
    userId: string,
    o: {
      eventTypes?: string[];
      active?: boolean;
      includeGuestData?: boolean;
      includeTestOrders?: boolean;
      url?: string;
    } = {},
  ) {
    return service.create(
      organizationId,
      { id: userId },
      {
        url: o.url ?? 'https://hooks.example.org/openeos',
        eventTypes: o.eventTypes ?? ['order.created'],
        active: o.active,
        includeGuestData: o.includeGuestData,
        includeTestOrders: o.includeTestOrders,
      },
    );
  }

  const outbox = (organizationId: string) =>
    sql(
      `SELECT event_type, resource_id, data FROM webhook_outbox WHERE organization_id = $1 ORDER BY id`,
      [organizationId],
    );
  const outboxTypes = async (organizationId: string) =>
    (await outbox(organizationId)).map((r) => r.event_type);
  const clearOutbox = (organizationId: string) =>
    sql(`DELETE FROM webhook_outbox WHERE organization_id = $1`, [
      organizationId,
    ]);
  const later = () => new Date(Date.now() + 10_000);
  const deliveriesOf = (endpointId: string) =>
    sql(
      `SELECT * FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at, event_type`,
      [endpointId],
    );

  // ---------- Trigger ----------

  describe('triggers', () => {
    it('record nothing while the organization has no active endpoint', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const first = await order(o, ev, {
        paymentStatus: 'paid',
        source: 'online',
      });
      await endpoint(o, u.id, { active: false });
      await order(o, ev, { paymentStatus: 'paid' });
      // Gewoehnliche Schreibvorgaenge laufen unberuehrt durch.
      await sql(`UPDATE orders SET status = 'completed' WHERE id = $1`, [
        first,
      ]);
      await sql(
        `UPDATE products SET price = 3, stock_quantity = 5, deleted_at = now() WHERE id = $1`,
        [ev.productId],
      );
      await sql(`UPDATE events SET status = 'active' WHERE id = $1`, [
        ev.eventId,
      ]);
      await sql(
        `INSERT INTO payments (order_id, amount, payment_method, payment_provider, status)
         VALUES ($1, 2.5, 'cash', 'CASH', 'captured')`,
        [first],
      );
      expect(await outbox(o)).toEqual([]);
    });

    it('map order inserts and transitions to event types', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      await endpoint(o, u.id);

      const shop = await order(o, ev, {
        paymentStatus: 'paid',
        source: 'online',
      });
      expect(await outboxTypes(o)).toEqual([
        'order.created',
        'shop.order.created',
        'order.paid',
      ]);
      await clearOutbox(o);

      const pos = await order(o, ev);
      await sql(`UPDATE orders SET notes = 'x', total = 3 WHERE id = $1`, [
        pos,
      ]);
      expect(await outboxTypes(o)).toEqual(['order.created']);
      await sql(
        `UPDATE orders SET payment_status = 'partly_paid' WHERE id = $1`,
        [pos],
      );
      await sql(`UPDATE orders SET payment_status = 'paid' WHERE id = $1`, [
        pos,
      ]);
      await sql(`UPDATE orders SET payment_status = 'paid' WHERE id = $1`, [
        pos,
      ]);
      await sql(`UPDATE orders SET status = 'completed' WHERE id = $1`, [pos]);
      await sql(`UPDATE orders SET status = 'completed' WHERE id = $1`, [pos]);
      await sql(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [shop]);
      expect(await outboxTypes(o)).toEqual([
        'order.created',
        'order.paid',
        'order.completed',
        'order.cancelled',
      ]);
    });

    it('payments (captured only, once), refunds, pfand returns, closings, events, products', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const orderId = await order(o, ev);
      await endpoint(o, u.id);
      await clearOutbox(o);

      const [{ id: pending }] = await sql(
        `INSERT INTO payments (order_id, amount, payment_method, payment_provider, status)
         VALUES ($1, 2.5, 'card', 'SUMUP', 'pending') RETURNING id`,
        [orderId],
      );
      expect(await outboxTypes(o)).toEqual([]);
      await sql(`UPDATE payments SET status = 'captured' WHERE id = $1`, [
        pending,
      ]);
      await sql(`UPDATE payments SET metadata = '{"x":1}' WHERE id = $1`, [
        pending,
      ]);
      await sql(
        `INSERT INTO payments (order_id, amount, payment_method, payment_provider, status)
         VALUES ($1, 1, 'cash', 'CASH', 'captured')`,
        [orderId],
      );
      await sql(
        `INSERT INTO refunds (organization_id, order_id, event_id, refund_number, kind, amount, payment_method, status, provider, reason_code, reason_text)
         VALUES ($1, $2, $3, 'R-1', 'refund', -1, 'cash', 'completed', 'cash', 'quality', 'Gast Frau Schulz')`,
        [o, orderId, ev.eventId],
      );
      await sql(
        `INSERT INTO pfand_returns (organization_id, event_id, total_amount, lines)
         VALUES ($1, $2, 2, '[{"pfandTypeId":"x","name":"Becher","unitAmount":2,"quantity":1}]')`,
        [o, ev.eventId],
      );
      await sql(
        `INSERT INTO cash_point_closings (organization_id, register_id, z_nr, business_date, period_to,
                                          closing_created_at, trigger, totals, master_data, rows, content_sha256)
         VALUES ($1, 'K1', 1, current_date, now(), now(), 'scheduled', '{}', '{}', '{}', repeat('a', 64))`,
        [o],
      );
      await sql(`UPDATE events SET status = 'active' WHERE id = $1`, [
        ev.eventId,
      ]);
      await sql(`UPDATE events SET name = 'Herbstfest' WHERE id = $1`, [
        ev.eventId,
      ]);
      await sql(
        `UPDATE products SET stock_quantity = stock_quantity - 1 WHERE id = $1`,
        [ev.productId],
      );
      await sql(
        `UPDATE products SET price = 3, is_available = false WHERE id = $1`,
        [ev.productId],
      );

      const rows = await outbox(o);
      expect(rows.map((r) => r.event_type)).toEqual([
        'payment.created',
        'payment.created',
        'refund.created',
        'pfand_return.created',
        'cash_point_closing.created',
        'event.activated',
        'product.updated',
      ]);
      expect(rows[6].data).toEqual({ changed: ['price', 'isAvailable'] });
    });

    it('never block a sale: a failing outbox insert only warns', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      await endpoint(o, u.id);
      const runner = ds.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query(
          `ALTER TABLE webhook_outbox RENAME TO webhook_outbox_gone`,
        );
        const inserted = rowsOf<Row>(
          await runner.query(
            `INSERT INTO orders (organization_id, event_id, order_number, daily_number, status, payment_status, source, total)
             VALUES ($1, $2, 'A-fail', 1, 'completed', 'paid', 'pos', 1) RETURNING id`,
            [o, ev.eventId],
          ),
        );
        expect(inserted).toHaveLength(1);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
      expect(await one(`SELECT to_regclass('webhook_outbox') AS t`)).toEqual({
        t: 'webhook_outbox',
      });
    });
  });

  // ---------- Verteilung ----------

  describe('dispatch', () => {
    it('fans out per subscribed active endpoint; test orders and guest data per endpoint', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const plain = await endpoint(o, u.id, { eventTypes: ['order.paid'] });
      const rich = await endpoint(o, u.id, {
        eventTypes: ['order.paid', 'order.created'],
        includeGuestData: true,
        includeTestOrders: true,
      });
      await endpoint(o, u.id, { eventTypes: ['order.paid'], active: false });

      const real = await order(o, ev, { paymentStatus: 'paid' });
      const test = await order(o, ev, { paymentStatus: 'paid', isTest: true });

      // Vor Ablauf der Wartezeit bleibt der Postausgang liegen.
      expect(
        await dispatcher.dispatchBatch(new Date(Date.now() - 60_000)),
      ).toBe(0);
      expect(await dispatcher.dispatchBatch(later())).toBe(5);
      expect(await outbox(o)).toEqual([]);

      const plainRows = await deliveriesOf(plain.id);
      expect(plainRows).toHaveLength(1);
      const plainBody = JSON.parse(plainRows[0].payload as string);
      expect(plainBody).toMatchObject({
        type: 'order.paid',
        apiVersion: '2026-11-10',
        organizationId: o,
        data: { order: { id: real, isTest: false, amounts: { total: 2.5 } } },
      });
      expect(plainBody.data.order).not.toHaveProperty('guest');
      expect(plainRows[0].payload).not.toContain('Max Gast');

      const richRows = await deliveriesOf(rich.id);
      expect(richRows.map((r) => r.event_type).sort()).toEqual([
        'order.created',
        'order.created',
        'order.paid',
        'order.paid',
      ]);
      const richPaidReal = richRows
        .map((r) => JSON.parse(r.payload as string))
        .find((b) => b.type === 'order.paid' && b.data.order.id === real);
      expect(richPaidReal.data.order.guest).toEqual({
        name: 'Max Gast',
        phone: '0170 1234',
        notes: 'Shop · max@gast.example',
      });
      // Dieselbe Ereignis-ID fuer dasselbe Ereignis an mehrere Endpunkte.
      expect(richPaidReal.id).toBe(plainBody.id);
      expect(
        richRows.some(
          (r) => JSON.parse(r.payload as string).data.order.id === test,
        ),
      ).toBe(true);
    });

    it('orders_only („Nur Bons“): no amounts, no payment events', async () => {
      const o = await org({ operatingMode: 'orders_only' });
      const u = await admin(o);
      const ev = await event(o);
      const ep = await endpoint(o, u.id, {
        eventTypes: ['order.created', 'payment.created'],
      });
      const orderId = await order(o, ev);
      await sql(
        `INSERT INTO payments (order_id, amount, payment_method, payment_provider, status)
         VALUES ($1, 2.5, 'cash', 'CASH', 'captured')`,
        [orderId],
      );
      await dispatcher.dispatchBatch(later());
      const rows = await deliveriesOf(ep.id);
      expect(rows.map((r) => r.event_type)).toEqual(['order.created']);
      const body = JSON.parse(rows[0].payload as string);
      expect(body.data.order.amounts).toBeNull();
      expect(body.data.order.items[0]).not.toHaveProperty('unitPrice');
    });

    it('drops events whose record is gone', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const ep = await endpoint(o, u.id);
      const orderId = await order(o, ev);
      await sql(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);
      await sql(`DELETE FROM orders WHERE id = $1`, [orderId]);
      await dispatcher.dispatchBatch(later());
      expect(await deliveriesOf(ep.id)).toEqual([]);
      expect(await outbox(o)).toEqual([]);
    });
  });

  // ---------- Zustellung ----------

  describe('delivery', () => {
    it('signs with the secret shown once and sends the stored body', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const ep = await endpoint(o, u.id);
      await order(o, ev);
      await dispatcher.dispatchBatch(later());
      expect(await delivery.deliverDue(later())).toBe(1);

      expect(sent).toHaveLength(1);
      const [request] = sent;
      const [row] = await deliveriesOf(ep.id);
      expect(request.body).toBe(row.payload);
      expect(request.headers['OpenEOS-Event-Id']).toBe(row.event_id);
      expect(request.headers['OpenEOS-Event-Type']).toBe('order.created');
      expect(request.headers['OpenEOS-Delivery-Id']).toBe(row.id);
      expect(request.headers['OpenEOS-Delivery-Attempt']).toBe('1');
      expect(request.timeoutMs).toBe(10_000);
      expect(
        verifyWebhookSignature(
          ep.secret,
          request.headers['OpenEOS-Signature'],
          request.body,
        ),
      ).toEqual({ valid: true });
      expect(row).toMatchObject({
        status: 'succeeded',
        attempts: 1,
        response_status: 200,
        error: null,
      });

      const view = await service.get(o, ep.id);
      expect(view.lastDeliveryStatus).toBe('succeeded');
      expect(view.lastSuccessAt).not.toBeNull();
      expect(view).not.toHaveProperty('secretEncrypted');
      expect(JSON.stringify(view)).not.toContain(ep.secret);
      // Kein Geheimnis im Protokoll.
      expect(JSON.stringify(await deliveriesOf(ep.id))).not.toContain(
        ep.secret,
      );
    });

    it('retries with backoff, then fails after 8 attempts', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const ep = await endpoint(o, u.id);
      await order(o, ev);
      await dispatcher.dispatchBatch(later());
      respond = () => ({
        ok: false,
        responseStatus: 503,
        responseBody: 'down',
        durationMs: 5,
        error: 'HTTP_ERROR',
      });

      let now = later();
      const gaps: number[] = [];
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        expect(await delivery.deliverDue(now)).toBe(1);
        const [row] = await deliveriesOf(ep.id);
        expect(row.attempts).toBe(attempt);
        if (attempt < 8) {
          expect(row.status).toBe('pending');
          const next = new Date(row.next_attempt_at as string);
          gaps.push(
            Math.round(
              (next.getTime() -
                new Date(row.last_attempt_at as string).getTime()) /
                60_000,
            ),
          );
          // vor dem naechsten Termin passiert nichts
          expect(
            await delivery.deliverDue(new Date(next.getTime() - 5_000)),
          ).toBe(0);
          now = new Date(next.getTime() + 1_000);
        } else {
          expect(row).toMatchObject({
            status: 'failed',
            error: 'HTTP_ERROR',
            next_attempt_at: null,
          });
          expect(row.attempt_log).toHaveLength(8);
        }
      }
      // Minuten (gerundet; der Versuch selbst dauert ein paar ms)
      expect(gaps).toEqual([1, 5, 30, 120, 300, 480, 480]);
      expect(sent.map((r) => r.headers['OpenEOS-Delivery-Attempt'])).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
      ]);
      // Jeder Versuch derselbe Text und dieselbe Ereignis-ID.
      expect(new Set(sent.map((r) => r.body)).size).toBe(1);
    });

    it('auto-disables after N consecutive failures over the minimum time, mails admins, ends pending', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const ep = await endpoint(o, u.id);
      await order(o, ev);
      await order(o, ev);
      await order(o, ev);
      await order(o, ev);
      await dispatcher.dispatchBatch(later());
      respond = () => ({
        ok: false,
        responseStatus: null,
        responseBody: null,
        durationMs: 10_000,
        error: 'TIMEOUT',
      });

      // Drei Fehlversuche, aber erst seit Kurzem: bleibt an.
      await delivery.deliverDue(later());
      let view = await service.get(o, ep.id);
      expect(view.active).toBe(true);
      // Je Takt hoechstens drei Zustellungen je Endpunkt.
      expect(view.consecutiveFailures).toBe(3);
      // Die Serie laeuft schon zwei Stunden.
      await sql(
        `UPDATE webhook_endpoints SET failing_since = now() - interval '2 hours' WHERE id = $1`,
        [ep.id],
      );
      await sql(
        `UPDATE webhook_deliveries SET next_attempt_at = now() WHERE endpoint_id = $1 AND status = 'pending'`,
        [ep.id],
      );
      // Nur einer kommt dran (Concurrency 1 fuer einen klaren Ablauf).
      const first = (await deliveriesOf(ep.id))[0];
      await sql(
        `UPDATE webhook_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE endpoint_id = $1 AND id <> $2 AND status = 'pending'`,
        [ep.id, first.id],
      );
      await delivery.deliverDue(new Date(Date.now() + 1_000));

      view = await service.get(o, ep.id);
      expect(view).toMatchObject({
        active: false,
        disabledReason: 'too_many_failures',
      });
      expect(view.disabledAt).not.toBeNull();
      expect(mails).toEqual([{ to: u.email, url: ep.url, failures: 4 }]);
      const audit = await one(
        `SELECT action, admin_user_id FROM admin_audit_logs WHERE resource_id = $1 AND action = 'webhook_auto_disabled'`,
        [ep.id],
      );
      expect(audit).toEqual({
        action: 'webhook_auto_disabled',
        admin_user_id: null,
      });
      const states = (await deliveriesOf(ep.id)).map(
        (r) => `${String(r.status)}:${String(r.error)}`,
      );
      // Der eben gescheiterte und die drei wartenden.
      expect(
        states.filter((s) => s === 'failed:ENDPOINT_INACTIVE'),
      ).toHaveLength(4);

      // Wieder einschalten setzt alles zurueck.
      view = await service.update(o, ep.id, { id: u.id }, { active: true });
      expect(view).toMatchObject({
        active: true,
        disabledReason: null,
        consecutiveFailures: 0,
        failingSince: null,
      });
    });

    it('manual test failures do not count, success resets the streak; inactive endpoints get no automatic sends', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const ep = await endpoint(o, u.id);
      respond = () => ({
        ok: false,
        responseStatus: 500,
        responseBody: null,
        durationMs: 1,
        error: 'HTTP_ERROR',
      });
      const test = await service.sendTest(o, ep.id);
      expect(test).toMatchObject({
        eventType: 'ping',
        manual: true,
        maxAttempts: 1,
        status: 'pending',
      });
      expect(kick).toHaveBeenCalled();
      await delivery.deliverDue(later());
      expect(JSON.parse(sent[0].body)).toMatchObject({
        type: 'ping',
        data: { webhookId: ep.id },
      });
      let row = (await deliveriesOf(ep.id))[0];
      expect(row).toMatchObject({ status: 'failed', attempts: 1 });
      expect((await service.get(o, ep.id)).consecutiveFailures).toBe(0);

      // Ausgeschaltet: automatische Zustellungen enden ohne Versand.
      await order(o, ev);
      await dispatcher.dispatchBatch(later());
      await sql(`UPDATE webhook_endpoints SET active = false WHERE id = $1`, [
        ep.id,
      ]);
      sent.length = 0;
      await delivery.deliverDue(later());
      expect(sent).toHaveLength(0);
      row = (await deliveriesOf(ep.id)).find(
        (r) => r.event_type === 'order.created',
      )!;
      expect(row).toMatchObject({
        status: 'failed',
        error: 'ENDPOINT_INACTIVE',
        attempts: 0,
      });

      // „Test senden“ geht auch ausgeschaltet.
      respond = () => ({
        ok: true,
        responseStatus: 204,
        responseBody: null,
        durationMs: 1,
        error: null,
      });
      await service.sendTest(o, ep.id);
      await delivery.deliverDue(later());
      expect(sent).toHaveLength(1);
    });

    it('sends the events of one endpoint in order, at most three per round', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      await endpoint(o, u.id, {
        eventTypes: ['order.created', 'order.paid', 'order.completed'],
      });
      const first = await order(o, ev);
      await sql(
        `UPDATE orders SET payment_status = 'paid', status = 'completed' WHERE id = $1`,
        [first],
      );
      const second = await order(o, ev);
      await dispatcher.dispatchBatch(later());
      expect(await delivery.deliverDue(later())).toBe(3);
      expect(await delivery.deliverDue(later())).toBe(1);
      expect(
        sent.map((r) => {
          const body = JSON.parse(r.body);
          return `${body.type} ${body.data.order.id === first ? 1 : body.data.order.id === second ? 2 : '?'}`;
        }),
      ).toEqual([
        'order.created 1',
        'order.paid 1',
        'order.completed 1',
        'order.created 2',
      ]);
    });

    it('takes over deliveries whose instance died mid-attempt (lease)', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const ep = await endpoint(o, u.id);
      await order(o, ev);
      await dispatcher.dispatchBatch(later());
      await sql(
        `UPDATE webhook_deliveries SET status = 'delivering', locked_until = now() + interval '1 minute' WHERE endpoint_id = $1`,
        [ep.id],
      );
      expect(await delivery.deliverDue(later())).toBe(0);
      expect(await delivery.deliverDue(new Date(Date.now() + 5 * 60_000))).toBe(
        1,
      );
      expect((await deliveriesOf(ep.id))[0].status).toBe('succeeded');
    });
  });

  // ---------- Verwaltung ----------

  describe('management', () => {
    it('validates URLs and event types and enforces the limit', async () => {
      const o = await org();
      const u = await admin(o);
      const create = (url: string, eventTypes = ['order.paid']) =>
        service.create(o, { id: u.id }, { url, eventTypes });
      const reasonOf = async (p: Promise<unknown>) =>
        p.then(
          () => 'ok',
          (e: {
            getResponse: () => { reason: string; params?: { reason?: string } };
          }) =>
            `${e.getResponse().reason}:${e.getResponse().params?.reason ?? ''}`,
        );

      expect(await reasonOf(create('http://hooks.example.org/'))).toBe(
        'WEBHOOK_URL_INVALID:not_https',
      );
      expect(await reasonOf(create('https://a:b@hooks.example.org/'))).toBe(
        'WEBHOOK_URL_INVALID:credentials',
      );
      expect(await reasonOf(create('https://db.internal/'))).toBe(
        'WEBHOOK_URL_INVALID:private_address',
      );
      expect(
        await reasonOf(create('https://169.254.169.254/latest/meta-data')),
      ).toBe('WEBHOOK_URL_INVALID:private_address');
      expect(await reasonOf(create('https://nx.example.org/'))).toBe(
        'WEBHOOK_URL_INVALID:unresolvable',
      );
      expect(
        await reasonOf(
          create('https://hooks.example.org/', ['order.paid', 'ping']),
        ),
      ).toBe('WEBHOOK_EVENT_TYPE_INVALID:');

      const created = await create('https://hooks.example.org/1');
      expect(created.secret).toMatch(/^whsec_/);
      expect(created.secretHint).toBe(`${created.secret.slice(0, 10)}…`);
      expect(created.createdBy).toEqual({
        id: u.id,
        firstName: 'Erika',
        lastName: 'Muster',
      });
      await create('https://hooks.example.org/2');
      await create('https://hooks.example.org/3');
      expect(await reasonOf(create('https://hooks.example.org/4'))).toBe(
        'WEBHOOK_LIMIT_REACHED:',
      );

      const list = await service.list(o);
      expect(list).toHaveLength(3);
      for (const entry of list) {
        expect(entry).not.toHaveProperty('secret');
        expect(entry).not.toHaveProperty('secretEncrypted');
      }
      const actions = await sql(
        `SELECT action FROM admin_audit_logs WHERE organization_id = $1 AND resource_type = 'webhook'`,
        [o],
      );
      expect(actions).toHaveLength(3);
    });

    it('keeps organizations apart', async () => {
      const a = await org();
      const ua = await admin(a);
      const b = await org();
      const ep = await endpoint(a, ua.id);
      const reasonOf = (p: Promise<unknown>) =>
        p.then(
          () => 'ok',
          (e: { getResponse: () => { reason: string } }) =>
            e.getResponse().reason,
        );
      expect(await reasonOf(service.get(b, ep.id))).toBe('WEBHOOK_NOT_FOUND');
      expect(await reasonOf(service.listDeliveries(b, ep.id, {}))).toBe(
        'WEBHOOK_NOT_FOUND',
      );
      expect(
        await reasonOf(
          service.update(b, ep.id, { id: ua.id }, { active: false }),
        ),
      ).toBe('WEBHOOK_NOT_FOUND');
      expect(await reasonOf(service.remove(b, ep.id, { id: ua.id }))).toBe(
        'WEBHOOK_NOT_FOUND',
      );
      expect(await reasonOf(service.sendTest(b, ep.id))).toBe(
        'WEBHOOK_NOT_FOUND',
      );
      const test = await service.sendTest(a, ep.id);
      expect(await reasonOf(service.getDelivery(b, ep.id, test.id))).toBe(
        'WEBHOOK_NOT_FOUND',
      );
      expect(await reasonOf(service.redeliver(a, randomUUID(), test.id))).toBe(
        'WEBHOOK_NOT_FOUND',
      );
      expect(await service.list(b)).toEqual([]);
    });

    it('rotates the secret with a 24 h overlap (two signatures)', async () => {
      const o = await org();
      const u = await admin(o);
      const ep = await endpoint(o, u.id);
      const rotated = await service.rotateSecret(o, ep.id, { id: u.id });
      expect(rotated.secret).not.toBe(ep.secret);
      const expires = new Date(rotated.previousSecretExpiresAt!).getTime();
      expect(Math.abs(expires - Date.now() - 24 * 3_600_000)).toBeLessThan(
        60_000,
      );

      await service.sendTest(o, ep.id);
      await delivery.deliverDue(later());
      const header = sent[0].headers['OpenEOS-Signature'];
      expect(header.match(/v1=/g)).toHaveLength(2);
      expect(
        verifyWebhookSignature(rotated.secret, header, sent[0].body).valid,
      ).toBe(true);
      expect(
        verifyWebhookSignature(ep.secret, header, sent[0].body).valid,
      ).toBe(true);

      // Nach Ablauf nur noch das neue.
      await sql(
        `UPDATE webhook_endpoints SET previous_secret_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [ep.id],
      );
      sent.length = 0;
      await service.sendTest(o, ep.id);
      await delivery.deliverDue(later());
      const after = sent[0].headers['OpenEOS-Signature'];
      expect(after.match(/v1=/g)).toHaveLength(1);
      expect(verifyWebhookSignature(ep.secret, after, sent[0].body).valid).toBe(
        false,
      );
    });

    it('redelivers with the same event id and body, lists and pages the log, deletes with the endpoint', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const ep = await endpoint(o, u.id);
      await order(o, ev);
      await dispatcher.dispatchBatch(later());
      await delivery.deliverDue(later());
      const [original] = await deliveriesOf(ep.id);

      const again = await service.redeliver(o, ep.id, original.id as string);
      expect(again).toMatchObject({
        eventId: original.event_id,
        eventType: 'order.created',
        manual: true,
        redeliveryOf: original.id,
        maxAttempts: 1,
      });
      await delivery.deliverDue(later());
      expect(sent[0].body).toBe(sent[1].body);
      expect(sent[0].headers['OpenEOS-Event-Id']).toBe(
        sent[1].headers['OpenEOS-Event-Id'],
      );
      expect(sent[0].headers['OpenEOS-Delivery-Id']).not.toBe(
        sent[1].headers['OpenEOS-Delivery-Id'],
      );

      const page = await service.listDeliveries(o, ep.id, {
        page: 1,
        limit: 1,
      });
      expect(page.meta).toMatchObject({
        page: 1,
        limit: 1,
        total: 2,
        totalPages: 2,
        hasNext: true,
      });
      expect(page.data[0].id).toBe(again.id);
      expect(page.data[0]).not.toHaveProperty('payload');
      const failedOnly = await service.listDeliveries(o, ep.id, {
        status: 'failed',
      });
      expect(failedOnly.meta.total).toBe(0);

      const detail = await service.getDelivery(o, ep.id, original.id as string);
      expect(detail.payload).toMatchObject({
        type: 'order.created',
        organizationId: o,
      });
      expect(detail.responseBody).toBe('ok');
      expect(detail.attemptLog).toHaveLength(1);

      await service.remove(o, ep.id, { id: u.id });
      expect(await deliveriesOf(ep.id)).toEqual([]);
      expect(
        await one(
          `SELECT count(*)::int AS n FROM admin_audit_logs WHERE resource_id = $1 AND action = 'webhook_deleted'`,
          [ep.id],
        ),
      ).toEqual({ n: 1 });
    });
  });

  // ---------- Aufbewahrung ----------

  describe('retention', () => {
    it('deletes the log after 30 days; the dry run only counts', async () => {
      const o = await org();
      const u = await admin(o);
      const ep = await endpoint(o, u.id);
      const old = await service.sendTest(o, ep.id);
      const fresh = await service.sendTest(o, ep.id);
      await sql(
        `UPDATE webhook_deliveries SET created_at = now() - interval '31 days' WHERE id = $1`,
        [old.id],
      );
      await sql(
        `UPDATE webhook_deliveries SET created_at = now() - interval '29 days' WHERE id = $1`,
        [fresh.id],
      );

      const job = new WebhookDeliveriesJob(delivery);
      const counts: Record<string, number> = {};
      const ctx = (dryRun: boolean): RetentionRunContext => ({
        now: new Date(),
        dryRun,
        manager: ds.manager,
        config: {} as RetentionRunContext['config'],
        removed: (key, n) => {
          counts[key] = (counts[key] ?? 0) + n;
        },
        note: () => undefined,
        afterCommit: () => undefined,
      });
      await job.run(ctx(true));
      expect(counts.deliveriesDeleted).toBeGreaterThanOrEqual(1);
      expect((await deliveriesOf(ep.id)).map((r) => r.id).sort()).toEqual(
        [old.id, fresh.id].sort(),
      );

      await job.run(ctx(false));
      expect((await deliveriesOf(ep.id)).map((r) => r.id)).toEqual([fresh.id]);
    });
  });

  // ---------- Phasen ----------

  describe('event.phase_changed', () => {
    it('remembers the first phase silently and reports changes', async () => {
      const o = await org();
      const u = await admin(o);
      const ev = await event(o);
      const ep = await endpoint(o, u.id, {
        eventTypes: ['event.phase_changed'],
      });
      phases.set(ev.eventId, 'planned');
      expect(await tracker.run()).toBe(0);
      expect(await outbox(o)).toEqual([]);
      expect(await tracker.run()).toBe(0);

      phases.set(ev.eventId, 'active');
      expect(await tracker.run()).toBe(1);
      expect(await outbox(o)).toEqual([
        {
          event_type: 'event.phase_changed',
          resource_id: ev.eventId,
          data: { previousPhase: 'planned', phase: 'active' },
        },
      ]);
      await dispatcher.dispatchBatch(later());
      const [row] = await deliveriesOf(ep.id);
      expect(JSON.parse(row.payload as string).data).toMatchObject({
        previousPhase: 'planned',
        phase: 'active',
        event: { id: ev.eventId, name: 'Sommerfest', phase: 'active' },
      });
    });
  });
});
