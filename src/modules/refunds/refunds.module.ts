import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Order,
  OrderEvent,
  OrderItem,
  Payment,
  Refund,
  RefundItem,
  UserOrganization,
} from '../../database/entities';
import { GatewayModule } from '../gateway/gateway.module';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';
import { SumUpModule } from '../sumup/sumup.module';
import { OrderHistoryService } from './order-history.service';
import { RefundsService } from './refunds.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      Payment,
      Refund,
      RefundItem,
      OrderEvent,
      UserOrganization,
    ]),
    forwardRef(() => GatewayModule),
    forwardRef(() => PrintJobsModule),
    SumUpModule,
  ],
  providers: [RefundsService, OrderHistoryService],
  exports: [RefundsService, OrderHistoryService],
})
export class RefundsModule {}
