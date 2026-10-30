// Sentry must be imported first
import './instrument';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters';
import { validationException } from './common/pipes';
import {
  TransformInterceptor,
  LoggingInterceptor,
  SentryContextInterceptor,
} from './common/interceptors';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';
import { RedactSecretsInterceptor } from './common/interceptors/redact-secrets.interceptor';
import { parseTrustProxy } from './common/utils/trust-proxy.util';
import {
  OPENAPI_DOCUMENT_OPTIONS,
  buildOpenApiConfig,
} from './common/openapi/openapi-config';
import { MCP_PATH, PROTECTED_RESOURCE_PATH } from './modules/mcp';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // rawBody: der Stripe-Webhook prueft seine Signatur gegen den unveraenderten
  // Rohtext. Nach dem JSON-Parser laesst sich der nicht mehr rekonstruieren —
  // schon eine andere Schluesselreihenfolge macht die Signatur ungueltig.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const configService = app.get(ConfigService);

  // SIGTERM/SIGINT run the shutdown hooks: ShutdownService marks the
  // instance as draining, websockets close (clients reconnect to another
  // instance), open requests finish (at most SHUTDOWN_TIMEOUT_MS, 20 s),
  // then database and Redis disconnect. See common/lifecycle.
  app.enableShutdownHooks();

  // Behind a reverse proxy (Traefik) the socket address is the proxy's.
  // `trust proxy` makes req.ip the client address taken from
  // X-Forwarded-For — but only from proxies we trust, so clients can not
  // spoof it. Used by sessions, the audit log and the rate limiter.
  const trustProxy = parseTrustProxy(configService.get<string>('trustProxy'));
  if (trustProxy.warning) logger.warn(trustProxy.warning);
  app.set('trust proxy', trustProxy.value);

  // Socket.io over Redis pub/sub — required so websocket broadcasts and
  // presence work when running more than one API replica.
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis(
    configService.get<string>('redis.host') || 'localhost',
    configService.get<number>('redis.port') || 6379,
    process.env.REDIS_PASSWORD || undefined,
  );
  app.useWebSocketAdapter(redisIoAdapter);

  // Security Headers — disable cross-origin-resource-policy for /uploads so the
  // Next.js frontend can embed images served from this API.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Serve uploaded files (avatars, organization logos, product images, ...)
  const uploadDir = configService.get<string>('UPLOAD_DIR') || './uploads';
  // Hochgeladene Speisekarten (Assistent) liegen im selben Verzeichnis,
  // sind aber nicht oeffentlich: sie gehoeren der Organisation und leben
  // nur bis zur Auswertung. Der Pfad wird vor dem statischen Handler gesperrt.
  app.use(
    '/uploads/menu-imports',
    (_req: unknown, res: { status: (code: number) => { end: () => void } }) => {
      res.status(404).end();
    },
  );
  app.useStaticAssets(join(process.cwd(), uploadDir.replace(/^\.\//, '')), {
    prefix: '/uploads/',
  });

  // Cookie Parser
  app.use(cookieParser());

  // CORS
  const isDev = process.env.NODE_ENV !== 'production';
  const corsOriginsConfig = configService.get<string | string[]>(
    'cors.origins',
  );
  let corsOrigins: string[];
  if (Array.isArray(corsOriginsConfig)) {
    corsOrigins = corsOriginsConfig;
  } else if (typeof corsOriginsConfig === 'string') {
    corsOrigins = corsOriginsConfig.split(',');
  } else {
    corsOrigins = ['http://localhost:3001'];
  }
  app.enableCors({
    // In dev, reflect any request origin (skip allow-list).
    origin: isDev ? true : corsOrigins,
    // PUT: Karte eines Tischbereichs (PUT /table-areas/:areaId/layout).
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Organization-Id',
      'X-Device-Id',
      'X-Device-Token',
      'X-Session-Token',
      'X-Request-Id',
      'Accept-Language',
    ],
  });

  // Global Exception Filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global Interceptors
  app.useGlobalInterceptors(
    // Zuerst registriert, damit es auf dem Rueckweg zuletzt laeuft und die
    // fertige Antwort sieht — siehe response-redaction.util.ts.
    new RedactSecretsInterceptor(),
    new SentryContextInterceptor(),
    new LoggingInterceptor(),
    new TransformInterceptor(),
  );

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      // Field and constraint per error, so clients can show their own text.
      exceptionFactory: validationException,
    }),
  );

  // API Prefix. Der MCP-Server und die Metadaten der geschuetzten
  // Ressource (RFC 9728) liegen bewusst ausserhalb: /mcp und /.well-known.
  const apiPrefix = configService.get<string>('apiPrefix') || 'api';
  app.setGlobalPrefix(apiPrefix, {
    exclude: [MCP_PATH, PROTECTED_RESOURCE_PATH],
  });

  // Swagger UI — nur ausserhalb der Produktion. Die oeffentliche
  // API-Referenz rendert die Doku-Seite (openeos-docs) aus docs/openapi.json,
  // das `pnpm docs:generate` aus derselben Konfiguration erzeugt.
  const nodeEnv = configService.get<string>('nodeEnv');
  if (nodeEnv !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      buildOpenApiConfig(),
      OPENAPI_DOCUMENT_OPTIONS,
    );
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs-json',
      yamlDocumentUrl: 'docs-yaml',
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'none',
        filter: true,
        showRequestDuration: true,
      },
    });

    logger.log(
      `Swagger documentation available at: http://localhost:${configService.get<number>('port') || 3000}/docs`,
    );
  }

  // Start Server
  const port = configService.get<number>('port') || 3000;
  const host = configService.get<string>('host') || '0.0.0.0';
  await app.listen(port, host);

  logger.log(`Application is running on: http://${host}:${port}/${apiPrefix}`);
  logger.log(`Environment: ${nodeEnv}`);
}

// Ein Fehler beim Start bleibt eine unbehandelte Ablehnung und beendet den
// Prozess — genau das ist gewollt, daher nur ausdruecklich `void`.
void bootstrap();
