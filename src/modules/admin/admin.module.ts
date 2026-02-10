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
import { PricingPublicController } from './pricing-public.controller';
import { AdminService } from './admin.service';
import { StripeModule } from '../stripe/stripe.module';

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
    StripeModule,
  ],
  controllers: [AdminController, PricingPublicController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
