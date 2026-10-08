import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PayPalService } from './providers/paypal.service';
import {
  Payment,
  Order,
  OrderItem,
  OrderItemPayment,
  Organization,
  UserOrganization,
} from '../../database/entities';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';
import { RefundsModule } from '../refunds/refunds.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Payment,
      Order,
      OrderItem,
      OrderItemPayment,
      Organization,
      UserOrganization,
    ]),
    PrintJobsModule,
    RefundsModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PayPalService],
  exports: [PaymentsService, PayPalService],
})
export class PaymentsModule {}
