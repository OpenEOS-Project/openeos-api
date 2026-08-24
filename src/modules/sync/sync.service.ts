import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryDeepPartialEntity } from 'typeorm';
import { RentalAssignment } from '../../database/entities';
import { SyncInbox } from '../../database/entities/sync-inbox.entity';
import { SyncPushDto } from './dto';

export interface SyncPushResult {
  received: number;
  inserted: number;
  duplicates: number;
}

/**
 * Central-side ingest for offline box sync (docs/design/offline-box-sync.md §5).
 *
 * Deliberately writes to sync_inbox (a staging table) rather than the live
 * orders/order_items/payments/print_jobs tables. Materializing into those
 * tables needs Device rows to be resolvable first — an Order's
 * createdByDeviceId points at a device that self-registered against the
 * box's local api and was never synced to central, so a naive insert would
 * violate that foreign key on the very first real order. That's real
 * follow-up work (see the design doc's Open Questions), not something to
 * paper over here with an untested generic upsert.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(SyncInbox)
    private readonly syncInboxRepository: Repository<SyncInbox>,
  ) {}

  async ingest(
    assignment: RentalAssignment,
    dto: SyncPushDto,
  ): Promise<SyncPushResult> {
    if (dto.rows.length === 0) {
      return { received: 0, inserted: 0, duplicates: 0 };
    }

    const receivedAt = new Date();

    // ON CONFLICT DO NOTHING against the (entity_type, entity_id,
    // sync_version) unique constraint: a retried batch after a dropped
    // connection is a no-op, not a double-insert (design doc §5/§6).
    const result = await this.syncInboxRepository
      .createQueryBuilder()
      .insert()
      .into(SyncInbox)
      .values(
        // TypeORM's QueryDeepPartialEntity tries to deep-partial the jsonb
        // `payload` column as if it were a nested entity graph rather than
        // opaque JSON — cast past that, the payload is intentionally
        // arbitrary (a full snapshot of whatever the box wrote).
        dto.rows.map((row) => ({
          assignmentId: assignment.id,
          entityType: row.entityType,
          entityId: row.entityId,
          syncVersion: row.syncVersion,
          payload: row.payload,
          receivedAt,
        })) as QueryDeepPartialEntity<SyncInbox>[],
      )
      .orIgnore()
      .execute();

    // Postgres RETURNING with ON CONFLICT DO NOTHING only yields rows that
    // were actually inserted, so identifiers.length is already the true
    // inserted count — not necessarily aligned positionally with dto.rows.
    const inserted = result.identifiers.length;
    const duplicates = dto.rows.length - inserted;

    this.logger.log(
      `Sync push from assignment ${assignment.id}: ${dto.rows.length} rows received, ${inserted} inserted, ${duplicates} duplicate(s) ignored`,
    );

    return { received: dto.rows.length, inserted, duplicates };
  }
}
