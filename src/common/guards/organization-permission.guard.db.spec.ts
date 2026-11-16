import { randomUUID } from 'crypto';
import * as path from 'path';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { ORGANIZATION_PERMISSION_KEY } from '../decorators/requires-organization-permission.decorator';
import { OrganizationPermissionGuard } from './organization-permission.guard';

/**
 * OrganizationPermissionGuard gegen echte Mitgliedschaften (jsonb
 * `permissions`): Admin, Mitglied mit und ohne `shiftPlans`, Mitglied
 * einer anderen Organisation.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5544/openeos_guards_scratch pnpm test organization-permission.guard.db
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('OrganizationPermissionGuard against Postgres', () => {
  let ds: DataSource;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const admin = randomUUID();
  const planner = randomUUID();
  const member = randomUUID();

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
    for (const id of [orgA, orgB]) {
      await ds.query(
        `INSERT INTO organizations (id, name, slug, support_pin)
         VALUES ($1, 'Testverein', $2, '123456')`,
        [id, `guard-${id}`],
      );
    }
    for (const id of [admin, planner, member]) {
      await ds.query(
        `INSERT INTO users (id, email, password_hash, first_name, last_name)
         VALUES ($1, $2, 'x', 'Test', 'Person')`,
        [id, `guard-${id}@example.org`],
      );
    }
    const membership = (
      user: string,
      org: string,
      role: string,
      permissions: Record<string, boolean>,
    ) =>
      ds.query(
        `INSERT INTO user_organizations (user_id, organization_id, role, permissions)
         VALUES ($1, $2, $3, $4)`,
        [user, org, role, JSON.stringify(permissions)],
      );
    await membership(admin, orgA, 'admin', {});
    await membership(planner, orgA, 'member', { shiftPlans: true });
    await membership(member, orgA, 'member', {
      events: true,
      shiftPlans: false,
    });
    await membership(member, orgB, 'admin', {});
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
        [orgA, orgB],
      ]);
      await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        [admin, planner, member],
      ]);
      await ds.destroy();
    }
  });

  function run(userId: string, pathOrg: string, headerOrg?: string) {
    const request = {
      user: { id: userId, isSuperAdmin: false, organizations: [] },
      route: { path: '/api/organizations/:organizationId/shift-plans' },
      params: { organizationId: pathOrg },
      headers: headerOrg ? { 'x-organization-id': headerOrg } : {},
      query: {},
      body: {},
    };
    const ctx = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === ORGANIZATION_PERMISSION_KEY ? 'shiftPlans' : undefined,
    } as unknown as Reflector;
    return new OrganizationPermissionGuard(reflector, ds).canActivate(ctx);
  }

  async function reason(promise: Promise<boolean>): Promise<string> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    return ((error as ForbiddenException).getResponse() as { reason: string })
      .reason;
  }

  it('admits administrators and members with the permission', async () => {
    await expect(run(admin, orgA)).resolves.toBe(true);
    await expect(run(planner, orgA)).resolves.toBe(true);
  });

  it('refuses members without the permission, even if they administer another organization', async () => {
    expect(await reason(run(member, orgA))).toBe('INSUFFICIENT_PERMISSIONS');
    expect(await reason(run(member, orgA, orgB))).toBe('ORGANIZATION_MISMATCH');
    await expect(run(member, orgB)).resolves.toBe(true);
  });

  it('refuses users who are not members of the path organization', async () => {
    expect(await reason(run(admin, orgB))).toBe('NOT_ORGANIZATION_MEMBER');
    expect(await reason(run(admin, orgB, orgA))).toBe('ORGANIZATION_MISMATCH');
  });
});
