import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeviceAuthGuard } from '../../common/guards/device-auth.guard';
import {
  CashbookEntry,
  CashPointClosing,
  Device,
  Organization,
} from '../../database/entities';
import { TseModule } from '../tse/tse.module';
import { CashbookService } from './cashbook.service';
import { CashPointClosingService } from './cash-point-closing.service';
import { DeviceCashbookController } from './device-cashbook.controller';
import { DsfinvkController } from './dsfinvk.controller';

/**
 * DSFinV-K (Kassenabschluss, Export, eigene Prüfung) und Kassenbuch,
 * openeos-api#102. Siehe README.md in diesem Ordner.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CashPointClosing,
      CashbookEntry,
      Organization,
      Device,
    ]),
    TseModule,
  ],
  controllers: [DsfinvkController, DeviceCashbookController],
  providers: [CashPointClosingService, CashbookService, DeviceAuthGuard],
  exports: [CashPointClosingService, CashbookService],
})
export class DsfinvkModule {}
