import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { User } from '../../database/entities';
import { OrganizationViewService } from '../organizations/organization-view.service';
import { AuthController, TRUSTED_DEVICE_COOKIE } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * Anmeldung mit zweitem Faktor im Controller: Ob der Code entfaellt,
 * entscheidet allein das vom Server gesetzte Cookie — nie ein Wert, den
 * der Client im Rumpf schickt.
 */

const user = {
  id: 'user-1',
  email: 'a@b.de',
  isSuperAdmin: false,
  isActive: true,
  twoFactorEnabled: true,
} as User;

const token = () => randomBytes(32).toString('base64url');

function setup(nodeEnv = 'production') {
  const needsTwoFactor = jest.fn(() => Promise.resolve(true));
  const authService = {
    needsTwoFactor,
    issueTwoFactorToken: () => Promise.resolve('pending-token'),
    login: () => Promise.resolve({ user, accessToken: 'a', refreshToken: 'r' }),
  } as unknown as AuthService;
  const verify2FA = jest.fn((..._args: unknown[]) =>
    Promise.resolve({ trustedDeviceToken: null as string | null }),
  );
  const twoFactorService = {
    verify2FA,
    sendLoginOtp: jest.fn(),
    assertChallengeOpen: jest.fn(() => Promise.resolve()),
  };
  const values: Record<string, string> = { nodeEnv, apiPrefix: 'api' };
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  const ctrl = new AuthController(
    authService,
    twoFactorService as never,
    config,
    undefined as never,
    new OrganizationViewService(),
    { isReacceptanceRequired: () => Promise.resolve(false) } as never,
  );
  return { ctrl, needsTwoFactor, verify2FA, twoFactorService };
}

function req(cookies: Record<string, string> = {}): Request {
  return {
    headers: {},
    ip: '203.0.113.7',
    cookies,
    user,
  } as unknown as Request;
}

function res() {
  const cookie = jest.fn((..._args: unknown[]) => undefined);
  return { response: { cookie } as unknown as Response, cookie };
}

describe('Login with a second factor', () => {
  it('ignores a device fingerprint sent by the client', async () => {
    const { ctrl, needsTwoFactor } = setup();
    const result = await ctrl.login(
      { email: 'a@b.de', password: 'x', deviceFingerprint: '1a2b3c' },
      req(),
      res().response,
    );

    expect(needsTwoFactor).toHaveBeenCalledWith(user, []);
    expect(result).toMatchObject({ twoFactorRequired: true });
  });

  it('passes only well-formed trusted-device secrets from the cookie', async () => {
    const { ctrl, needsTwoFactor } = setup();
    const a = token();
    const b = token();

    await ctrl.login(
      { email: 'a@b.de', password: 'x' },
      req({ [TRUSTED_DEVICE_COOKIE]: `${a}.garbage.${b}` }),
      res().response,
    );

    expect(needsTwoFactor).toHaveBeenCalledWith(user, [a, b]);
  });

  it('sets the trusted-device secret as a strict httpOnly cookie for the auth routes', async () => {
    const { ctrl, verify2FA } = setup();
    const issued = token();
    const existing = token();
    verify2FA.mockResolvedValueOnce({ trustedDeviceToken: issued });
    const { response, cookie } = res();

    await ctrl.verify2FA(
      { ...user, pending2fa: true, twoFactorChallengeId: 'c-1' } as never,
      { code: '123456', trustDevice: true },
      req({ [TRUSTED_DEVICE_COOKIE]: existing }),
      response,
    );

    expect(verify2FA).toHaveBeenCalledWith(
      'user-1',
      'c-1',
      '123456',
      true,
      expect.any(Object),
    );
    const call = cookie.mock.calls.find(
      ([name]) => name === TRUSTED_DEVICE_COOKIE,
    ) as [string, string, Record<string, unknown>];
    expect(call[1]).toBe(`${issued}.${existing}`);
    expect(call[2]).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth',
    });
  });

  it('sets no trusted-device cookie unless one was issued', async () => {
    const { ctrl } = setup();
    const { response, cookie } = res();

    await ctrl.verify2FA(
      { ...user, pending2fa: true, twoFactorChallengeId: 'c-1' } as never,
      { code: '123456' },
      req(),
      response,
    );

    expect(cookie.mock.calls.map((call) => call[0] as string)).not.toContain(
      TRUSTED_DEVICE_COOKIE,
    );
  });

  it('does not treat a full session as a pending login', async () => {
    const { ctrl, verify2FA } = setup();

    await ctrl.verify2FA(
      { ...user, pending2fa: false, twoFactorChallengeId: 'c-1' } as never,
      { code: '123456' },
      req(),
      res().response,
    );

    expect(verify2FA.mock.calls[0][1]).toBeNull();
  });

  it('checks the pending login before sending another e-mail code', async () => {
    const { ctrl, twoFactorService } = setup();

    await ctrl.sendLoginOtp({
      ...user,
      pending2fa: true,
      twoFactorChallengeId: 'c-9',
    } as never);

    expect(twoFactorService.assertChallengeOpen).toHaveBeenCalledWith(
      'user-1',
      'c-9',
    );
  });
});

describe('Trusted devices after a password change', () => {
  function service(userRow: Partial<User>) {
    const revokeTrustedDevices = jest.fn(() => Promise.resolve());
    const users = {
      findOne: () => Promise.resolve(userRow),
      save: (u: unknown) => Promise.resolve(u),
    };
    const refreshTokens = {
      createQueryBuilder: () => {
        const qb = {
          update: () => qb,
          set: () => qb,
          where: () => qb,
          execute: () => Promise.resolve({ affected: 0 }),
        };
        return qb;
      },
    };
    const none = {} as never;
    const auth = new AuthService(
      users as never,
      none,
      none,
      refreshTokens as never,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      { revokeTrustedDevices } as never,
      none,
      none,
    );
    return { auth, revokeTrustedDevices };
  }

  it('revokes them when the password is changed', async () => {
    const { auth, revokeTrustedDevices } = service({
      id: 'user-1',
      email: 'a@b.de',
      passwordHash: null,
    });

    await auth.changePassword('user-1', { newPassword: 'NeuesPasswort1!' });

    expect(revokeTrustedDevices).toHaveBeenCalledWith('user-1');
  });

  it('revokes them when the password is reset', async () => {
    const { auth, revokeTrustedDevices } = service({
      id: 'user-1',
      email: 'a@b.de',
      passwordResetExpiresAt: new Date(Date.now() + 60_000),
    });

    await auth.resetPassword({ token: 't', password: 'NeuesPasswort1!' });

    expect(revokeTrustedDevices).toHaveBeenCalledWith('user-1');
  });
});
