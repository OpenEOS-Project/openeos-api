import { ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';
import { legalConfigFromEnv } from '../../config/legal.config';
import { LegalAcceptance } from '../../database/entities/legal-acceptance.entity';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

/*
 * Die Newsletter-Checkbox der Registrierung kam frueher nie an. Diese Tests
 * sichern, dass die Einwilligung mit Zeitpunkt am Konto landet — und ohne
 * Haken keine.
 */
function setup(legalService?: unknown) {
  const saved: unknown[] = [];
  const inserted: { target: unknown; rows: unknown }[] = [];
  const identity = <T>(data: T) => data;
  const userRepository = {
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn(identity),
  };
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn(identity),
  };
  const userOrganizationRepository = { create: jest.fn(identity) };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      save: jest.fn((entity: unknown) => {
        saved.push(entity);
        return Promise.resolve(entity);
      }),
      query: jest.fn(() => Promise.resolve([])),
      insert: jest.fn((target: unknown, rows: unknown) => {
        inserted.push({ target, rows });
        return Promise.resolve({});
      }),
    },
  };
  const dataSource = { createQueryRunner: () => queryRunner };
  const platformSettingsService = {
    resolveNotificationTarget: jest.fn(() => Promise.resolve(null)),
  };
  const deployment = { isSelfHosted: false };

  const none = undefined as never;
  const service = new AuthService(
    userRepository as never,
    organizationRepository as never,
    userOrganizationRepository as never,
    none,
    none,
    none,
    none,
    new ConfigService({}),
    dataSource as never,
    none,
    platformSettingsService as never,
    none,
    none,
    deployment as never,
    legalService as never,
  );
  return { service, saved, inserted };
}

const base = {
  email: 'Neu@Example.org',
  firstName: 'Nina',
  lastName: 'Neu',
  organizationName: 'TSV Musterstadt',
  country: 'DE',
  acceptTerms: true,
  confirmBusiness: true,
};

describe('AuthService.register — newsletter consent', () => {
  it('records the time of consent when the box was ticked', async () => {
    const { service, saved } = setup();
    const before = Date.now();

    const { user } = await service.register({
      ...base,
      newsletterOptIn: true,
    });

    expect(user.newsletterOptInAt).toBeInstanceOf(Date);
    expect(user.newsletterOptInAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(saved[0]).toBe(user);
  });

  it('records no consent without the box', async () => {
    const { service } = setup();
    const { user } = await service.register({ ...base });
    expect(user.newsletterOptInAt).toBeNull();

    const { user: explicitNo } = await service.register({
      ...base,
      newsletterOptIn: false,
    });
    expect(explicitNo.newsletterOptInAt).toBeNull();
  });
});

describe('AuthService.register — AGB/AVV acceptance', () => {
  const legalService = {
    config: legalConfigFromEnv({}, false),
    sendRegistrationEmail: jest.fn(() => Promise.resolve()),
  };

  it('stores AGB and AVV acceptance with IP and user agent in the transaction', async () => {
    const { service, inserted } = setup(legalService);
    await service.register(
      { ...base },
      { ip: '203.0.113.9', userAgent: 'Mozilla/5.0' },
    );
    const legal = inserted.find((i) => i.target === LegalAcceptance);
    expect(legal?.rows).toEqual([
      expect.objectContaining({
        document: 'agb',
        version: '2026-11-04',
        context: 'registration',
        businessConfirmed: true,
        ipAddress: '203.0.113.9',
        userAgent: 'Mozilla/5.0',
        userEmail: 'neu@example.org',
        organizationName: 'TSV Musterstadt',
      }),
      expect.objectContaining({ document: 'avv', version: '2026-11-04' }),
    ]);
    expect(legalService.sendRegistrationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ organizationName: 'TSV Musterstadt' }),
    );
  });

  it('refuses a registration without both confirmations', async () => {
    const { service } = setup(legalService);
    await expect(
      service.register({ ...base, confirmBusiness: false }),
    ).rejects.toThrow();
    await expect(
      service.register({ ...base, acceptTerms: false }),
    ).rejects.toThrow();
  });
});
