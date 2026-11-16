import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppGateway } from './app.gateway';
import {
  DeviceStatus,
  DeviceType,
} from '../../database/entities/device.entity';
import { gesperrterTokenSchluessel } from '../auth/token-blocklist';
import { GatewayEvents } from './dto';

const SECRET = 'gateway-handshake-test-secret';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

type DeviceRow = {
  id: string;
  name: string;
  type: DeviceType;
  status: DeviceStatus;
  isActive: boolean;
  organizationId: string | null;
  organization: { id: string; deletedAt: Date | null } | null;
};

function deviceRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: 'dev-1',
    name: 'Kasse 1',
    type: DeviceType.POS,
    status: DeviceStatus.VERIFIED,
    isActive: true,
    organizationId: ORG,
    organization: { id: ORG, deletedAt: null },
    ...overrides,
  };
}

interface FakeSocket {
  id: string;
  handshake: {
    headers: Record<string, string>;
    address: string;
    auth: Record<string, unknown>;
    query: Record<string, unknown>;
  };
  data: Record<string, unknown>;
  rooms: Set<string>;
  join: jest.Mock;
  leave: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  device?: { id: string; organizationId: string; type: string };
}

function setup() {
  const jwt = new JwtService({ secret: SECRET });
  const config = { get: jest.fn(() => SECRET) };
  const cache = new Map<string, unknown>();
  const cacheManager = {
    get: jest.fn((key: string) => Promise.resolve(cache.get(key))),
  };
  let user: Record<string, unknown> | null = {
    id: USER_ID,
    email: 'kim@example.org',
    isActive: true,
    lockedUntil: null,
  };
  let memberships = [{ organizationId: ORG }];
  let deviceById: DeviceRow | null = null;
  const devicesService = {
    findByToken: jest.fn(
      (): Promise<DeviceRow | null> => Promise.resolve(null),
    ),
    updateLastSeen: jest.fn(() => Promise.resolve()),
    updateLastSeenById: jest.fn(() => Promise.resolve()),
  };
  const printersService = { updateOnlineStatus: jest.fn() };
  const printerAgentsService = {
    handleAgentHeartbeat: jest.fn(),
    markAgentOffline: jest.fn(),
  };
  const printJobsService = {
    updateJobStatus: jest.fn(() => Promise.resolve({ printerId: 'p-1' })),
    agentTemplates: jest.fn(() => Promise.resolve([])),
    getQueuedJobsForDevice: jest.fn(() => Promise.resolve([])),
  };
  const userOrganizationRepository = {
    findOne: jest.fn(({ where }: { where: { organizationId: string } }) =>
      Promise.resolve(
        memberships.find((m) => m.organizationId === where.organizationId) ??
          null,
      ),
    ),
    find: jest.fn(() => Promise.resolve(memberships)),
  };
  const userRepository = { findOne: jest.fn(() => Promise.resolve(user)) };
  const deviceRepository = {
    findOne: jest.fn(() => Promise.resolve(deviceById)),
  };

  const gateway = new AppGateway(
    jwt,
    config as never,
    devicesService as never,
    printersService as never,
    printerAgentsService as never,
    printJobsService as never,
    userOrganizationRepository as never,
    userRepository as never,
    deviceRepository as never,
    cacheManager as never,
  );
  const emitToRoom = jest.fn();
  gateway.server = {
    to: jest.fn(() => ({ emit: emitToRoom })),
    in: jest.fn(() => ({
      fetchSockets: jest.fn(() => Promise.resolve([])),
      disconnectSockets: jest.fn(),
    })),
  } as never;

  const sockets: FakeSocket[] = [];
  function socket(handshake: {
    auth?: Record<string, unknown>;
    query?: Record<string, unknown>;
  }): FakeSocket {
    const rooms = new Set<string>(['sock-1']);
    const s: FakeSocket = {
      id: 'sock-1',
      handshake: {
        headers: {},
        address: '127.0.0.1',
        auth: handshake.auth ?? {},
        query: handshake.query ?? {},
      },
      data: {} as Record<string, unknown>,
      rooms,
      join: jest.fn((room: string) => rooms.add(room)),
      leave: jest.fn((room: string) => rooms.delete(room)),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    sockets.push(s);
    return s;
  }

  const sign = (claims: Record<string, unknown>) =>
    jwt.sign({ sub: USER_ID, email: 'kim@example.org', ...claims });

  return {
    gateway,
    jwt,
    sign,
    cache,
    socket,
    sockets,
    devicesService,
    printersService,
    printerAgentsService,
    printJobsService,
    emitToRoom,
    setUser: (u: Record<string, unknown> | null) => (user = u),
    setMemberships: (m: { organizationId: string }[]) => (memberships = m),
    setDeviceById: (d: DeviceRow | null) => (deviceById = d),
  };
}

let ctx: ReturnType<typeof setup>;

beforeAll(() => {
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

beforeEach(() => {
  ctx = setup();
});

afterEach(async () => {
  // Stop the revalidation timers the connected sockets started.
  for (const s of ctx.sockets) {
    await ctx.gateway.handleDisconnect(s as never);
  }
});

function wasRejected(s: FakeSocket) {
  const emitted = s.emit.mock.calls as unknown[][];
  return (
    s.disconnect.mock.calls.length > 0 &&
    !emitted.some((c) => c[0] === GatewayEvents.CONNECTED)
  );
}

describe('AppGateway handshake — device tokens', () => {
  it('connects a verified device and joins its organization rooms', async () => {
    ctx.devicesService.findByToken.mockResolvedValue(deviceRow());
    const s = ctx.socket({ auth: { deviceToken: 'dev_tok' } });

    await ctx.gateway.handleConnection(s as never);

    expect(s.disconnect).not.toHaveBeenCalled();
    expect([...s.rooms]).toEqual(
      expect.arrayContaining([
        'device:dev-1',
        `org:${ORG}`,
        `org:${ORG}:device:dev-1`,
      ]),
    );
    expect(s.emit).toHaveBeenCalledWith(GatewayEvents.CONNECTED, {
      deviceId: 'dev-1',
      hasOrganization: true,
    });
  });

  it.each([
    ['awaiting approval', { status: DeviceStatus.PENDING }],
    ['blocked', { status: DeviceStatus.BLOCKED }],
    ['inactive', { isActive: false }],
    ['of a deleted organization', { organization: null }],
    [
      'of an organization marked deleted',
      { organization: { id: ORG, deletedAt: new Date() } },
    ],
  ])('refuses a device %s and joins no room', async (_label, overrides) => {
    ctx.devicesService.findByToken.mockResolvedValue(deviceRow(overrides));
    const s = ctx.socket({ auth: { deviceToken: 'dev_tok' } });

    await ctx.gateway.handleConnection(s as never);

    expect(wasRejected(s)).toBe(true);
    expect(s.join).not.toHaveBeenCalled();
    expect(ctx.devicesService.updateLastSeen).not.toHaveBeenCalled();
  });

  it('gives a verified device without organization only its own device room', async () => {
    ctx.devicesService.findByToken.mockResolvedValue(
      deviceRow({
        type: DeviceType.PRINTER_AGENT,
        organizationId: null,
        organization: null,
      }),
    );
    const s = ctx.socket({ auth: { deviceToken: 'dev_tok' } });

    await ctx.gateway.handleConnection(s as never);

    expect(s.disconnect).not.toHaveBeenCalled();
    expect([...s.rooms].filter((r) => r.startsWith('org:'))).toEqual([]);
    expect(s.rooms.has('device:dev-1')).toBe(true);
  });

  it('refuses an unknown device token', async () => {
    const s = ctx.socket({ query: { deviceToken: 'dev_unknown' } });
    await ctx.gateway.handleConnection(s as never);
    expect(wasRejected(s)).toBe(true);
  });
});

describe('AppGateway handshake — user tokens', () => {
  it('connects a user with a regular session token', async () => {
    const s = ctx.socket({ auth: { token: ctx.sign({ jti: 'a', sid: 's' }) } });

    await ctx.gateway.handleConnection(s as never);

    expect(s.disconnect).not.toHaveBeenCalled();
    expect(s.emit).toHaveBeenCalledWith(GatewayEvents.CONNECTED, {
      userId: USER_ID,
    });
  });

  it('refuses the intermediate token of the two-step sign-in', async () => {
    const s = ctx.socket({ auth: { token: ctx.sign({ pending2fa: true }) } });
    await ctx.gateway.handleConnection(s as never);
    expect(wasRejected(s)).toBe(true);
  });

  it('refuses a token typed as anything other than an access token', async () => {
    const s = ctx.socket({ auth: { token: ctx.sign({ typ: '2fa' }) } });
    await ctx.gateway.handleConnection(s as never);
    expect(wasRejected(s)).toBe(true);
  });

  it('refuses a token that was signed out', async () => {
    const token = ctx.sign({ jti: 'b' });
    ctx.cache.set(gesperrterTokenSchluessel(token), true);
    const s = ctx.socket({ auth: { token } });

    await ctx.gateway.handleConnection(s as never);

    expect(wasRejected(s)).toBe(true);
  });

  it.each([
    ['deactivated', { isActive: false }],
    ['locked', { lockedUntil: new Date(Date.now() + 60_000) }],
  ])('refuses a %s account', async (_label, overrides) => {
    ctx.setUser({
      id: USER_ID,
      email: 'kim@example.org',
      isActive: true,
      lockedUntil: null,
      ...overrides,
    });
    const s = ctx.socket({ auth: { token: ctx.sign({ jti: 'c' }) } });
    await ctx.gateway.handleConnection(s as never);
    expect(wasRejected(s)).toBe(true);
  });

  it('refuses a token for a user that no longer exists', async () => {
    ctx.setUser(null);
    const s = ctx.socket({ auth: { token: ctx.sign({ jti: 'd' }) } });
    await ctx.gateway.handleConnection(s as never);
    expect(wasRejected(s)).toBe(true);
  });

  it('refuses a token signed with another secret', async () => {
    const foreign = new JwtService({ secret: 'other' }).sign({
      sub: USER_ID,
      email: 'kim@example.org',
    });
    const s = ctx.socket({ auth: { token: foreign } });
    await ctx.gateway.handleConnection(s as never);
    expect(wasRejected(s)).toBe(true);
  });
});

describe('AppGateway — connected sockets are checked again', () => {
  async function connectedUser() {
    const token = ctx.sign({ jti: 'e' });
    const s = ctx.socket({ auth: { token } });
    await ctx.gateway.handleConnection(s as never);
    expect(s.disconnect).not.toHaveBeenCalled();
    return { s, token };
  }

  it('disconnects a user socket once its session is signed out', async () => {
    const { s, token } = await connectedUser();
    ctx.cache.set(gesperrterTokenSchluessel(token), true);

    await expect(ctx.gateway.revalidate(s as never)).resolves.toBe(false);
    expect(s.disconnect).toHaveBeenCalled();
  });

  it('disconnects a user socket once the account is deactivated', async () => {
    const { s } = await connectedUser();
    ctx.setUser({
      id: USER_ID,
      email: 'x',
      isActive: false,
      lockedUntil: null,
    });

    await expect(ctx.gateway.revalidate(s as never)).resolves.toBe(false);
    expect(s.disconnect).toHaveBeenCalled();
  });

  it('refuses joinRoom after the account was deactivated', async () => {
    const { s } = await connectedUser();
    ctx.setUser({
      id: USER_ID,
      email: 'x',
      isActive: false,
      lockedUntil: null,
    });

    const result = await ctx.gateway.handleJoinRoom(s as never, {
      organizationId: ORG,
    });

    expect(result).toEqual({ error: 'Not authenticated' });
    expect(s.rooms.has(`org:${ORG}`)).toBe(false);
  });

  it('removes a user from rooms of an organization they left', async () => {
    const { s } = await connectedUser();
    await ctx.gateway.handleJoinRoom(s as never, { organizationId: ORG });
    expect(s.rooms.has(`org:${ORG}`)).toBe(true);

    ctx.setMemberships([]);
    await expect(ctx.gateway.revalidate(s as never)).resolves.toBe(true);

    expect(s.rooms.has(`org:${ORG}`)).toBe(false);
  });

  it('refuses joinRoom for an organization the user is not a member of', async () => {
    const { s } = await connectedUser();
    const result = await ctx.gateway.handleJoinRoom(s as never, {
      organizationId: OTHER_ORG,
    });
    expect(result).toEqual({ error: 'Forbidden' });
  });

  it('disconnects a device socket once the device is blocked', async () => {
    ctx.devicesService.findByToken.mockResolvedValue(deviceRow());
    const s = ctx.socket({ auth: { deviceToken: 'dev_tok' } });
    await ctx.gateway.handleConnection(s as never);

    ctx.setDeviceById(deviceRow({ status: DeviceStatus.BLOCKED }));
    await expect(ctx.gateway.revalidate(s as never)).resolves.toBe(false);
    expect(s.disconnect).toHaveBeenCalled();
  });

  it('disconnects a device socket once it belongs to another organization', async () => {
    ctx.devicesService.findByToken.mockResolvedValue(deviceRow());
    const s = ctx.socket({ auth: { deviceToken: 'dev_tok' } });
    await ctx.gateway.handleConnection(s as never);

    ctx.setDeviceById(
      deviceRow({
        organizationId: OTHER_ORG,
        organization: { id: OTHER_ORG, deletedAt: null },
      }),
    );
    await expect(ctx.gateway.revalidate(s as never)).resolves.toBe(false);
  });

  it('follows a changed device type without dropping the connection', async () => {
    ctx.devicesService.findByToken.mockResolvedValue(deviceRow());
    const s = ctx.socket({ auth: { deviceToken: 'dev_tok' } });
    await ctx.gateway.handleConnection(s as never);

    ctx.setDeviceById(deviceRow({ type: DeviceType.DISPLAY }));
    await expect(ctx.gateway.revalidate(s as never)).resolves.toBe(true);
    expect(s.disconnect).not.toHaveBeenCalled();
    expect(s.device?.type).toBe(DeviceType.DISPLAY);
  });

  it('keeps the socket when the check itself fails', async () => {
    const { s } = await connectedUser();
    (
      ctx.gateway as unknown as { userRepository: { findOne: jest.Mock } }
    ).userRepository.findOne.mockRejectedValueOnce(new Error('db away'));

    await expect(ctx.gateway.revalidate(s as never)).resolves.toBe(true);
    expect(s.disconnect).not.toHaveBeenCalled();
  });
});

describe('AppGateway — device events by device type', () => {
  async function connectedDevice(type: DeviceType) {
    ctx.devicesService.findByToken.mockResolvedValue(deviceRow({ type }));
    const s = ctx.socket({ auth: { deviceToken: 'dev_tok' } });
    await ctx.gateway.handleConnection(s as never);
    return s;
  }

  it.each([DeviceType.POS, DeviceType.DISPLAY])(
    'ignores printer reports from a %s device',
    async (type) => {
      const s = await connectedDevice(type);

      await expect(
        ctx.gateway.handlePrinterHeartbeat(
          s as never,
          {
            printerId: 'p-1',
            agentId: 'dev-1',
            isOnline: false,
          } as never,
        ),
      ).resolves.toEqual({ error: 'Not a printer agent' });
      await expect(
        ctx.gateway.handlePrinterJobComplete(
          s as never,
          {
            jobId: 'j-1',
            agentId: 'dev-1',
          } as never,
        ),
      ).resolves.toEqual({ error: 'Not a printer agent' });
      await expect(
        ctx.gateway.handlePrinterJobFailed(
          s as never,
          {
            jobId: 'j-1',
            agentId: 'dev-1',
            errorCode: 'X',
            errorMessage: 'y',
          } as never,
        ),
      ).resolves.toEqual({ error: 'Not a printer agent' });

      expect(ctx.printersService.updateOnlineStatus).not.toHaveBeenCalled();
      expect(ctx.printJobsService.updateJobStatus).not.toHaveBeenCalled();
    },
  );

  it('accepts printer reports from a printer agent', async () => {
    const s = await connectedDevice(DeviceType.PRINTER_AGENT);

    await expect(
      ctx.gateway.handlePrinterJobComplete(
        s as never,
        {
          jobId: 'j-1',
          agentId: 'dev-1',
        } as never,
      ),
    ).resolves.toEqual({ success: true });
    expect(ctx.printJobsService.updateJobStatus).toHaveBeenCalledWith(
      'j-1',
      'completed',
      undefined,
      ORG,
    );
  });

  it('relays the cart only from a POS device', async () => {
    const display = await connectedDevice(DeviceType.DISPLAY);
    expect(
      ctx.gateway.handleCartUpdate(display as never, { items: [] } as never),
    ).toEqual({ error: 'Not a POS device' });
    expect(ctx.emitToRoom).not.toHaveBeenCalled();

    const pos = await connectedDevice(DeviceType.POS);
    expect(
      ctx.gateway.handleCartUpdate(pos as never, { items: [] } as never),
    ).toEqual({ success: true });
  });

  it('lets only display devices watch a POS cart', async () => {
    const pos = await connectedDevice(DeviceType.POS);
    expect(
      ctx.gateway.handleWatchPosCart(pos as never, { posDeviceId: 'pos-9' }),
    ).toEqual({ error: 'Not a display device' });
    expect([...pos.rooms].some((r) => r.includes(':cart'))).toBe(false);

    const display = await connectedDevice(DeviceType.DISPLAY);
    expect(
      ctx.gateway.handleWatchPosCart(display as never, {
        posDeviceId: 'pos-9',
      }),
    ).toEqual(expect.objectContaining({ success: true }));
  });
});
