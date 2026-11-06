import {
  ForbiddenException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
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
import { validationException } from '../../common/pipes/validation.pipe';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ApiTokensService, hashToken } from '../api-tokens/api-tokens.service';
import { TokenScope } from '../api-tokens/api-scopes';
import { RefundsService } from '../refunds/refunds.service';
import { OrderHistoryService } from '../refunds/order-history.service';
import { OrdersController } from './orders.controller';
import { OrdersExportService } from './orders-export.service';
import { OrdersService } from './orders.service';
import { OrdersExportVariant, type ExportOrdersDto } from './dto';

/**
 * `GET …/orders/export` per HTTP mit einem API-Token (Scope `read`):
 * Kopfzeilen des Downloads, BOM als Bytes, Filter aus der Query und
 * Fehler als JSON, bevor die erste Zeile geschrieben ist.
 */

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const EVENT = '9c9c9c9c-4f43-4a3e-9f8e-0f2b8f3f1a33';
const SECRET = 'oeos_export-secret';

const owner = {
  id: 'user-1',
  email: 'lena@example.org',
  isActive: true,
  isSuperAdmin: false,
} as User;

describe('GET /organizations/:id/orders/export over HTTP', () => {
  let app: INestApplication<App>;
  const tokens = new Map<string, Partial<ApiToken>>();
  const prepare = jest.fn(
    (_org: string, _user: User, query: ExportOrdersDto) => {
      async function* chunks() {
        for (const chunk of [
          '\uFEFFBestellnummer;Gastname\r\n',
          'SF-0001;Jürgen\r\n',
          'SF-0002;\r\n',
        ]) {
          // Wie die Datenbankbloecke: jedes Stueck kommt asynchron.
          yield await Promise.resolve(chunk);
        }
      }
      return Promise.resolve({
        filename:
          query.variant === OrdersExportVariant.ITEMS
            ? 'bestellpositionen_2026-11-06.csv'
            : 'bestellungen_2026-11-06.csv',
        chunks: chunks(),
      });
    },
  );

  function issue(scopes: TokenScope[]) {
    tokens.set(hashToken(SECRET), {
      id: 'token-1',
      name: 'Buchhaltung',
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
      controllers: [OrdersController],
      providers: [
        ApiTokensService,
        Reflector,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: OrdersExportService, useValue: { prepare } },
        { provide: OrdersService, useValue: {} },
        { provide: RefundsService, useValue: {} },
        { provide: OrderHistoryService, useValue: {} },
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
            findOne: () => Promise.resolve({ role: 'admin', permissions: {} }),
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
    // Wie in main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        exceptionFactory: validationException,
      }),
    );
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
  const url = `/organizations/${ORG}/orders/export`;

  it('streams the CSV as a download with BOM bytes', async () => {
    issue([TokenScope.READ]);
    const res = await request(app.getHttpServer())
      .get(url)
      .set(auth)
      .buffer(true)
      .parse((r, done) => {
        const parts: Buffer[] = [];
        r.on('data', (c: Buffer) => parts.push(c));
        r.on('end', () => done(null, Buffer.concat(parts)));
      })
      .expect(200);

    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="bestellungen_2026-11-06.csv"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as Buffer;
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(body.toString('utf8')).toBe(
      '\uFEFFBestellnummer;Gastname\r\nSF-0001;Jürgen\r\nSF-0002;\r\n',
    );
  });

  it('passes the list filters through, with isTest=false as boolean false', async () => {
    issue([TokenScope.READ]);
    await request(app.getHttpServer())
      .get(url)
      .query({
        variant: 'items',
        eventId: EVENT,
        dateFrom: '2026-08-01',
        dateTo: '2026-08-02',
        displayStatus: 'completed,refunded',
        paymentMethod: 'cash',
        isTest: 'false',
      })
      .set(auth)
      .expect(200)
      .expect(
        'content-disposition',
        'attachment; filename="bestellpositionen_2026-11-06.csv"',
      );
    const [org, user, query] = prepare.mock.calls[0];
    expect(org).toBe(ORG);
    expect(user.id).toBe(owner.id);
    expect(query).toMatchObject({
      variant: 'items',
      eventId: EVENT,
      dateFrom: '2026-08-01',
      dateTo: '2026-08-02',
      displayStatus: 'completed,refunded',
      paymentMethod: 'cash',
      isTest: false,
    });

    await request(app.getHttpServer())
      .get(url)
      .query({ isTest: 'true' })
      .set(auth)
      .expect(200);
    expect(prepare.mock.calls[1][2].isTest).toBe(true);
  });

  it('rejects unknown variants, paging and bad booleans with 400', async () => {
    issue([TokenScope.READ]);
    for (const query of [
      { variant: 'xlsx' },
      { page: '2' },
      { isTest: 'yes' },
    ]) {
      await request(app.getHttpServer())
        .get(url)
        .query(query)
        .set(auth)
        .expect(400);
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('answers 403 as JSON when the owner may not export', async () => {
    issue([TokenScope.READ]);
    prepare.mockRejectedValueOnce(
      new ForbiddenException({
        code: 'FORBIDDEN',
        reason: 'INSUFFICIENT_PERMISSIONS',
        message: 'nope',
      }),
    );
    const res = await request(app.getHttpServer())
      .get(url)
      .set(auth)
      .expect(403)
      .expect('content-type', /json/);
    expect((res.body as { error: { reason: string } }).error.reason).toBe(
      'INSUFFICIENT_PERMISSIONS',
    );
  });

  it('needs the read scope', async () => {
    issue([TokenScope.CATALOG_WRITE]);
    await request(app.getHttpServer()).get(url).set(auth).expect(403);
    expect(prepare).not.toHaveBeenCalled();
  });
});
