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
import { DeviceWaitersController } from './device-waiters.controller';
import { WaitersController } from './waiters.controller';
import { WaitersService } from './waiters.service';

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
  ],
  controllers: [WaitersController, DeviceWaitersController],
  providers: [WaitersService],
  exports: [WaitersService],
})
export class WaitersModule {}
