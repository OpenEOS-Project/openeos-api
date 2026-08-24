import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RentalAssignment } from '../../database/entities';
import { SyncOutbox } from '../../database/entities/sync-outbox.entity';
import { SyncInbox } from '../../database/entities/sync-inbox.entity';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { SyncPushService } from './sync-push.service';
import { SyncTokenGuard } from '../../common/guards/sync-token.guard';

/**
 * Offline box sync (docs/design/offline-box-sync.md). One module serves
 * both roles, distinguished at runtime by SYNC_ROLE:
 *   - central (default): exposes POST /sync/push for boxes to call.
 *   - box: also runs SyncPushService's background push loop. Its
 *     counterpart, SyncOutboxSubscriber (writes the outbox rows this
 *     service pushes), lives in src/database/subscribers — TypeORM
 *     subscribers are discovered via the glob in database.config.ts, not
 *     registered here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RentalAssignment, SyncOutbox, SyncInbox]),
  ],
  controllers: [SyncController],
  providers: [SyncService, SyncPushService, SyncTokenGuard],
})
export class SyncModule {}
