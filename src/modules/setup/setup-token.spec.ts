import { ConflictException, ForbiddenException } from '@nestjs/common';

import { SetupMode } from './dto';
import { SetupService } from './setup.service';
import {
  generateSetupToken,
  normalizeSetupToken,
  setupTokenMatches,
} from './setup-token';

/** platform_settings und users im Speicher, so weit die Einrichtung sie liest. */
function fakeDatabase(initialUsers = 0) {
  const settings = new Map<string, unknown>();
  const state = { users: initialUsers, locks: 0 };
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    const key = params[0] as string;
    if (sql.includes('pg_advisory_xact_lock')) {
      state.locks++;
      return Promise.resolve([]);
    }
    if (sql.startsWith('INSERT INTO platform_settings')) {
      if (!settings.has(key)) {
        settings.set(key, JSON.parse(params[1] as string));
      }
      return Promise.resolve([]);
    }
    if (sql.startsWith('SELECT value FROM platform_settings')) {
      return Promise.resolve(
        settings.has(key) ? [{ value: settings.get(key) }] : [],
      );
    }
    if (sql.startsWith('SELECT 1 FROM platform_settings')) {
      return Promise.resolve(settings.has(key) ? [{}] : []);
    }
    if (sql.startsWith('DELETE FROM platform_settings')) {
      settings.delete(key);
      return Promise.resolve([]);
    }
    if (sql.includes('FROM users')) {
      return Promise.resolve([{ count: String(state.users) }]);
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const manager = {
    query,
    save: jest.fn((entity: { email?: string }) => {
      if (entity.email) state.users++;
      return Promise.resolve(entity);
    }),
  };
  const queryRunner = {
    manager,
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
  };
  const dataSource = {
    query,
    manager,
    createQueryRunner: () => queryRunner,
  };
  return { settings, state, dataSource };
}

function setup(options: { users?: number; envToken?: string } = {}) {
  const db = fakeDatabase(options.users);
  const userRepository = {
    create: (data: object) => ({ id: 'user-1', ...data }),
    count: () => Promise.resolve(db.state.users),
  };
  const deployment = { mode: 'saas', isSelfHosted: false };
  const limits = {
    defaultOrganizationLimit: 5,
    defaultMemberLimit: 10,
    defaultWaiterLimit: 200,
  };
  const config = {
    get: (key: string) =>
      key === 'SETUP_TOKEN' ? options.envToken : undefined,
  };
  const service = new SetupService(
    userRepository as never,
    {} as never,
    {} as never,
    db.dataSource as never,
    deployment as never,
    limits as never,
    config as never,
  );
  return { service, db };
}

const admin = {
  mode: SetupMode.MULTI,
  email: 'Admin@Example.com',
  password: 'Sicher-123',
  firstName: 'Ada',
  lastName: 'Admin',
};

describe('setup token', () => {
  it('is generated in groups that are easy to type', () => {
    const token = generateSetupToken();
    expect(token).toMatch(
      /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
    );
    expect(normalizeSetupToken(' k7qm-2xrt 9hcp ')).toBe('K7QM2XRT9HCP');
    expect(setupTokenMatches('k7qm 2xrt 9hcp', 'K7QM-2XRT-9HCP')).toBe(true);
    expect(setupTokenMatches('', 'K7QM-2XRT-9HCP')).toBe(false);
    expect(setupTokenMatches(undefined, 'K7QM-2XRT-9HCP')).toBe(false);
  });
});

describe('first-run setup', () => {
  it('logs one shared token on start while setup is open', async () => {
    const { service, db } = setup();
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    await service.onApplicationBootstrap();
    await service.onApplicationBootstrap();
    const token = (db.settings.get('setup.token') as { value: string }).value;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain(token);
    expect(warn.mock.calls[1][0]).toContain(token);
  });

  it('reports that a token is required', async () => {
    const { service } = setup();
    await expect(service.isSetupRequired()).resolves.toMatchObject({
      required: true,
      tokenRequired: true,
    });
  });

  it('refuses setup without the token', async () => {
    const { service, db } = setup();
    await expect(service.performSetup(admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.performSetup(admin, 'AAAA-BBBB-CCCC'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.state.users).toBe(0);
  });

  it('runs with the logged token and closes for good', async () => {
    const { service, db } = setup();
    await service.onApplicationBootstrap();
    const token = (db.settings.get('setup.token') as { value: string }).value;

    const result = await service.performSetup(admin, token.toLowerCase());
    expect(result.user.email).toBe('admin@example.com');
    expect(db.state.locks).toBe(1);
    expect(db.settings.has('setup.token')).toBe(false);
    expect(db.settings.has('setup.completedAt')).toBe(true);

    // Auch ohne Benutzer bleibt die Einrichtung danach zu.
    db.state.users = 0;
    await expect(service.isSetupRequired()).resolves.toMatchObject({
      required: false,
    });
    await expect(service.performSetup(admin, token)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('uses SETUP_TOKEN when it is set and does not log it', async () => {
    const { service, db } = setup({ envToken: 'mein-einrichtungscode' });
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    await service.onApplicationBootstrap();
    expect(warn.mock.calls[0][0]).not.toContain('mein-einrichtungscode');
    expect(db.settings.has('setup.token')).toBe(false);
    await expect(
      service.performSetup(admin, 'mein-einrichtungscode'),
    ).resolves.toMatchObject({ mode: SetupMode.MULTI });
  });

  it('marks existing installations as set up', async () => {
    const { service, db } = setup({ users: 3 });
    await service.onApplicationBootstrap();
    expect(db.settings.has('setup.completedAt')).toBe(true);
    await expect(service.performSetup(admin, 'x')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
