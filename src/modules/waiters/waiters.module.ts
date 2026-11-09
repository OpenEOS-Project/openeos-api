import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AdminAuditLog,
  Device,
  Event,
  Organization,
  UserOrganization,
  Waiter,
} from '../../database/entities';
import { GatewayModule } from '../gateway/gateway.module';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';
import { DeviceWaitersController } from './device-waiters.controller';
import { WaitersController } from './waiters.controller';
import { WaitersService } from './waiters.service';
import { WaiterSettlementsController } from './waiter-settlements.controller';
import { WaiterSettlementsService } from './waiter-settlements.service';
import { WaiterTransferService } from './waiter-transfer.service';

/** Bedienungen verwalten (Verwaltung) und an der Kasse anmelden. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Waiter,
      Organization,
      Event,
      UserOrganization,
      AdminAuditLog,
      // Fuer DeviceAuthGuard (Kassen-Endpunkte).
      Device,
    ]),
    forwardRef(() => GatewayModule),
    PrintJobsModule,
  ],
  controllers: [
    WaitersController,
    WaiterSettlementsController,
    DeviceWaitersController,
  ],
  providers: [WaitersService, WaiterSettlementsService, WaiterTransferService],
  exports: [WaitersService, WaiterSettlementsService],
})
export class WaitersModule {}
