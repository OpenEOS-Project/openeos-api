import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Order,
  OrderItem,
  Payment,
  Product,
  Category,
  StockMovement,
  PfandReturn,
  UserOrganization,
  Device,
  Printer,
  PrintJob,
} from '../../database/entities';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      Payment,
      Product,
      Category,
      StockMovement,
      PfandReturn,
      UserOrganization,
      Device,
      Printer,
      PrintJob,
    ]),
    // forwardRef: GatewayModule haengt seinerseits an Modulen, die
    // ReportsService nutzen.
    forwardRef(() => GatewayModule),
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
