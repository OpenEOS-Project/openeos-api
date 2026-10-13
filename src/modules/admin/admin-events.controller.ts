import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AdminEventsService } from './admin-events.service';
import {
  QueryAdminEventsDto,
  MarkInvoicedDto,
  PlatformCancelBillingDto,
} from './dto/admin-events.dto';
import { SuperAdminGuard } from '../../common/guards/super-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '../../database/entities';
import { SaasOnly } from '../../common/decorators/saas-only.decorator';
import {
  EventUnlockCancellationService,
  toCancellationSummary,
} from '../events/event-unlock-cancellation.service';

@ApiTags('Admin')
@ApiBearerAuth('JWT-auth')
@SaasOnly()
@Controller('admin/events')
@UseGuards(SuperAdminGuard)
export class AdminEventsController {
  constructor(
    private readonly adminEventsService: AdminEventsService,
    private readonly cancellationService: EventUnlockCancellationService,
  ) {}

  @Get()
  async findAll(@Query() queryDto: QueryAdminEventsDto) {
    const result = await this.adminEventsService.findAllEvents(queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: Math.ceil(result.total / result.limit),
        hasNext: result.page < Math.ceil(result.total / result.limit),
        hasPrev: result.page > 1,
      },
    };
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const event = await this.adminEventsService.getEvent(id);
    return { data: event };
  }

  @Patch(':id/invoice')
  async markInvoiced(
    @Param('id') id: string,
    @Body() dto: MarkInvoicedDto,
    @CurrentUser() user: User,
  ) {
    const event = await this.adminEventsService.markInvoiced(id, user.id, dto);
    return { data: event };
  }

  @Delete(':id/invoice')
  async unmarkInvoiced(@Param('id') id: string) {
    const event = await this.adminEventsService.unmarkInvoiced(id);
    return { data: event };
  }

  /**
   * Was ein Storno bzw. eine Kulanzerstattung gerade bewirken wuerde:
   * Betrag, schon Erstattetes, echte Bestellungen, Frist.
   */
  @Get(':id/cancel-billing')
  async cancelBillingPreview(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.cancellationService.platformPreview(id) };
  }

  /**
   * Freischaltung stornieren oder per Kulanz (teil-)erstatten — ohne Frist
   * und auch bei echten Bestellungen; Grund ist Pflicht. Mit Bestellungen
   * oder bei einem Teilbetrag bleibt die Freischaltung bestehen (siehe
   * EventUnlockCancellationService.cancelForPlatform).
   */
  @Post(':id/cancel-billing')
  async cancelBilling(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlatformCancelBillingDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    const cancellation = await this.cancellationService.cancelForPlatform(
      id,
      user,
      {
        reason: dto.reason,
        amount: dto.amount ?? null,
        audit: {
          userId: user.id,
          ipAddress:
            (req as { ip?: string }).ip ||
            req.socket?.remoteAddress ||
            '0.0.0.0',
          userAgent: req.headers['user-agent'] ?? null,
        },
      },
    );
    return { data: toCancellationSummary(cancellation) };
  }

  @Post(':id/waive')
  async waive(@Param('id') id: string) {
    const event = await this.adminEventsService.waive(id);
    return { data: event };
  }
}
