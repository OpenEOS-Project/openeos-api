import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import {
  AdminAction,
  AdminAuditLog,
  ApiToken,
  Event,
  User,
  UserOrganization,
} from '../../database/entities';
import {
  ApiTokensService,
  LAST_USED_INTERVAL_MS,
  MAX_ACTIVE_TOKENS_PER_ORGANIZATION,
  hashToken,
} from './api-tokens.service';
import { TokenScope } from './api-scopes';

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const OTHER_ORG = '1b1b1b1b-4f43-4a3e-9f8e-0f2b8f3f1a22';

function setup(options: { active?: number; membership?: boolean } = {}) {
  const saved: ApiToken[] = [];
  const apiTokenRepository = {
    create: jest.fn((entry: Partial<ApiToken>) => ({
      id: `token-${saved.length + 1}`,
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
      ...entry,
    })),
    save: jest.fn((entry: ApiToken) => {
      saved.push(entry);
      return Promise.resolve(entry);
    }),
    count: jest.fn(() => Promise.resolve(options.active ?? 0)),
    find: jest.fn(() => Promise.resolve(saved)),
    findOne: jest.fn(),
    update: jest.fn(() => Promise.resolve()),
  };
  const userOrganizationRepository = {
    findOne: jest.fn(() =>
      Promise.resolve(
        options.membership === false
          ? null
          : ({ role: 'admin', permissions: {} } as UserOrganization),
      ),
    ),
  };
  const eventRepository = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === 'event-1' ? { id: 'event-1', organizationId: ORG } : null,
      ),
    ),
  };
  const auditLogRepository = {
    create: jest.fn((entry: unknown) => entry),
    save: jest.fn((entry: unknown) => Promise.resolve(entry)),
  };
  const service = new ApiTokensService(
    apiTokenRepository as unknown as Repository<ApiToken>,
    userOrganizationRepository as unknown as Repository<UserOrganization>,
    eventRepository as unknown as Repository<Event>,
    auditLogRepository as unknown as Repository<AdminAuditLog>,
  );
  return {
    service,
    saved,
    apiTokenRepository,
    userOrganizationRepository,
    auditLogRepository,
  };
}

const owner = {
  id: 'user-1',
  isActive: true,
  isSuperAdmin: false,
  firstName: 'Lena',
  lastName: 'Muster',
} as User;

function storedToken(overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id: 'token-1',
    name: 'Agent',
    tokenHash: hashToken('oeos_secret'),
    tokenPrefix: 'oeos_secret'.slice(0, 12),
    userId: owner.id,
    user: owner,
    organizationId: ORG,
    scopes: [TokenScope.READ],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ApiToken;
}

describe('ApiTokensService', () => {
  describe('erstelle', () => {
    it('returns the secret once and stores only its SHA-256 hash', async () => {
      const { service, saved, auditLogRepository } = setup();
      const { token, eintrag } = await service.erstelle({
        userId: owner.id,
        organizationId: ORG,
        name: 'Claude Desktop',
        scopes: [TokenScope.READ, TokenScope.CATALOG_WRITE],
      });

      expect(token).toMatch(/^oeos_[A-Za-z0-9_-]{43}$/);
      expect(saved[0].tokenHash).toBe(
        crypto.createHash('sha256').update(token).digest('hex'),
      );
      expect(saved[0].tokenPrefix).toBe(token.slice(0, 12));
      expect(saved[0].organizationId).toBe(ORG);
      expect(eintrag).not.toHaveProperty('tokenHash');
      expect(eintrag).not.toHaveProperty('token');
      expect(eintrag.tokenPrefix).toBe(token.slice(0, 12));
      expect(auditLogRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AdminAction.API_TOKEN_CREATED,
          organizationId: ORG,
          resourceType: 'api_token',
          details: expect.objectContaining({
            scopes: [TokenScope.READ, TokenScope.CATALOG_WRITE],
          }) as unknown,
        }),
      );
    });

    it('refuses the 21st active token of an organization', async () => {
      const { service } = setup({
        active: MAX_ACTIVE_TOKENS_PER_ORGANIZATION,
      });
      await expect(
        service.erstelle({
          userId: owner.id,
          organizationId: ORG,
          name: 'one too many',
          scopes: [TokenScope.READ],
        }),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        response: { reason: 'API_TOKEN_LIMIT_REACHED', params: { limit: 20 } },
      });
    });

    it('refuses platform scopes on organization tokens and vice versa', async () => {
      const { service } = setup();
      await expect(
        service.erstelle({
          userId: owner.id,
          organizationId: ORG,
          name: 'x',
          scopes: [TokenScope.MONITORING_READ],
        }),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { reason: 'API_TOKEN_SCOPE_INVALID' },
      });
      await expect(
        service.erstelle({
          userId: owner.id,
          name: 'x',
          scopes: [TokenScope.READ],
        }),
      ).rejects.toMatchObject({
        response: { reason: 'API_TOKEN_SCOPE_INVALID' },
      });
      await expect(
        service.erstelle({
          userId: owner.id,
          organizationId: ORG,
          name: 'x',
          scopes: [],
        }),
      ).rejects.toMatchObject({
        response: { reason: 'API_TOKEN_SCOPE_INVALID' },
      });
    });

    it('refuses an expiry in the past', async () => {
      const { service } = setup();
      await expect(
        service.erstelle({
          userId: owner.id,
          organizationId: ORG,
          name: 'x',
          scopes: [TokenScope.READ],
          expiresAt: new Date(Date.now() - 1000),
        }),
      ).rejects.toMatchObject({
        response: { reason: 'API_TOKEN_EXPIRES_IN_PAST' },
      });
    });

    it('does not write an audit entry for platform tokens', async () => {
      const { service, auditLogRepository } = setup();
      await service.erstelle({
        userId: owner.id,
        name: 'Grafana',
        scopes: [TokenScope.MONITORING_READ],
      });
      expect(auditLogRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('pruefe', () => {
    it('accepts a valid token and reports its organization', async () => {
      const { service, apiTokenRepository } = setup();
      apiTokenRepository.findOne.mockResolvedValue(storedToken());

      const result = await service.pruefe('oeos_secret');

      expect(apiTokenRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: hashToken('oeos_secret') },
        }),
      );
      expect(result?.user).toBe(owner);
      expect(result?.scopes).toEqual([TokenScope.READ]);
      expect(result?.token).toEqual({
        id: 'token-1',
        name: 'Agent',
        organizationId: ORG,
      });
      expect(result?.membership?.role).toBe('admin');
    });

    it.each([
      ['unknown', null],
      ['revoked', storedToken({ revokedAt: new Date() })],
      ['expired', storedToken({ expiresAt: new Date(Date.now() - 1) })],
      [
        'owner inactive',
        storedToken({ user: { ...owner, isActive: false } as User }),
      ],
    ])('rejects a %s token', async (_label, stored) => {
      const { service, apiTokenRepository } = setup();
      apiTokenRepository.findOne.mockResolvedValue(stored);
      expect(await service.pruefe('oeos_secret')).toBeNull();
    });

    it('rejects a token whose owner left the organization', async () => {
      const { service, apiTokenRepository } = setup({ membership: false });
      apiTokenRepository.findOne.mockResolvedValue(storedToken());
      expect(await service.pruefe('oeos_secret')).toBeNull();
    });

    it('rejects a platform token whose owner is no longer super admin', async () => {
      const { service, apiTokenRepository } = setup();
      apiTokenRepository.findOne.mockResolvedValue(
        storedToken({
          organizationId: null,
          scopes: [TokenScope.MONITORING_READ],
        }),
      );
      expect(await service.pruefe('oeos_secret')).toBeNull();

      apiTokenRepository.findOne.mockResolvedValue(
        storedToken({
          organizationId: null,
          scopes: [TokenScope.MONITORING_READ],
          user: { ...owner, isSuperAdmin: true } as User,
        }),
      );
      const result = await service.pruefe('oeos_secret');
      expect(result?.token.organizationId).toBeNull();
      expect(result?.membership).toBeNull();
    });

    it('records last use at most once per minute', async () => {
      const { service, apiTokenRepository } = setup();
      apiTokenRepository.findOne.mockResolvedValue(storedToken());
      await service.pruefe('oeos_secret');
      await new Promise((r) => setImmediate(r));
      expect(apiTokenRepository.update).toHaveBeenCalledTimes(1);

      apiTokenRepository.findOne.mockResolvedValue(
        storedToken({
          lastUsedAt: new Date(Date.now() - LAST_USED_INTERVAL_MS / 2),
        }),
      );
      await service.pruefe('oeos_secret');
      await new Promise((r) => setImmediate(r));
      expect(apiTokenRepository.update).toHaveBeenCalledTimes(1);

      apiTokenRepository.findOne.mockResolvedValue(
        storedToken({
          lastUsedAt: new Date(Date.now() - LAST_USED_INTERVAL_MS - 1),
        }),
      );
      await service.pruefe('oeos_secret');
      await new Promise((r) => setImmediate(r));
      expect(apiTokenRepository.update).toHaveBeenCalledTimes(2);
    });
  });

  it('organizationOfEvent resolves the owning organization', async () => {
    const { service } = setup();
    expect(await service.organizationOfEvent('event-1')).toBe(ORG);
    expect(await service.organizationOfEvent('nope')).toBeNull();
  });

  describe('widerrufeOrganisation', () => {
    it('revokes once, writes an audit entry and never returns the hash', async () => {
      const { service, apiTokenRepository, auditLogRepository } = setup();
      const stored = storedToken();
      apiTokenRepository.findOne.mockResolvedValue(stored);
      const actor = { id: 'admin-2' } as User;

      const result = await service.widerrufeOrganisation(ORG, 'token-1', actor);
      expect(result.revokedAt).toBeInstanceOf(Date);
      expect(result).not.toHaveProperty('tokenHash');
      expect(result.createdBy).toEqual({
        id: owner.id,
        firstName: 'Lena',
        lastName: 'Muster',
      });
      expect(auditLogRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AdminAction.API_TOKEN_REVOKED,
          adminUserId: 'admin-2',
          resourceId: 'token-1',
        }),
      );

      await service.widerrufeOrganisation(ORG, 'token-1', actor);
      expect(apiTokenRepository.save).toHaveBeenCalledTimes(1);
    });

    it('is scoped to the organization', async () => {
      const { service, apiTokenRepository } = setup();
      apiTokenRepository.findOne.mockResolvedValue(null);
      await expect(
        service.widerrufeOrganisation(OTHER_ORG, 'token-1', owner),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(apiTokenRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'token-1', organizationId: OTHER_ORG },
        }),
      );
    });
  });

  it('listeOrganisation never includes the hash', async () => {
    const { service, apiTokenRepository } = setup();
    apiTokenRepository.find.mockResolvedValue([storedToken()]);
    const [entry] = await service.listeOrganisation(ORG);
    expect(entry).not.toHaveProperty('tokenHash');
    expect(entry).not.toHaveProperty('user');
    expect(entry.tokenPrefix).toBe('oeos_secret');
  });
});
