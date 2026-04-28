import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Organization,
  User,
  SubscriptionConfig,
  Invoice,
  RentalHardware,
  RentalAssignment,
  AdminAuditLog,
  Event,
  Order,
  Printer,
  Device,
} from '../../database/entities';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminEventsController } from './admin-events.controller';
import { AdminEventsService } from './admin-events.service';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Organization,
      User,
      SubscriptionConfig,
      Invoice,
      RentalHardware,
      RentalAssignment,
      AdminAuditLog,
      Event,
      Order,
      Printer,
      Device,
    ]),
    forwardRef(() => GatewayModule),
  ],
  controllers: [AdminController, AdminEventsController],
  providers: [AdminService, AdminEventsService],
  exports: [AdminService, AdminEventsService],
})
export class AdminModule {}
