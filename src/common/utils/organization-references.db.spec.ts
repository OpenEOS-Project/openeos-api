import { INVALID_WHERE_VALUES_BEHAVIOR } from '../../config/where-values';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';

import { ClearCrossOrganizationReferences1842910000000 } from '../../database/migrations/1842910000000-ClearCrossOrganizationReferences';
import { assertReferencesInOrganization } from './organization-references';

/**
 * Verweis-Pruefung und Aufraeum-Migration gegen ein echtes Postgres.
 *
 * Laeuft nur mit einer Wegwerf-Datenbank, z. B.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos@127.0.0.1:5432/openeos_references_scratch pnpm test
 *
 * Der Name der Datenbank muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('Organization references against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];

  beforeAll(async () => {
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(
        `Database "${name}" does not end in _test/_scratch — aborting.`,
      );
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
  }, 180_000);

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

  async function one<T>(sql: string, params: unknown[]): Promise<T> {
    const rows: T[] = await ds.query(sql, params);
    return rows[0];
  }

  async function seedOrganization() {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, support_pin)
       VALUES ($1, 'Verein', $2, '123456')`,
      [orgId, `verein-${orgId}`],
    );
    const event = await one<{ id: string }>(
      `INSERT INTO events (organization_id, name, status) VALUES ($1, 'Fest', 'active') RETURNING id`,
      [orgId],
    );
    const category = await one<{ id: string }>(
      `INSERT INTO categories (event_id, name) VALUES ($1, 'Getränke') RETURNING id`,
      [event.id],
    );
    const pfand = await one<{ id: string }>(
      `INSERT INTO pfand_types (organization_id, name, amount) VALUES ($1, 'Becher', 2) RETURNING id`,
      [orgId],
    );
    const product = await one<{ id: string }>(
      `INSERT INTO products (event_id, category_id, name, price) VALUES ($1, $2, 'Bier', 4) RETURNING id`,
      [event.id, category.id],
    );
    return {
      orgId,
      eventId: event.id,
      categoryId: category.id,
      pfandTypeId: pfand.id,
      productId: product.id,
    };
  }

  it('accepts own records and rejects records of another organization', async () => {
    const own = await seedOrganization();
    const other = await seedOrganization();
    await expect(
      assertReferencesInOrganization(
        ds,
        { organizationId: own.orgId, eventId: own.eventId },
        [
          { kind: 'category', ids: own.categoryId },
          { kind: 'pfandType', ids: own.pfandTypeId },
          { kind: 'event', ids: own.eventId },
        ],
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertReferencesInOrganization(
        ds,
        { organizationId: own.orgId, eventId: own.eventId },
        [{ kind: 'pfandType', ids: other.pfandTypeId }],
      ),
    ).rejects.toMatchObject({ response: { reason: 'DEPOSIT_TYPE_NOT_FOUND' } });
    await expect(
      assertReferencesInOrganization(
        ds,
        { organizationId: own.orgId, eventId: own.eventId },
        [{ kind: 'category', ids: other.categoryId }],
      ),
    ).rejects.toMatchObject({ response: { reason: 'CATEGORY_NOT_FOUND' } });
  });

  it('clears references to records of another organization', async () => {
    const own = await seedOrganization();
    const other = await seedOrganization();
    const ownPfand = await one<{ id: string }>(
      `INSERT INTO pfand_types (organization_id, name, amount) VALUES ($1, 'Glas', 3) RETURNING id`,
      [own.orgId],
    );
    const keep = await one<{ id: string }>(
      `INSERT INTO products (event_id, category_id, name, price, pfand_type_id)
       VALUES ($1, $2, 'Wasser', 2, $3) RETURNING id`,
      [own.eventId, own.categoryId, ownPfand.id],
    );
    await ds.query(`UPDATE products SET pfand_type_id = $1 WHERE id = $2`, [
      other.pfandTypeId,
      own.productId,
    ]);
    await ds.query(`UPDATE categories SET parent_id = $1 WHERE id = $2`, [
      other.categoryId,
      own.categoryId,
    ]);
    const qr = await one<{ id: string }>(
      `INSERT INTO qr_codes (organization_id, event_id, code, type)
       VALUES ($1, $2, $3, 'table') RETURNING id`,
      [own.orgId, other.eventId, `T${Date.now()}`.slice(0, 12)],
    );

    const runner = ds.createQueryRunner();
    try {
      await new ClearCrossOrganizationReferences1842910000000().up(runner);
    } finally {
      await runner.release();
    }

    const product = await one<{ pfand_type_id: string | null }>(
      `SELECT pfand_type_id FROM products WHERE id = $1`,
      [own.productId],
    );
    expect(product.pfand_type_id).toBeNull();
    const kept = await one<{ pfand_type_id: string | null }>(
      `SELECT pfand_type_id FROM products WHERE id = $1`,
      [keep.id],
    );
    expect(kept.pfand_type_id).toBe(ownPfand.id);
    const category = await one<{ parent_id: string | null }>(
      `SELECT parent_id FROM categories WHERE id = $1`,
      [own.categoryId],
    );
    expect(category.parent_id).toBeNull();
    const code = await one<{ event_id: string | null }>(
      `SELECT event_id FROM qr_codes WHERE id = $1`,
      [qr.id],
    );
    expect(code.event_id).toBeNull();
  });
});
