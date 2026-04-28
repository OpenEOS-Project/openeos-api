import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevicesController } from './devices.controller';
import { DevicesPublicController } from './devices-public.controller';
import { DevicesLinkController } from './devices-link.controller';
import { DeviceApiController } from './device-api.controller';
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
  ],
  controllers: [DevicesController, DevicesPublicController, DevicesLinkController, DeviceApiController],
  providers: [DevicesService, DeviceAuthGuard],
  exports: [DevicesService, DeviceAuthGuard],
})
export class DevicesModule {}
