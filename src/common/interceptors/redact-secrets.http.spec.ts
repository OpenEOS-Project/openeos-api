import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';

import { OrganizationGuard, RolesGuard } from '../guards';
import { RedactSecretsInterceptor } from './redact-secrets.interceptor';
import { DevicesController } from '../../modules/devices/devices.controller';
import { DevicesPublicController } from '../../modules/devices/devices-public.controller';
import { DevicesService } from '../../modules/devices/devices.service';
import { GatewayService } from '../../modules/gateway/gateway.service';
import { WaitersController } from '../../modules/waiters/waiters.controller';
import { WaitersService } from '../../modules/waiters/waiters.service';
import { WaiterSettlementsService } from '../../modules/waiters/waiter-settlements.service';
import { WaiterTransferService } from '../../modules/waiters/waiter-transfer.service';
import { WaiterCashAuditService } from '../../modules/waiters/waiter-cash-audit.service';
import { WebhooksController } from '../../modules/webhooks/webhooks.controller';
import { WebhooksService } from '../../modules/webhooks/webhooks.service';
import { OrganizationApiTokensController } from '../../modules/api-tokens/organization-api-tokens.controller';
import { ApiTokensService } from '../../modules/api-tokens/api-tokens.service';
import { Device } from '../../database/entities';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const WAITER = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'd'.repeat(64);

function device(): Device {
  return Object.assign(new Device(), {
    id: DEVICE,
    organizationId: ORG,
    name: 'Kasse 1',
    deviceToken: TOKEN,
    verificationCode: '654321',
    status: 'verified',
    settings: {},
  });
}

/**
 * Die Antwort-Schwaerzung so, wie sie in main.ts haengt, vor echten
 * Controllern: Lesende Endpunkte liefern keine Zugangsdaten, die wenigen
 * Endpunkte, die ein Geheimnis einmalig ausgeben, tun das weiterhin.
 */
describe('response redaction over HTTP', () => {
  let app: INestApplication<App>;

  const devices = {
    findOne: jest.fn(() => Promise.resolve(device())),
    update: jest.fn(() => Promise.resolve(device())),
    verifyDevice: jest.fn(() => Promise.resolve(device())),
    blockDevice: jest.fn(() => Promise.resolve(device())),
    findAll: jest.fn(() =>
      Promise.resolve({ items: [device()], total: 1, page: 1, limit: 20 }),
    ),
    create: jest.fn(() => Promise.resolve(device())),
    regenerateToken: jest.fn(() => Promise.resolve(device())),
    initDevice: jest.fn(() =>
      Promise.resolve({
        deviceId: DEVICE,
        deviceToken: TOKEN,
        verificationCode: '654321',
      }),
    ),
    registerDevice: jest.fn(() =>
      Promise.resolve({
        deviceId: DEVICE,
        deviceToken: TOKEN,
        verificationCode: '654321',
        organizationName: 'TSV',
      }),
    ),
    getDeviceStatus: jest.fn(() =>
      Promise.resolve({ status: 'verified', deviceId: DEVICE }),
    ),
  };
  const waiters = {
    create: jest.fn(() =>
      Promise.resolve({ waiter: { id: WAITER, name: 'Kim' }, pin: '4711' }),
    ),
    resetPin: jest.fn(() =>
      Promise.resolve({ waiter: { id: WAITER, name: 'Kim' }, pin: '0815' }),
    ),
  };
  const webhooks = {
    create: jest.fn(() =>
      Promise.resolve({
        id: 'w1',
        url: 'https://example.org/hook',
        secret: 'whsec_once',
        secretEncrypted: 'enc:v1:stored',
      }),
    ),
    rotateSecret: jest.fn(() =>
      Promise.resolve({ id: 'w1', secret: 'whsec_next' }),
    ),
  };
  const apiTokens = {
    erstelle: jest.fn(() =>
      Promise.resolve({
        token: 'oeos_once',
        eintrag: { id: 't1', tokenPrefix: 'oeos_on', tokenHash: 'stored' },
      }),
    ),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        DevicesController,
        DevicesPublicController,
        WaitersController,
        WebhooksController,
        OrganizationApiTokensController,
      ],
      providers: [
        { provide: DevicesService, useValue: devices },
        { provide: GatewayService, useValue: {} },
        { provide: WaitersService, useValue: waiters },
        { provide: WaiterSettlementsService, useValue: {} },
        { provide: WaiterTransferService, useValue: {} },
        { provide: WaiterCashAuditService, useValue: {} },
        { provide: WebhooksService, useValue: webhooks },
        { provide: ApiTokensService, useValue: apiTokens },
      ],
    })
      .overrideGuard(OrganizationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: unknown }).user = { id: 'u1' };
      next();
    });
    // Wie in main.ts.
    app.useGlobalInterceptors(new RedactSecretsInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const body = (res: request.Response) => res.body as Record<string, unknown>;
  const data = (res: request.Response) =>
    (res.body as { data: Record<string, unknown> }).data;

  describe('device management never shows the device credentials', () => {
    it.each([
      [
        'GET detail',
        () => http().get(`/organizations/${ORG}/devices/${DEVICE}`),
      ],
      ['GET list', () => http().get(`/organizations/${ORG}/devices`)],
      [
        'PATCH',
        () =>
          http()
            .patch(`/organizations/${ORG}/devices/${DEVICE}`)
            .send({ name: 'Kasse 2' }),
      ],
      [
        'verify',
        () =>
          http()
            .post(`/organizations/${ORG}/devices/${DEVICE}/verify`)
            .send({ code: '654321' }),
      ],
      [
        'block',
        () => http().post(`/organizations/${ORG}/devices/${DEVICE}/block`),
      ],
    ])('%s', async (_name, call) => {
      const res = await call();
      expect(res.status).toBeLessThan(300);
      expect(JSON.stringify(body(res))).not.toContain(TOKEN);
      expect(JSON.stringify(body(res))).not.toContain('654321');
      expect(JSON.stringify(body(res))).toContain('Kasse 1');
    });
  });

  describe('one-time secrets still reach their recipient', () => {
    it('pairing a device returns its token and code', async () => {
      const res = await http().post('/devices/init').send({}).expect(201);
      expect(data(res)).toMatchObject({
        deviceToken: TOKEN,
        verificationCode: '654321',
      });
    });

    it('legacy registration returns its token and code', async () => {
      const res = await http()
        .post('/devices/register')
        .send({ name: 'Kasse', organizationSlug: 'tsv' })
        .expect(201);
      expect(data(res)).toMatchObject({
        deviceToken: TOKEN,
        verificationCode: '654321',
      });
    });

    it('creating a device and renewing its token return the token', async () => {
      const created = await http()
        .post(`/organizations/${ORG}/devices`)
        .send({ name: 'Agent', type: 'printer' })
        .expect(201);
      expect(body(created).deviceToken).toBe(TOKEN);
      expect(body(created)).not.toHaveProperty('verificationCode');

      const renewed = await http()
        .post(`/organizations/${ORG}/devices/${DEVICE}/regenerate-token`)
        .expect(200);
      expect(body(renewed).deviceToken).toBe(TOKEN);
    });

    it('a new or reset waiter PIN is shown once', async () => {
      const created = await http()
        .post(`/organizations/${ORG}/waiters`)
        .send({ name: 'Kim' })
        .expect(201);
      expect(data(created).pin).toBe('4711');

      const reset = await http()
        .post(`/organizations/${ORG}/waiters/${WAITER}/pin`)
        .send({})
        .expect(200);
      expect(data(reset).pin).toBe('0815');
    });

    it('webhook creation returns the signing secret, not the stored one', async () => {
      const res = await http()
        .post(`/organizations/${ORG}/webhooks`)
        .send({ url: 'https://example.org/hook', events: ['order.created'] })
        .expect(201);
      expect(data(res).secret).toBe('whsec_once');
      expect(data(res)).not.toHaveProperty('secretEncrypted');
    });

    it('API token creation returns the token, not its hash', async () => {
      const res = await http()
        .post(`/organizations/${ORG}/api-tokens`)
        .send({ name: 'CI', scopes: ['read'] })
        .expect(201);
      expect(data(res).token).toBe('oeos_once');
      expect(data(res)).not.toHaveProperty('tokenHash');
    });
  });
});
