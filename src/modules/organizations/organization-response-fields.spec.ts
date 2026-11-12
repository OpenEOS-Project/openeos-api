import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { User } from '../../database/entities/user.entity';
import {
  OrganizationPermissions,
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import type { Organization } from '../../database/entities/organization.entity';
import { organizationView } from './organization-view.service';
import { memberView, ownMembershipView } from './member-view';
import { OrganizationsService } from './organizations.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const ACTOR = { id: 'actor', isSuperAdmin: false } as User;

const fullUser = {
  id: 'user-1',
  email: 'anna@example.com',
  firstName: 'Anna',
  lastName: 'Muster',
  avatarUrl: null,
  passwordHash: '$2b$10$hash',
  twoFactorSecret: 'secret',
  failedLoginAttempts: 3,
} as unknown as User;

const storedMember = {
  id: 'membership-1',
  userId: 'user-1',
  organizationId: ORG_ID,
  role: OrganizationRole.MEMBER,
  permissions: { products: true },
  pin: '$2b$10$pinhash',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  user: fullUser,
} as unknown as UserOrganization;

function serviceFor(
  role: OrganizationRole,
  permissions: OrganizationPermissions = {},
) {
  const findAndCount = jest.fn(() => Promise.resolve([[storedMember], 1]));
  const userOrganizationRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({ role, permissions } as UserOrganization),
    ),
    findAndCount,
  } as unknown as Repository<UserOrganization>;
  const dataSource = { query: jest.fn(() => Promise.resolve([])) };
  const none = undefined as never;
  const service = new OrganizationsService(
    none,
    none,
    userOrganizationRepository,
    none,
    dataSource as never,
    none,
    none,
    none,
    none,
    none,
  );
  return { service, findAndCount };
}

describe('organization responses', () => {
  const organization = {
    id: ORG_ID,
    name: 'Verein',
    slug: 'verein',
    settings: { currency: 'EUR', timezone: 'Europe/Berlin', locale: 'de' },
    supportPin: '123456',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    country: 'DE',
    operatingMode: 'full',
    operatingModeLegacy: false,
    operatingModeSince: null,
    tseActive: false,
    userOrganizations: [storedMember],
  } as unknown as Organization;

  it('leave out the support PIN, Stripe references and loaded members', () => {
    const view = organizationView(organization, null) as unknown as Record<
      string,
      unknown
    >;
    expect(view.name).toBe('Verein');
    expect(view.settings).toEqual(organization.settings);
    expect(view).not.toHaveProperty('supportPin');
    expect(view).not.toHaveProperty('stripeCustomerId');
    expect(view).not.toHaveProperty('stripeSubscriptionId');
    expect(view).not.toHaveProperty('userOrganizations');
    // Das geladene Entity bleibt unveraendert.
    expect(organization.supportPin).toBe('123456');
  });

  it('show an accepted membership without the organization support PIN', () => {
    const view = ownMembershipView({
      ...storedMember,
      organization,
    } as UserOrganization) as Record<string, unknown>;
    expect(view).not.toHaveProperty('pin');
    expect(view).not.toHaveProperty('user');
    expect(view.organization).not.toHaveProperty('supportPin');
    expect(view.organization).not.toHaveProperty('userOrganizations');
  });
});

describe('member list', () => {
  it('lists members with the fields the members page shows', async () => {
    const { service } = serviceFor(OrganizationRole.MEMBER, { members: true });
    const result = await service.getMembers(ORG_ID, ACTOR, {
      page: 1,
      limit: 20,
    });
    expect(result.data).toEqual([
      {
        id: 'membership-1',
        userId: 'user-1',
        organizationId: ORG_ID,
        role: OrganizationRole.MEMBER,
        permissions: { products: true },
        hasPin: true,
        createdAt: storedMember.createdAt,
        updatedAt: storedMember.updatedAt,
        user: {
          id: 'user-1',
          email: 'anna@example.com',
          firstName: 'Anna',
          lastName: 'Muster',
          avatarUrl: null,
        },
      },
    ]);
  });

  it('is available to admins', async () => {
    const { service } = serviceFor(OrganizationRole.ADMIN);
    await expect(
      service.getMembers(ORG_ID, ACTOR, { page: 1, limit: 20 }),
    ).resolves.toHaveProperty(['meta', 'total'], 1);
  });

  it('needs the members permission', async () => {
    const { service, findAndCount } = serviceFor(OrganizationRole.MEMBER, {
      products: true,
    });
    await expect(
      service.getMembers(ORG_ID, ACTOR, { page: 1, limit: 20 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findAndCount).not.toHaveBeenCalled();
  });

  it('never returns the stored PIN or account internals', () => {
    const view = memberView(storedMember) as unknown as Record<string, unknown>;
    expect(view).not.toHaveProperty('pin');
    expect(view.hasPin).toBe(true);
    expect(Object.keys(view.user as object).sort()).toEqual(
      ['avatarUrl', 'email', 'firstName', 'id', 'lastName'].sort(),
    );
  });
});
