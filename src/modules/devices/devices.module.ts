import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevicesController } from './devices.controller';
import { DevicesPublicController } from './devices-public.controller';
import { DeviceApiController } from './device-api.controller';
import { DevicesService } from './devices.service';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import { GatewayModule } from '../gateway/gateway.module';
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
} from '../../database/entities';

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
    ]),
    forwardRef(() => GatewayModule),
  ],
  controllers: [DevicesController, DevicesPublicController, DeviceApiController],
  providers: [DevicesService, DeviceAuthGuard],
  exports: [DevicesService, DeviceAuthGuard],
})
export class DevicesModule {}
