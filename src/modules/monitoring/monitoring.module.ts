import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  ContactRequest,
  Device,
  Event,
  Order,
  Organization,
  SupportMessage,
  User,
} from '../../database/entities';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Organization,
      User,
      Event,
      Device,
      Order,
      ContactRequest,
      SupportMessage,
    ]),
  ],
  controllers: [MonitoringController],
  providers: [MonitoringService],
})
export class MonitoringModule {}
