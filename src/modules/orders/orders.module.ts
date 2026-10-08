import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import {
  Order,
  OrderItem,
  Product,
  UserOrganization,
  StockMovement,
  Event,
  ProductionStation,
  Organization,
} from '../../database/entities';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';
import { GatewayModule } from '../gateway/gateway.module';
import { RefundsModule } from '../refunds/refunds.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      Product,
      UserOrganization,
      StockMovement,
      Event,
      ProductionStation,
      Organization,
    ]),
    PrintJobsModule,
    forwardRef(() => GatewayModule),
    RefundsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
