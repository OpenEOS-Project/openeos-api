import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import {
  Event,
  Organization,
  UserOrganization,
  Category,
  Product,
  Order,
  OrderItem,
} from '../../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([Event, Organization, UserOrganization, Category, Product, Order, OrderItem]),
  ],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
