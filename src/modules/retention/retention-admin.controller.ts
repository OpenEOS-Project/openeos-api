import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SuperAdminGuard } from '../../common/guards/super-admin.guard';
import type { User } from '../../database/entities';
import {
  EraseRecordDto,
  ListRetentionNoticesQueryDto,
  ListRetentionRunsQueryDto,
  StartRetentionRunDto,
} from './dto';
import { RetentionErasureService } from './retention-erasure.service';
import { RetentionService } from './retention.service';

/**
 * Aufbewahrung und Loeschung (README „Aufbewahrung und Löschung“): Protokoll
 * der Loeschlaeufe, Ankuendigungen, Lauf von Hand und Einzelloeschung auf
 * Weisung des Kunden.
 */
@ApiTags('Admin — Aufbewahrung und Löschung')
@ApiBearerAuth('JWT-auth')
@Controller('admin/retention')
@UseGuards(SuperAdminGuard)
export class RetentionAdminController {
  constructor(
    private readonly retention: RetentionService,
    private readonly erasure: RetentionErasureService,
  ) {}

  @Get('config')
  @ApiOperation({ summary: 'Effective retention periods and run mode' })
  config() {
    return {
      data: {
        ...this.retention.config,
        activeCategories: this.retention.activeCategories(),
      },
    };
  }

  @Get('runs')
  @ApiOperation({ summary: 'Protocol of deletion runs, newest first' })
  async runs(@Query() query: ListRetentionRunsQueryDto) {
    const { items, total } = await this.retention.listRuns(query);
    return { data: items, meta: { total } };
  }

  @Post('runs')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Run the deletion jobs now (dry run unless dryRun=false or RETENTION_DRY_RUN=false)',
  })
  async start(@Body() dto: StartRetentionRunDto) {
    const runs = await this.retention.runAll(
      { trigger: 'manual', dryRun: dto.dryRun },
      dto.categories?.length
        ? dto.categories
        : this.retention.activeCategories(),
    );
    return { data: runs };
  }

  @Get('notices')
  @ApiOperation({
    summary: 'Announced closures and deletions of organizations and accounts',
  })
  async notices(@Query() query: ListRetentionNoticesQueryDto) {
    return {
      data: await this.retention.listNotices({
        open: query.open === undefined ? undefined : query.open === 'true',
        subjectType: query.subjectType,
      }),
    };
  }

  @Post('organizations/:organizationId/keep')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cancel an announced closure for inactivity (counts as activity, period restarts)',
  })
  async keepOrganization(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return {
      data: await this.retention.keep('organization', organizationId),
    };
  }

  @Post('users/:userId/keep')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cancel an announced account deletion for inactivity (period restarts)',
  })
  async keepUser(@Param('userId', ParseUUIDPipe) userId: string) {
    return { data: await this.retention.keep('user', userId) };
  }

  @Post('organizations/:organizationId/erasures')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Erase a specific guest or helper record on the customer’s instruction (logged with reason and executing admin)',
  })
  async erase(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: EraseRecordDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.erasure.erase({
        organizationId,
        kind: dto.kind,
        id: dto.id,
        email: dto.email,
        reason: dto.reason,
        dryRun: dto.dryRun,
        executedByUserId: user.id,
      }),
    };
  }
}
