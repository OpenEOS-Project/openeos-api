import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../config/where-values';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Event, Order, Organization } from '../../database/entities';
import { saveOrderWithNumbers } from '../orders/order-numbering';
import { GatewayService } from '../gateway/gateway.service';
import { CronLockService } from '../../common/redis/cron-lock.service';
import { DeploymentService } from '../../common/services/deployment.service';
import { TestOrderCleanupService } from './test-order-cleanup.service';
import { EventPhaseService } from './event-phase.service';
import { EventPhaseTransitionService } from './event-phase-transition.service';

/**
 * Phasen gegen ein echtes Postgres: Testbestellungen im Zustand „Geplant“
 * und ihr Aufraeumen zu Beginn des Verkaufsfensters.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_phase_scratch pnpm test
 *
 * Datenbankname muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

// Fest 16.–17.11.2026 (reine Daten), Verkaufsfenster 15.11. 18:00 – 18.11. 12:00
const START = '2026-11-15T23:00:00.000Z';
const END = '2026-11-16T23:00:00.000Z';
const PLANNED = new Date('2026-11-10T12:00:00Z');
const ACTIVE = new Date('2026-11-15T17:00:30Z');
const ENDED = new Date('2026-11-18T11:00:00Z');

describeWithDb('Event phases against Postgres', () => {
  let ds: DataSource;
  let phase: EventPhaseService;
  let transition: EventPhaseTransitionService;
  const gateway = {
    notifyOrderUpdated: jest.fn(),
    notifyMenuRefresh: jest.fn(),
    notifyTablesUpdated: jest.fn(),
    notifyEventStatusChanged: jest.fn(),
  };
  const orgIds: string[] = [];

  function build(billingEnabled = true) {
    const deployment = { billingEnabled } as DeploymentService;
    phase = new EventPhaseService(
      { get: () => undefined } as unknown as ConfigService,
      deployment,
      ds.getRepository(Organization),
      ds.getRepository(Order),
    );
    transition = new EventPhaseTransitionService(
      ds.getRepository(Event),
      phase,
      new TestOrderCleanupService(gateway as unknown as GatewayService),
      {} as CronLockService,
      deployment,
      gateway as unknown as GatewayService,
    );
  }

  beforeAll(async () => {
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
    build();
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

  beforeEach(() => build());

  async function seed(
    options: { status?: string; billing?: string; salesStartedAt?: Date } = {},
  ): Promise<{ orgId: string; eventId: string }> {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings)
       VALUES ($1, 'Testverein', $2, '123456', '{"timezone":"Europe/Berlin"}')`,
      [orgId, `phase-${orgId}`],
    );
    const [row] = await ds.query<{ id: string }[]>(
      `INSERT INTO events (organization_id, name, status, billing_status,
         start_date, end_date, sales_started_at)
       VALUES ($1, 'Herbstfest', $2, $3, $4, $5, $6) RETURNING id`,
      [
        orgId,
        options.status ?? 'active',
        options.billing ?? 'paid',
        START,
        END,
        options.salesStartedAt ?? null,
      ],
    );
    return { orgId, eventId: row.id };
  }

  async function order(
    orgId: string,
    eventId: string,
    plannedTest: boolean,
  ): Promise<Order> {
    return saveOrderWithNumbers(
      ds.getRepository(Order),
      { organizationId: orgId, eventId, plannedTest },
      { total: 5 },
    );
  }

  async function orders(eventId: string) {
    return ds.query<{ id: string; is_test: boolean }[]>(
      `SELECT id, is_test FROM orders WHERE event_id = $1 ORDER BY created_at`,
      [eventId],
    );
  }

  it('saveOrderWithNumbers: plannedTest marks orders of an active event as test', async () => {
    const { orgId, eventId } = await seed();
    expect((await order(orgId, eventId, true)).isTest).toBe(true);
    expect((await order(orgId, eventId, false)).isTest).toBe(false);
  });

  it('saveOrderWithNumbers: plannedTest is ignored when the event is not active', async () => {
    const inactive = await seed({ status: 'inactive' });
    expect((await order(inactive.orgId, inactive.eventId, true)).isTest).toBe(
      false,
    );
    const test = await seed({ status: 'test', billing: 'none' });
    expect((await order(test.orgId, test.eventId, false)).isTest).toBe(true);
  });

  it('window start: test orders and test deposit returns go, real orders stay', async () => {
    const { orgId, eventId } = await seed();
    const testOrder = await order(orgId, eventId, true);
    const presale = await order(orgId, eventId, false); // Vorverkauf im Shop
    await ds.query(
      `INSERT INTO pfand_returns (organization_id, event_id, is_test, total_amount, lines)
       VALUES ($1, $2, true, 2, '[]'), ($1, $2, false, 1, '[]')`,
      [orgId, eventId],
    );

    expect(await transition.run(PLANNED)).not.toContain(eventId);
    expect(await orders(eventId)).toHaveLength(2);

    expect(await transition.run(ACTIVE)).toContain(eventId);
    const left = await orders(eventId);
    expect(left.map((o) => o.id)).toEqual([presale.id]);
    expect(left.map((o) => o.id)).not.toContain(testOrder.id);
    const pfand = await ds.query<{ is_test: boolean }[]>(
      `SELECT is_test FROM pfand_returns WHERE event_id = $1`,
      [eventId],
    );
    expect(pfand).toEqual([{ is_test: false }]);
    const [event] = await ds.query<{ sales_started_at: Date | null }[]>(
      `SELECT sales_started_at FROM events WHERE id = $1`,
      [eventId],
    );
    expect(event.sales_started_at).not.toBeNull();
    expect(gateway.notifyEventStatusChanged).toHaveBeenCalled();

    // Zweiter Lauf: nichts mehr zu tun; neue echte Bestellungen bleiben.
    await order(orgId, eventId, false);
    expect(await transition.run(ACTIVE)).not.toContain(eventId);
    expect(await orders(eventId)).toHaveLength(2);
  });

  it('existing event already in its window (deploy): real orders are never touched', async () => {
    const { orgId, eventId } = await seed();
    await order(orgId, eventId, false);
    await order(orgId, eventId, false);
    expect(await transition.run(ENDED)).toContain(eventId);
    expect(await orders(eventId)).toHaveLength(2);
  });

  it('skips legacy active events without unlock, inactive events and finished transitions', async () => {
    const legacy = await seed({ billing: 'none' });
    const inactive = await seed({ status: 'inactive' });
    const done = await seed({
      salesStartedAt: new Date('2026-11-15T17:01:00Z'),
    });
    for (const fixture of [legacy, inactive, done]) {
      await ds.query(
        `INSERT INTO orders (organization_id, event_id, order_number, daily_number, is_test, total)
         VALUES ($1, $2, 'T-1', 1, true, 1)`,
        [fixture.orgId, fixture.eventId],
      );
    }
    const result = await transition.run(ACTIVE);
    for (const fixture of [legacy, inactive, done]) {
      expect(result).not.toContain(fixture.eventId);
      expect(await orders(fixture.eventId)).toHaveLength(1);
    }
  });

  it('self-hosted: the transition also runs without billing', async () => {
    build(false);
    const { orgId, eventId } = await seed({ billing: 'none' });
    await order(orgId, eventId, true);
    expect(await transition.run(ACTIVE)).toContain(eventId);
    expect(await orders(eventId)).toHaveLength(0);
  });
});
