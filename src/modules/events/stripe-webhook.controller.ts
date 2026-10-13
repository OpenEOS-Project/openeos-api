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
import { StripeService } from '../stripe/stripe.service';
import { SaasOnly } from '../../common/decorators/saas-only.decorator';

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

    if (
      event.type === 'checkout.session.completed' ||
      /* Lastschrift: beim Abschluss des Checkouts ist noch nichts bezahlt
         (payment_status 'unpaid'); Stripe meldet den Eingang Tage spaeter
         mit diesem Ereignis. */
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const session = event.data.object;
      await this.eventBillingService.settleStripePayment(session.id);
    } else if (
      event.type === 'refund.updated' ||
      event.type === 'refund.failed'
    ) {
      // Stand der Erstattung nach einem Storno (Lastschrift dauert Tage).
      await this.cancellationService.handleRefundUpdate(event.data.object);
    } else {
      this.logger.debug(`Stripe-Webhook ${event.type} ignoriert`);
    }

    // Stripe wiederholt alles, was nicht mit 2xx quittiert wird. Ein
    // unbekannter Ereignistyp ist kein Fehler, sondern nur nichts zu tun.
    return { received: true };
  }
}
