import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventLifecycleService } from './event-lifecycle.service';
import {
  Event,
  Organization,
  UserOrganization,
  EventLicense,
  Category,
  Product,
  Order,
  OrderItem,
} from '../../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([Event, Organization, UserOrganization, EventLicense, Category, Product, Order, OrderItem]),
  ],
  controllers: [EventsController],
  providers: [EventsService, EventLifecycleService],
  exports: [EventsService],
})
export class EventsModule {}
