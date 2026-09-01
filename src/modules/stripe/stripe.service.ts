import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { ErrorCodes } from '../../common/constants/error-codes';

/**
 * Duenner Mantel um das Stripe-SDK.
 *
 * Der Dienst kennt nur Stripe, keine Veranstaltungen und keine Preise — was
 * abgerechnet wird, entscheidet der Aufrufer. So bleibt die Abrechnungslogik
 * an einer Stelle und dieser Dienst austauschbar.
 *
 * Ohne konfigurierten Schluessel wird der Mantel nicht scharf: `isConfigured`
 * meldet false und jeder Aufruf laeuft in eine sprechende Fehlermeldung,
 * statt beim Start die ganze Anwendung zu verhindern. Entwicklung und Tests
 * kommen damit ohne Stripe-Konto aus.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly client: Stripe | null;
  private readonly webhookSecret: string;

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>('stripe.secretKey') || '';
    this.webhookSecret = this.configService.get<string>('stripe.webhookSecret') || '';

    this.client = secretKey ? new Stripe(secretKey) : null;
    if (!this.client) {
      this.logger.warn('STRIPE_SECRET_KEY ist nicht gesetzt — Online-Zahlung ist deaktiviert');
    }
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  private requireClient(): Stripe {
    if (!this.client) {
      throw new ServiceUnavailableException({
        code: ErrorCodes.STRIPE_NOT_CONFIGURED,
        message: 'Online-Zahlung ist derzeit nicht verfügbar',
      });
    }
    return this.client;
  }

  /**
   * Den Stripe-Kunden zu einer Organisation finden oder anlegen.
   *
   * Die zurueckgegebene ID gehoert in `organization.stripe_customer_id` —
   * dann sieht der Verein seine Zahlungen im Stripe-Kundenportal
   * zusammenhaengend, statt als lose Einzelzahlungen.
   */
  async ensureCustomer(params: {
    existingCustomerId: string | null;
    organizationId: string;
    organizationName: string;
    email: string | null;
  }): Promise<string> {
    const client = this.requireClient();

    if (params.existingCustomerId) {
      try {
        const existing = await client.customers.retrieve(params.existingCustomerId);
        if (!existing.deleted) return existing.id;
      } catch (error) {
        // Ein geloeschter oder aus einem anderen Konto stammender Kunde darf
        // den Kauf nicht blockieren — dann eben ein neuer.
        this.logger.warn(
          `Stripe-Kunde ${params.existingCustomerId} nicht abrufbar, lege neuen an: ${(error as Error).message}`,
        );
      }
    }

    const created = await client.customers.create({
      name: params.organizationName,
      email: params.email ?? undefined,
      metadata: { organizationId: params.organizationId },
    });
    return created.id;
  }

  /**
   * Eine Checkout-Sitzung fuer einen einmaligen Betrag anlegen.
   *
   * Der Betrag kommt in Cent herein, weil Stripe in der kleinsten
   * Waehrungseinheit rechnet und ein Gleitkommawert auf dem Weg dorthin
   * genau der Ort waere, an dem ein Cent verschwindet.
   */
  async createCheckoutSession(params: {
    customerId: string;
    amountInCents: number;
    currency: string;
    productName: string;
    productDescription: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }> {
    const client = this.requireClient();

    const session = await client.checkout.sessions.create(
      {
        mode: 'payment',
        customer: params.customerId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: params.currency.toLowerCase(),
              unit_amount: params.amountInCents,
              product_data: {
                name: params.productName,
                description: params.productDescription,
              },
            },
          },
        ],
        // Ohne Rechnung bliebe dem Verein nur die Kartenabrechnung als Beleg.
        invoice_creation: { enabled: true },
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata: params.metadata,
        payment_intent_data: { metadata: params.metadata },
      },
      // Ein Doppelklick auf "Zahlungspflichtig bestellen" darf keine zweite
      // Sitzung und keine zweite Zahlung erzeugen.
      { idempotencyKey: params.idempotencyKey },
    );

    if (!session.url) {
      throw new ServiceUnavailableException({
        code: ErrorCodes.STRIPE_NOT_CONFIGURED,
        message: 'Stripe hat keine Zahlungsseite zurückgegeben',
      });
    }

    return { id: session.id, url: session.url };
  }

  async getCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    return this.requireClient().checkout.sessions.retrieve(sessionId);
  }

  /**
   * Die Signatur eines Webhooks pruefen und das Ereignis auspacken.
   *
   * Ohne diese Pruefung koennte jeder eine "Zahlung erfolgreich"-Nachricht an
   * den Endpunkt schicken und sich eine Veranstaltung freischalten. Fehlt das
   * Signaturgeheimnis, wird deshalb nichts akzeptiert.
   */
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const client = this.requireClient();
    if (!this.webhookSecret) {
      throw new ServiceUnavailableException({
        code: ErrorCodes.STRIPE_NOT_CONFIGURED,
        message: 'STRIPE_WEBHOOK_SECRET ist nicht konfiguriert',
      });
    }
    return client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
