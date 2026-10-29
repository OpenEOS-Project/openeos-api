import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiTokenAccess } from '../decorators/api-token-access.decorator';
import { TokenScope } from '../../modules/api-tokens/api-scopes';
import type {
  ApiTokensService,
  TokenPruefung,
} from '../../modules/api-tokens/api-tokens.service';
import type { AppRequest } from '../types/request.types';
import { User } from '../../database/entities';

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const OTHER_ORG = '1b1b1b1b-4f43-4a3e-9f8e-0f2b8f3f1a22';

/* Handler mit und ohne Freigabe — die Metadaten kommen vom Decorator,
   genau wie an einem echten Controller. */
class Handlers {
  @ApiTokenAccess(TokenScope.READ)
  lesen() {}

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  schreiben() {}

  @ApiTokenAccess(TokenScope.MONITORING_READ)
  metrics() {}

  gesperrt() {}
}

function contextFor(
  handler: keyof Handlers,
  request: Partial<AppRequest>,
): { context: ExecutionContext; request: AppRequest } {
  const req = {
    headers: { authorization: 'Bearer oeos_secret' },
    params: {},
    body: {},
    query: {},
    ...request,
  } as unknown as AppRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
    getType: () => 'http',
  } as unknown as ExecutionContext;
  return { context, request: req };
}

const owner = {
  id: 'user-1',
  email: 'lena@example.org',
  isActive: true,
  isSuperAdmin: false,
} as User;

function pruefung(overrides: Partial<TokenPruefung> = {}): TokenPruefung {
  return {
    user: { ...owner } as User,
    scopes: [TokenScope.READ],
    token: { id: 'token-1', name: 'Agent', organizationId: ORG },
    membership: { role: 'admin' } as TokenPruefung['membership'],
    ...overrides,
  };
}

function guardWith(
  result: TokenPruefung | null,
  events: Record<string, string> = {},
) {
  const service = {
    pruefe: jest.fn(() => Promise.resolve(result)),
    organizationOfEvent: jest.fn((id: string) =>
      Promise.resolve(events[id] ?? null),
    ),
  };
  const guard = new JwtAuthGuard(
    new Reflector(),
    service as unknown as ApiTokensService,
  );
  return { guard, service };
}

describe('JwtAuthGuard with API tokens', () => {
  it('lets a valid token through and restricts the user to its organization', async () => {
    const { guard } = guardWith(pruefung());
    const { context, request } = contextFor('lesen', {
      params: { organizationId: ORG },
    });

    expect(await guard.canActivate(context)).toBe(true);
    expect(request.user?.id).toBe('user-1');
    expect(request.user?.organizations).toEqual([{ id: ORG, role: 'admin' }]);
    expect(request.apiToken).toEqual({
      id: 'token-1',
      name: 'Agent',
      organizationId: ORG,
      scopes: [TokenScope.READ],
    });
    expect(request.organizationId).toBe(ORG);
  });

  it('rejects unknown, revoked or expired tokens with 401 API_TOKEN_INVALID', async () => {
    const { guard } = guardWith(null);
    const { context } = contextFor('lesen', {
      params: { organizationId: ORG },
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      constructor: UnauthorizedException,
      response: { reason: 'API_TOKEN_INVALID' },
    });
  });

  it('rejects endpoints without @ApiTokenAccess, whatever the owner may do', async () => {
    const { guard } = guardWith(
      pruefung({ user: { ...owner, isSuperAdmin: true } as User }),
    );
    const { context } = contextFor('gesperrt', {
      params: { organizationId: ORG },
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { reason: 'API_TOKEN_NOT_ALLOWED' },
    });
  });

  it('rejects a token without the required scope', async () => {
    const { guard } = guardWith(pruefung({ scopes: [TokenScope.READ] }));
    const { context } = contextFor('schreiben', {
      params: { organizationId: ORG },
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: {
        reason: 'API_TOKEN_SCOPE_MISSING',
        params: { scope: 'catalog:write' },
      },
    });
  });

  it('write scopes do not imply read', async () => {
    const { guard } = guardWith(
      pruefung({ scopes: [TokenScope.CATALOG_WRITE] }),
    );
    const { context } = contextFor('lesen', {
      params: { organizationId: ORG },
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { reason: 'API_TOKEN_SCOPE_MISSING' },
    });
  });

  it.each([
    ['path', { params: { organizationId: OTHER_ORG } }],
    [
      'header',
      {
        params: { organizationId: ORG },
        headers: {
          authorization: 'Bearer oeos_secret',
          'x-organization-id': OTHER_ORG,
        },
      },
    ],
    [
      'body',
      { params: { organizationId: ORG }, body: { organizationId: OTHER_ORG } },
    ],
    [
      'query',
      { params: { organizationId: ORG }, query: { organizationId: OTHER_ORG } },
    ],
    [
      'organizations/:id route',
      { params: { id: OTHER_ORG }, route: { path: '/api/organizations/:id' } },
    ],
    ['no organization at all', { params: {} }],
  ])(
    'rejects another organization named in the %s with 403 API_TOKEN_WRONG_ORGANIZATION',
    async (_label, request) => {
      const { guard } = guardWith(pruefung());
      const { context } = contextFor('lesen', request as Partial<AppRequest>);
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        constructor: ForbiddenException,
        response: { reason: 'API_TOKEN_WRONG_ORGANIZATION' },
      });
    },
  );

  it('accepts organizations/:id for the token organization', async () => {
    const { guard } = guardWith(pruefung());
    const { context } = contextFor('lesen', {
      params: { id: ORG },
      route: { path: '/api/organizations/:id' },
    } as Partial<AppRequest>);
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('resolves the organization of events/:eventId routes', async () => {
    const { guard, service } = guardWith(pruefung(), {
      'event-ok': ORG,
      'event-foreign': OTHER_ORG,
    });

    const ok = contextFor('lesen', { params: { eventId: 'event-ok' } });
    expect(await guard.canActivate(ok.context)).toBe(true);
    expect(service.organizationOfEvent).toHaveBeenCalledWith('event-ok');

    const foreign = contextFor('lesen', {
      params: { eventId: 'event-foreign' },
    });
    await expect(guard.canActivate(foreign.context)).rejects.toMatchObject({
      response: { reason: 'API_TOKEN_WRONG_ORGANIZATION' },
    });

    const missing = contextFor('lesen', {
      params: { eventId: 'event-missing' },
    });
    await expect(guard.canActivate(missing.context)).rejects.toMatchObject({
      constructor: NotFoundException,
      response: { reason: 'EVENT_NOT_FOUND' },
    });
  });

  it('platform tokens reach platform endpoints but no organization', async () => {
    const platform = pruefung({
      user: { ...owner, isSuperAdmin: true } as User,
      scopes: [TokenScope.MONITORING_READ],
      token: { id: 'token-p', name: 'Grafana', organizationId: null },
      membership: null,
    });
    const { guard } = guardWith(platform);

    const metrics = contextFor('metrics', { params: {} });
    expect(await guard.canActivate(metrics.context)).toBe(true);
    expect(metrics.request.user?.organizations).toEqual([]);
    expect(metrics.request.apiToken?.organizationId).toBeNull();

    const org = contextFor('metrics', { params: { organizationId: ORG } });
    await expect(guard.canActivate(org.context)).rejects.toMatchObject({
      response: { reason: 'API_TOKEN_WRONG_ORGANIZATION' },
    });
  });

  it('leaves JWT requests to passport', async () => {
    const { guard, service } = guardWith(pruefung());
    const { context } = contextFor('gesperrt', {
      headers: { authorization: 'Bearer eyJhbGciOi.not.a-token' },
    } as Partial<AppRequest>);
    const passport = jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockResolvedValue(true);
    try {
      expect(await guard.canActivate(context)).toBe(true);
      expect(service.pruefe).not.toHaveBeenCalled();
    } finally {
      passport.mockRestore();
    }
  });
});
