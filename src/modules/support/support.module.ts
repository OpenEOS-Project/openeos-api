import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Device,
  Event,
  Organization,
  SupportMessage,
  User,
  UserOrganization,
} from '../../database/entities';
import { SupportController } from './support.controller';
import { SupportAdminController } from './support-admin.controller';
import { SupportService } from './support.service';
import { EmergencySupportService } from './emergency-support.service';
import { DeviceEmergencySupportController } from './device-emergency-support.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SupportMessage,
      Organization,
      // Fuer DeviceAuthGuard (Notfall-Support an der Kasse).
      Device,
      UserOrganization,
      Event,
      User,
    ]),
  ],
  controllers: [
    SupportController,
    SupportAdminController,
    DeviceEmergencySupportController,
  ],
  providers: [SupportService, EmergencySupportService],
  exports: [SupportService, EmergencySupportService],
})
export class SupportModule {}
