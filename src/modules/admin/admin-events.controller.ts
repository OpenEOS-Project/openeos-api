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
  Res,
  StreamableFile,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody } from '@nestjs/swagger';
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
import { StripeInvoiceService } from '../events/stripe-invoice.service';
import { EventBillingService } from '../events/event-billing.service';
import {
  MoveEventDatesDto,
  WaiveEventDto,
} from '../events/dto/event-billing.dto';
import {
  BillingAuditService,
  type AuditActor,
} from '../events/billing-audit.service';
import { EventsService } from '../events/events.service';
import {
  EventPhaseFields,
  EventPhaseService,
} from '../events/event-phase.service';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';

function actorOf(user: User, req: Request): AuditActor {
  return {
    userId: user.id,
    ipAddress:
      (req as { ip?: string }).ip || req.socket?.remoteAddress || '0.0.0.0',
    userAgent: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin')
@ApiBearerAuth('JWT-auth')
@SaasOnly()
@Controller('admin/events')
@UseGuards(SuperAdminGuard)
export class AdminEventsController {
  constructor(
    private readonly adminEventsService: AdminEventsService,
    private readonly cancellationService: EventUnlockCancellationService,
    private readonly invoiceService: StripeInvoiceService,
    private readonly eventBillingService: EventBillingService,
    private readonly eventsService: EventsService,
    private readonly billingAudit: BillingAuditService,
    private readonly eventPhase: EventPhaseService,
  ) {}

  /** Phase (Geplant/Aktiv/Beendet) zu jeder Zeile der Liste. */
  private async withPhases<T extends { id: string }>(
    items: T[],
  ): Promise<(T & Partial<EventPhaseFields>)[]> {
    const phases = await this.eventPhase.phaseFieldsByIds(
      items.map((item) => item.id),
      this.adminEventsService.events,
    );
    return items.map((item) => ({ ...item, ...(phases.get(item.id) ?? {}) }));
  }

  @Get()
  async findAll(@Query() queryDto: QueryAdminEventsDto) {
    const result = await this.adminEventsService.findAllEvents(queryDto);
    return {
      data: await this.withPhases(result.data),
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
    return { data: (await this.withPhases([event]))[0] };
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

  /** Auf Rechnung ueber Stripe: Stripes Rechnungsmail erneut verschicken. */
  @Post(':id/invoice/resend')
  async resendInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    const event = await this.invoiceService.resend(id, actorOf(user, req));
    return { data: await this.adminEventsService.getEvent(event.id) };
  }

  /**
   * Auf Rechnung ueber Stripe: als ausserhalb von Stripe bezahlt verbuchen
   * (Ueberweisung auf das eigene Konto). Stripe setzt die Rechnung auf
   * bezahlt.
   */
  @Post(':id/invoice/mark-paid')
  async markInvoicePaid(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    const event = await this.invoiceService.markPaid(id, actorOf(user, req));
    return { data: await this.adminEventsService.getEvent(event.id) };
  }

  /** Auf Rechnung ueber Stripe: das Rechnungs-PDF. */
  @Get(':id/invoice/pdf')
  async invoicePdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { filename, content } = await this.invoiceService.invoicePdf(id);
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}"`,
    });
    return new StreamableFile(content);
  }

  @Post(':id/waive')
  @ApiOperation({
    summary: 'Freischaltung erlassen (Support)',
    description:
      'Wie ein Kauf: in Deutschland mit „Alle Funktionen“ schaltet der Server danach die Cloud-TSE ein; ' +
      'Bestandsorganisationen nur mit `withTse: true` (sonst gilt die Antwort einer früheren Zahlungsseite).',
  })
  @ApiBody({ type: WaiveEventDto, required: false })
  async waive(
    @Param('id') id: string,
    @Body() dto: WaiveEventDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    await this.eventBillingService.assertWaiveMasterData(
      id,
      {
        withTse: dto?.withTse,
        overrideMasterData: dto?.overrideMasterData,
        overrideReason: dto?.overrideReason,
      },
      actorOf(user, req),
    );
    const event = await this.adminEventsService.waive(id);
    await this.eventBillingService.afterWaive(
      event,
      dto?.withTse,
      user?.id ?? null,
    );
    return { data: event };
  }

  @Post(':id/dates')
  @ApiOperation({
    summary: 'Veranstaltung trotz begonnenem Verkauf verschieben (Support)',
    description:
      'Übersteuert die Sperre der Phasen: nach Beginn des Verkaufsfensters lassen sich Beginn und Ende sonst nicht mehr verschieben (Ende nur vorziehen). Grund Pflicht (400 `EVENT_DATES_OVERRIDE_REASON_REQUIRED`), protokolliert als `event_dates_override`. Die bezahlte Dauer gilt weiter (400 `EVENT_PAID_DAYS_EXCEEDED`). Liegt das Verkaufsfenster danach wieder in der Zukunft, ist die Veranstaltung wieder „Geplant“ (Testbestellungen) und wird zu Beginn erneut aufgeräumt.',
  })
  @ApiBody({ type: MoveEventDatesDto })
  async moveDates(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveEventDatesDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    const reason = (dto?.reason ?? '').trim();
    if (!reason) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EVENT_DATES_OVERRIDE_REASON_REQUIRED,
        message: 'Bitte gib einen Grund für das Verschieben an',
      });
    }
    const { event, before } = await this.eventsService.moveDatesAsSupport(id, {
      startDate: dto.startDate,
      endDate: dto.endDate,
    });
    const phase = await this.eventPhase.resolve(event);
    await this.billingAudit.record({
      action: AdminAction.EVENT_DATES_OVERRIDE,
      organizationId: event.organizationId,
      eventId: event.id,
      actor: actorOf(user, req),
      reason,
      details: {
        before: {
          startDate: before.startDate?.toISOString?.() ?? before.startDate,
          endDate: before.endDate?.toISOString?.() ?? before.endDate,
        },
        after: {
          startDate: event.startDate?.toISOString() ?? null,
          endDate: event.endDate?.toISOString() ?? null,
        },
        phase: phase.phase,
        realSalesFrom: phase.realSalesFrom,
        realSalesUntil: phase.realSalesUntil,
      },
    });
    const updated = await this.adminEventsService.getEvent(event.id);
    return { data: (await this.withPhases([updated]))[0] };
  }
}
