import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Order,
  OrderEvent,
  Organization,
  Payment,
  PrintTemplate,
  ReceiptLink,
  HospitalityReceipt,
  Device,
} from '../../database/entities';
import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import { EmailModule } from '../email/email.module';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';
import { TseModule } from '../tse/tse.module';
import { ReceiptsDeviceController } from './receipts-device.controller';
import { ReceiptsPublicController } from './receipts-public.controller';
import { ReceiptsService } from './receipts.service';
import { HospitalityReceiptsService } from './hospitality-receipts.service';
import { HospitalityDeviceController } from './hospitality-device.controller';

/** Digitaler Beleg: QR-Code, E-Mail, PDF, oeffentliche Seite. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReceiptLink,
      HospitalityReceipt,
      Order,
      OrderEvent,
      Organization,
      Payment,
      PrintTemplate,
      Device,
    ]),
    forwardRef(() => PrintJobsModule),
    EmailModule,
    TseModule,
  ],
  controllers: [
    ReceiptsDeviceController,
    ReceiptsPublicController,
    HospitalityDeviceController,
  ],
  providers: [ReceiptsService, HospitalityReceiptsService, DeviceAuthGuard],
  exports: [ReceiptsService, HospitalityReceiptsService],
})
export class ReceiptsModule {}
