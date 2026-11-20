import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrintJobsController } from './print-jobs.controller';
import { PrintJobsService } from './print-jobs.service';
import { OrderPrintService } from './order-print.service';
import { PrintRoutingService } from './print-routing.service';
import { PrintHealthService } from './print-health.service';
import { PrintJobRedeliveryService } from './print-job-redelivery.service';
import {
  PrintJob,
  Printer,
  PrintTemplate,
  UserOrganization,
  Organization,
  OrderItem,
  ProductionStation,
  Device,
  Event,
} from '../../database/entities';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PrintJob,
      Printer,
      PrintTemplate,
      UserOrganization,
      Organization,
      OrderItem,
      ProductionStation,
      Device,
      Event,
    ]),
    forwardRef(() => GatewayModule),
  ],
  controllers: [PrintJobsController],
  providers: [
    PrintJobsService,
    OrderPrintService,
    PrintRoutingService,
    PrintHealthService,
    PrintJobRedeliveryService,
  ],
  exports: [
    PrintJobsService,
    OrderPrintService,
    PrintRoutingService,
    PrintHealthService,
  ],
})
export class PrintJobsModule {}
