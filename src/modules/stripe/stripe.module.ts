import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StripeController } from './stripe.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeService } from './stripe.service';
import {
  Organization,
  CreditPackage,
  CreditPurchase,
  SubscriptionConfig,
} from '../../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Organization,
      CreditPackage,
      CreditPurchase,
      SubscriptionConfig,
    ]),
  ],
  controllers: [StripeController, StripeWebhookController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
