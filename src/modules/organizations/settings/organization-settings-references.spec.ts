import { Repository } from 'typeorm';

import type { Organization } from '../../../database/entities/organization.entity';
import type { User } from '../../../database/entities/user.entity';
import {
  OrganizationRole,
  type UserOrganization,
} from '../../../database/entities/user-organization.entity';
import { OrganizationsService } from '../organizations.service';

const ORG_ID = '0b9d8c6e-5f0a-4c1d-8e2b-3a4f5e6d7c8b';
const OWN_PRINTER = '11111111-1111-4111-8111-111111111111';
const OTHER_PRINTER = '22222222-2222-4222-8222-222222222222';
const user = { id: 'user-1', isSuperAdmin: false } as User;

function setup() {
  const stored = {
    id: ORG_ID,
    name: 'TSV Musterstadt',
    settings: { currency: 'EUR', timezone: 'Europe/Berlin', locale: 'de' },
  } as unknown as Organization;
  const query = jest.fn((_sql: string, params: [string, string[]]) =>
    Promise.resolve(
      params[1].filter((id) => id === OWN_PRINTER).map((id) => ({ id })),
    ),
  );
  const save = jest.fn((org: Organization) => Promise.resolve(org));
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(structuredClone(stored))),
    save,
    manager: { query },
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
  return { service, save, query };
}

const orderFlow = (printerId: string) => ({
  orderFlow: {
    receiptPrinting: {
      enabled: true,
      trigger: 'payment_received',
      printerId,
      templateId: null,
    },
  },
});

describe('organization settings — order flow references', () => {
  it('accepts printers of the organization', async () => {
    const { service, save, query } = setup();
    await service.update(ORG_ID, { settings: orderFlow(OWN_PRINTER) }, user);
    expect(save).toHaveBeenCalled();
    expect(query.mock.calls[0][1]).toEqual([ORG_ID, [OWN_PRINTER]]);
  });

  it.each([[OTHER_PRINTER], ['not-a-uuid']])(
    'rejects the printer %s',
    async (printerId) => {
      const { service, save } = setup();
      await expect(
        service.update(ORG_ID, { settings: orderFlow(printerId) }, user),
      ).rejects.toMatchObject({
        response: { reason: 'ORGANIZATION_SETTINGS_INVALID' },
      });
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('rejects the assistant switch through the general settings', async () => {
    const { service, save } = setup();
    await expect(
      service.update(
        ORG_ID,
        { settings: { assistant: { enabled: true } } },
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: 'ORGANIZATION_SETTING_NOT_UPDATABLE' },
    });
    expect(save).not.toHaveBeenCalled();
  });
});
