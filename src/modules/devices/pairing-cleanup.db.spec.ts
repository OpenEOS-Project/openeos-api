import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';

import { Device } from '../../database/entities';
import { DevicesService } from './devices.service';

/**
 * Aufraeumen wartender Geraete gegen ein echtes Postgres, z. B.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_pairing_scratch pnpm test
 *
 * Der Name der Datenbank muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('pending device cleanup against Postgres', () => {
  let ds: DataSource;
  let service: DevicesService;
  const now = new Date('2031-06-01T18:00:00.000Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const ids: string[] = [];

  beforeAll(async () => {
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
    const none = undefined as never;
    service = new DevicesService(
      ds.getRepository(Device),
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
    );
  }, 180_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [ids]);
      await ds.destroy();
    }
  });

  async function seed(
    code: string | null,
    expiresAt: Date | null,
    status = 'pending',
  ): Promise<string> {
    const id = randomUUID();
    ids.push(id);
    await ds.query(
      `INSERT INTO devices (id, name, type, device_token, verification_code,
         verification_code_expires_at, status, is_active)
       VALUES ($1, 'Geraet', 'pos', $2, $3, $4, $5, true)`,
      [id, `token-${id}`, code, expiresAt, status],
    );
    return id;
  }

  it('removes only waiting devices whose code expired long ago', async () => {
    const stale = await seed('11111111', minutesAgo(90));
    const recent = await seed('22222222', minutesAgo(10));
    const manual = await seed(null, null);
    const linked = await seed(null, minutesAgo(90), 'verified');

    await service.removeStalePendingDevices(now);

    const left: { id: string }[] = await ds.query(
      `SELECT id FROM devices WHERE id = ANY($1::uuid[])`,
      [[stale, recent, manual, linked]],
    );
    expect(left.map((r) => r.id).sort()).toEqual(
      [recent, manual, linked].sort(),
    );
  });
});
