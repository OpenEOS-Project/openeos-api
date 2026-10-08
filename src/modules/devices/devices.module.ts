import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevicesController } from './devices.controller';
import { DevicesPublicController } from './devices-public.controller';
import { DevicesLinkController } from './devices-link.controller';
import { DeviceApiController } from './device-api.controller';
import { DeviceTablesController } from './device-tables.controller';
import { DevicesService } from './devices.service';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import { GatewayModule } from '../gateway/gateway.module';
import { PrintersModule } from '../printers/printers.module';
import { SumUpModule } from '../sumup/sumup.module';
import {
  Device,
  UserOrganization,
  Organization,
  Event,
  Category,
  Product,
  Order,
  OrderItem,
  Payment,
  PrintTemplate,
  Printer,
  StockMovement,
  ProductionStation,
} from '../../database/entities';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';
import { OrdersModule } from '../orders/orders.module';
import { DiscountVouchersModule } from '../discount-vouchers';
import { PfandTypesModule } from '../pfand-types';
import { TablesModule } from '../tables/tables.module';
import { PaymentsBatchService } from '../payments/payments-batch.service';
import { RefundsModule } from '../refunds/refunds.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Device,
      UserOrganization,
      Organization,
      Event,
      Category,
      Product,
      Order,
      OrderItem,
      Payment,
      PrintTemplate,
      Printer,
      StockMovement,
      ProductionStation,
    ]),
    forwardRef(() => GatewayModule),
    forwardRef(() => PrintersModule),
    forwardRef(() => PrintJobsModule),
    forwardRef(() => OrdersModule),
    SumUpModule,
    DiscountVouchersModule,
    PfandTypesModule,
    TablesModule,
    RefundsModule,
  ],
  controllers: [
    DevicesController,
    DevicesPublicController,
    DevicesLinkController,
    DeviceApiController,
    DeviceTablesController,
  ],
  // PaymentsBatchService liegt bei den Zahlungen, wird aber nur von der
  // Geraete-API genutzt (PaymentsModule bleibt so unberuehrt, api #12).
  providers: [DevicesService, DeviceAuthGuard, PaymentsBatchService],
  exports: [DevicesService, DeviceAuthGuard],
})
export class DevicesModule {}
