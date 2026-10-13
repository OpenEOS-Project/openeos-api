import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { EventBillingService } from './event-billing.service';
import {
  EventUnlockCancellationService,
  toCancellationSummary,
} from './event-unlock-cancellation.service';
import { OrderInvoiceDto } from './dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { SaasOnly } from '../../common/decorators/saas-only.decorator';

@ApiTags('Event Billing')
@ApiBearerAuth('JWT-auth')
@SaasOnly()
@Controller('organizations/:organizationId')
export class EventBillingController {
  constructor(
    private readonly eventBillingService: EventBillingService,
    private readonly cancellationService: EventUnlockCancellationService,
  ) {}

  @Get('event-price-preview')
  @ApiOperation({
    summary: 'What an event over this period would cost, before creating it',
    description:
      'Same calculation as the real price, so the preview cannot disagree ' +
      'with the invoice. Dates as YYYY-MM-DD; end defaults to start.',
  })
  @ApiQuery({ name: 'start', required: true, description: 'JJJJ-MM-TT' })
  @ApiQuery({ name: 'end', required: false, description: 'JJJJ-MM-TT' })
  async previewPrice(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query('start') start: string,
    @Query('end') end: string | undefined,
    @CurrentUser() user: User,
  ) {
    const data = await this.eventBillingService.previewPrice(
      organizationId,
      start,
      end,
      user,
    );
    return { data };
  }

  @Get('events/:eventId/billing')
  @ApiOperation({
    summary: 'Preis, Rabatt und Freischaltungsstatus einer Veranstaltung',
  })
  async getBillingInfo(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.eventBillingService.getBillingInfo(
      organizationId,
      eventId,
      user,
    );
    return { data };
  }

  @Post('events/:eventId/order-invoice')
  @ApiOperation({
    summary:
      'Veranstaltung kostenpflichtig auf Rechnung bestellen (Kauf auf Rechnung)',
  })
  async orderInvoice(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: OrderInvoiceDto,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventBillingService.orderInvoice(
      organizationId,
      eventId,
      dto,
      user,
    );
    return { data: event };
  }

  @Post('events/:eventId/checkout')
  @ApiOperation({
    summary: 'Stripe-Zahlungsseite für die Freischaltung anlegen',
  })
  async createCheckout(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.eventBillingService.createStripeCheckout(
      organizationId,
      eventId,
      user,
    );
    return { data };
  }

  @Post('events/:eventId/billing/sync')
  @ApiOperation({
    summary:
      'Nach der Rückkehr aus dem Stripe-Checkout den Zahlungsstand abgleichen',
  })
  async syncPayment(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.eventBillingService.syncStripePayment(
      organizationId,
      eventId,
      user,
    );
    return { data };
  }

  @Post('events/:eventId/billing/cancel')
  @ApiOperation({
    summary: 'Freischaltung kostenlos stornieren (bis 7 Tage vor Beginn)',
    description:
      'Nur Administratoren der Organisation und nur ohne echte Bestellungen. ' +
      'Stripe-Zahlungen werden voll erstattet (mit Stornorechnung, wenn eine ' +
      'Rechnung erzeugt wurde); die Veranstaltung faellt in den Testmodus ' +
      'zurueck. Wiederholte Aufrufe liefern die bestehende Stornierung. ' +
      'Fehler: EVENT_CANCELLATION_DEADLINE_PASSED, EVENT_HAS_ORDERS, ' +
      'EVENT_NOT_PAID, REFUND_FAILED.',
  })
  async cancelUnlock(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const cancellation = await this.cancellationService.cancelForOrganization(
      organizationId,
      eventId,
      user,
    );
    const billing = await this.eventBillingService.getBillingInfo(
      organizationId,
      eventId,
      user,
    );
    return {
      data: { cancellation: toCancellationSummary(cancellation), billing },
    };
  }

  @Get('billing/invoices')
  @ApiOperation({
    summary: 'Von Stripe ausgestellte Rechnungen der Organisation',
  })
  async listInvoices(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.eventBillingService.listInvoices(
      organizationId,
      user,
    );
    return { data };
  }

  @Get('billing/invoices/:invoiceId/pdf')
  @ApiOperation({ summary: 'Rechnungs-PDF herunterladen' })
  async downloadInvoicePdf(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('invoiceId') invoiceId: string,
    @CurrentUser() user: User,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { filename, content } = await this.eventBillingService.getInvoicePdf(
      organizationId,
      invoiceId,
      user,
    );

    // Die Rechnungsnummer kommt von Stripe und ist unbedenklich; entschärft
    // wird sie trotzdem, damit ein Sonderzeichen den Content-Disposition-
    // Header nicht zerlegen kann.
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}"`,
    });

    return new StreamableFile(content);
  }

  @Get('billing/company-search')
  @ApiOperation({
    summary: 'Firmensuche (openregister.de) für das Kauf-auf-Rechnung-Formular',
  })
  async companySearch(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query('q') q: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.eventBillingService.companySearch(
      organizationId,
      q,
      user,
    );
    return { data };
  }
}
