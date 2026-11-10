import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { UsersService } from './users.service';
import type { EmailService } from '../email/email.service';
import type { RefreshToken, User } from '../../database/entities';

/**
 * E-Mail-Adresse aendern: Konten ohne Passwort brauchen keins, der Link
 * geht per Mail an die neue Adresse (frueher stand er nur im Log), und die
 * Bestaetigung prueft, ob die Adresse inzwischen vergeben ist.
 */
describe('UsersService email change', () => {
  const user = (over: Partial<User> = {}): User =>
    ({
      id: 'u1',
      email: 'alt@example.com',
      firstName: 'Lena',
      passwordHash: null,
      pendingEmail: null,
      pendingEmailToken: null,
      pendingEmailExpiresAt: null,
      ...over,
    }) as User;

  function setup(current: User, others: User[] = []) {
    const repo = {
      findOneOrFail: jest.fn(() => Promise.resolve(current)),
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        if ('pendingEmailToken' in where) {
          return Promise.resolve(
            where.pendingEmailToken === current.pendingEmailToken
              ? current
              : null,
          );
        }
        return Promise.resolve(
          others.find((o) => o.email === where.email) ?? null,
        );
      }),
      save: jest.fn((u: User) => Promise.resolve(u)),
    };
    const email = {
      sendEmailChangeVerificationEmail: jest.fn(
        (_mail: { to: string; verifyUrl: string }) => Promise.resolve(true),
      ),
    };
    const service = new UsersService(
      repo as unknown as Repository<User>,
      {} as Repository<RefreshToken>,
      new ConfigService({ APP_URL: 'https://app.example.org' }),
      email as unknown as EmailService,
    );
    return { service, repo, email };
  }

  it('sends the confirmation link to the new address, without a password for password-less accounts', async () => {
    const current = user();
    const { service, email } = setup(current);

    await service.requestEmailChange('u1', { newEmail: 'Neu@Example.com' });

    expect(current.pendingEmail).toBe('neu@example.com');
    expect(email.sendEmailChangeVerificationEmail).toHaveBeenCalledTimes(1);
    const mail = email.sendEmailChangeVerificationEmail.mock.calls[0][0];
    expect(mail.to).toBe('neu@example.com');
    const token = new URL(mail.verifyUrl).searchParams.get('token') ?? '';
    expect(mail.verifyUrl).toMatch(
      /^https:\/\/app\.example\.org\/verify-email-change\?token=/,
    );
    // Gespeichert wird nur der Hash.
    expect(current.pendingEmailToken).toBe(
      crypto.createHash('sha256').update(token).digest('hex'),
    );
  });

  it('still asks accounts with a password for it', async () => {
    const { service, email } = setup(user({ passwordHash: '$2b$04$x' }));
    await expect(
      service.requestEmailChange('u1', { newEmail: 'neu@example.com' }),
    ).rejects.toMatchObject({
      response: { reason: 'CURRENT_PASSWORD_REQUIRED' },
    });
    expect(email.sendEmailChangeVerificationEmail).not.toHaveBeenCalled();
  });

  it('switches the address with a valid token', async () => {
    const token = 'abc';
    const current = user({
      pendingEmail: 'neu@example.com',
      pendingEmailToken: crypto
        .createHash('sha256')
        .update(token)
        .digest('hex'),
      pendingEmailExpiresAt: new Date(Date.now() + 60_000),
    });
    const { service } = setup(current);

    const updated = await service.verifyEmailChange(token);

    expect(updated.email).toBe('neu@example.com');
    expect(updated.pendingEmail).toBeNull();
    expect(updated.pendingEmailToken).toBeNull();
  });

  it('refuses when the address was taken in the meantime', async () => {
    const token = 'abc';
    const current = user({
      pendingEmail: 'neu@example.com',
      pendingEmailToken: crypto
        .createHash('sha256')
        .update(token)
        .digest('hex'),
      pendingEmailExpiresAt: new Date(Date.now() + 60_000),
    });
    const { service, repo } = setup(current, [
      user({ id: 'u2', email: 'neu@example.com' }),
    ]);

    await expect(service.verifyEmailChange(token)).rejects.toMatchObject({
      response: { reason: 'EMAIL_IN_USE' },
    });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('answers an unknown or expired link with EMAIL_CHANGE_LINK_INVALID', async () => {
    const expired = user({
      pendingEmail: 'neu@example.com',
      pendingEmailToken: crypto.createHash('sha256').update('t').digest('hex'),
      pendingEmailExpiresAt: new Date(Date.now() - 1),
    });
    const { service } = setup(expired);
    await expect(service.verifyEmailChange('unbekannt')).rejects.toMatchObject({
      response: { reason: 'EMAIL_CHANGE_LINK_INVALID' },
    });
    await expect(service.verifyEmailChange('t')).rejects.toMatchObject({
      response: { reason: 'EMAIL_CHANGE_LINK_INVALID' },
    });
  });
});
