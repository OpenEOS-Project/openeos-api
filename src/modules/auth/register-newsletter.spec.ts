import { ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

/*
 * Die Newsletter-Checkbox der Registrierung kam frueher nie an. Diese Tests
 * sichern, dass die Einwilligung mit Zeitpunkt am Konto landet — und ohne
 * Haken keine.
 */
function setup() {
  const saved: unknown[] = [];
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
  );
  return { service, saved };
}

const base = {
  email: 'Neu@Example.org',
  firstName: 'Nina',
  lastName: 'Neu',
  organizationName: 'TSV Musterstadt',
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
