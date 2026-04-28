import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  OnlineOrderSession,
  QrCode,
  Product,
  Category,
  Order,
  OrderItem,
  Organization,
  Payment,
} from '../../database/entities';
import { Event } from '../../database/entities/event.entity';
import { OnlineOrdersController } from './online-orders.controller';
import { OnlineOrdersService } from './online-orders.service';
import { PaymentsModule } from '../payments/payments.module';
import { SumUpModule } from '../sumup/sumup.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OnlineOrderSession,
      QrCode,
      Product,
      Category,
      Order,
      OrderItem,
      Organization,
      Payment,
      Event,
    ]),
    PaymentsModule,
    SumUpModule,
  ],
  controllers: [OnlineOrdersController],
  providers: [OnlineOrdersService],
  exports: [OnlineOrdersService],
})
export class OnlineOrdersModule {}
