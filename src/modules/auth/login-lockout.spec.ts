import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageService } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';

import { ErrorCodes } from '../../common/constants/error-codes';
import { TargetLimitService } from '../../common/rate-limit/target-limit.service';
import { ACCOUNT_LOCK_THRESHOLD, AuthService } from './auth.service';
import {
  ATTEMPTS_PER_ROUND,
  FIRST_BACKOFF_MS,
  LoginBackoffService,
  MAX_BACKOFF_MS,
  backoffMs,
} from './login-backoff.service';
import { JwtStrategy } from './strategies/jwt.strategy';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

/** Cache im Speicher mit derselben Schnittstelle wie der Redis-Cache. */
function memoryCache() {
  const values = new Map<string, unknown>();
  return {
    get: jest.fn((key: string) => Promise.resolve(values.get(key))),
    set: jest.fn((key: string, value: unknown) => {
      values.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    }),
    del: jest.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
  };
}

const PASSWORD = 'richtig-geheim';
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

function setup() {
  const user = {
    id: 'u1',
    email: 'helga@example.org',
    firstName: 'Helga',
    isActive: true,
    passwordHash,
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null as Date | null,
  };
  const storage = new ThrottlerStorageService();
  const userRepository = {
    findOne: jest.fn(() => Promise.resolve(user)),
    save: jest.fn((u: unknown) => Promise.resolve(u)),
  };
  const magicLinks = {
    update: jest.fn(() => Promise.resolve({})),
    create: jest.fn(<T>(v: T) => v),
    save: jest.fn((v: unknown) => Promise.resolve(v)),
  };
  const emailService = {
    sendLoginLockedEmail: jest.fn(() => Promise.resolve(true)),
    sendLoginMagicLinkEmail: jest.fn(() => Promise.resolve(true)),
  };
  const backoff = new LoginBackoffService(memoryCache() as never);
  const none = undefined as never;
  const service = new AuthService(
    userRepository as never,
    none,
    none,
    none,
    none,
    magicLinks as never,
    none,
    new ConfigService({ APP_URL: 'https://app.example.org' }),
    none,
    emailService as never,
    none,
    none,
    none,
    { isSelfHosted: false } as never,
    undefined,
    new TargetLimitService(storage),
    backoff,
  );
  return { service, user, emailService, storage };
}

async function wrong(service: AuthService, ip: string) {
  return service
    .validateUser('helga@example.org', 'falsch', ip)
    .catch((e: unknown) => e);
}

describe('password login backoff', () => {
  it('doubles the wait for each round and stops at one day', () => {
    expect(backoffMs(1)).toBe(FIRST_BACKOFF_MS);
    expect(backoffMs(2)).toBe(2 * FIRST_BACKOFF_MS);
    expect(backoffMs(3)).toBe(4 * FIRST_BACKOFF_MS);
    expect(backoffMs(20)).toBe(MAX_BACKOFF_MS);
  });

  it('pauses password logins from one address after a round of wrong passwords', async () => {
    const { service, storage } = setup();
    for (let i = 0; i < ATTEMPTS_PER_ROUND; i++) {
      await expect(wrong(service, '203.0.113.1')).resolves.toBeNull();
    }
    // Auch das richtige Passwort wartet jetzt — von dieser Adresse.
    const error = await service
      .validateUser('helga@example.org', PASSWORD, '203.0.113.1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toMatchObject({
      code: ErrorCodes.ACCOUNT_LOCKED,
      params: { minutes: 15 },
    });
    storage.onApplicationShutdown();
  });

  it('keeps password logins from other addresses working', async () => {
    const { service, user, storage } = setup();
    for (let i = 0; i < ATTEMPTS_PER_ROUND; i++) {
      await wrong(service, '203.0.113.1');
    }
    await expect(
      service.validateUser('helga@example.org', PASSWORD, '198.51.100.9'),
    ).resolves.toBe(user);
    storage.onApplicationShutdown();
  });

  it('locks password logins for the whole account only after many failures from several addresses', async () => {
    const { service, user, storage } = setup();
    for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD; i++) {
      await wrong(service, `203.0.113.${i}`);
    }
    expect(user.lockedUntil).not.toBeNull();
    const error = await service
      .validateUser('helga@example.org', PASSWORD, '198.51.100.9')
      .catch((e: unknown) => e);
    expect((error as UnauthorizedException).getResponse()).toMatchObject({
      code: ErrorCodes.ACCOUNT_LOCKED,
    });
    storage.onApplicationShutdown();
  });

  it('tells the account holder about a lock, at most once every few hours', async () => {
    const { service, emailService, storage } = setup();
    for (let i = 0; i < 3 * ATTEMPTS_PER_ROUND; i++) {
      await wrong(service, `203.0.113.${i % 3}`);
    }
    expect(emailService.sendLoginLockedEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendLoginLockedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'helga@example.org', minutes: 15 }),
    );
    storage.onApplicationShutdown();
  });

  it('still sends a login link while password logins are locked', async () => {
    const { service, user, emailService, storage } = setup();
    user.lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
    await service.requestLoginMagicLink('helga@example.org');
    expect(emailService.sendLoginMagicLinkEmail).toHaveBeenCalledTimes(1);
    storage.onApplicationShutdown();
  });
});

describe('running sessions during a password lock', () => {
  it('stay valid', async () => {
    const user = {
      id: 'u1',
      isActive: true,
      isSuperAdmin: false,
      lockedUntil: new Date(Date.now() + 10 * 60 * 1000),
      userOrganizations: [],
    };
    const strategy = new JwtStrategy(
      { get: () => 'secret' } as never,
      { findOne: jest.fn(() => Promise.resolve(user)) } as never,
      { get: jest.fn(() => Promise.resolve(undefined)) } as never,
    );
    await expect(
      strategy.validate(
        { headers: { authorization: 'Bearer abc' } } as never,
        { sub: 'u1', email: 'helga@example.org' } as never,
      ),
    ).resolves.toMatchObject({ id: 'u1' });
  });
});
