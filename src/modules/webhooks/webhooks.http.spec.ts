import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';

import {
  AdminAuditLog,
  ApiToken,
  Event,
  User,
  UserOrganization,
} from '../../database/entities';
import { HttpExceptionFilter } from '../../common/filters';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ApiTokensService, hashToken } from '../api-tokens/api-tokens.service';
import { TokenScope } from '../api-tokens/api-scopes';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Der Webhook-Controller hinter dem echten Guard, per HTTP mit einem
 * API-Token: `webhooks:read` liest, `webhooks:write` legt an, testet und
 * sendet erneut, Loeschen geht nie per Token, und der Besitzer muss Admin
 * der Organisation sein.
 */

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const OTHER_ORG = '1b1b1b1b-4f43-4a3e-9f8e-0f2b8f3f1a22';
const HOOK = '3a3a3a3a-4f43-4a3e-9f8e-0f2b8f3f1a55';
const DELIVERY = '4b4b4b4b-4f43-4a3e-9f8e-0f2b8f3f1a66';
const SECRET = 'oeos_webhook-http-secret';

interface ErrorBody {
  error: { reason: string };
}

const owner = {
  id: 'user-1',
  email: 'lena@example.org',
  isActive: true,
  isSuperAdmin: false,
} as User;

describe('Webhooks over HTTP (API token)', () => {
  let app: INestApplication<App>;
  const tokens = new Map<string, Partial<ApiToken>>();
  let role: 'admin' | 'member' = 'admin';
  const service = {
    info: jest.fn(() => ({ enabled: true })),
    list: jest.fn(() => Promise.resolve([{ id: HOOK }])),
    get: jest.fn(() => Promise.resolve({ id: HOOK })),
    create: jest.fn(() => Promise.resolve({ id: HOOK, secret: 'whsec_x' })),
    update: jest.fn(() => Promise.resolve({ id: HOOK })),
    remove: jest.fn(() => Promise.resolve({ id: HOOK, deleted: true })),
    rotateSecret: jest.fn(() =>
      Promise.resolve({ id: HOOK, secret: 'whsec_y' }),
    ),
    sendTest: jest.fn(() => Promise.resolve({ id: DELIVERY })),
    listDeliveries: jest.fn(() => Promise.resolve({ data: [], meta: {} })),
    getDelivery: jest.fn(() => Promise.resolve({ id: DELIVERY })),
    redeliver: jest.fn(() => Promise.resolve({ id: DELIVERY })),
  };

  function issue(scopes: TokenScope[]) {
    tokens.set(hashToken(SECRET), {
      id: 'token-1',
      name: 'Zapier',
      tokenHash: hashToken(SECRET),
      tokenPrefix: SECRET.slice(0, 12),
      userId: owner.id,
      user: owner,
      organizationId: ORG,
      scopes,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: new Date(),
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        ApiTokensService,
        Reflector,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: WebhooksService, useValue: service },
        {
          provide: getRepositoryToken(ApiToken),
          useValue: {
            findOne: ({ where }: { where: { tokenHash: string } }) =>
              Promise.resolve(tokens.get(where.tokenHash) ?? null),
            update: () => Promise.resolve(),
          },
        },
        {
          provide: getRepositoryToken(UserOrganization),
          useValue: {
            findOne: ({ where }: { where: { organizationId: string } }) =>
              Promise.resolve(
                where.organizationId === ORG ? { role, permissions: {} } : null,
              ),
          },
        },
        {
          provide: getRepositoryToken(Event),
          useValue: { findOne: () => Promise.resolve(null) },
        },
        {
          provide: getRepositoryToken(AdminAuditLog),
          useValue: {
            create: (e: unknown) => e,
            save: () => Promise.resolve(),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    tokens.clear();
    role = 'admin';
    jest.clearAllMocks();
  });

  const auth = { Authorization: `Bearer ${SECRET}` };
  const base = `/organizations/${ORG}/webhooks`;
  const reason = (body: unknown) => (body as ErrorBody).error.reason;

  it('reads with webhooks:read, but `read` alone is not enough', async () => {
    issue([TokenScope.READ]);
    const denied = await request(app.getHttpServer())
      .get(base)
      .set(auth)
      .expect(403);
    expect(reason(denied.body)).toBe('API_TOKEN_SCOPE_MISSING');

    issue([TokenScope.WEBHOOKS_READ]);
    await request(app.getHttpServer()).get(base).set(auth).expect(200);
    await request(app.getHttpServer())
      .get(`${base}/info`)
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .get(`${base}/${HOOK}/deliveries`)
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .get(`${base}/${HOOK}/deliveries/${DELIVERY}`)
      .set(auth)
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(ORG);
  });

  it('writes only with webhooks:write', async () => {
    issue([TokenScope.WEBHOOKS_READ]);
    const body = {
      url: 'https://hooks.example.org/',
      eventTypes: ['order.paid'],
    };
    const denied = await request(app.getHttpServer())
      .post(base)
      .set(auth)
      .send(body)
      .expect(403);
    expect(reason(denied.body)).toBe('API_TOKEN_SCOPE_MISSING');
    expect(service.create).not.toHaveBeenCalled();

    issue([TokenScope.WEBHOOKS_WRITE]);
    await request(app.getHttpServer())
      .post(base)
      .set(auth)
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .patch(`${base}/${HOOK}`)
      .set(auth)
      .send({ active: false })
      .expect(200);
    await request(app.getHttpServer())
      .post(`${base}/${HOOK}/rotate-secret`)
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .post(`${base}/${HOOK}/test`)
      .set(auth)
      .expect(202);
    await request(app.getHttpServer())
      .post(`${base}/${HOOK}/deliveries/${DELIVERY}/redeliver`)
      .set(auth)
      .expect(202);
  });

  it('never deletes per token', async () => {
    issue([
      TokenScope.WEBHOOKS_READ,
      TokenScope.WEBHOOKS_WRITE,
      TokenScope.SETTINGS_WRITE,
    ]);
    const res = await request(app.getHttpServer())
      .delete(`${base}/${HOOK}`)
      .set(auth)
      .expect(403);
    expect(reason(res.body)).toBe('API_TOKEN_NOT_ALLOWED');
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('requires an admin as token owner', async () => {
    role = 'member';
    issue([TokenScope.WEBHOOKS_READ]);
    const res = await request(app.getHttpServer())
      .get(base)
      .set(auth)
      .expect(403);
    expect(reason(res.body)).toBe('INSUFFICIENT_PERMISSIONS');
    expect(service.list).not.toHaveBeenCalled();
  });

  it('stays inside the token organization', async () => {
    issue([TokenScope.WEBHOOKS_READ]);
    const res = await request(app.getHttpServer())
      .get(`/organizations/${OTHER_ORG}/webhooks`)
      .set(auth)
      .expect(403);
    expect(reason(res.body)).toBe('API_TOKEN_WRONG_ORGANIZATION');
  });

  it('validates the body', async () => {
    issue([TokenScope.WEBHOOKS_WRITE]);
    await request(app.getHttpServer())
      .post(base)
      .set(auth)
      .send({ url: 'https://hooks.example.org/', eventTypes: [] })
      .expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });
});
