import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { App } from 'supertest/types';

import { ErrorReasons } from '../../common/constants/error-codes';
import { AllowPendingTwoFactor } from '../../common/decorators';
import { HttpExceptionFilter } from '../../common/filters';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RefreshToken, User } from '../../database/entities';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Der Ausweis aus dem ersten Anmeldeschritt gegen echte HTTP-Anfragen:
 * Er oeffnet nur Endpunkte mit @AllowPendingTwoFactor — im Header wie im
 * Cookie. Token ohne erkennbare Art gelten gar nicht.
 */

const SECRET = 'two-factor-http-secret';

@Controller('probe')
class ProbeController {
  @Get('protected')
  protectedRoute() {
    return { ok: true };
  }

  @AllowPendingTwoFactor()
  @Get('second-step')
  secondStep() {
    return { ok: true };
  }
}

const user = {
  id: randomUUID(),
  email: 'kim@example.org',
  isSuperAdmin: false,
  isActive: true,
  lockedUntil: null,
  userOrganizations: [],
} as unknown as User;

describe('Login step tokens over HTTP', () => {
  let app: INestApplication<App>;
  let auth: AuthService;
  const jwt = new JwtService({ secret: SECRET });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: ApiTokensService, useValue: {} },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'jwt.secret' ? SECRET : undefined),
          },
        },
        {
          provide: CACHE_MANAGER,
          useValue: { get: () => Promise.resolve(undefined) },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: ({ where }: { where: { id: string } }) =>
              Promise.resolve(where.id === user.id ? user : null),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    const refreshTokens = {
      create: (row: Partial<RefreshToken>) => row,
      save: (row: RefreshToken) => {
        row.id = randomUUID();
        return Promise.resolve(row);
      },
    };
    const twoFactor = {
      createChallenge: () => Promise.resolve({ id: randomUUID() }),
    };
    const none = {} as never;
    auth = new AuthService(
      none,
      none,
      none,
      refreshTokens as never,
      none,
      none,
      jwt,
      none,
      none,
      none,
      none,
      twoFactor as never,
      none,
      none,
    );
  });

  afterAll(() => app.close());

  const get = (path: string, token: string, via: 'header' | 'cookie') => {
    const req = request(app.getHttpServer()).get(path);
    return via === 'header'
      ? req.set('Authorization', `Bearer ${token}`)
      : req.set('Cookie', `accessToken=${token}`);
  };

  it.each(['header', 'cookie'] as const)(
    'rejects the pending token on a protected route (%s)',
    async (via) => {
      const pending = await auth.issueTwoFactorToken(user);

      const res = await get('/probe/protected', pending, via).expect(401);
      expect(JSON.stringify(res.body)).toContain(
        ErrorReasons.TWO_FACTOR_PENDING,
      );
    },
  );

  it('lets the pending token reach the second login step', async () => {
    const pending = await auth.issueTwoFactorToken(user);
    await get('/probe/second-step', pending, 'header').expect(200);
  });

  it('accepts a full access token everywhere', async () => {
    const { accessToken } = await auth.login(user);
    expect(jwt.decode<{ typ: string }>(accessToken).typ).toBe('access');

    await get('/probe/protected', accessToken, 'header').expect(200);
    await get('/probe/protected', accessToken, 'cookie').expect(200);
  });

  it('rejects a pending token even without the typ claim', async () => {
    const legacyPending = jwt.sign({
      sub: user.id,
      email: user.email,
      isSuperAdmin: false,
      pending2fa: true,
    });
    await get('/probe/protected', legacyPending, 'header').expect(401);
  });

  it('rejects tokens of an unknown type', async () => {
    const unknownType = jwt.sign({
      sub: user.id,
      email: user.email,
      isSuperAdmin: false,
      typ: 'refresh',
      sid: randomUUID(),
    });
    await get('/probe/protected', unknownType, 'header').expect(401);
    await get('/probe/second-step', unknownType, 'header').expect(401);
  });

  it('rejects a token without type and without session', async () => {
    const bare = jwt.sign({
      sub: user.id,
      email: user.email,
      isSuperAdmin: false,
    });
    await get('/probe/protected', bare, 'header').expect(401);
  });

  it('still accepts an access token issued before the typ claim', async () => {
    const legacyAccess = jwt.sign({
      sub: user.id,
      email: user.email,
      isSuperAdmin: false,
      sid: randomUUID(),
      jti: randomUUID(),
    });
    await get('/probe/protected', legacyAccess, 'header').expect(200);
  });
});
