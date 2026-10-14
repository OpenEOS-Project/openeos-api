import { ForbiddenException, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';

import { Organization } from '../../database/entities/organization.entity';
import { OrganizationCashlessChange } from '../../database/entities/organization-cashless-change.entity';
import { User } from '../../database/entities/user.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { OrganizationsService } from './organizations.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '2a3f1c52-4f43-4a3e-9f8e-0f2b8f3f1a33';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

/** Organisation im Speicher; `query` versteht SELECT … FOR UPDATE und das jsonb-UPDATE. */
function setup(role: OrganizationRole, settings: Record<string, unknown> = {}) {
  const stored = {
    id: ORG_ID,
    name: 'TSV Musterstadt',
    settings: { currency: 'EUR', vatExempt: true, ...settings },
  } as unknown as Organization;
  const log: Partial<OrganizationCashlessChange>[] = [];
  const save = jest.fn((org: Organization) => Promise.resolve(org));
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(structuredClone(stored))),
    save,
  } as unknown as Repository<Organization>;
  const userOrganizationRepository = {
    findOne: jest.fn(() => Promise.resolve({ role } as UserOrganization)),
  } as unknown as Repository<UserOrganization>;
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve([{ settings: stored.settings }]);
      }
      const payments = JSON.parse(params[1] as string) as object;
      stored.settings = {
        ...stored.settings,
        payments: { ...(stored.settings.payments ?? {}), ...payments },
      };
      return Promise.resolve([]);
    }),
    insert: jest.fn((_entity: unknown, row: object) => {
      log.push(row);
      return Promise.resolve();
    }),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) =>
      work(manager),
    ),
    getRepository: () => ({
      find: jest.fn(() => Promise.resolve(log)),
    }),
  };
  const none = undefined as never;
  const service = new OrganizationsService(
    organizationRepository,
    none,
    userOrganizationRepository,
    none,
    dataSource as never,
    none,
    none,
    none,
    none,
  );
  return { service, save, stored, log, manager };
}

const user = {
  id: 'user-1',
  firstName: 'Anna',
  lastName: 'Admin',
  email: 'anna@tsv.example',
  isSuperAdmin: false,
} as User;

describe('OrganizationsService — bargeldloser Modus', () => {
  it('switches on, stores the time and logs who did it', async () => {
    const { service, stored, log } = setup(OrganizationRole.ADMIN);

    await service.setCashlessMode(ORG_ID, true, user, {
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });

    expect(stored.settings.payments).toMatchObject({ cashless: true });
    expect(typeof stored.settings.payments?.changedAt).toBe('string');
    expect(stored.settings.vatExempt).toBe(true);
    expect(log).toEqual([
      expect.objectContaining({
        organizationId: ORG_ID,
        cashless: true,
        changedByUserId: 'user-1',
        changedByName: 'Anna Admin (anna@tsv.example)',
        ipAddress: '203.0.113.7',
      }),
    ]);
  });

  it('switching back to cash is allowed (reversible) and logged too', async () => {
    const { service, stored, log } = setup(OrganizationRole.ADMIN, {
      payments: { cashless: true },
    });

    await service.setCashlessMode(ORG_ID, false, user);

    expect(stored.settings.payments).toMatchObject({ cashless: false });
    expect(log).toEqual([expect.objectContaining({ cashless: false })]);
  });

  it('writes nothing when the mode does not change', async () => {
    const { service, log, manager } = setup(OrganizationRole.ADMIN, {
      payments: { cashless: true },
    });

    await service.setCashlessMode(ORG_ID, true, user);

    expect(log).toHaveLength(0);
    expect(manager.query).toHaveBeenCalledTimes(1); // nur die Sperre
  });

  it('only admins can switch it', async () => {
    const { service, log } = setup(OrganizationRole.MEMBER);

    await expect(
      service.setCashlessMode(ORG_ID, true, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(log).toHaveLength(0);
  });

  it('the generic settings update cannot change it (no unlogged switch)', async () => {
    const { service } = setup(OrganizationRole.ADMIN, {
      payments: { cashless: true },
    });

    const result = await service.update(
      ORG_ID,
      { settings: { payments: { cashless: false }, vatExempt: false } },
      user,
    );

    expect(result.settings.payments).toEqual({ cashless: true });
    expect(result.settings.vatExempt).toBe(false);
  });

  it('returns the history', async () => {
    const { service } = setup(OrganizationRole.ADMIN);
    await service.setCashlessMode(ORG_ID, true, user);

    const history = await service.getCashlessHistory(ORG_ID, user);

    expect(history).toEqual([expect.objectContaining({ cashless: true })]);
  });
});
