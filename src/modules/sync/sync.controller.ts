import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { SyncTokenGuard } from '../../common/guards/sync-token.guard';
import { CurrentRentalAssignment } from '../../common/decorators';
import { Public } from '../../common/decorators/public.decorator';
import { RentalAssignment } from '../../database/entities';
import { SyncService, SyncPushResult } from './sync.service';
import { SyncPushDto } from './dto';

/**
 * Central-side endpoints for offline box sync
 * (docs/design/offline-box-sync.md §5). Called by a box's SyncPushService,
 * never by a browser/dashboard client.
 */
@ApiTags('Sync')
@ApiHeader({
  name: 'Authorization',
  description: 'Bearer <rental assignment sync token>',
  required: true,
})
@Controller('sync')
@Public() // authenticated via SyncTokenGuard instead of the global JWT guard
@UseGuards(SyncTokenGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('push')
  @ApiOperation({
    summary: 'Push a batch of outbox rows from a box to central (idempotent)',
  })
  async push(
    @CurrentRentalAssignment() assignment: RentalAssignment,
    @Body() dto: SyncPushDto,
  ): Promise<SyncPushResult> {
    return this.syncService.ingest(assignment, dto);
  }
}
