import { HttpException, UnauthorizedException } from '@nestjs/common';

import { DeviceStatus } from '../../database/entities/device.entity';
import { ErrorReasons } from '../../common/constants/error-codes';
import { DevicesService } from './devices.service';
import {
  MAX_PENDING_DEVICES_PER_IP,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  newPairingCode,
  normalizePairingCode,
  pairingCodeValid,
} from './pairing-code';

describe('pairing codes', () => {
  it('have eight digits', () => {
    for (let i = 0; i < 50; i++) {
      expect(newPairingCode()).toMatch(/^\d{8}$/);
    }
    expect(PAIRING_CODE_LENGTH).toBe(8);
  });

  it('accept spaces and dashes when typed, and six-digit codes of older devices', () => {
    expect(normalizePairingCode('1234 5678')).toBe('12345678');
    expect(normalizePairingCode('1234-5678')).toBe('12345678');
    expect(normalizePairingCode('573080')).toBe('573080');
    expect(normalizePairingCode('1234567')).toBeNull();
    expect(normalizePairingCode('12345678a')).toBeNull();
    expect(normalizePairingCode(undefined)).toBeNull();
  });

  it('are valid for a limited time only', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    const device = {
      verificationCode: '12345678',
      verificationCodeExpiresAt: new Date(now.getTime() + 1000),
    };
    expect(pairingCodeValid(device, now)).toBe(true);
    expect(
      pairingCodeValid(device, new Date(now.getTime() + PAIRING_CODE_TTL_MS)),
    ).toBe(false);
    expect(
      pairingCodeValid({ ...device, verificationCodeExpiresAt: null }, now),
    ).toBe(false);
  });
});

describe('device pairing', () => {
  const user = { id: 'user-1' } as never;

  function setup(
    options: {
      device?: Record<string, unknown> | null;
      pendingCount?: number;
      allow?: boolean;
    } = {},
  ) {
    const saved: Record<string, unknown>[] = [];
    const deleted: unknown[] = [];
    const deviceRepository = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        // Freiheitspruefung beim Erzeugen eines Codes
        if ('verificationCode' in where && !options.device) {
          return Promise.resolve(null);
        }
        return Promise.resolve(options.device ?? null);
      }),
      count: jest.fn(() => Promise.resolve(options.pendingCount ?? 0)),
      create: jest.fn((data: Record<string, unknown>) => ({
        id: 'device-1',
        ...data,
      })),
      save: jest.fn((device: Record<string, unknown>) => {
        saved.push({ ...device });
        return Promise.resolve(device);
      }),
      update: jest.fn(() => Promise.resolve()),
      delete: jest.fn((where: unknown) => {
        deleted.push(where);
        return Promise.resolve({ affected: 1 });
      }),
    };
    const userOrganizationRepository = {
      findOne: jest.fn(() => Promise.resolve({ role: 'admin' })),
    };
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve({ id: 'org-1', name: 'Verein' })),
    };
    const attempts: string[] = [];
    const targetLimits = {
      allow: jest.fn((_scope: string, target: string) => {
        attempts.push(target);
        return Promise.resolve(options.allow ?? true);
      }),
    };
    const none = undefined as never;
    const service = new DevicesService(
      deviceRepository as never,
      userOrganizationRepository as never,
      organizationRepository as never,
      none,
      none,
      none,
      none,
      none,
      none,
      targetLimits as never,
    );
    return { service, deviceRepository, saved, deleted, attempts };
  }

  const validUntil = () => new Date(Date.now() + 60_000);

  it('hands out a code with an expiry time', async () => {
    const { service, saved } = setup();
    const result = await service.initDevice(
      { name: 'Kasse' } as never,
      '203.0.113.5',
    );
    expect(result.verificationCode).toMatch(/^\d{8}$/);
    const ttl = result.verificationCodeExpiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(PAIRING_CODE_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(PAIRING_CODE_TTL_MS);
    // Die Adresse steht nur als Hash am Geraet.
    expect(saved[0].pairingIpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved[0].pairingIpHash).not.toContain('203.0.113.5');
  });

  it('stops handing out codes when too many devices wait at one address', async () => {
    const { service } = setup({ pendingCount: MAX_PENDING_DEVICES_PER_IP });
    await expect(
      service.initDevice({ name: 'Kasse' } as never, '203.0.113.5'),
    ).rejects.toMatchObject({
      response: { reason: ErrorReasons.PENDING_DEVICE_LIMIT_REACHED },
    });
  });

  it('links a device while its code is valid', async () => {
    const { service, saved, attempts } = setup({
      device: {
        id: 'device-1',
        status: DeviceStatus.PENDING,
        verificationCode: '12345678',
        verificationCodeExpiresAt: validUntil(),
        type: 'pos',
        settings: {},
      },
    });
    await service.linkDevice(
      { code: '1234 5678', organizationId: 'org-1', name: 'Kasse 1' } as never,
      user,
    );
    expect(attempts).toEqual(['12345678']);
    expect(saved.at(-1)).toMatchObject({
      status: DeviceStatus.VERIFIED,
      verificationCode: null,
      verificationCodeExpiresAt: null,
      pairingIpHash: null,
    });
  });

  it('does not link a device with an expired code', async () => {
    const { service, saved } = setup({
      device: {
        id: 'device-1',
        status: DeviceStatus.PENDING,
        verificationCode: '12345678',
        verificationCodeExpiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(
      service.linkDevice(
        { code: '12345678', organizationId: 'org-1', name: 'Kasse' } as never,
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: ErrorReasons.DEVICE_NOT_FOUND_OR_LINKED },
    });
    expect(saved).toHaveLength(0);
  });

  it('refuses a code after too many tries', async () => {
    const { service } = setup({
      allow: false,
      device: {
        id: 'device-1',
        status: DeviceStatus.PENDING,
        verificationCode: '12345678',
        verificationCodeExpiresAt: validUntil(),
      },
    });
    const error = await service
      .findByVerificationCode('12345678')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
  });

  it('does not reveal a device for an expired code', async () => {
    const { service } = setup({
      device: {
        id: 'device-1',
        status: DeviceStatus.PENDING,
        verificationCode: '12345678',
        verificationCodeExpiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(
      service.findByVerificationCode('12345678'),
    ).resolves.toBeNull();
  });

  it('asks a waiting device with an expired code to register again', async () => {
    const { service, deleted } = setup({
      device: {
        id: 'device-1',
        status: DeviceStatus.PENDING,
        verificationCode: '12345678',
        verificationCodeExpiresAt: new Date(Date.now() - 1000),
      },
    });
    const error = await service
      .getDeviceStatus('token')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toMatchObject({
      reason: ErrorReasons.PAIRING_CODE_EXPIRED,
    });
    expect(deleted).toHaveLength(1);
  });

  it('reports the expiry time to a waiting device', async () => {
    const expiresAt = validUntil();
    const { service } = setup({
      device: {
        id: 'device-1',
        status: DeviceStatus.PENDING,
        verificationCode: '12345678',
        verificationCodeExpiresAt: expiresAt,
        isActive: true,
      },
    });
    await expect(service.getDeviceStatus('token')).resolves.toMatchObject({
      status: DeviceStatus.PENDING,
      verificationCodeExpiresAt: expiresAt,
    });
  });
});

describe('verifying a device inside the organization', () => {
  it('needs a valid, unexpired code', async () => {
    const device = {
      id: 'device-1',
      organizationId: 'org-1',
      status: DeviceStatus.PENDING,
      verificationCode: '12345678',
      verificationCodeExpiresAt: new Date(Date.now() - 1000),
      settings: {},
    };
    const none = undefined as never;
    const service = new DevicesService(
      {
        findOne: jest.fn(() => Promise.resolve(device)),
        save: jest.fn((d: unknown) => Promise.resolve(d)),
      } as never,
      { findOne: jest.fn(() => Promise.resolve({ role: 'admin' })) } as never,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      { allow: jest.fn(() => Promise.resolve(true)) } as never,
    );
    await expect(
      service.verifyDevice('org-1', 'device-1', '12345678', {
        id: 'u',
      } as never),
    ).rejects.toMatchObject({
      response: { reason: ErrorReasons.DEVICE_VERIFICATION_CODE_INVALID },
    });
    device.verificationCodeExpiresAt = new Date(Date.now() + 60_000);
    await expect(
      service.verifyDevice('org-1', 'device-1', '1234-5678', {
        id: 'u',
      } as never),
    ).resolves.toMatchObject({
      status: DeviceStatus.VERIFIED,
      verificationCode: null,
      verificationCodeExpiresAt: null,
    });
  });
});
