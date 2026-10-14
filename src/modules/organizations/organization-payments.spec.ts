import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { Organization } from '../../database/entities/organization.entity';
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

function setup(role: OrganizationRole) {
  const stored = {
    id: ORG_ID,
    name: 'TSV Musterstadt',
    settings: { currency: 'EUR', vatExempt: true },
  } as unknown as Organization;
  const save = jest.fn((org: Organization) => Promise.resolve(org));
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(structuredClone(stored))),
    save,
  } as unknown as Repository<Organization>;
  const userOrganizationRepository = {
    findOne: jest.fn(() => Promise.resolve({ role } as UserOrganization)),
  } as unknown as Repository<UserOrganization>;
  const none = undefined as never;
  const service = new OrganizationsService(
    organizationRepository,
    none,
    userOrganizationRepository,
    none,
    none,
    none,
    none,
    none,
    none,
  );
  return { service, save };
}

const user = { id: 'user-1', isSuperAdmin: false } as User;

describe('OrganizationsService.update — bargeldloser Modus', () => {
  it('stores settings.payments.cashless and keeps the other settings', async () => {
    const { service } = setup(OrganizationRole.ADMIN);

    const result = await service.update(
      ORG_ID,
      { settings: { payments: { cashless: true, junk: 'x' } } },
      user,
    );

    expect(result.settings.payments).toEqual({ cashless: true });
    expect(result.settings.vatExempt).toBe(true);
  });

  it('drops a non-boolean value instead of storing it', async () => {
    const { service } = setup(OrganizationRole.ADMIN);

    const result = await service.update(
      ORG_ID,
      { settings: { payments: { cashless: 'true' } } },
      user,
    );

    expect(result.settings.payments).toEqual({});
  });

  it('only admins can switch it', async () => {
    const { service, save } = setup(OrganizationRole.MEMBER);

    await expect(
      service.update(
        ORG_ID,
        { settings: { payments: { cashless: false } } },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(save).not.toHaveBeenCalled();
  });
});
