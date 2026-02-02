import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CacheModule } from '@nestjs/cache-manager';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { redisStore } from 'cache-manager-redis-yet';
import { SentryModule, SentryGlobalFilter } from '@sentry/nestjs/setup';

import {
  configuration,
  databaseConfig,
  redisConfig,
  jwtConfig,
  validationSchema,
} from './config';
import { JwtAuthGuard } from './common/guards';
import { AuthModule } from './modules/auth';
import { UsersModule } from './modules/users';
import { StripeModule } from './modules/stripe';
import { OrganizationsModule } from './modules/organizations';
import { EventsModule } from './modules/events';
import { CategoriesModule } from './modules/categories';
import { ProductsModule } from './modules/products';
import { OrdersModule } from './modules/orders';
import { PaymentsModule } from './modules/payments';
import { DevicesModule } from './modules/devices';
import { PrintersModule } from './modules/printers';
import { PrintTemplatesModule } from './modules/print-templates';
import { PrintJobsModule } from './modules/print-jobs';
import { GatewayModule } from './modules/gateway';
import { WorkflowsModule } from './modules/workflows';
import { QrCodesModule } from './modules/qr-codes';
import { OnlineOrdersModule } from './modules/online-orders';
import { CreditsModule } from './modules/credits';
import { InvoicesModule } from './modules/invoices';
import { RentalsModule } from './modules/rentals';
import { AdminModule } from './modules/admin';
import { ReportsModule } from './modules/reports';
import { UploadsModule } from './modules/uploads';
import { InventoryModule } from './modules/inventory';
import { HealthModule } from './modules/health';
import { SetupModule } from './modules/setup';
import { EmailModule } from './modules/email';
import { ShiftsModule } from './modules/shifts';

@Module({
  imports: [
    // Sentry Error Tracking (must be first)
    SentryModule.forRoot(),

    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration, databaseConfig, redisConfig, jwtConfig],
      validationSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),

    // Database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('database.host'),
        port: configService.get<number>('database.port'),
        username: configService.get<string>('database.username'),
        password: configService.get<string>('database.password'),
        database: configService.get<string>('database.database'),
        entities: [__dirname + '/database/entities/*.entity{.ts,.js}'],
        migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
        synchronize: configService.get<boolean>('database.synchronize'),
        logging: configService.get<boolean>('database.logging'),
        migrationsRun: configService.get<boolean>('database.migrationsRun'),
        poolSize: 10,
      }),
      inject: [ConfigService],
    }),

    // Redis Cache
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        store: await redisStore({
          socket: {
            host: configService.get<string>('redis.host'),
            port: configService.get<number>('redis.port'),
          },
        }),
        ttl: 60 * 1000, // 1 minute default TTL
      }),
      inject: [ConfigService],
    }),

    // Rate Limiting
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => [
        {
          ttl: configService.get<number>('throttle.ttl') || 60000,
          limit: configService.get<number>('throttle.limit') || 300,
        },
      ],
      inject: [ConfigService],
    }),

    // Scheduling (Cron Jobs)
    ScheduleModule.forRoot(),

    // Feature Modules
    AuthModule,
    UsersModule,
    StripeModule,
    OrganizationsModule,
    EventsModule,
    CategoriesModule,
    ProductsModule,
    OrdersModule,
    PaymentsModule,
    DevicesModule,
    PrintersModule,
    PrintTemplatesModule,
    PrintJobsModule,
    GatewayModule,
    WorkflowsModule,
    QrCodesModule,
    OnlineOrdersModule,
    CreditsModule,
    InvoicesModule,
    RentalsModule,
    AdminModule,
    ReportsModule,
    UploadsModule,
    InventoryModule,
    HealthModule,
    SetupModule,
    EmailModule,
    ShiftsModule,
  ],
  controllers: [],
  providers: [
    // Global Sentry Exception Filter (must be first to catch all errors)
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
    // Global JWT Auth Guard
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Global Rate Limiting Guard
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
