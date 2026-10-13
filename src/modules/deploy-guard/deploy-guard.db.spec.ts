import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { Order } from '../../database/entities';
import { DeployGuardService } from './deploy-guard.service';

/**
 * Die Abfrage des Deploy-Schutzes gegen ein echtes Postgres.
 *
 * Laeuft nur mit einer Wegwerf-Datenbank, z. B.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_deployguard_scratch pnpm test
 *
 * Der Name der Datenbank muss auf `_test` oder `_scratch` enden. Die Tests
 * rechnen mit einem festen "jetzt" in der Zukunft, damit andere Daten in
 * derselben Datenbank nicht ins Fenster fallen.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('DeployGuardService against Postgres', () => {
  let ds: DataSource;
  let service: DeployGuardService;
  const orgIds: string[] = [];
  const now = new Date('2031-06-01T18:00:00.000Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  let orderNumber = 0;

  beforeAll(async () => {
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(
        `Database "${name}" does not end in _test/_scratch — aborting.`,
      );
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
    service = new DeployGuardService(ds.getRepository(Order));
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

  async function seedEvent(
    status: string,
    name: string,
    deleted = false,
  ): Promise<{ orgId: string; eventId: string }> {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin)
       VALUES ($1, 'Testverein', $2, '123456')`,
      [orgId, `testverein-${orgId}`],
    );
    const [row] = await ds.query<{ id: string }[]>(
      `INSERT INTO events (organization_id, name, status, deleted_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, name, status, deleted ? now : null],
    );
    return { orgId, eventId: row.id };
  }

  async function seedOrder(
    ev: { orgId: string; eventId: string },
    createdAt: Date,
    isTest = false,
  ) {
    orderNumber += 1;
    await ds.query(
      `INSERT INTO orders (organization_id, event_id, order_number,
         daily_number, is_test, total, created_at)
       VALUES ($1, $2, $3, $4, $5, 7, $6)`,
      [
        ev.orgId,
        ev.eventId,
        `DG-${orderNumber}`,
        orderNumber,
        isTest,
        createdAt,
      ],
    );
  }

  it('reports a festival only for real orders of active events', async () => {
    const selling = await seedEvent('active', 'Sommerfest');
    await seedOrder(selling, minutesAgo(50));
    await seedOrder(selling, minutesAgo(5));

    const quiet = await seedEvent('active', 'Ruhig');
    await seedOrder(quiet, minutesAgo(45));

    const testOnly = await seedEvent('active', 'Nur Testbuchungen');
    await seedOrder(testOnly, minutesAgo(2), true);

    const testMode = await seedEvent('test', 'Im Testmodus');
    await seedOrder(testMode, minutesAgo(2));

    const deleted = await seedEvent('active', 'Geloescht', true);
    await seedOrder(deleted, minutesAgo(2));

    const status = await service.status(30, now);

    expect(status.busy).toBe(true);
    expect(status.events).toEqual([
      { name: 'Sommerfest', lastOrderAt: minutesAgo(5).toISOString() },
    ]);
  });

  it('widens the window on request', async () => {
    const status = await service.status(60, now);
    expect(status.events.map((e) => e.name)).toEqual(['Sommerfest', 'Ruhig']);
  });

  it('is quiet once the last real order is older than the window', async () => {
    const later = new Date(now.getTime() + 40 * 60_000);
    await expect(service.status(30, later)).resolves.toMatchObject({
      busy: false,
      events: [],
    });
  });
});
