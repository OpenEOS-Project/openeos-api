import { Logger } from '@nestjs/common';

import { hasActiveTse, resetTseStatus } from '../../common/utils/tse.util';
import { isCashAllowed } from '../../common/utils/operating-mode.util';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import type { Organization } from '../../database/entities/organization.entity';
import type { User } from '../../database/entities/user.entity';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  autoCreateHorizon,
  berlinTime,
  businessDayEnd,
  localDate,
  startOfLocalMonth,
} from './tse-dates';
import { billedMonths } from './tse-admin.controller';

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
  resetTseStatus();
});

describe('hasActiveTse (Integration an UND TSE aktiv)', () => {
  const base = {
    id: 'o',
    country: 'DE',
    operatingMode: 'full',
    operatingModeLegacy: false,
  };
  it.each([
    [
      {
        tseActive: true,
        settings: { integrations: { tse: { enabled: true } } },
      },
      true,
    ],
    [
      {
        tseActive: true,
        settings: { integrations: { tse: { enabled: false } } },
      },
      false,
    ],
    [
      {
        tseActive: false,
        settings: { integrations: { tse: { enabled: true } } },
      },
      false,
    ],
    [{ tseActive: true, settings: {} }, false],
    [{ settings: { integrations: { tse: { enabled: true } } } }, false],
  ])('%j -> %s (and cash in DE follows it)', (org, expected) => {
    expect(hasActiveTse({ ...base, ...org })).toBe(expected);
    expect(isCashAllowed({ ...base, ...org })).toBe(expected);
  });
});

describe('Integration „tse“ umschalten (OrganizationsService.setIntegrationEnabled)', () => {
  function setup(country: string, liveUnits: number) {
    const audit: Array<{ action: string }> = [];
    const repo = {
      create: (x: { action: string }) => x,
      save: (x: { action: string }) => {
        audit.push(x);
        return Promise.resolve(x);
      },
    };
    const dataSource = {
      query: jest.fn(() =>
        Promise.resolve(
          Array.from({ length: liveUnits }, () => ({ '?column?': 1 })),
        ),
      ),
      getRepository: jest.fn(() => repo),
    };
    const organizationRepository = {
      query: jest.fn(() => Promise.resolve([])),
    };
    const env: Record<string, string> = {
      TSE_PROVIDER: 'swissbit',
      SWISSBIT_CREDIT_CLIENT_ID: 'c',
      SWISSBIT_CREDIT_CLIENT_SECRET: 's',
      SWISSBIT_PRODUCT_TYPE: '850007',
    };
    const service = new OrganizationsService(
      organizationRepository as never,
      {} as never,
      {} as never,
      {} as never,
      dataSource as never,
      {} as never,
      {} as never,
      { get: (key: string) => env[key] } as never,
      {} as never,
      {} as never,
    );
    const org = { id: 'org-1', country } as Organization;
    jest.spyOn(service, 'findOne').mockResolvedValue(org);
    jest
      .spyOn(service as never, 'checkRole' as never)
      .mockResolvedValue(undefined as never);
    return { service, audit, organizationRepository, env };
  }
  const user = { id: 'u1' } as User;

  it('enabling is only possible in Germany', async () => {
    const { service } = setup('AT', 0);
    await expect(
      service.setIntegrationEnabled('org-1', 'tse', true, user),
    ).rejects.toMatchObject({
      response: { code: 'TSE_COUNTRY_NOT_SUPPORTED' },
    });
  });

  it('enabling needs a configured TSE provider on the server', async () => {
    const { service, env } = setup('DE', 0);
    env.TSE_PROVIDER = 'none';
    await expect(
      service.setIntegrationEnabled('org-1', 'tse', true, user),
    ).rejects.toMatchObject({
      response: { code: 'TSE_NOT_AVAILABLE' },
    });
  });

  it('enabling in Germany writes the setting and an audit entry', async () => {
    const { service, audit, organizationRepository } = setup('DE', 0);
    await service.setIntegrationEnabled('org-1', 'tse', true, user, {
      ipAddress: '1.2.3.4',
    });
    expect(organizationRepository.query).toHaveBeenCalled();
    expect(audit.map((a) => a.action)).toEqual([
      AdminAction.TSE_INTEGRATION_ENABLED,
    ]);
  });

  it('disabling with a live TSE is refused (deactivation is a separate, permanent step)', async () => {
    const { service, organizationRepository } = setup('DE', 1);
    await expect(
      service.setIntegrationEnabled('org-1', 'tse', false, user),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'TSE_ACTIVE_DEACTIVATE_FIRST' },
    });
    expect(organizationRepository.query).not.toHaveBeenCalled();
  });

  it('disabling without a live TSE works and is audited', async () => {
    const { service, audit } = setup('DE', 0);
    await service.setIntegrationEnabled('org-1', 'tse', false, user);
    expect(audit.map((a) => a.action)).toEqual([
      AdminAction.TSE_INTEGRATION_DISABLED,
    ]);
  });
});

describe('Berlin dates for the cost rules', () => {
  it('business day ends at 6:00 local time (also across DST)', () => {
    expect(businessDayEnd(berlinTime(2026, 7, 19, 23)).toISOString()).toBe(
      '2026-07-20T04:00:00.000Z',
    );
    expect(businessDayEnd(berlinTime(2026, 7, 20, 3)).toISOString()).toBe(
      '2026-07-20T04:00:00.000Z',
    );
    expect(businessDayEnd(berlinTime(2026, 10, 24, 22)).toISOString()).toBe(
      '2026-10-25T05:00:00.000Z',
    );
  });

  it('auto creation covers events starting today until tomorrow 6:00', () => {
    expect(autoCreateHorizon(berlinTime(2026, 7, 18, 5)).toISOString()).toBe(
      '2026-07-19T04:00:00.000Z',
    );
    expect(autoCreateHorizon(berlinTime(2026, 7, 18, 21)).toISOString()).toBe(
      '2026-07-19T04:00:00.000Z',
    );
  });

  it('allows creation from the first day of the event month', () => {
    expect(localDate(startOfLocalMonth(berlinTime(2026, 12, 12, 18)))).toBe(
      '2026-12-01',
    );
  });

  it('counts billed calendar months from creation to deactivation', () => {
    expect(
      billedMonths({
        serialNumber: 'x',
        createdAt: berlinTime(2026, 7, 18, 5),
        deactivatedAt: berlinTime(2026, 8, 2, 6),
      }),
    ).toEqual(['2026-07', '2026-08']);
    expect(
      billedMonths({
        serialNumber: null,
        createdAt: new Date(),
        deactivatedAt: null,
      }),
    ).toEqual([]);
  });
});
