import { BadRequestException } from '@nestjs/common';
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

const ORG_ID = '2a3f1c52-4f43-4a3e-9f8e-0f2b8f3f1a22';

function setup() {
  const stored = {
    id: ORG_ID,
    name: 'TSV Musterstadt',
    settings: {
      currency: 'EUR',
      timezone: 'Europe/Berlin',
      legal: { imprintUrl: 'https://tsv.example/impressum' },
    },
  } as unknown as Organization;

  const save = jest.fn((org: Organization) => Promise.resolve(org));
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(structuredClone(stored))),
    save,
  } as unknown as Repository<Organization>;
  const userOrganizationRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({ role: OrganizationRole.ADMIN } as UserOrganization),
    ),
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
    none,
  );
  return { service, save };
}

const user = { id: 'user-1', isSuperAdmin: false } as User;

describe('OrganizationsService.update — legal information', () => {
  it('stores normalized legal information and keeps the other settings', async () => {
    const { service, save } = setup();

    const result = await service.update(
      ORG_ID,
      {
        settings: {
          legal: {
            imprintUrl: '',
            imprintText: 'TSV Musterstadt e.V.\r\nHauptstr. 1',
            privacyUrl: ' https://tsv.example/datenschutz ',
          },
        },
      },
      user,
    );

    expect(save).toHaveBeenCalled();
    expect(result.settings.legal).toEqual({
      imprintText: 'TSV Musterstadt e.V.\nHauptstr. 1',
      privacyUrl: 'https://tsv.example/datenschutz',
    });
    expect(result.settings.currency).toBe('EUR');
  });

  it('leaves stored legal information alone when it is not sent', async () => {
    const { service } = setup();
    const result = await service.update(
      ORG_ID,
      { settings: { vatExempt: true } },
      user,
    );
    expect(result.settings.legal).toEqual({
      imprintUrl: 'https://tsv.example/impressum',
    });
  });

  it('rejects invalid links without saving', async () => {
    const { service, save } = setup();
    await expect(
      service.update(
        ORG_ID,
        { settings: { legal: { privacyUrl: 'javascript:alert(1)' } } },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });
});
