import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { AddressInfo } from 'net';
import { AppGateway } from './app.gateway';
import { Device, User, UserOrganization } from '../../database/entities';
import {
  DeviceStatus,
  DeviceType,
} from '../../database/entities/device.entity';
import { DevicesService } from '../devices/devices.service';
import { PrintersService } from '../printers/printers.service';
import { PrinterAgentsService } from '../printers/printer-agents.service';
import { PrintJobsService } from '../print-jobs/print-jobs.service';

/**
 * The handshake through a real Socket.IO server inside a Nest app, spoken
 * over the HTTP long-polling transport (Engine.IO v4) so no extra client
 * library is needed.
 */
const SECRET = 'gateway-socket-test-secret';
const ORG = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SEP = '\x1e';

const devices: Record<string, Partial<Device>> = {
  dev_verified: {
    id: 'dev-verified',
    name: 'Kasse',
    type: DeviceType.POS,
    status: DeviceStatus.VERIFIED,
    isActive: true,
    organizationId: ORG,
    organization: { id: ORG, deletedAt: null } as never,
  },
  dev_pending: {
    id: 'dev-pending',
    name: 'Neu',
    type: DeviceType.POS,
    status: DeviceStatus.PENDING,
    isActive: true,
    organizationId: ORG,
    organization: { id: ORG, deletedAt: null } as never,
  },
};

describe('AppGateway over Socket.IO', () => {
  let app: INestApplication;
  let baseUrl: string;
  const jwt = new JwtService({ secret: SECRET });

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppGateway,
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: { get: () => SECRET } },
        {
          provide: DevicesService,
          useValue: {
            findByToken: (token: string) =>
              Promise.resolve(devices[token] ?? null),
            updateLastSeen: () => Promise.resolve(),
          },
        },
        { provide: PrintersService, useValue: {} },
        { provide: PrinterAgentsService, useValue: {} },
        { provide: PrintJobsService, useValue: {} },
        {
          provide: getRepositoryToken(UserOrganization),
          useValue: { findOne: () => Promise.resolve(null) },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: () =>
              Promise.resolve({
                id: USER_ID,
                email: 'kim@example.org',
                isActive: true,
                lockedUntil: null,
              }),
          },
        },
        { provide: getRepositoryToken(Device), useValue: {} },
        { provide: CACHE_MANAGER, useValue: { get: () => undefined } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as { address(): AddressInfo };
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`;
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  /** Opens a session, sends the CONNECT packet and collects what follows. */
  async function handshake(auth: Record<string, unknown>): Promise<string[]> {
    const open = await (await fetch(`${baseUrl}&t=1`)).text();
    const sid = (JSON.parse(open.slice(1)) as { sid: string }).sid;
    const url = `${baseUrl}&sid=${sid}`;
    await fetch(url, { method: 'POST', body: `40${JSON.stringify(auth)}` });

    const packets: string[] = [];
    for (let i = 0; i < 5; i++) {
      const body = await (await fetch(`${url}&t=${i + 2}`)).text();
      packets.push(...body.split(SEP));
      if (packets.some((p) => p === '41' || p.startsWith('42["connected"'))) {
        break;
      }
    }
    return packets;
  }

  const connected = (packets: string[]) =>
    packets.some((p) => p.startsWith('42["connected"'));
  const dropped = (packets: string[]) => packets.includes('41');

  it('accepts an approved device', async () => {
    const packets = await handshake({ deviceToken: 'dev_verified' });
    expect(connected(packets)).toBe(true);
    expect(dropped(packets)).toBe(false);
  });

  it('turns away a device that is still awaiting approval', async () => {
    const packets = await handshake({ deviceToken: 'dev_pending' });
    expect(connected(packets)).toBe(false);
    expect(dropped(packets)).toBe(true);
  });

  it('accepts a regular session token', async () => {
    const token = jwt.sign({ sub: USER_ID, email: 'kim@example.org' });
    const packets = await handshake({ token });
    expect(connected(packets)).toBe(true);
  });

  it('turns away the intermediate token of the two-step sign-in', async () => {
    const token = jwt.sign({
      sub: USER_ID,
      email: 'kim@example.org',
      pending2fa: true,
    });
    const packets = await handshake({ token });
    expect(connected(packets)).toBe(false);
    expect(dropped(packets)).toBe(true);
  });
});
