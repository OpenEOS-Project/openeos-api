import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Device,
  Event,
  PinCredential,
  UserOrganization,
  Waiter,
  WaiterSession,
} from '../../database/entities';
import { PinCredentialsService } from './pin-credentials.service';
import { PinLockoutService } from './pin-lockout.service';
import { WaiterSessionGuard } from './waiter-session.guard';
import { WaiterSessionsService } from './waiter-sessions.service';

/**
 * PIN-Raum, Sperre nach Fehlversuchen und Bedienungs-Sitzungen. Global,
 * damit der WaiterSessionGuard an jedem Geraete-Controller (Kasse,
 * Tische, Kassenbuch) ohne weitere Importe funktioniert.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Waiter,
      PinCredential,
      WaiterSession,
      UserOrganization,
      Device,
      Event,
    ]),
  ],
  providers: [
    PinCredentialsService,
    PinLockoutService,
    WaiterSessionsService,
    WaiterSessionGuard,
  ],
  exports: [
    PinCredentialsService,
    PinLockoutService,
    WaiterSessionsService,
    WaiterSessionGuard,
  ],
})
export class WaiterCoreModule {}
