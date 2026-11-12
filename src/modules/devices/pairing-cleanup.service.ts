import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CronLockService } from '../../common/redis/cron-lock.service';
import { DevicesService } from './devices.service';

/**
 * Raeumt stuendlich wartende Geraete auf, deren Kopplungscode laengst
 * abgelaufen ist und die sich nicht neu angemeldet haben (Seite
 * geschlossen, Agent gestoppt). Laeuft auf einer Instanz zur Zeit.
 */
@Injectable()
export class PairingCleanupService {
  private readonly logger = new Logger(PairingCleanupService.name);

  constructor(
    private readonly devices: DevicesService,
    private readonly cronLock: CronLockService,
  ) {}

  @Cron('17 * * * *', { name: 'pending-device-cleanup' })
  async cleanup(): Promise<void> {
    try {
      await this.cronLock.runExclusive('pending-device-cleanup', async () => {
        await this.devices.removeStalePendingDevices();
      });
    } catch (error) {
      this.logger.warn(
        `Pending device cleanup failed: ${(error as Error).message}`,
      );
    }
  }
}
