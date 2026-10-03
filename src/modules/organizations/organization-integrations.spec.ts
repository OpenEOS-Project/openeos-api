import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { Organization } from '../../database/entities/organization.entity';
import { User } from '../../database/entities/user.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { redactResponse } from '../../common/utils/response-redaction.util';
import { OrganizationsService } from './organizations.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';

const SUMUP = {
  apiKey: 'sup_sk_live_abcdef1234',
  merchantCode: 'MC123',
  affiliateKey: 'aff_key_9876',
};

function setup(options: {
  role?: OrganizationRole | null;
  integrations?: Record<string, { enabled: boolean; enabledAt?: string }>;
}) {
  const stored = {
    id: ORG_ID,
    name: 'Musterverein',
    settings: {
      currency: 'EUR',
      sumup: { ...SUMUP },
      ...(options.integrations ? { integrations: options.integrations } : {}),
    },
  } as unknown as Organization;

  // Der Fake spielt die jsonb-Zusammenfuehrung nach, damit der Test sieht,
  // was nach dem Umschalten in der Zeile steht.
  const query = jest.fn((_sql: string, params: unknown[]) => {
    const [, integrationId, entryJson] = params as [string, string, string];
    const settings = stored.settings as unknown as Record<string, unknown>;
    settings.integrations = {
      ...(settings.integrations as Record<string, unknown> | undefined),
      [integrationId]: JSON.parse(entryJson) as unknown,
    };
    return Promise.resolve([]);
  });
  const findOne = jest.fn(() => Promise.resolve(structuredClone(stored)));
  const save = jest.fn();
  const organizationRepository = {
    query,
    findOne,
    save,
  } as unknown as Repository<Organization>;

  const membershipFindOne = jest.fn(() =>
    Promise.resolve(
      options.role ? ({ role: options.role } as UserOrganization) : null,
    ),
  );
  const userOrganizationRepository = {
    findOne: membershipFindOne,
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

  return { service, stored, query, save };
}

const user = { id: 'user-1', isSuperAdmin: false } as User;

describe('OrganizationsService.setIntegrationEnabled', () => {
  it('enables an integration with a timestamp, scoped to the organization', async () => {
    const { service, query } = setup({ role: OrganizationRole.ADMIN });

    const result = await service.setIntegrationEnabled(
      ORG_ID,
      'sumup',
      true,
      user,
    );

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('WHERE id = $1');
    expect(params[0]).toBe(ORG_ID);
    expect(params[1]).toBe('sumup');
    const entry = JSON.parse(params[2] as string) as {
      enabled: boolean;
      enabledAt: string;
    };
    expect(entry.enabled).toBe(true);
    expect(new Date(entry.enabledAt).toISOString()).toBe(entry.enabledAt);
    expect(result.settings.integrations?.sumup?.enabled).toBe(true);
  });

  it('disables an integration', async () => {
    const { service } = setup({
      role: OrganizationRole.ADMIN,
      integrations: {
        sumup: { enabled: true, enabledAt: '2026-01-01T00:00:00.000Z' },
      },
    });

    const result = await service.setIntegrationEnabled(
      ORG_ID,
      'sumup',
      false,
      user,
    );

    expect(result.settings.integrations?.sumup).toEqual({ enabled: false });
  });

  it('rejects an unknown integration with 404 INTEGRATION_NOT_FOUND', async () => {
    const { service, query } = setup({ role: OrganizationRole.ADMIN });

    const call = service.setIntegrationEnabled(ORG_ID, 'fiskaly', true, user);

    await expect(call).rejects.toBeInstanceOf(NotFoundException);
    await expect(call).rejects.toMatchObject({
      response: { code: 'INTEGRATION_NOT_FOUND' },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a member who is not an admin', async () => {
    const { service, query } = setup({ role: OrganizationRole.MEMBER });

    const call = service.setIntegrationEnabled(ORG_ID, 'sumup', true, user);

    await expect(call).rejects.toBeInstanceOf(ForbiddenException);
    await expect(call).rejects.toMatchObject({
      response: { code: 'FORBIDDEN' },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a user without membership', async () => {
    const { service, query } = setup({ role: null });

    await expect(
      service.setIntegrationEnabled(ORG_ID, 'sumup', true, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(query).not.toHaveBeenCalled();
  });

  it('lets a super-admin toggle without membership', async () => {
    const { service, query } = setup({ role: null });

    await service.setIntegrationEnabled(ORG_ID, 'sumup', true, {
      id: 'root',
      isSuperAdmin: true,
    } as User);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('leaves stored SumUp credentials untouched and unmasked across a toggle', async () => {
    const { service, stored, query, save } = setup({
      role: OrganizationRole.ADMIN,
    });

    await service.setIntegrationEnabled(ORG_ID, 'sumup', false, user);
    const result = await service.setIntegrationEnabled(
      ORG_ID,
      'sumup',
      true,
      user,
    );

    // Nie die kompletten Einstellungen zurueckschreiben ...
    expect(save).not.toHaveBeenCalled();
    // ... und nichts aus den Zugangsdaten in die Schreibabfrage geben.
    for (const [, params] of query.mock.calls) {
      const serialized = JSON.stringify(params);
      expect(serialized).not.toContain(SUMUP.apiKey);
      expect(serialized).not.toContain('****');
    }
    expect(stored.settings.sumup).toEqual(SUMUP);

    // Die Antwort laeuft durch den globalen Interceptor und ist maskiert.
    const response = redactResponse({ data: result });
    expect(response.data.settings.sumup).toEqual({
      ...SUMUP,
      apiKey: '****1234',
      affiliateKey: '****9876',
    });
    expect(response.data.settings.integrations?.sumup?.enabled).toBe(true);
  });
});
