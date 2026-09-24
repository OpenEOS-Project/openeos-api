import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Device, Event, Order, Organization, User } from '../../database/entities';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Organization, User, Event, Device, Order])],
  controllers: [MonitoringController],
  providers: [MonitoringService],
})
export class MonitoringModule {}
