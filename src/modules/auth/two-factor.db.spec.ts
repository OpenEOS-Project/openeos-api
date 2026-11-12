import { randomUUID } from 'crypto';
import * as path from 'path';
import { HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as OTPAuth from 'otplib';
import { DataSource } from 'typeorm';

import { ErrorReasons } from '../../common/constants/error-codes';
import { EncryptionService } from '../../common/services/encryption.service';
import {
  EmailOtp,
  TrustedDevice,
  TwoFactorChallenge,
  TwoFactorMethod,
  User,
} from '../../database/entities';
import type { EmailService } from '../email/email.service';
import {
  MAX_ATTEMPTS_PER_CHALLENGE,
  MAX_FAILED_ATTEMPTS_PER_USER,
  TwoFactorService,
  hashTrustedDeviceToken,
} from './two-factor.service';

/**
 * Zweiter Anmeldeschritt gegen ein echtes Postgres: vertraute Geraete
 * (Geheimnis nur als Hash, an das Konto gebunden, ablaufend, entziehbar)
 * und Fehlversuche je offenem Schritt und je Konto.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5561/openeos_twofa_scratch pnpm test two-factor.db
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('Second login step against Postgres', () => {
  let ds: DataSource;
  let service: TwoFactorService;
  const config = {
    get: (_key: string, fallback?: unknown) => fallback,
  } as unknown as ConfigService;
  const encryption = new EncryptionService(config);
  const secret = OTPAuth.authenticator.generateSecret();
  const userIds: string[] = [];

  /** Ein Code, der garantiert nicht der aktuelle ist. */
  const wrongCode = () => {
    const valid = new Set(
      [-30, 0, 30].map((offset) =>
        OTPAuth.authenticator
          .clone({ epoch: Date.now() + offset * 1000 })
          .generate(secret),
      ),
    );
    for (let i = 0; ; i++) {
      const candidate = String(i).padStart(6, '0');
      if (!valid.has(candidate)) return candidate;
    }
  };
  const validCode = () => OTPAuth.authenticator.generate(secret);

  async function createUser(): Promise<string> {
    const id = randomUUID();
    userIds.push(id);
    await ds.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name,
                          two_factor_enabled, two_factor_method,
                          two_factor_secret_encrypted)
       VALUES ($1, $2, 'x', 'Kim', 'Kasse', true, $3, $4)`,
      [
        id,
        `twofa-${id}@example.org`,
        TwoFactorMethod.TOTP,
        encryption.encrypt(secret),
      ],
    );
    return id;
  }

  const reasonOf = (error: unknown) =>
    ((error as HttpException).getResponse() as { reason?: string }).reason;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    }
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();
    service = new TwoFactorService(
      ds.getRepository(User),
      ds.getRepository(TrustedDevice),
      ds.getRepository(EmailOtp),
      encryption,
      config,
      {} as EmailService,
      ds.getRepository(TwoFactorChallenge),
    );
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    if (userIds.length) {
      await ds.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
    }
    await ds.destroy();
  });

  describe('trusted devices', () => {
    it('stores only the hash of a random secret and recognises it for the same account', async () => {
      const userId = await createUser();
      const challenge = await service.createChallenge(userId, 10);

      const { trustedDeviceToken } = await service.verify2FA(
        userId,
        challenge.id,
        validCode(),
        true,
        { name: 'Vereinslaptop', browser: 'Firefox', os: 'Linux' },
      );

      expect(trustedDeviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const rows: { token_hash: string }[] = await ds.query(
        `SELECT token_hash FROM trusted_devices WHERE user_id = $1`,
        [userId],
      );
      expect(rows).toEqual([
        { token_hash: hashTrustedDeviceToken(trustedDeviceToken!) },
      ]);
      expect(rows[0].token_hash).not.toContain(trustedDeviceToken);

      expect(await service.isTrustedDevice(userId, [trustedDeviceToken!])).toBe(
        true,
      );
    });

    it('does not trust a secret issued for another account', async () => {
      const owner = await createUser();
      const other = await createUser();
      const challenge = await service.createChallenge(owner, 10);
      const { trustedDeviceToken } = await service.verify2FA(
        owner,
        challenge.id,
        validCode(),
        true,
      );

      expect(await service.isTrustedDevice(other, [trustedDeviceToken!])).toBe(
        false,
      );
    });

    it('does not trust unknown, malformed or client-derived values', async () => {
      const userId = await createUser();
      expect(await service.isTrustedDevice(userId, [])).toBe(false);
      expect(await service.isTrustedDevice(userId, ['1a2b3c4d'])).toBe(false);
      expect(await service.isTrustedDevice(userId, ['A'.repeat(43)])).toBe(
        false,
      );
    });

    it('does not trust an expired entry', async () => {
      const userId = await createUser();
      const challenge = await service.createChallenge(userId, 10);
      const { trustedDeviceToken } = await service.verify2FA(
        userId,
        challenge.id,
        validCode(),
        true,
      );
      await ds.query(
        `UPDATE trusted_devices SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
        [userId],
      );

      expect(await service.isTrustedDevice(userId, [trustedDeviceToken!])).toBe(
        false,
      );
    });

    it('revokes all trusted devices of an account', async () => {
      const userId = await createUser();
      const challenge = await service.createChallenge(userId, 10);
      const { trustedDeviceToken } = await service.verify2FA(
        userId,
        challenge.id,
        validCode(),
        true,
      );

      await service.revokeTrustedDevices(userId);

      expect(await service.isTrustedDevice(userId, [trustedDeviceToken!])).toBe(
        false,
      );
    });

    it('issues no secret unless asked to', async () => {
      const userId = await createUser();
      const challenge = await service.createChallenge(userId, 10);
      const { trustedDeviceToken } = await service.verify2FA(
        userId,
        challenge.id,
        validCode(),
        false,
      );
      expect(trustedDeviceToken).toBeNull();
      expect(
        await ds.query(`SELECT 1 FROM trusted_devices WHERE user_id = $1`, [
          userId,
        ]),
      ).toHaveLength(0);
    });

    it('lists trusted devices without the stored hash', async () => {
      const userId = await createUser();
      const challenge = await service.createChallenge(userId, 10);
      const { trustedDeviceToken } = await service.verify2FA(
        userId,
        challenge.id,
        validCode(),
        true,
      );

      const devices = await service.getTrustedDevices(userId);

      expect(devices).toHaveLength(1);
      expect(devices[0].tokenHash).toBeUndefined();
      expect(JSON.stringify(devices)).not.toContain(
        hashTrustedDeviceToken(trustedDeviceToken!),
      );
    });
  });

  describe('attempt limits', () => {
    it(`locks a pending login after ${MAX_ATTEMPTS_PER_CHALLENGE} wrong codes, even for a correct one`, async () => {
      const userId = await createUser();
      const challenge = await service.createChallenge(userId, 10);

      for (let i = 0; i < MAX_ATTEMPTS_PER_CHALLENGE; i++) {
        await expect(
          service.verify2FA(userId, challenge.id, wrongCode()),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
      const error: unknown = await service
        .verify2FA(userId, challenge.id, validCode())
        .catch((e: unknown) => e);

      expect((error as HttpException).getStatus()).toBe(429);
      expect(reasonOf(error)).toBe(ErrorReasons.TWO_FACTOR_LOCKED);
    });

    it('counts parallel attempts without exceeding the limit', async () => {
      const userId = await createUser();
      const challenge = await service.createChallenge(userId, 10);

      const results = await Promise.allSettled(
        Array.from({ length: MAX_ATTEMPTS_PER_CHALLENGE * 3 }, () =>
          service.verify2FA(userId, challenge.id, wrongCode()),
        ),
      );

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      const [row]: { failed_attempts: number }[] = await ds.query(
        `SELECT failed_attempts FROM two_factor_challenges WHERE id = $1`,
        [challenge.id],
      );
      expect(row.failed_attempts).toBe(MAX_ATTEMPTS_PER_CHALLENGE);
    });

    it('locks the account across new pending logins', async () => {
      const userId = await createUser();
      let failed = 0;
      while (failed < MAX_FAILED_ATTEMPTS_PER_USER) {
        const challenge = await service.createChallenge(userId, 10);
        for (
          let i = 0;
          i < MAX_ATTEMPTS_PER_CHALLENGE &&
          failed < MAX_FAILED_ATTEMPTS_PER_USER;
          i++, failed++
        ) {
          await expect(
            service.verify2FA(userId, challenge.id, wrongCode()),
          ).rejects.toBeInstanceOf(UnauthorizedException);
        }
      }

      const fresh = await service.createChallenge(userId, 10);
      const error: unknown = await service
        .verify2FA(userId, fresh.id, validCode())
        .catch((e: unknown) => e);
      expect(reasonOf(error)).toBe(ErrorReasons.TWO_FACTOR_LOCKED);
      await expect(
        service.assertChallengeOpen(userId, fresh.id),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('does not count wrong codes of a login that later succeeded', async () => {
      const userId = await createUser();
      for (let round = 0; round < 3; round++) {
        const challenge = await service.createChallenge(userId, 10);
        for (let i = 0; i < MAX_ATTEMPTS_PER_CHALLENGE - 1; i++) {
          await expect(
            service.verify2FA(userId, challenge.id, wrongCode()),
          ).rejects.toBeInstanceOf(UnauthorizedException);
        }
        await service.verify2FA(userId, challenge.id, validCode());
      }
    });

    it('accepts a pending login only once', async () => {
      const userId = await createUser();
      const challenge = await service.createChallenge(userId, 10);
      await service.verify2FA(userId, challenge.id, validCode());

      const error: unknown = await service
        .verify2FA(userId, challenge.id, validCode())
        .catch((e: unknown) => e);
      expect(reasonOf(error)).toBe(ErrorReasons.TWO_FACTOR_CHALLENGE_INVALID);
    });

    it('rejects an expired pending login', async () => {
      const userId = await createUser();
      const challenge = await service.createChallenge(userId, 10);
      await ds.query(
        `UPDATE two_factor_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [challenge.id],
      );

      const error: unknown = await service
        .verify2FA(userId, challenge.id, validCode())
        .catch((e: unknown) => e);
      expect(reasonOf(error)).toBe(ErrorReasons.TWO_FACTOR_CHALLENGE_INVALID);
    });

    it('rejects a pending login of another account or none at all', async () => {
      const owner = await createUser();
      const other = await createUser();
      const challenge = await service.createChallenge(owner, 10);

      for (const id of [challenge.id, null, randomUUID()]) {
        const error: unknown = await service
          .verify2FA(other, id, validCode())
          .catch((e: unknown) => e);
        expect(reasonOf(error)).toBe(ErrorReasons.TWO_FACTOR_CHALLENGE_INVALID);
      }
    });
  });
});
