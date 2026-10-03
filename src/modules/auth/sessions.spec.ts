import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { FindOperator } from 'typeorm';

import { ErrorCodes } from '../../common/constants/error-codes';
import { RefreshToken, User } from '../../database/entities';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtPayload } from './strategies/jwt.strategy';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

/** In-memory stand-in for the refresh_tokens repository. */
class FakeRefreshTokens {
  rows: RefreshToken[] = [];

  create(data: Partial<RefreshToken>): RefreshToken {
    return {
      revokedAt: null,
      deviceInfo: null,
      ipAddress: null,
      ...data,
    } as RefreshToken;
  }

  save(row: RefreshToken): Promise<RefreshToken> {
    if (!row.id) {
      row.id = randomUUID();
      row.createdAt = new Date();
      row.updatedAt = row.createdAt;
      this.rows.push(row);
    }
    return Promise.resolve(row);
  }

  async findOne(options: {
    where: { tokenHash: string };
  }): Promise<RefreshToken | null> {
    // Yield once so concurrent callers interleave like real queries.
    await Promise.resolve();
    return (
      this.rows.find((r) => r.tokenHash === options.where.tokenHash) ?? null
    );
  }

  update(
    criteria: Partial<Record<keyof RefreshToken, unknown>>,
    changes: Partial<RefreshToken>,
  ): Promise<{ affected: number }> {
    const matches = this.rows.filter((row) =>
      Object.entries(criteria).every(([key, value]) => {
        const actual = row[key as keyof RefreshToken];
        if (value instanceof FindOperator) {
          return value.type === 'isNull' ? actual === null : false;
        }
        return actual === value;
      }),
    );
    for (const row of matches)
      Object.assign(row, changes, { updatedAt: new Date() });
    return Promise.resolve({ affected: matches.length });
  }

  remove(row: RefreshToken): Promise<RefreshToken> {
    this.rows = this.rows.filter((r) => r !== row);
    return Promise.resolve(row);
  }
}

const user = {
  id: 'user-1',
  email: 'a@b.de',
  isSuperAdmin: false,
  isActive: true,
} as User;

function setup() {
  const tokens = new FakeRefreshTokens();
  // findOne must also hand back the user relation.
  const findOne = tokens.findOne.bind(tokens);
  tokens.findOne = async (options) => {
    const row = await findOne(options);
    if (row) row.user = user;
    return row;
  };
  const jwt = new JwtService({ secret: 'test-secret' });
  const none = {} as never;
  const service = new AuthService(
    none,
    none,
    none,
    tokens as never,
    none,
    none,
    jwt,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
  );
  const sid = (accessToken: string) => jwt.decode<JwtPayload>(accessToken).sid;
  return { service, tokens, sid };
}

describe('AuthService sessions', () => {
  it('records user agent and IP, truncated to the column lengths', async () => {
    const { service, tokens, sid } = setup();
    const longAgent = `Mozilla/5.0 ${'x'.repeat(400)}`;

    const result = await service.login(user, {
      userAgent: longAgent,
      ip: '203.0.113.7',
    });

    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0].deviceInfo).toBe(longAgent.slice(0, 255));
    expect(tokens.rows[0].ipAddress).toBe('203.0.113.7');
    expect(sid(result.accessToken)).toBe(tokens.rows[0].id);
  });

  it('rotates the refresh token in place and keeps the session id', async () => {
    const { service, tokens, sid } = setup();
    const first = await service.login(user, {
      userAgent: 'UA',
      ip: '203.0.113.7',
    });

    const second = await service.refreshTokens(first.refreshToken, {
      userAgent: 'UA',
      ip: '198.51.100.2',
    });
    const third = await service.refreshTokens(second.refreshToken);

    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0].revokedAt).toBeNull();
    expect(tokens.rows[0].ipAddress).toBe('198.51.100.2');
    expect(tokens.rows[0].deviceInfo).toBe('UA');
    expect(sid(second.accessToken)).toBe(tokens.rows[0].id);
    expect(sid(third.accessToken)).toBe(tokens.rows[0].id);
    expect(second.refreshToken).not.toBe(first.refreshToken);
  });

  it('rejects an old refresh token after rotation', async () => {
    const { service } = setup();
    const first = await service.login(user);
    await service.refreshTokens(first.refreshToken);

    await expect(
      service.refreshTokens(first.refreshToken),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.INVALID_TOKEN } });
  });

  it('lets only one of two concurrent refreshes with the same token win', async () => {
    const { service } = setup();
    const first = await service.login(user);

    const results = await Promise.allSettled([
      service.refreshTokens(first.refreshToken),
      service.refreshTokens(first.refreshToken),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a revoked session', async () => {
    const { service, tokens } = setup();
    const first = await service.login(user);
    tokens.rows[0].revokedAt = new Date();

    await expect(
      service.refreshTokens(first.refreshToken),
    ).rejects.toMatchObject({ response: { code: ErrorCodes.TOKEN_REVOKED } });
  });
});

describe('AuthController passes the client to the session', () => {
  function controller() {
    const login = jest.fn(() =>
      Promise.resolve({ user, accessToken: 'a', refreshToken: 'r' }),
    );
    const refreshTokens = jest.fn(() =>
      Promise.resolve({ accessToken: 'a', refreshToken: 'r' }),
    );
    const authService = {
      login,
      refreshTokens,
      needsTwoFactor: () => Promise.resolve(false),
      consumeLoginMagicLink: () => Promise.resolve(user),
    } as unknown as AuthService;
    const twoFactorService = {
      verify2FA: () => Promise.resolve(),
    };
    const config = { get: () => undefined } as unknown as ConfigService;
    const ctrl = new AuthController(
      authService,
      twoFactorService as never,
      config,
    );
    return { ctrl, login, refreshTokens };
  }

  const request = {
    headers: { 'user-agent': 'Mozilla/5.0 Test' },
    ip: '203.0.113.7',
    cookies: { refreshToken: 'r-old' },
    user,
  } as unknown as Request;
  const response = { cookie: jest.fn() } as unknown as Response;
  const client = { userAgent: 'Mozilla/5.0 Test', ip: '203.0.113.7' };

  it('on password login', async () => {
    const { ctrl, login } = controller();
    await ctrl.login({ email: 'a@b.de', password: 'x' }, request, response);
    expect(login).toHaveBeenCalledWith(user, client);
  });

  it('on magic-link login', async () => {
    const { ctrl, login } = controller();
    await ctrl.verifyMagicLink({ token: 't' }, request, response);
    expect(login).toHaveBeenCalledWith(user, client);
  });

  it('after the second factor', async () => {
    const { ctrl, login } = controller();
    await ctrl.verify2FA(user, { code: '123456' }, request, response);
    expect(login).toHaveBeenCalledWith(user, client);
  });

  it('on refresh', async () => {
    const { ctrl, refreshTokens } = controller();
    await ctrl.refresh({}, request, response);
    expect(refreshTokens).toHaveBeenCalledWith('r-old', client);
  });
});

describe('UsersController sessions', () => {
  function controller() {
    const sessions = [
      { id: 's-1', createdAt: new Date(0), updatedAt: new Date(1000) },
      { id: 's-2', createdAt: new Date(0), updatedAt: new Date(2000) },
    ] as RefreshToken[];
    const revokeAllOtherSessions = jest.fn(() => Promise.resolve(1));
    const usersService = {
      getSessions: () => Promise.resolve(sessions),
      revokeAllOtherSessions,
    } as unknown as UsersService;
    return {
      ctrl: new UsersController(usersService, {} as never),
      revokeAllOtherSessions,
    };
  }

  it('marks the session of the access token as current', async () => {
    const { ctrl } = controller();

    const { data } = await ctrl.getSessions(user, 's-2');

    expect(data.map((s) => [s.id, s.isCurrent])).toEqual([
      ['s-1', false],
      ['s-2', true],
    ]);
    expect(data[1].lastActiveAt).toEqual(new Date(2000));
  });

  it('marks nothing as current for tokens without a session', async () => {
    const { ctrl } = controller();
    const { data } = await ctrl.getSessions(user, null);
    expect(data.some((s) => s.isCurrent)).toBe(false);
  });

  it('keeps the current session when revoking all others', async () => {
    const { ctrl, revokeAllOtherSessions } = controller();
    await ctrl.revokeAllOtherSessions(user, 's-2');
    expect(revokeAllOtherSessions).toHaveBeenCalledWith('user-1', 's-2');
  });
});
