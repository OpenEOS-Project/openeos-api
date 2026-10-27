import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';

/** Rechnungsanschrift, wie Stripe sie am Kunden fuehrt. */
export interface StripeCustomerAddress {
  line1: string;
  postal_code: string;
  city: string;
  country: string;
}

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
    this.webhookSecret =
      this.configService.get<string>('stripe.webhookSecret') || '';

    this.client = secretKey ? new Stripe(secretKey) : null;
    if (!this.client) {
      this.logger.warn(
        'STRIPE_SECRET_KEY ist nicht gesetzt — Online-Zahlung ist deaktiviert',
      );
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
   *
   * Ein vorhandener Kunde wird mit den mitgegebenen Angaben abgeglichen:
   * Name, E-Mail und Anschrift stehen auf jeder Rechnung, die Stripe
   * ausstellt, und muessen deshalb dem entsprechen, was der Verein zuletzt
   * im Bestellformular eingetragen hat. Die Sprache ist Deutsch — Stripes
   * Rechnungsmails und die Rechnungsseite erscheinen darin.
   */
  async ensureCustomer(params: {
    existingCustomerId: string | null;
    organizationId: string;
    organizationName: string;
    email: string | null;
    /** Rechnungsanschrift; fehlt sie, bleibt die bei Stripe hinterlegte. */
    address?: StripeCustomerAddress | null;
  }): Promise<string> {
    const client = this.requireClient();
    const fields: Pick<
      Stripe.CustomerCreateParams,
      'name' | 'email' | 'preferred_locales' | 'metadata' | 'address'
    > = {
      name: params.organizationName,
      email: params.email ?? undefined,
      preferred_locales: ['de'],
      metadata: { organizationId: params.organizationId },
      ...(params.address ? { address: params.address } : {}),
    };

    if (params.existingCustomerId) {
      try {
        const existing = await client.customers.retrieve(
          params.existingCustomerId,
        );
        if (!existing.deleted) {
          await client.customers.update(existing.id, fields);
          return existing.id;
        }
      } catch (error) {
        // Ein geloeschter oder aus einem anderen Konto stammender Kunde darf
        // den Kauf nicht blockieren — dann eben ein neuer.
        this.logger.warn(
          `Stripe-Kunde ${params.existingCustomerId} nicht abrufbar, lege neuen an: ${(error as Error).message}`,
        );
      }
    }

    const created = await client.customers.create(fields);
    return created.id;
  }

  /**
   * Eine Rechnung zum Kauf auf Rechnung ausstellen und verschicken.
   *
   * Stripe fuehrt den Nummernkreis, erzeugt PDF und Rechnungsseite,
   * verschickt die Mail samt Erinnerungen und ordnet Ueberweisungen zu.
   * Hier passiert in dieser Reihenfolge: Entwurf anlegen, Positionen
   * anhaengen, finalisieren (ab da gibt es Nummer, PDF und Seite),
   * versenden.
   *
   * Jeder Schritt traegt einen eigenen Idempotenzschluessel, abgeleitet aus
   * dem des Aufrufers. Bricht der Ablauf mittendrin ab (Netz, Neustart),
   * fuehrt ein Wiederholen denselben Entwurf zu Ende, statt eine zweite
   * Rechnung mit denselben Positionen auszustellen.
   *
   * Keine Steuersaetze: der Betreiber faellt unter § 19 UStG, der Hinweis
   * dazu steht in der Fusszeile (`footer`).
   */
  async createAndSendInvoice(params: {
    customerId: string;
    currency: string;
    /** Memo oben auf der Rechnung. */
    description: string;
    footer: string;
    daysUntilDue: number;
    lines: { description: string; amountInCents: number }[];
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<Stripe.Invoice> {
    const client = this.requireClient();
    const currency = params.currency.toLowerCase();

    const draft = await client.invoices.create(
      {
        customer: params.customerId,
        collection_method: 'send_invoice',
        days_until_due: params.daysUntilDue,
        currency,
        description: params.description,
        footer: params.footer,
        metadata: params.metadata,
        // Nur die hier angehaengten Positionen — nichts, was zufaellig noch
        // am Kunden haengt.
        pending_invoice_items_behavior: 'exclude',
        auto_advance: true,
      },
      { idempotencyKey: `${params.idempotencyKey}:invoice` },
    );
    const invoiceId = draft.id;
    if (!invoiceId) {
      throw new ServiceUnavailableException({
        code: ErrorCodes.STRIPE_API_ERROR,
        message: 'Stripe hat keine Rechnung angelegt',
      });
    }

    for (const [index, line] of params.lines.entries()) {
      await client.invoiceItems.create(
        {
          customer: params.customerId,
          invoice: invoiceId,
          amount: line.amountInCents,
          currency,
          description: line.description,
          metadata: params.metadata,
        },
        { idempotencyKey: `${params.idempotencyKey}:line:${index}` },
      );
    }

    // Ein schon finalisierter Entwurf (Wiederholung) laesst sich nicht noch
    // einmal finalisieren — dann reicht der aktuelle Stand.
    const finalized =
      draft.status === 'draft'
        ? await client.invoices.finalizeInvoice(
            invoiceId,
            { auto_advance: true },
            { idempotencyKey: `${params.idempotencyKey}:finalize` },
          )
        : draft;

    if (finalized.status === 'open') {
      return client.invoices.sendInvoice(
        invoiceId,
        {},
        { idempotencyKey: `${params.idempotencyKey}:send` },
      );
    }
    return finalized;
  }

  /** Stripes Rechnungsmail noch einmal verschicken (nur offene Rechnungen). */
  async sendInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    return this.requireClient().invoices.sendInvoice(invoiceId);
  }

  /**
   * Eine offene Rechnung stornieren. Danach ist sie "void": nicht mehr
   * bezahlbar, bleibt aber mit Nummer im Nummernkreis — so verlangt es die
   * Buchhaltung. Bezahlte Rechnungen lassen sich nicht stornieren, dafuer
   * gibt es die Gutschrift.
   */
  async voidInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    return this.requireClient().invoices.voidInvoice(invoiceId);
  }

  /**
   * Eine Rechnung als ausserhalb von Stripe bezahlt verbuchen (etwa eine
   * Ueberweisung auf das eigene Konto des Betreibers). Stripe meldet
   * danach `invoice.paid` wie bei jeder anderen Zahlung.
   */
  async markInvoicePaidOutOfBand(invoiceId: string): Promise<Stripe.Invoice> {
    return this.requireClient().invoices.pay(invoiceId, {
      paid_out_of_band: true,
    });
  }

  /** Die Rechnung samt ihren Zahlungen — fuer die Frage, wie erstattet wird. */
  async getInvoiceWithPayments(invoiceId: string): Promise<Stripe.Invoice> {
    return this.requireClient().invoices.retrieve(invoiceId, {
      expand: ['payments'],
    });
  }

  /**
   * Wurde die Rechnung ueber Stripe bezahlt (Karte, Lastschrift,
   * Ueberweisung auf Stripes Konto)? Dann kann Stripe die Erstattung selbst
   * anlegen. Ohne eine solche Zahlung (als bezahlt markiert) muss der
   * Betreiber von Hand zurueckueberweisen.
   */
  isInvoicePaidThroughStripe(invoice: Stripe.Invoice): boolean {
    const payments = invoice.payments?.data ?? [];
    return payments.some(
      (payment) =>
        payment.status === 'paid' &&
        (payment.payment.type === 'payment_intent' ||
          payment.payment.type === 'charge'),
    );
  }

  /**
   * Eine Gutschrift (Stornorechnung) zu einer Rechnung ausstellen.
   *
   * - `refund`: zu einer ueber Stripe bezahlten Rechnung, Stripe legt die
   *   Erstattung auf die Zahlung an (bei Ueberweisung fragt Stripe die
   *   Bankverbindung beim Kunden ab),
   * - `out_of_band`: zu einer ausserhalb von Stripe bezahlten Rechnung —
   *   die Gutschrift dokumentiert, erstattet wird von Hand,
   * - `credit`: zu einer noch offenen Rechnung — der offene Betrag sinkt.
   *
   * Keine Mail von Stripe: die Bestaetigung schicken wir selbst, auf Deutsch
   * und mit den Folgen fuer die Veranstaltung.
   */
  async createCreditNote(params: {
    invoiceId: string;
    amountInCents: number;
    mode: 'refund' | 'out_of_band' | 'credit';
    memo: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<Stripe.CreditNote> {
    const amounts: Partial<Stripe.CreditNoteCreateParams> =
      params.mode === 'refund'
        ? { refund_amount: params.amountInCents }
        : params.mode === 'out_of_band'
          ? { out_of_band_amount: params.amountInCents }
          : { credit_amount: params.amountInCents };
    return this.requireClient().creditNotes.create(
      {
        invoice: params.invoiceId,
        amount: params.amountInCents,
        ...amounts,
        reason: 'order_change',
        memo: params.memo,
        email_type: 'none',
        metadata: params.metadata,
      },
      { idempotencyKey: params.idempotencyKey },
    );
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
        reason: ErrorReasons.STRIPE_NO_CHECKOUT_URL,
        message: 'Stripe hat keine Zahlungsseite zurückgegeben',
      });
    }

    return { id: session.id, url: session.url };
  }

  /**
   * Die Rechnungen eines Kunden, neueste zuerst.
   *
   * Ausgestellt hat sie Stripe, nicht wir — Nummernkreis, PDF und
   * Hosted-Ansicht kommen von dort. Hier wird nur gelesen.
   */
  async listInvoices(
    customerId: string,
    limit = 100,
  ): Promise<Stripe.Invoice[]> {
    const client = this.requireClient();
    const page = await client.invoices.list({ customer: customerId, limit });
    return page.data;
  }

  async getInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    return this.requireClient().invoices.retrieve(invoiceId);
  }

  /**
   * Das PDF einer Rechnung oder Gutschrift holen.
   *
   * Stripe legt es unter einer eigenen, nicht erratbaren URL ab. Die wird
   * bewusst nicht an den Browser durchgereicht, sondern hier abgerufen und
   * weitergeleitet — sonst waere ein einmal kopierter Link dauerhaft und
   * ohne Anmeldung gueltig.
   */
  async fetchInvoicePdf(invoicePdfUrl: string): Promise<Buffer> {
    const response = await fetch(invoicePdfUrl);
    if (!response.ok) {
      throw new ServiceUnavailableException({
        code: ErrorCodes.STRIPE_NOT_CONFIGURED,
        reason: ErrorReasons.STRIPE_INVOICE_PDF_UNAVAILABLE,
        message: `Rechnungs-PDF konnte nicht geladen werden (HTTP ${response.status})`,
      });
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async getCheckoutSession(
    sessionId: string,
  ): Promise<Stripe.Checkout.Session> {
    return this.requireClient().checkout.sessions.retrieve(sessionId);
  }

  /**
   * Die Checkout-Sitzung samt Zahlung und deren letzter Belastung — daraus
   * stammt bei einer gescheiterten Lastschrift der Grund.
   */
  async getCheckoutSessionWithPayment(
    sessionId: string,
  ): Promise<Stripe.Checkout.Session> {
    return this.requireClient().checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent.latest_charge'],
    });
  }

  /**
   * Eine offene Checkout-Sitzung beenden. Danach kann ueber sie nichts mehr
   * bezahlt werden — die Voraussetzung, um eine haengende Freischaltung
   * gefahrlos zurueckzusetzen.
   */
  async expireCheckoutSession(
    sessionId: string,
  ): Promise<Stripe.Checkout.Session> {
    return this.requireClient().checkout.sessions.expire(sessionId);
  }

  async getPaymentIntent(
    paymentIntentId: string,
  ): Promise<Stripe.PaymentIntent> {
    return this.requireClient().paymentIntents.retrieve(paymentIntentId);
  }

  /** Stripe kennt das angefragte Objekt nicht (geloescht, anderes Konto/Modus). */
  isResourceMissing(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'resource_missing'
    );
  }

  /**
   * Die Checkout-Sitzung samt Zahlung und Rechnung — was ein Storno braucht,
   * um die richtige Zahlung zu erstatten und die Rechnung gutzuschreiben.
   */
  async getCheckoutSessionForRefund(
    sessionId: string,
  ): Promise<Stripe.Checkout.Session> {
    return this.requireClient().checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'invoice'],
    });
  }

  /**
   * Eine bezahlte Rechnung ganz oder teilweise gutschreiben und dabei
   * erstatten.
   *
   * Stripe stellt dazu eine Gutschrift (Credit Note) mit eigener Nummer
   * („<Rechnungsnummer>-CN-01“) und eigenem PDF aus — die Stornorechnung —
   * und legt die Erstattung auf die Zahlung der Rechnung an. Keine Mail von
   * Stripe: die Bestätigung schicken wir selbst, auf Deutsch und mit den
   * Folgen für die Veranstaltung.
   */
  async createCreditNoteWithRefund(params: {
    invoiceId: string;
    amountInCents: number;
    memo: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<Stripe.CreditNote> {
    return this.requireClient().creditNotes.create(
      {
        invoice: params.invoiceId,
        amount: params.amountInCents,
        refund_amount: params.amountInCents,
        reason: 'order_change',
        memo: params.memo,
        email_type: 'none',
        metadata: params.metadata,
      },
      { idempotencyKey: params.idempotencyKey },
    );
  }

  /** Die Erstattung, die Stripe zu einer Gutschrift angelegt hat. */
  refundIdOfCreditNote(creditNote: Stripe.CreditNote): string | null {
    const first = creditNote.refunds?.[0]?.refund;
    if (!first) return null;
    return typeof first === 'string' ? first : first.id;
  }

  /**
   * Eine Zahlung erstatten (ohne Rechnung, also ohne Gutschrift). Ohne
   * Betrag erstattet Stripe, was von der Zahlung noch offen ist.
   */
  async createRefund(params: {
    paymentIntentId: string;
    amountInCents?: number;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<Stripe.Refund> {
    return this.requireClient().refunds.create(
      {
        payment_intent: params.paymentIntentId,
        ...(params.amountInCents !== undefined
          ? { amount: params.amountInCents }
          : {}),
        reason: 'requested_by_customer',
        metadata: params.metadata,
      },
      { idempotencyKey: params.idempotencyKey },
    );
  }

  async retrieveRefund(refundId: string): Promise<Stripe.Refund> {
    return this.requireClient().refunds.retrieve(refundId);
  }

  /** Die Gutschriften (Stornorechnungen) eines Kunden, mit Rechnungsnummer. */
  async listCreditNotes(
    customerId: string,
    limit = 100,
  ): Promise<Stripe.CreditNote[]> {
    const page = await this.requireClient().creditNotes.list({
      customer: customerId,
      limit,
      expand: ['data.invoice'],
    });
    return page.data;
  }

  async getCreditNote(creditNoteId: string): Promise<Stripe.CreditNote> {
    return this.requireClient().creditNotes.retrieve(creditNoteId);
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
        reason: ErrorReasons.STRIPE_WEBHOOK_SECRET_MISSING,
        message: 'STRIPE_WEBHOOK_SECRET ist nicht konfiguriert',
      });
    }
    return client.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );
  }
}
