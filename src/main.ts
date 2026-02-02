// Sentry must be imported first
import './instrument';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters';
import { TransformInterceptor, LoggingInterceptor, SentryContextInterceptor } from './common/interceptors';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Security Headers
  app.use(helmet());

  // Cookie Parser
  app.use(cookieParser());

  // CORS
  const corsOriginsConfig = configService.get<string | string[]>('cors.origins');
  let corsOrigins: string[];
  if (Array.isArray(corsOriginsConfig)) {
    corsOrigins = corsOriginsConfig;
  } else if (typeof corsOriginsConfig === 'string') {
    corsOrigins = corsOriginsConfig.split(',');
  } else {
    corsOrigins = ['http://localhost:3001'];
  }
  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Organization-Id',
      'X-Device-Id',
      'X-Device-Token',
      'X-Request-Id',
      'Accept-Language',
    ],
  });

  // Global Exception Filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global Interceptors
  app.useGlobalInterceptors(
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
    }),
  );

  // API Prefix
  const apiPrefix = configService.get<string>('apiPrefix') || 'api';
  app.setGlobalPrefix(apiPrefix);

  // Swagger API Documentation
  const nodeEnv = configService.get<string>('nodeEnv');
  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('OpenEOS API')
      .setDescription('Open Event Ordering System - REST API Documentation')
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'JWT',
          description: 'Enter JWT token',
          in: 'header',
        },
        'JWT-auth',
      )
      .addApiKey(
        {
          type: 'apiKey',
          name: 'X-Organization-Id',
          in: 'header',
          description: 'Organization ID for multi-tenant requests',
        },
        'X-Organization-Id',
      )
      .addApiKey(
        {
          type: 'apiKey',
          name: 'X-Session-Token',
          in: 'header',
          description: 'Session token for online orders',
        },
        'X-Session-Token',
      )
      .addTag('Auth', 'Authentication endpoints')
      .addTag('Organizations', 'Organization management')
      .addTag('Events', 'Event management')
      .addTag('Categories', 'Product category management')
      .addTag('Products', 'Product management')
      .addTag('Orders', 'Order management')
      .addTag('Payments', 'Payment processing')
      .addTag('Devices', 'Device management')
      .addTag('Printers', 'Printer management')
      .addTag('Print Templates', 'Print template management')
      .addTag('Print Jobs', 'Print job management')
      .addTag('Workflows', 'Workflow engine')
      .addTag('QR Codes', 'QR code generation and management')
      .addTag('Online Orders', 'Public online ordering endpoints')
      .addTag('Credits', 'Credit management')
      .addTag('Invoices', 'Invoice management')
      .addTag('Rentals', 'Hardware rental management')
      .addTag('Admin', 'Super admin endpoints')
      .addTag('Reports', 'Reporting and analytics')
      .addTag('Uploads', 'File upload management')
      .addTag('Inventory', 'Inventory and stock management')
      .addTag('Health', 'Health check endpoints')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'none',
        filter: true,
        showRequestDuration: true,
      },
    });

    logger.log(`Swagger documentation available at: http://localhost:${configService.get<number>('port') || 3000}/docs`);
  }

  // Start Server
  const port = configService.get<number>('port') || 3000;
  const host = configService.get<string>('host') || '0.0.0.0';
  await app.listen(port, host);

  logger.log(`Application is running on: http://${host}:${port}/${apiPrefix}`);
  logger.log(`Environment: ${nodeEnv}`);
}

bootstrap();
