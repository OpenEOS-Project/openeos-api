import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthDetailsGuard } from './health-details.guard';

const TOKEN = 'monitoring-token-0123456789abcdef';

function context(headers: Record<string, string>) {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers,
  };
  return {
    request,
    ctx: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
}

function guard(token: string | undefined, user?: { isSuperAdmin: boolean }) {
  const g = new HealthDetailsGuard({
    get: () => token,
  } as unknown as ConfigService);
  // Die JWT-Pruefung von Passport ersetzen: angemeldet als `user` oder 401.
  const jwt = jest
    .spyOn(Object.getPrototypeOf(HealthDetailsGuard.prototype), 'canActivate')
    .mockImplementation(function (this: unknown, ...args: unknown[]) {
      const ctx = args[0] as ExecutionContext;
      if (!user) return Promise.reject(new UnauthorizedException());
      ctx.switchToHttp().getRequest<{ user?: unknown }>().user = user;
      return Promise.resolve(true);
    });
  return { g, jwt };
}

afterEach(() => jest.restoreAllMocks());

describe('detailed health status', () => {
  it('is guarded', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      Object.getOwnPropertyDescriptor(HealthController.prototype, 'detailed')!
        .value as object,
    ) as unknown[];
    expect(guards).toContain(HealthDetailsGuard);
  });

  it('is available with the internal token', async () => {
    const { g, jwt } = guard(TOKEN);
    await expect(
      g.canActivate(context({ 'x-health-token': TOKEN }).ctx),
    ).resolves.toBe(true);
    expect(jwt).not.toHaveBeenCalled();
  });

  it('rejects a wrong internal token', async () => {
    const { g } = guard(TOKEN, { isSuperAdmin: true });
    await expect(
      g.canActivate(context({ 'x-health-token': 'wrong' }).ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ignores the header when no internal token is configured', async () => {
    const { g } = guard(undefined);
    await expect(
      g.canActivate(context({ 'x-health-token': '' }).ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('is available to super admins', async () => {
    const { g } = guard(TOKEN, { isSuperAdmin: true });
    await expect(g.canActivate(context({}).ctx)).resolves.toBe(true);
  });

  it('is not available to other signed-in users', async () => {
    const { g } = guard(TOKEN, { isSuperAdmin: false });
    await expect(g.canActivate(context({}).ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('is not available without sign-in', async () => {
    const { g } = guard(TOKEN);
    await expect(g.canActivate(context({}).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
