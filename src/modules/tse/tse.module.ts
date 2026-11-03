import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  Event,
  Order,
  Organization,
  Payment,
  TseExport,
  TseOutage,
  TseTransaction,
  TseUnit,
  UserOrganization,
} from '../../database/entities';
import { SwissbitClientProvider } from './swissbit/swissbit-client.provider';
import { TseAdminController } from './tse-admin.controller';
import { TseAutoActivationService } from './tse-auto-activation.service';
import { TseConfig } from './tse.config';
import { TseController } from './tse.controller';
import { TseCryptoService } from './tse-crypto.service';
import { TseExportService } from './tse-export.service';
import { TseNotifyService } from './tse-notify.service';
import { TseOutageService } from './tse-outage.service';
import { TseReconcileService } from './tse-reconcile.service';
import { TseSigningService } from './tse-signing.service';
import { TseStatusService } from './tse-status.service';
import { TseUnitCache } from './tse-unit-cache.service';
import { TseUnitService } from './tse-unit.service';

/**
 * Cloud-TSE (Swissbit), tse-swissbit-plan.md §8. Importiert bewusst keine
 * Fachmodule (Geraete, Zahlungen, Gateway …): die importieren dieses Modul
 * fuer `TseSigningService`/`TseStatusService`. Das Gateway wird zur
 * Laufzeit geholt (TseNotifyService).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TseUnit,
      TseTransaction,
      TseOutage,
      TseExport,
      Organization,
      UserOrganization,
      Event,
      Order,
      Payment,
    ]),
  ],
  controllers: [TseController, TseAdminController],
  providers: [
    TseConfig,
    SwissbitClientProvider,
    TseCryptoService,
    TseUnitCache,
    TseNotifyService,
    TseOutageService,
    TseSigningService,
    TseUnitService,
    TseExportService,
    TseReconcileService,
    TseStatusService,
    TseAutoActivationService,
  ],
  exports: [
    TseSigningService,
    TseStatusService,
    TseUnitService,
    TseConfig,
    TseAutoActivationService,
  ],
})
export class TseModule {}
