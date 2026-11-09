import type { Request } from 'express';

import type { Organization } from '../../database/entities/organization.entity';
import type { TseUnit } from '../../database/entities/tse-unit.entity';
import type { User } from '../../database/entities/user.entity';
import { AuthController } from '../auth/auth.controller';
import type { AuthService } from '../auth/auth.service';
import { TseStatusService, tseSummaryOf } from '../tse/tse-status.service';
import { OrganizationViewService } from './organization-view.service';
import { OrganizationsController } from './organizations.controller';
import type { OrganizationsService } from './organizations.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '05e0c31e-9b3a-4f43-9f8e-0f2b8f3f1a11';
const OTHER_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a22';

/** Deutsche Organisation, Alle Funktionen, Cloud-TSE an und aktiv. */
function germanWithTse(id = ORG_ID): Organization {
  return {
    id,
    name: 'Musterverein',
    country: 'DE',
    operatingMode: 'full',
    operatingModeLegacy: false,
    operatingModeSince: new Date('2026-11-02T10:00:00.000Z'),
    tseActive: true,
    settings: {
      currency: 'EUR',
      integrations: { tse: { enabled: true } },
    },
  } as unknown as Organization;
}

function unit(organizationId: string, state: TseUnit['state']): TseUnit {
  return {
    id: `unit-${organizationId}`,
    organizationId,
    state,
    serialNumber: 'ab'.repeat(32),
    clientId: 'OEOS-05E0C31E9B3A',
  } as unknown as TseUnit;
}

function tseStatusService(units: TseUnit[]) {
  const findLatestFor = jest.fn((ids: readonly string[]) =>
    Promise.resolve(
      new Map(
        units
          .filter((u) => ids.includes(u.organizationId))
          .map((u) => [u.organizationId, u] as const),
      ),
    ),
  );
  const none = undefined as never;
  const service = new TseStatusService(
    none,
    none,
    { enabled: true, availability: 'available' } as never,
    { findLatestFor } as never,
    none,
    none,
    none,
  );
  return { service, findLatestFor };
}

const DERIVED = {
  country: 'DE',
  operatingMode: 'full',
  operatingModeLegacy: false,
  operatingModeSince: '2026-11-02T10:00:00.000Z',
  tseActive: true,
  cashAllowed: true,
  pricesVisible: true,
  tse: {
    available: true,
    integrationEnabled: true,
    active: true,
    state: 'active',
    serialNumber: 'ab'.repeat(32),
    clientId: 'OEOS-05E0C31E9B3A',
  },
};

describe('OrganizationViewService', () => {
  it('adds operating mode, cash and TSE fields to the stored organization', async () => {
    const { service } = tseStatusService([unit(ORG_ID, 'active')]);
    const view = await new OrganizationViewService(service).view(
      germanWithTse(),
    );
    expect(view).toMatchObject({
      id: ORG_ID,
      name: 'Musterverein',
      ...DERIVED,
    });
  });

  it('loads the TSE of a whole list with one query', async () => {
    const { service, findLatestFor } = tseStatusService([
      unit(ORG_ID, 'active'),
    ]);
    const other = {
      ...germanWithTse(OTHER_ID),
      country: 'AT',
      tseActive: false,
      settings: { currency: 'EUR' },
    } as unknown as Organization;
    const views = await new OrganizationViewService(service).views([
      germanWithTse(),
      other,
    ]);
    expect(findLatestFor).toHaveBeenCalledTimes(1);
    expect(views[0]).toMatchObject(DERIVED);
    expect(views[1]).toMatchObject({
      country: 'AT',
      tseActive: false,
      cashAllowed: true,
      tse: { integrationEnabled: false, active: false, state: null },
    });
  });

  it('reports tse null without the TSE module', async () => {
    const view = await new OrganizationViewService().view(germanWithTse());
    expect(view.tse).toBeNull();
    expect(view.cashAllowed).toBe(true);
  });

  it('maps memberships without touching the loaded entities', async () => {
    const { service } = tseStatusService([unit(ORG_ID, 'active')]);
    const organization = germanWithTse();
    const user = {
      id: 'user-1',
      userOrganizations: [
        { organizationId: ORG_ID, role: 'admin', organization },
      ],
    };
    const mapped = await new OrganizationViewService(service).forMemberships(
      user,
    );
    expect(mapped.userOrganizations[0]).toMatchObject({
      role: 'admin',
      organization: DERIVED,
    });
    expect('cashAllowed' in organization).toBe(false);
  });
});

describe('tseSummaryOf', () => {
  it('is only active with the integration switched on', () => {
    const off = {
      settings: { integrations: { tse: { enabled: false } } },
    } as unknown as Organization;
    expect(
      tseSummaryOf(off, unit(ORG_ID, 'active'), 'available'),
    ).toMatchObject({
      integrationEnabled: false,
      active: false,
      state: 'active',
    });
  });

  it('shows the latest unit even when deactivated', () => {
    expect(
      tseSummaryOf(germanWithTse(), unit(ORG_ID, 'deactivated'), 'available'),
    ).toMatchObject({ active: false, state: 'deactivated' });
  });
});

describe('organization responses carry the same derived fields', () => {
  function orgController() {
    const { service } = tseStatusService([unit(ORG_ID, 'active')]);
    const organizationsService = {
      findOne: jest.fn(() => Promise.resolve(germanWithTse())),
      memberUsage: jest.fn(() =>
        Promise.resolve({ memberLimit: 0, memberCount: 1 }),
      ),
      setIntegrationEnabled: jest.fn(() => Promise.resolve(germanWithTse())),
      update: jest.fn(() => Promise.resolve(germanWithTse())),
      create: jest.fn(() => Promise.resolve(germanWithTse())),
      findAll: jest.fn(() =>
        Promise.resolve({
          data: [germanWithTse()],
          meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
        }),
      ),
    };
    const gatewayService = { notifyOrganizationSettingsUpdated: jest.fn() };
    const none = undefined as never;
    const controller = new OrganizationsController(
      organizationsService as unknown as OrganizationsService,
      gatewayService as never,
      none,
      none,
      none,
      new OrganizationViewService(service),
    );
    return { controller };
  }
  const user = { id: 'user-1' } as User;
  const request = { ip: '127.0.0.1', headers: {} } as unknown as Request;

  it('GET /organizations/:id', async () => {
    const { controller } = orgController();
    const { data } = await controller.findOne(ORG_ID, user);
    expect(data).toMatchObject({ ...DERIVED, memberCount: 1 });
  });

  it('PATCH /organizations/:id/integrations/:integrationId', async () => {
    const { controller } = orgController();
    const { data } = await controller.setIntegration(
      ORG_ID,
      'tse',
      { enabled: true },
      user,
      request,
    );
    expect(data).toMatchObject(DERIVED);
  });

  it('PATCH /organizations/:id', async () => {
    const { controller } = orgController();
    const { data } = await controller.update(ORG_ID, { name: 'Neu' }, user);
    expect(data).toMatchObject(DERIVED);
  });

  it('POST /organizations', async () => {
    const { controller } = orgController();
    const { data } = await controller.create({ name: 'Neu' } as never, user);
    expect(data).toMatchObject(DERIVED);
  });

  it('GET /organizations', async () => {
    const { controller } = orgController();
    const page = await controller.findAll(user, {} as never);
    expect(page.data[0]).toMatchObject(DERIVED);
    expect(page.meta).toMatchObject({ total: 1 });
  });

  it('GET /auth/me lists the organizations with the derived fields', async () => {
    const { service } = tseStatusService([unit(ORG_ID, 'active')]);
    const fullUser = {
      id: 'user-1',
      email: 'a@b.de',
      passwordHash: 'secret-hash',
      userOrganizations: [
        {
          organizationId: ORG_ID,
          role: 'admin',
          organization: germanWithTse(),
        },
      ],
    };
    const authService = {
      getCurrentUser: jest.fn(() => Promise.resolve(fullUser)),
    } as unknown as AuthService;
    const limits = { effectiveOrganizationLimit: () => 0 };
    const controller = new AuthController(
      authService,
      undefined as never,
      undefined as never,
      limits as never,
      new OrganizationViewService(service),
      { isReacceptanceRequired: () => Promise.resolve(false) } as never,
    );
    const { user: me } = await controller.getCurrentUser(fullUser as never);
    expect(me.userOrganizations?.[0].organization).toMatchObject(DERIVED);
    expect('passwordHash' in me).toBe(false);
    expect(me.organizationCount).toBe(1);
  });
});
