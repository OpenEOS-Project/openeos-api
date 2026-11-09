import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import {
  Device,
  Event,
  Order,
  OrderItem,
  Organization,
} from '../../database/entities';
import { OrderPrintService } from './order-print.service';
import { loadOrderStaff } from './order-staff';
import { PrintJobsService } from './print-jobs.service';
import { PrintRoutingService } from './print-routing.service';

/**
 * Bon-Elemente „Bedienung“/„Gerät“ gegen ein echtes Postgres: Namen nur aus
 * der Organisation der Bestellung.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5544/openeos_history_scratch pnpm test
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('order staff names against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const userIds: string[] = [];

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
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      if (userIds.length) {
        await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
          userIds,
        ]);
      }
      await ds.destroy();
    }
  });

  async function org(): Promise<string> {
    const id = randomUUID();
    orgIds.push(id);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin, settings, country, operating_mode)
       VALUES ($1, 'Feuerwehr', $2, '123456', '{}', 'DE', 'full')`,
      [id, `ff-${id}`],
    );
    return id;
  }

  async function device(orgId: string, name: string): Promise<string> {
    const [row] = await ds.query<{ id: string }[]>(
      `INSERT INTO devices (organization_id, name, type, device_token, settings)
       VALUES ($1, $2, 'pos', $3, '{}') RETURNING id`,
      [orgId, name, `tok-${randomUUID()}`],
    );
    return row.id;
  }

  async function user(
    first: string,
    last: string,
    memberOf: string | null,
  ): Promise<string> {
    const id = randomUUID();
    userIds.push(id);
    await ds.query(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, $3, $4)`,
      [id, `w-${id}@example.com`, first, last],
    );
    if (memberOf) {
      await ds.query(
        `INSERT INTO user_organizations (user_id, organization_id, role, permissions)
         VALUES ($1, $2, 'member', '{}')`,
        [id, memberOf],
      );
    }
    return id;
  }

  const staffOf = (
    organizationId: string,
    createdByDeviceId: string | null,
    createdByUserId: string | null,
  ) =>
    loadOrderStaff(ds.manager, {
      organizationId,
      createdByDeviceId,
      createdByUserId,
    });

  it('falls back to the ordering device of the same organization', async () => {
    const orgId = await org();
    const dev = await device(orgId, 'Handy Markus');
    expect(await staffOf(orgId, dev, null)).toEqual({
      userName: null,
      deviceName: 'Handy Markus',
    });
  });

  it('prefers a member who created the order', async () => {
    const orgId = await org();
    const dev = await device(orgId, 'Kasse 1');
    const markus = await user('Markus', 'Maier', orgId);
    expect(await staffOf(orgId, dev, markus)).toEqual({
      userName: 'Markus Maier',
      deviceName: 'Kasse 1',
    });
  });

  it('never prints names from another organization', async () => {
    const orgA = await org();
    const orgB = await org();
    const foreignDevice = await device(orgB, 'Fremdes Geraet');
    const foreignUser = await user('Fremde', 'Person', orgB);
    const noMember = await user('Kein', 'Mitglied', null);
    expect(await staffOf(orgA, foreignDevice, foreignUser)).toEqual({
      userName: null,
      deviceName: null,
    });
    expect(await staffOf(orgA, null, noMember)).toEqual({
      userName: null,
      deviceName: null,
    });
  });

  it('puts the device name on the kitchen ticket via OrderPrintService', async () => {
    const orgId = await org();
    const dev = await device(orgId, 'Handy Markus');
    await ds.query(`UPDATE organizations SET settings = $2 WHERE id = $1`, [
      orgId,
      JSON.stringify({
        orderFlow: { kitchenTicketPrinting: { enabled: true } },
      }),
    ]);
    const createFromWorkflow = jest.fn(() => Promise.resolve({}));
    const service = new OrderPrintService(
      ds.getRepository(Organization),
      ds.getRepository(OrderItem),
      ds.getRepository(Device),
      ds.getRepository(Event),
      { createFromWorkflow } as unknown as PrintJobsService,
      {
        resolveOrderPrinter: jest.fn(() =>
          Promise.resolve({ printerId: 'printer-1' }),
        ),
      } as unknown as PrintRoutingService,
    );
    await service.handleOrderCreated(orgId, {
      order: {
        id: randomUUID(),
        organizationId: orgId,
        orderNumber: 'A-1',
        dailyNumber: 1,
        eventId: null,
        isTest: false,
        createdByDeviceId: dev,
        createdByUserId: null,
      } as unknown as Order,
      orderId: randomUUID(),
      orderNumber: 'A-1',
      total: 0,
      source: 'pos',
    });
    const calls = createFromWorkflow.mock.calls as unknown as unknown[][];
    expect(calls).toHaveLength(1);
    expect(calls[0][5]).toMatchObject({
      waiter_name: 'Handy Markus',
      device_name: 'Handy Markus',
    });
  });
});
