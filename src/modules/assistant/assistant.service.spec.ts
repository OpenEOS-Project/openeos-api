import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  AdminAction,
  AdminAuditLog,
  Organization,
  User,
} from '../../database/entities';
import { OrganizationsService } from '../organizations/organizations.service';
import { AiProvider } from '../ai/ai-provider.interface';
import { AiQuotaService } from '../ai/ai-quota.service';
import { AssistantService } from './assistant.service';

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const user = { id: 'user-1' } as User;

function setup(options: { enabled?: boolean; available?: boolean } = {}) {
  const stored = {
    id: ORG,
    settings:
      options.enabled === undefined
        ? {}
        : { assistant: { enabled: options.enabled } },
  } as unknown as Organization;
  const query = jest.fn((_sql: string, params: unknown[]) => {
    (stored.settings as Record<string, unknown>).assistant = JSON.parse(
      params[1] as string,
    ) as unknown;
    return Promise.resolve([]);
  });
  const organizationRepository = {
    query,
    findOne: jest.fn(() => Promise.resolve(structuredClone(stored))),
  } as unknown as Repository<Organization>;
  const auditSave = jest.fn((entry: unknown) => Promise.resolve(entry));
  const auditLogRepository = {
    create: jest.fn((entry: unknown) => entry),
    save: auditSave,
  } as unknown as Repository<AdminAuditLog>;
  const checkRole = jest.fn(() => Promise.resolve({}));
  const organizationsService = {
    findOne: jest.fn(() => Promise.resolve(structuredClone(stored))),
    checkRole,
  } as unknown as OrganizationsService;
  const provider = {
    isAvailable: () => options.available ?? true,
  } as unknown as AiProvider;
  const quota = {
    getQuota: jest.fn((_org: string, feature: string) =>
      Promise.resolve({
        limit: feature === 'menu_import' ? 5 : 500,
        used: 1,
        remaining: 4,
        resetAt: 'r',
      }),
    ),
  } as unknown as AiQuotaService;
  const service = new AssistantService(
    organizationRepository,
    auditLogRepository,
    organizationsService,
    provider,
    quota,
  );
  return { service, query, auditSave, checkRole };
}

describe('AssistantService', () => {
  it('reports status with availability and both quotas', async () => {
    const { service } = setup({ enabled: true });
    await expect(service.getStatus(ORG, user)).resolves.toEqual({
      enabled: true,
      available: true,
      quotas: {
        menuImports: { limit: 5, used: 1, remaining: 4, resetAt: 'r' },
        classifications: { limit: 500, used: 1, remaining: 4, resetAt: 'r' },
      },
    });
  });

  it('enables for admins via jsonb_set and writes an audit entry', async () => {
    const { service, query, auditSave, checkRole } = setup({});
    const status = await service.setEnabled(ORG, true, user, {
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
    });
    expect(checkRole).toHaveBeenCalledWith(ORG, user, 'admin');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("'{assistant}'");
    expect(JSON.parse(params[1] as string)).toMatchObject({
      enabled: true,
      enabledByUserId: 'user-1',
    });
    expect(status.enabled).toBe(true);
    expect(auditSave).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAction.ASSISTANT_ENABLED,
        organizationId: ORG,
        adminUserId: 'user-1',
        ipAddress: '10.0.0.1',
      }),
    );
  });

  it('does not write anything when the switch already has that value', async () => {
    const { service, query, auditSave } = setup({ enabled: true });
    await service.setEnabled(ORG, true, user);
    expect(query).not.toHaveBeenCalled();
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('assertUsable: 404 without provider, 403 without opt-in', async () => {
    await expect(
      setup({ enabled: true, available: false }).service.assertUsable(ORG),
    ).rejects.toMatchObject({
      response: { code: 'AI_DISABLED' },
    });
    await expect(
      setup({ enabled: true, available: false }).service.assertUsable(ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup({ enabled: false }).service.assertUsable(ORG),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      setup({ enabled: false }).service.assertUsable(ORG),
    ).rejects.toMatchObject({
      response: { code: 'ASSISTANT_DISABLED' },
    });
    await expect(
      setup({ enabled: true }).service.assertUsable(ORG),
    ).resolves.toMatchObject({ id: ORG });
  });
});
