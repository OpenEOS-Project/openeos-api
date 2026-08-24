import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { SyncOutbox } from '../../database/entities/sync-outbox.entity';

const PUSH_INTERVAL_MS = 15_000;
const BATCH_SIZE = 200;

/**
 * Box-side push loop for offline box sync (docs/design/offline-box-sync.md
 * §5). Only does anything when SYNC_ROLE=box — on a normal (central)
 * deployment every tick is a one-line no-op.
 *
 * No schedule assumption: this ticks constantly and simply finds nothing
 * to push when there's no connectivity, so it behaves identically whether
 * central is reachable mid-event over a phone hotspot or only once the box
 * is physically back on the office network.
 */
@Injectable()
export class SyncPushService {
  private readonly logger = new Logger(SyncPushService.name);
  private pushing = false;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(SyncOutbox)
    private readonly outboxRepository: Repository<SyncOutbox>,
  ) {}

  @Interval('sync-push', PUSH_INTERVAL_MS)
  async handlePush(): Promise<void> {
    if (this.configService.get<string>('sync.role') !== 'box') return;
    if (this.pushing) return; // previous tick's batch is still in flight

    this.pushing = true;
    try {
      await this.pushPendingBatch();
    } catch (error) {
      this.logger.warn(
        `Sync push failed, will retry next tick: ${(error as Error).message}`,
      );
    } finally {
      this.pushing = false;
    }
  }

  private async pushPendingBatch(): Promise<void> {
    const batch = await this.outboxRepository.find({
      where: { pushedAt: IsNull() },
      order: { syncVersion: 'ASC' },
      take: BATCH_SIZE,
    });
    if (batch.length === 0) return;

    const centralUrl = this.configService.get<string>('sync.centralUrl');
    const token = this.configService.get<string>('sync.token');
    if (!centralUrl || !token) {
      this.logger.warn(
        'SYNC_CENTRAL_URL/SYNC_TOKEN not set — cannot push pending outbox rows',
      );
      return;
    }

    const response = await fetch(`${centralUrl.replace(/\/$/, '')}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        rows: batch.map((row) => ({
          entityType: row.entityType,
          entityId: row.entityId,
          syncVersion: row.syncVersion,
          payload: row.payload,
        })),
      }),
    });

    if (!response.ok) {
      this.logger.warn(
        `Sync push rejected: ${response.status} ${await response.text()}`,
      );
      return;
    }

    const pushedAt = new Date();
    await this.outboxRepository.update(
      batch.map((row) => row.id),
      { pushedAt },
    );
    this.logger.log(`Pushed ${batch.length} outbox row(s) to central`);
  }
}
