import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsController } from './events.controller';
import { EventsShopPublicController } from './events-shop-public.controller';
import { EventsShopCheckoutController } from './events-shop-checkout.controller';
import { EventsService } from './events.service';
import { GatewayModule } from '../gateway/gateway.module';
import { SumUpModule } from '../sumup/sumup.module';
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
  ],
  controllers: [EventsController, EventsShopPublicController, EventsShopCheckoutController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
