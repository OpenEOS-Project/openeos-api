import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as OTPAuth from 'otplib';
import { Repository } from 'typeorm';

import { EncryptionService } from '../../common/services/encryption.service';
import {
  EmailOtp,
  TrustedDevice,
  TwoFactorMethod,
  User,
} from '../../database/entities';
import { EmailService } from '../email/email.service';
import { TwoFactorService } from './two-factor.service';

/**
 * Abschalten der 2FA verlangt einen gueltigen Code des zweiten Faktors.
 *
 * Vorher genuegte eine angemeldete Sitzung: der Weg nahm ein Passwort
 * entgegen und pruefte es nicht.
 */
describe('TwoFactorService.disable2FA', () => {
  const config = {
    get: (_key: string, fallback?: unknown) => fallback,
  } as unknown as ConfigService;
  const encryption = new EncryptionService(config);
  const secret = OTPAuth.authenticator.generateSecret();

  let user: User;
  let saved: User[];
  let trustedDevicesDeleted: boolean;
  let service: TwoFactorService;

  beforeEach(() => {
    user = Object.assign(new User(), {
      id: 'u1',
      email: 'a@b.de',
      twoFactorEnabled: true,
      twoFactorMethod: TwoFactorMethod.TOTP,
      twoFactorSecretEncrypted: encryption.encrypt(secret),
      twoFactorBackupCodesHash: JSON.stringify([
        encryption.hashCode('abcd1234'),
      ]),
    });
    saved = [];
    trustedDevicesDeleted = false;

    const users = {
      findOneOrFail: () => Promise.resolve(user),
      save: (u: User) => {
        saved.push({ ...u } as User);
        return Promise.resolve(u);
      },
    } as unknown as Repository<User>;
    const trusted = {
      delete: () => {
        trustedDevicesDeleted = true;
        return Promise.resolve();
      },
    } as unknown as Repository<TrustedDevice>;

    service = new TwoFactorService(
      users,
      trusted,
      {} as Repository<EmailOtp>,
      encryption,
      config,
      {} as EmailService,
    );
  });

  it('weist einen falschen Code ab und laesst die 2FA an', async () => {
    await expect(service.disable2FA('u1', '000000')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(user.twoFactorEnabled).toBe(true);
    expect(trustedDevicesDeleted).toBe(false);
  });

  it('weist ein Passwort statt eines Codes ab', async () => {
    // Genau der fruehere Aufruf: `{ password }` im Body.
    await expect(
      service.disable2FA('u1', 'MySecurePassword123!'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(user.twoFactorEnabled).toBe(true);
  });

  it('schaltet mit einem gueltigen TOTP-Code ab', async () => {
    await service.disable2FA('u1', OTPAuth.authenticator.generate(secret));

    const final = saved[saved.length - 1];
    expect(final.twoFactorEnabled).toBe(false);
    expect(final.twoFactorSecretEncrypted).toBeNull();
    expect(trustedDevicesDeleted).toBe(true);
  });

  it('akzeptiert auch einen Wiederherstellungscode', async () => {
    await service.disable2FA('u1', 'abcd-1234');
    expect(saved[saved.length - 1].twoFactorEnabled).toBe(false);
  });

  it('gibt neue Wiederherstellungscodes nur gegen einen gueltigen Code heraus', async () => {
    await expect(
      service.regenerateRecoveryCodes('u1', '000000'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const result = await service.regenerateRecoveryCodes(
      'u1',
      OTPAuth.authenticator.generate(secret),
    );
    expect(result.codes.length).toBeGreaterThan(0);
  });
});
