import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource, IsNull } from 'typeorm';
import { Event, Product } from '../database/entities';
import databaseConfig from './database.config';
import { dataSourceOptions } from './data-source';
import { INVALID_WHERE_VALUES_BEHAVIOR } from './where-values';

describe('where values configuration', () => {
  it('is used by the application and the CLI data source', () => {
    const appOptions = databaseConfig() as {
      invalidWhereValuesBehavior?: unknown;
    };
    expect(appOptions.invalidWhereValuesBehavior).toEqual({
      null: 'throw',
      undefined: 'throw',
    });
    expect(dataSourceOptions.invalidWhereValuesBehavior).toBe(
      INVALID_WHERE_VALUES_BEHAVIOR,
    );
  });
});

/**
 *   TEST_ORDERS_DATABASE_URL=postgres://…/openeos_x_scratch pnpm test where-values
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('where values against Postgres', () => {
  let ds: DataSource;
  const orgId = randomUUID();
  const eventId = randomUUID();
  const productId = randomUUID();

  beforeAll(async () => {
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    }
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
      invalidWhereValuesBehavior: INVALID_WHERE_VALUES_BEHAVIOR,
    });
    await ds.initialize();
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin)
       VALUES ($1, 'Where', $2, '123456')`,
      [orgId, `where-${orgId}`],
    );
    await ds.query(
      `INSERT INTO events (id, organization_id, name) VALUES ($1, $2, 'Fest')`,
      [eventId, orgId],
    );
    const [{ id: categoryId }] = await ds.query<{ id: string }[]>(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Getränke') RETURNING id`,
      [eventId],
    );
    await ds.query(
      `INSERT INTO products (id, event_id, category_id, name, price)
       VALUES ($1, $2, $3, 'Bier', 4)`,
      [productId, eventId, categoryId],
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM products WHERE id = $1`, [productId]);
    await ds.query(`DELETE FROM categories WHERE event_id = $1`, [eventId]);
    await ds.query(`DELETE FROM events WHERE id = $1`, [eventId]);
    await ds.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await ds.destroy();
  });

  it('refuses a lookup with an undefined or null value instead of dropping the condition', async () => {
    const products = ds.getRepository(Product);
    await expect(
      products.findOne({
        where: { id: productId, eventId: undefined as unknown as string },
      }),
    ).rejects.toThrow();
    await expect(
      products.findOne({
        where: { id: productId, eventId: null as unknown as string },
      }),
    ).rejects.toThrow();
    await expect(
      products.findOneBy({ id: undefined as unknown as string }),
    ).rejects.toThrow();
  });

  it('still matches with explicit values and IsNull()', async () => {
    const products = ds.getRepository(Product);
    await expect(
      products.findOne({ where: { id: productId, eventId } }),
    ).resolves.toMatchObject({ id: productId });
    await expect(
      products.findOne({ where: { id: productId, deletedAt: IsNull() } }),
    ).resolves.toMatchObject({ id: productId });
    await expect(
      products.findOne({
        where: { id: productId, event: { organizationId: randomUUID() } },
      }),
    ).resolves.toBeNull();
    await expect(
      ds.getRepository(Event).count({ where: { organizationId: orgId } }),
    ).resolves.toBe(1);
  });
});
