import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsController } from './events.controller';
import { EventsShopPublicController } from './events-shop-public.controller';
import { EventsShopCheckoutController } from './events-shop-checkout.controller';
import { EventBillingController } from './event-billing.controller';
import { EventsService } from './events.service';
import { EventBillingService } from './event-billing.service';
import { GatewayModule } from '../gateway/gateway.module';
import { SumUpModule } from '../sumup/sumup.module';
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
    ]),
    forwardRef(() => GatewayModule),
    SumUpModule,
    PrintJobsModule,
    OrganizationsModule,
  ],
  controllers: [
    EventsController,
    EventsShopPublicController,
    EventsShopCheckoutController,
    EventBillingController,
  ],
  providers: [EventsService, EventBillingService],
  exports: [EventsService, EventBillingService],
})
export class EventsModule {}
