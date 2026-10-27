import {
  BadRequestException,
  Controller,
  Headers,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { EventBillingService } from './event-billing.service';
import { EventUnlockCancellationService } from './event-unlock-cancellation.service';
import { EventCheckoutLifecycleService } from './event-checkout-lifecycle.service';
import { StripeDisputeService } from './stripe-dispute.service';
import { StripeInvoiceService } from './stripe-invoice.service';
import { StripeService } from '../stripe/stripe.service';
import { SaasOnly } from '../../common/decorators/saas-only.decorator';

/**
 * Stripe-Ereignisse, die dieser Endpunkt verarbeitet. Genau diese muessen
 * im Stripe-Dashboard am Webhook-Endpunkt abonniert sein (siehe
 * .env.example); alles andere wird quittiert und ignoriert.
 */
export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
  'charge.dispute.closed',
  // Kauf auf Rechnung ueber Stripe Invoicing
  'invoice.finalized',
  'invoice.sent',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
  'credit_note.created',
  'credit_note.voided',
] as const;

/**
 * Stripes Rueckmeldung zu bezahlten Freischaltungen.
 *
 * Der Webhook ist die verlaessliche Quelle, nicht die Rueckkehr im Browser:
 * wer nach dem Bezahlen den Tab schliesst, kommt nie zurueck, die Zahlung ist
 * aber trotzdem erfolgt.
 *
 * Der Endpunkt ist oeffentlich und muss es sein — Stripe hat kein Konto bei
 * uns. Was ihn schuetzt, ist ausschliesslich die Signaturpruefung.
 */
@ApiExcludeController()
@SaasOnly()
@Controller('public/stripe')
@Public()
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly eventBillingService: EventBillingService,
    private readonly cancellationService: EventUnlockCancellationService,
    private readonly checkoutLifecycle: EventCheckoutLifecycleService,
    private readonly disputeService: StripeDisputeService,
    private readonly invoiceService: StripeInvoiceService,
  ) {}

  @Post('webhook')
  async handleWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!request.rawBody) {
      // Ohne unveraenderten Rohtext laesst sich die Signatur nicht pruefen.
      // Fehlt er, ist rawBody im Bootstrap nicht eingeschaltet.
      throw new BadRequestException({
        code: 'RAW_BODY_MISSING',
        message: 'Rohdaten fehlen',
      });
    }
    if (!signature) {
      throw new BadRequestException({
        code: 'SIGNATURE_MISSING',
        message: 'Signatur fehlt',
      });
    }

    let event;
    try {
      event = this.stripeService.constructWebhookEvent(
        request.rawBody,
        signature,
      );
    } catch (error) {
      this.logger.warn(`Stripe-Webhook abgelehnt: ${(error as Error).message}`);
      throw new BadRequestException({
        code: 'SIGNATURE_INVALID',
        message: 'Signatur ungültig',
      });
    }

    switch (event.type) {
      case 'checkout.session.completed':
      /* Lastschrift: beim Abschluss des Checkouts ist noch nichts bezahlt
         (payment_status 'unpaid'); Stripe meldet den Eingang Tage spaeter
         mit diesem Ereignis. */
      // falls through
      case 'checkout.session.async_payment_succeeded':
        await this.eventBillingService.settleStripePayment(
          event.data.object.id,
        );
        break;
      case 'checkout.session.expired':
        // Zahlungsseite abgelaufen, ohne dass bezahlt wurde.
        await this.checkoutLifecycle.handleCheckoutExpired(
          event.data.object,
          event.id,
        );
        break;
      case 'checkout.session.async_payment_failed':
        // Lastschrift nicht eingeloest.
        await this.checkoutLifecycle.handleAsyncPaymentFailed(
          event.data.object,
          event.id,
        );
        break;
      case 'refund.updated':
      case 'refund.failed':
        // Stand der Erstattung nach einem Storno (Lastschrift dauert Tage).
        await this.cancellationService.handleRefundUpdate(event.data.object);
        break;
      case 'charge.dispute.created':
        await this.disputeService.handleDispute(
          event.data.object,
          'created',
          event.id,
        );
        break;
      case 'charge.dispute.closed':
        await this.disputeService.handleDispute(
          event.data.object,
          'closed',
          event.id,
        );
        break;
      case 'invoice.finalized':
      case 'invoice.sent':
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.voided':
      case 'invoice.marked_uncollectible':
        // Kauf auf Rechnung: Stand der Stripe-Rechnung.
        await this.invoiceService.handleInvoiceEvent(
          event.type,
          event.data.object,
          event.id,
        );
        break;
      case 'credit_note.created':
      case 'credit_note.voided':
        await this.invoiceService.handleCreditNoteEvent(
          event.type,
          event.data.object,
          event.id,
        );
        break;
      default:
        this.logger.debug(`Stripe-Webhook ${event.type} ignoriert`);
    }

    // Stripe wiederholt alles, was nicht mit 2xx quittiert wird. Ein
    // unbekannter Ereignistyp ist kein Fehler, sondern nur nichts zu tun.
    return { received: true };
  }
}
