import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Organization,
  User,
  CreditPurchase,
  CreditPackage,
  SubscriptionConfig,
  Invoice,
  RentalHardware,
  RentalAssignment,
  AdminAuditLog,
  Event,
  Order,
} from '../../database/entities';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Organization,
      User,
      CreditPurchase,
      CreditPackage,
      SubscriptionConfig,
      Invoice,
      RentalHardware,
      RentalAssignment,
      AdminAuditLog,
      Event,
      Order,
    ]),
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
