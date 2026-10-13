import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsController } from './events.controller';
import { EventsShopPublicController } from './events-shop-public.controller';
import { EventsShopCheckoutController } from './events-shop-checkout.controller';
import { EventBillingController } from './event-billing.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { EventsService } from './events.service';
import { EventBillingService } from './event-billing.service';
import { EventUnlockCancellationService } from './event-unlock-cancellation.service';
import { TestOrderCleanupService } from './test-order-cleanup.service';
import { GatewayModule } from '../gateway/gateway.module';
import { SumUpModule } from '../sumup/sumup.module';
import { StripeModule } from '../stripe/stripe.module';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import {
  Event,
  Organization,
  UserOrganization,
  Category,
  Product,
  Order,
  OrderItem,
  Payment,
  ShopCheckout,
  TableArea,
  EventBillingCancellation,
} from '../../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Event,
      Organization,
      UserOrganization,
      Category,
      Product,
      Order,
      OrderItem,
      Payment,
      ShopCheckout,
      TableArea,
      EventBillingCancellation,
    ]),
    forwardRef(() => GatewayModule),
    SumUpModule,
    StripeModule,
    PrintJobsModule,
    OrganizationsModule,
  ],
  controllers: [
    EventsController,
    EventsShopPublicController,
    EventsShopCheckoutController,
    EventBillingController,
    StripeWebhookController,
  ],
  providers: [
    EventsService,
    EventBillingService,
    EventUnlockCancellationService,
    TestOrderCleanupService,
  ],
  exports: [EventsService, EventBillingService, EventUnlockCancellationService],
})
export class EventsModule {}
