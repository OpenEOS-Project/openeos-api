import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';

import { ErrorCodes } from '../../common/constants/error-codes';
import { OrganizationLimitsService } from '../../common/services/organization-limits.service';
import { Invitation } from '../../database/entities/invitation.entity';
import { User } from '../../database/entities/user.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { OrganizationsService } from './organizations.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const USER_ID = 'a3d2c1b0-1111-4222-8333-444455556666';

interface Counts {
  memberships?: number;
  members?: number;
  pendingInvitations?: number;
  /** Rohe Spaltenwerte, wie sie die gesperrte Zeile liefert. */
  userOverride?: number | null;
  orgOverride?: number | null;
  /** Organisation existiert nicht (Zeile fehlt). */
  orgMissing?: boolean;
}

/** Manager-Attrappe: `query` liefert die gesperrte Zeile, `count` die Zahlen. */
function fakeManager(counts: Counts) {
  const queries: string[] = [];
  const manager = {
    query: jest.fn((sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM users')) {
        return Promise.resolve([
          { organization_limit: counts.userOverride ?? null },
        ]);
      }
      if (sql.includes('FROM organizations')) {
        return Promise.resolve(
          counts.orgMissing
            ? []
            : [{ member_limit: counts.orgOverride ?? null }],
        );
      }
      return Promise.resolve([]);
    }),
    count: jest.fn(
      (entity: unknown, options: { where: { userId?: string } }) => {
        if (entity === UserOrganization) {
          return Promise.resolve(
            options.where.userId !== undefined
              ? (counts.memberships ?? 0)
              : (counts.members ?? 0),
          );
        }
        if (entity === Invitation) {
          return Promise.resolve(counts.pendingInvitations ?? 0);
        }
        return Promise.resolve(0);
      },
    ),
    save: jest.fn((entity: unknown) => Promise.resolve(entity)),
  };
  return {
    manager: manager as unknown as EntityManager,
    queries,
    raw: manager,
  };
}

function limitsService(env: { orgs?: number; members?: number } = {}) {
  const config = {
    get: (key: string) =>
      key === 'limits.organizationsPerUser'
        ? env.orgs
        : key === 'limits.membersPerOrganization'
          ? env.members
          : undefined,
  } as unknown as ConfigService;
  return new OrganizationLimitsService(config, {} as DataSource);
}

async function expectForbidden(
  promise: Promise<unknown>,
  code: string,
  params?: Record<string, number>,
) {
  await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
  await promise.catch(
    (error: {
      getResponse: () => { code: string; params: Record<string, number> };
    }) => {
      const response = error.getResponse();
      expect(response.code).toBe(code);
      if (params) expect(response.params).toEqual(params);
    },
  );
}

const normalUser = { id: USER_ID, isSuperAdmin: false } as User;
const superAdmin = { id: USER_ID, isSuperAdmin: true } as User;

describe('OrganizationLimitsService: effective limits', () => {
  it('falls back to 5 organizations and 10 members without configuration', () => {
    const service = limitsService();
    expect(service.defaultOrganizationLimit).toBe(5);
    expect(service.defaultMemberLimit).toBe(10);
  });

  it('reads the defaults from the environment', () => {
    const service = limitsService({ orgs: 3, members: 25 });
    expect(
      service.effectiveOrganizationLimit({ organizationLimit: null }),
    ).toBe(3);
    expect(service.effectiveMemberLimit({ memberLimit: null })).toBe(25);
  });

  it('prefers the per-record override, including 0 for unlimited', () => {
    const service = limitsService({ orgs: 5, members: 10 });
    expect(service.effectiveOrganizationLimit({ organizationLimit: 12 })).toBe(
      12,
    );
    expect(service.effectiveOrganizationLimit({ organizationLimit: 0 })).toBe(
      0,
    );
    expect(service.effectiveMemberLimit({ memberLimit: 40 })).toBe(40);
    expect(service.effectiveMemberLimit({ memberLimit: 0 })).toBe(0);
  });
});

describe('OrganizationLimitsService: organizations per user', () => {
  it('allows joining while below the limit', async () => {
    const { manager } = fakeManager({ memberships: 4 });
    await expect(
      limitsService({ orgs: 5 }).assertCanJoinOrganization(normalUser, manager),
    ).resolves.toBeUndefined();
  });

  it('rejects the sixth organization with the limit in params', async () => {
    const { manager } = fakeManager({ memberships: 5 });
    await expectForbidden(
      limitsService({ orgs: 5 }).assertCanJoinOrganization(normalUser, manager),
      ErrorCodes.ORGANIZATION_LIMIT_REACHED,
      { limit: 5, used: 5 },
    );
  });

  it('locks the user row before counting', async () => {
    const { manager, queries, raw } = fakeManager({ memberships: 1 });
    await limitsService({ orgs: 5 }).assertCanJoinOrganization(
      normalUser,
      manager,
    );
    expect(queries[0]).toMatch(/FROM users WHERE id = \$1 FOR UPDATE/);
    expect(raw.query.mock.invocationCallOrder[0]).toBeLessThan(
      raw.count.mock.invocationCallOrder[0],
    );
  });

  it('uses the per-user override from the locked row', async () => {
    const { manager } = fakeManager({ memberships: 7, userOverride: 8 });
    await expect(
      limitsService({ orgs: 5 }).assertCanJoinOrganization(normalUser, manager),
    ).resolves.toBeUndefined();

    const full = fakeManager({ memberships: 8, userOverride: 8 });
    await expectForbidden(
      limitsService({ orgs: 5 }).assertCanJoinOrganization(
        normalUser,
        full.manager,
      ),
      ErrorCodes.ORGANIZATION_LIMIT_REACHED,
      { limit: 8, used: 8 },
    );
  });

  it('treats 0 as unlimited, from the environment and as override', async () => {
    const env = fakeManager({ memberships: 500 });
    await expect(
      limitsService({ orgs: 0 }).assertCanJoinOrganization(
        normalUser,
        env.manager,
      ),
    ).resolves.toBeUndefined();

    const override = fakeManager({ memberships: 500, userOverride: 0 });
    await expect(
      limitsService({ orgs: 5 }).assertCanJoinOrganization(
        normalUser,
        override.manager,
      ),
    ).resolves.toBeUndefined();
  });

  it('exempts super admins without touching the database', async () => {
    const { manager, raw } = fakeManager({ memberships: 50 });
    await expect(
      limitsService({ orgs: 5 }).assertCanJoinOrganization(superAdmin, manager),
    ).resolves.toBeUndefined();
    expect(raw.query).not.toHaveBeenCalled();
    expect(raw.count).not.toHaveBeenCalled();
  });

  it('fails closed when counting fails', async () => {
    const { manager, raw } = fakeManager({ memberships: 0 });
    raw.count.mockImplementation(() => Promise.reject(new Error('db down')));
    await expect(
      limitsService({ orgs: 5 }).assertCanJoinOrganization(normalUser, manager),
    ).rejects.toThrow('db down');
  });
});

describe('OrganizationLimitsService: members per organization', () => {
  it('counts active members plus pending invitations', async () => {
    const { manager } = fakeManager({ members: 6, pendingInvitations: 3 });
    expect(await limitsService().countMemberSeats(ORG_ID, manager)).toBe(9);
  });

  it('allows a seat while members plus invitations are below the limit', async () => {
    const { manager } = fakeManager({ members: 6, pendingInvitations: 3 });
    await expect(
      limitsService({ members: 10 }).assertMemberSeatAvailable(
        ORG_ID,
        normalUser,
        manager,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects when members plus invitations reach the limit', async () => {
    const { manager } = fakeManager({ members: 7, pendingInvitations: 3 });
    await expectForbidden(
      limitsService({ members: 10 }).assertMemberSeatAvailable(
        ORG_ID,
        normalUser,
        manager,
      ),
      ErrorCodes.MEMBER_LIMIT_REACHED,
      { limit: 10, used: 10 },
    );
  });

  it('locks the organization row before counting', async () => {
    const { manager, queries, raw } = fakeManager({ members: 1 });
    await limitsService({ members: 10 }).assertMemberSeatAvailable(
      ORG_ID,
      normalUser,
      manager,
    );
    expect(queries[0]).toMatch(/FROM organizations WHERE id = \$1 FOR UPDATE/);
    expect(raw.query.mock.invocationCallOrder[0]).toBeLessThan(
      raw.count.mock.invocationCallOrder[0],
    );
  });

  it('uses the per-organization override from the locked row', async () => {
    const { manager } = fakeManager({
      members: 10,
      pendingInvitations: 4,
      orgOverride: 20,
    });
    await expect(
      limitsService({ members: 10 }).assertMemberSeatAvailable(
        ORG_ID,
        normalUser,
        manager,
      ),
    ).resolves.toBeUndefined();

    const full = fakeManager({
      members: 10,
      pendingInvitations: 10,
      orgOverride: 20,
    });
    await expectForbidden(
      limitsService({ members: 10 }).assertMemberSeatAvailable(
        ORG_ID,
        normalUser,
        full.manager,
      ),
      ErrorCodes.MEMBER_LIMIT_REACHED,
      { limit: 20, used: 20 },
    );
  });

  it('treats 0 as unlimited', async () => {
    const env = fakeManager({ members: 999 });
    await expect(
      limitsService({ members: 0 }).assertMemberSeatAvailable(
        ORG_ID,
        normalUser,
        env.manager,
      ),
    ).resolves.toBeUndefined();

    const override = fakeManager({ members: 999, orgOverride: 0 });
    await expect(
      limitsService({ members: 10 }).assertMemberSeatAvailable(
        ORG_ID,
        normalUser,
        override.manager,
      ),
    ).resolves.toBeUndefined();
  });

  it('exempts a super admin who invites or adds', async () => {
    const { manager, raw } = fakeManager({ members: 99 });
    await expect(
      limitsService({ members: 10 }).assertMemberSeatAvailable(
        ORG_ID,
        superAdmin,
        manager,
      ),
    ).resolves.toBeUndefined();
    expect(raw.query).not.toHaveBeenCalled();
  });

  it('rejects an unknown organization instead of waving it through', async () => {
    const { manager } = fakeManager({ orgMissing: true });
    await expect(
      limitsService({ members: 10 }).assertMemberSeatAvailable(
        ORG_ID,
        normalUser,
        manager,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports usage with the effective limit', async () => {
    const { manager } = fakeManager({ members: 2, pendingInvitations: 1 });
    expect(
      await limitsService({ members: 10 }).memberUsage(
        { id: ORG_ID, memberLimit: null },
        manager,
      ),
    ).toEqual({ memberLimit: 10, memberCount: 3 });
    expect(
      await limitsService({ members: 10 }).memberUsage(
        { id: ORG_ID, memberLimit: 30 },
        manager,
      ),
    ).toEqual({ memberLimit: 30, memberCount: 3 });
  });
});

/**
 * Durchstich durch OrganizationsService: die Pruefung sitzt vor dem
 * Schreiben, innerhalb derselben Transaktion, und nichts wird gespeichert
 * oder verschickt, wenn sie fehlschlaegt.
 */
describe('OrganizationsService enforces the limits', () => {
  function serviceWith(
    counts: Counts,
    env: { orgs?: number; members?: number } = {},
    options: { actorIsMember?: boolean } = {},
  ) {
    const { manager, raw } = fakeManager(counts);
    const queryRunner = {
      connect: jest.fn(() => Promise.resolve()),
      startTransaction: jest.fn(() => Promise.resolve()),
      commitTransaction: jest.fn(() => Promise.resolve()),
      rollbackTransaction: jest.fn(() => Promise.resolve()),
      release: jest.fn(() => Promise.resolve()),
      manager,
    };
    const dataSource = {
      createQueryRunner: () => queryRunner,
      transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    };
    const organizationRepository = {
      create: jest.fn((data: object) => ({ id: ORG_ID, ...data })),
      findOne: jest.fn(() => Promise.resolve(null)),
      findOneOrFail: jest.fn(() =>
        Promise.resolve({ id: ORG_ID, name: 'Verein', memberLimit: null }),
      ),
    };
    const userRepository = {
      // Die eingeladene bzw. hinzugefuegte Adresse hat schon ein Konto.
      findOne: jest.fn(({ where }: { where: { email?: string } }) =>
        Promise.resolve(
          where.email ? { id: 'other', email: where.email } : null,
        ),
      ),
    };
    const actorMembership = {
      role: OrganizationRole.ADMIN,
      permissions: {},
    };
    const userOrganizationRepository = {
      findOne: jest.fn(({ where }: { where: { userId?: string } }) =>
        Promise.resolve(
          where.userId === USER_ID && options.actorIsMember !== false
            ? actorMembership
            : null,
        ),
      ),
      create: jest.fn((data: object) => ({ id: 'membership', ...data })),
      findOneOrFail: jest.fn(() => Promise.resolve({ id: 'membership' })),
    };
    const invitation = {
      organizationId: ORG_ID,
      email: 'gast@example.com',
      role: OrganizationRole.MEMBER,
      permissions: {},
      organization: { name: 'Verein' },
      isExpired: () => false,
      isAccepted: () => false,
    };
    const invitationRepository = {
      findOne: jest.fn(({ where }: { where: { token?: string } }) =>
        Promise.resolve(where.token ? invitation : null),
      ),
      create: jest.fn((data: object) => ({ id: 'invitation', ...data })),
    };
    const emailService = {
      sendInvitationEmail: jest.fn(() => Promise.resolve()),
      sendAdminOrganizationCreatedNotification: jest.fn(() =>
        Promise.resolve(),
      ),
    };
    const platformSettings = {
      resolveNotificationTarget: jest.fn(() => Promise.resolve(null)),
    };
    const configService = { get: jest.fn(() => undefined) };
    const deployment = { multiTenant: true, isSelfHosted: false };

    const service = new OrganizationsService(
      organizationRepository as never,
      userRepository as never,
      userOrganizationRepository as never,
      invitationRepository as never,
      dataSource as never,
      emailService as never,
      platformSettings as never,
      configService as never,
      deployment as never,
      limitsService(env),
    );
    return { service, raw, queryRunner, emailService };
  }

  const actor = {
    id: USER_ID,
    email: 'gast@example.com',
    isSuperAdmin: false,
  } as User;

  it('create: rejects at the limit, rolls back and saves nothing', async () => {
    const { service, raw, queryRunner } = serviceWith(
      { memberships: 5 },
      { orgs: 5 },
    );
    await expectForbidden(
      service.create({ name: 'Noch ein Verein' }, actor),
      ErrorCodes.ORGANIZATION_LIMIT_REACHED,
      { limit: 5, used: 5 },
    );
    expect(raw.save).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('create: succeeds below the limit and checks inside the transaction', async () => {
    const { service, raw, queryRunner } = serviceWith(
      { memberships: 4 },
      { orgs: 5 },
    );
    await expect(
      service.create({ name: 'Verein' }, actor),
    ).resolves.toMatchObject({
      name: 'Verein',
    });
    expect(
      queryRunner.startTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(raw.query.mock.invocationCallOrder[0]);
    expect(raw.save).toHaveBeenCalledTimes(2);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('create: a super admin is not limited', async () => {
    const { service, queryRunner } = serviceWith(
      { memberships: 50 },
      { orgs: 5 },
    );
    await expect(
      service.create({ name: 'Verein' }, {
        ...actor,
        isSuperAdmin: true,
      } as User),
    ).resolves.toBeDefined();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('acceptInvitation: rejects when the invitee is at the limit', async () => {
    const { service, raw, queryRunner } = serviceWith(
      { memberships: 5 },
      { orgs: 5 },
      { actorIsMember: false },
    );
    await expectForbidden(
      service.acceptInvitation('token', actor),
      ErrorCodes.ORGANIZATION_LIMIT_REACHED,
      { limit: 5, used: 5 },
    );
    expect(raw.save).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('acceptInvitation: joins below the limit', async () => {
    const { service, raw } = serviceWith(
      { memberships: 2 },
      { orgs: 5 },
      { actorIsMember: false },
    );
    await expect(
      service.acceptInvitation('token', actor),
    ).resolves.toBeDefined();
    expect(raw.save).toHaveBeenCalledTimes(2);
  });

  it('createInvitation: rejects when members plus invitations fill the organization', async () => {
    const { service, raw, emailService } = serviceWith(
      { members: 7, pendingInvitations: 3 },
      { members: 10 },
    );
    await expectForbidden(
      service.createInvitation(
        ORG_ID,
        { email: 'neu@example.com', role: OrganizationRole.MEMBER },
        actor,
      ),
      ErrorCodes.MEMBER_LIMIT_REACHED,
      { limit: 10, used: 10 },
    );
    expect(raw.save).not.toHaveBeenCalled();
    expect(emailService.sendInvitationEmail).not.toHaveBeenCalled();
  });

  it('createInvitation: sends the invitation while a seat is free', async () => {
    const { service, raw, emailService } = serviceWith(
      { members: 7, pendingInvitations: 2 },
      { members: 10 },
    );
    await expect(
      service.createInvitation(
        ORG_ID,
        { email: 'neu@example.com', role: OrganizationRole.MEMBER },
        actor,
      ),
    ).resolves.toMatchObject({ email: 'neu@example.com' });
    expect(raw.save).toHaveBeenCalledTimes(1);
    expect(emailService.sendInvitationEmail).toHaveBeenCalledTimes(1);
  });

  it('createInvitation: the per-organization override raises the limit', async () => {
    const { service } = serviceWith(
      { members: 10, pendingInvitations: 5, orgOverride: 20 },
      { members: 10 },
    );
    await expect(
      service.createInvitation(
        ORG_ID,
        { email: 'neu@example.com', role: OrganizationRole.MEMBER },
        actor,
      ),
    ).resolves.toBeDefined();
  });

  it('addMember: rejects when the organization is full', async () => {
    const { service, raw } = serviceWith({ members: 10 }, { members: 10 });
    await expectForbidden(
      service.addMember(
        ORG_ID,
        { email: 'neu@example.com', role: OrganizationRole.MEMBER },
        actor,
      ),
      ErrorCodes.MEMBER_LIMIT_REACHED,
      { limit: 10, used: 10 },
    );
    expect(raw.save).not.toHaveBeenCalled();
  });
});
