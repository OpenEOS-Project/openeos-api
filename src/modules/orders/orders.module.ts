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
} from '../../database/entities';
import { WorkflowsModule } from '../workflows/workflows.module';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      Product,
      UserOrganization,
      StockMovement,
      Event,
    ]),
    forwardRef(() => WorkflowsModule),
    forwardRef(() => GatewayModule),
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
