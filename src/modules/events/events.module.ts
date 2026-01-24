import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import {
  Event,
  Organization,
  UserOrganization,
  EventLicense,
  Category,
  Product,
} from '../../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([Event, Organization, UserOrganization, EventLicense, Category, Product]),
  ],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
