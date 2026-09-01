import { Controller, Get, Post, Param, Body, Query, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { EventBillingService } from './event-billing.service';
import { OrderInvoiceDto } from './dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('Event Billing')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId')
export class EventBillingController {
  constructor(private readonly eventBillingService: EventBillingService) {}

  @Get('events/:eventId/billing')
  @ApiOperation({ summary: 'Preis, Rabatt und Freischaltungsstatus einer Veranstaltung' })
  async getBillingInfo(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.eventBillingService.getBillingInfo(organizationId, eventId, user);
    return { data };
  }

  @Post('events/:eventId/order-invoice')
  @ApiOperation({ summary: 'Veranstaltung kostenpflichtig auf Rechnung bestellen (Kauf auf Rechnung)' })
  async orderInvoice(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: OrderInvoiceDto,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventBillingService.orderInvoice(organizationId, eventId, dto, user);
    return { data: event };
  }

  @Post('events/:eventId/checkout')
  @ApiOperation({ summary: 'Stripe-Zahlungsseite für die Freischaltung anlegen' })
  async createCheckout(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.eventBillingService.createStripeCheckout(organizationId, eventId, user);
    return { data };
  }

  @Post('events/:eventId/billing/sync')
  @ApiOperation({ summary: 'Nach der Rückkehr aus dem Stripe-Checkout den Zahlungsstand abgleichen' })
  async syncPayment(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.eventBillingService.syncStripePayment(organizationId, eventId, user);
    return { data };
  }

  @Get('billing/company-search')
  @ApiOperation({ summary: 'Firmensuche (openregister.de) für das Kauf-auf-Rechnung-Formular' })
  async companySearch(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query('q') q: string,
    @CurrentUser() user: User,
  ) {
    const data = await this.eventBillingService.companySearch(organizationId, q, user);
    return { data };
  }
}
