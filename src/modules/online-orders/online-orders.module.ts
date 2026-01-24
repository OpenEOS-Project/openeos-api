import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  OnlineOrderSession,
  QrCode,
  Product,
  Category,
  Order,
  OrderItem,
} from '../../database/entities';
import { OnlineOrdersController } from './online-orders.controller';
import { OnlineOrdersService } from './online-orders.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OnlineOrderSession,
      QrCode,
      Product,
      Category,
      Order,
      OrderItem,
    ]),
  ],
  controllers: [OnlineOrdersController],
  providers: [OnlineOrdersService],
  exports: [OnlineOrdersService],
})
export class OnlineOrdersModule {}
