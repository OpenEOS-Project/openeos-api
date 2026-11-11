import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Device,
  TokenTransaction,
  TokenType,
  UserOrganization,
} from '../../database/entities';
import { DevicesModule } from '../devices/devices.module';
import { GatewayModule } from '../gateway/gateway.module';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';
import { TseModule } from '../tse/tse.module';
import { DeviceTokensController } from './device-tokens.controller';
import { TokenTransactionsService } from './token-transactions.service';
import { TokenTypesController } from './token-types.controller';
import { TokenTypesService } from './token-types.service';

/**
 * Wertmarken: Markentypen, Verkauf und Ruecktausch an der Kasse,
 * Auswertung. Die Einloesung als Zahlung steckt in der Sammelzahlung
 * (payments-batch.service.ts), die Abbildung in TSE und DSFinV-K im
 * TSE- bzw. DSFinV-K-Modul.
 */
@Module({
  imports: [
    // Device: fuer den DeviceAuthGuard der Geraete-Endpunkte.
    TypeOrmModule.forFeature([
      TokenType,
      TokenTransaction,
      UserOrganization,
      Device,
    ]),
    forwardRef(() => GatewayModule),
    forwardRef(() => PrintJobsModule),
    DevicesModule,
    TseModule,
  ],
  controllers: [TokenTypesController, DeviceTokensController],
  providers: [TokenTypesService, TokenTransactionsService],
  exports: [TokenTypesService, TokenTransactionsService],
})
export class TokensModule {}
