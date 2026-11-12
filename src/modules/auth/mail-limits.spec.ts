import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageService } from '@nestjs/throttler';

import { AuthService } from './auth.service';
import { TargetLimitService } from '../../common/rate-limit/target-limit.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

/*
 * Mails aus "Passwort vergessen", "Bestaetigung erneut senden" und dem
 * Anmeldelink gehen je Adresse nur begrenzt oft raus — die Antwort bleibt
 * dabei dieselbe.
 */
function setup(user: Record<string, unknown>) {
  const storage = new ThrottlerStorageService();
  const identity = <T>(data: T) => data;
  const userRepository = {
    findOne: jest.fn(() => Promise.resolve({ ...user })),
    save: jest.fn((u: unknown) => Promise.resolve(u)),
  };
  const magicLinks = {
    update: jest.fn(() => Promise.resolve({})),
    create: jest.fn(identity),
    save: jest.fn((v: unknown) => Promise.resolve(v)),
  };
  const emailService = {
    sendPasswordResetEmail: jest.fn(() => Promise.resolve()),
    sendLoginMagicLinkEmail: jest.fn(() => Promise.resolve()),
    sendVerificationEmail: jest.fn(() => Promise.resolve()),
    sendEmailVerification: jest.fn(() => Promise.resolve()),
  };
  const none = undefined as never;
  const service = new AuthService(
    userRepository as never,
    none,
    none,
    none,
    none,
    magicLinks as never,
    none,
    new ConfigService({}),
    none,
    emailService as never,
    none,
    none,
    none,
    { isSelfHosted: false } as never,
    undefined,
    new TargetLimitService(storage),
  );
  return { service, emailService, storage };
}

const user = {
  id: 'u1',
  email: 'helga@example.org',
  firstName: 'Helga',
  isActive: true,
  lockedUntil: null,
  emailVerifiedAt: new Date(),
};

describe('Mail limits per address', () => {
  it('sends at most three password reset mails per hour to one address', async () => {
    const { service, emailService, storage } = setup(user);
    for (let i = 0; i < 5; i += 1) {
      await expect(
        service.forgotPassword({ email: 'helga@example.org' }),
      ).resolves.toBeUndefined();
    }
    storage.onApplicationShutdown();
    expect(emailService.sendPasswordResetEmail).toHaveBeenCalledTimes(3);
  });

  it('sends at most five login links per hour to one address', async () => {
    const { service, emailService, storage } = setup(user);
    for (let i = 0; i < 7; i += 1) {
      await service.requestLoginMagicLink('Helga@Example.org');
    }
    storage.onApplicationShutdown();
    expect(emailService.sendLoginMagicLinkEmail).toHaveBeenCalledTimes(5);
  });

  it('resends the verification mail at most three times per hour', async () => {
    const { service, storage } = setup({ ...user, emailVerifiedAt: null });
    const issue = jest
      .spyOn(
        service as unknown as {
          issueVerificationEmail(u: unknown): Promise<void>;
        },
        'issueVerificationEmail',
      )
      .mockResolvedValue(undefined);
    for (let i = 0; i < 5; i += 1) {
      await service.resendVerificationEmail('helga@example.org');
    }
    storage.onApplicationShutdown();
    expect(issue).toHaveBeenCalledTimes(3);
  });
});
