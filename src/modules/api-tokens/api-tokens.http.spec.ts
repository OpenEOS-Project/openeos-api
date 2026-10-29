import { INestApplication } from '@nestjs/common';
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
import { ApiTokensService, hashToken } from './api-tokens.service';
import { TokenScope } from './api-scopes';
import { CategoriesController } from '../categories/categories.controller';
import { CategoriesService } from '../categories/categories.service';

/**
 * Ein echter Controller hinter dem echten Guard, angesprochen per HTTP
 * mit einem API-Token: Kategorien lesen (freigegeben, `read`), anlegen
 * (`catalog:write`) und loeschen (nicht freigegeben).
 */

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const OTHER_ORG = '1b1b1b1b-4f43-4a3e-9f8e-0f2b8f3f1a22';
const EVENT = '9c9c9c9c-4f43-4a3e-9f8e-0f2b8f3f1a33';
const FOREIGN_EVENT = '5e5e5e5e-4f43-4a3e-9f8e-0f2b8f3f1a44';
const CATEGORY = '3a3a3a3a-4f43-4a3e-9f8e-0f2b8f3f1a55';

const SECRET = 'oeos_e2e-secret';

interface ErrorBody {
  error: { reason: string };
}
interface DataBody {
  data: Record<string, unknown>;
}
const owner = {
  id: 'user-1',
  email: 'lena@example.org',
  isActive: true,
  isSuperAdmin: false,
} as User;

describe('API token over HTTP', () => {
  let app: INestApplication<App>;
  const tokens = new Map<string, Partial<ApiToken>>();
  const categoriesService = {
    findAll: jest.fn(() => Promise.resolve([{ id: CATEGORY, name: 'Essen' }])),
    create: jest.fn((_e: string, dto: unknown) =>
      Promise.resolve({ id: CATEGORY, ...(dto as object) }),
    ),
    remove: jest.fn(() => Promise.resolve()),
  };

  function issue(scopes: TokenScope[], organizationId: string | null = ORG) {
    tokens.set(hashToken(SECRET), {
      id: 'token-1',
      name: 'Agent',
      tokenHash: hashToken(SECRET),
      tokenPrefix: SECRET.slice(0, 12),
      userId: owner.id,
      user: owner,
      organizationId,
      scopes,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: new Date(),
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CategoriesController],
      providers: [
        ApiTokensService,
        Reflector,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: CategoriesService, useValue: categoriesService },
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
            findOne: ({
              where,
            }: {
              where: { userId: string; organizationId: string };
            }) =>
              Promise.resolve(
                where.organizationId === ORG
                  ? { role: 'admin', permissions: {} }
                  : null,
              ),
          },
        },
        {
          provide: getRepositoryToken(Event),
          useValue: {
            findOne: ({ where }: { where: { id: string } }) =>
              Promise.resolve(
                where.id === EVENT
                  ? { id: EVENT, organizationId: ORG }
                  : where.id === FOREIGN_EVENT
                    ? { id: FOREIGN_EVENT, organizationId: OTHER_ORG }
                    : null,
              ),
          },
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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    tokens.clear();
    jest.clearAllMocks();
  });

  const auth = { Authorization: `Bearer ${SECRET}` };

  it('reads categories of an event in the token organization', async () => {
    issue([TokenScope.READ]);
    const res = await request(app.getHttpServer())
      .get(`/events/${EVENT}/categories`)
      .set(auth)
      .expect(200);
    expect(res.body).toEqual({ data: [{ id: CATEGORY, name: 'Essen' }] });
    const [, user] = categoriesService.findAll.mock.calls[0] as unknown as [
      string,
      User & { organizations: unknown },
    ];
    expect(user.id).toBe(owner.id);
    expect(user.organizations).toEqual([{ id: ORG, role: 'admin' }]);
  });

  it('refuses an event of another organization', async () => {
    issue([TokenScope.READ]);
    const res = await request(app.getHttpServer())
      .get(`/events/${FOREIGN_EVENT}/categories`)
      .set(auth)
      .expect(403);
    expect((res.body as ErrorBody).error.reason).toBe(
      'API_TOKEN_WRONG_ORGANIZATION',
    );
    expect(categoriesService.findAll).not.toHaveBeenCalled();
  });

  it('writes only with catalog:write', async () => {
    issue([TokenScope.READ]);
    const denied = await request(app.getHttpServer())
      .post(`/events/${EVENT}/categories`)
      .set(auth)
      .send({ name: 'Getränke' })
      .expect(403);
    expect((denied.body as ErrorBody).error.reason).toBe(
      'API_TOKEN_SCOPE_MISSING',
    );

    issue([TokenScope.CATALOG_WRITE]);
    const res = await request(app.getHttpServer())
      .post(`/events/${EVENT}/categories`)
      .set(auth)
      .send({ name: 'Getränke' })
      .expect(201);
    expect((res.body as DataBody).data).toMatchObject({
      id: CATEGORY,
      name: 'Getränke',
    });
  });

  it('never deletes, whatever the scopes', async () => {
    issue([
      TokenScope.READ,
      TokenScope.CATALOG_WRITE,
      TokenScope.EVENTS_WRITE,
      TokenScope.SETTINGS_WRITE,
    ]);
    const res = await request(app.getHttpServer())
      .delete(`/events/${EVENT}/categories/${CATEGORY}`)
      .set(auth)
      .expect(403);
    expect((res.body as ErrorBody).error.reason).toBe('API_TOKEN_NOT_ALLOWED');
    expect(categoriesService.remove).not.toHaveBeenCalled();
  });

  it('rejects unknown tokens with 401', async () => {
    const res = await request(app.getHttpServer())
      .get(`/events/${EVENT}/categories`)
      .set({ Authorization: 'Bearer oeos_nope' })
      .expect(401);
    expect((res.body as ErrorBody).error.reason).toBe('API_TOKEN_INVALID');
  });
});
