import { priceSelectedOptions } from '../products/product-option-pricing';
import {
  OPERATING_MODE_SELECT,
  assertCashAllowed,
  assertPaymentsAllowed,
} from '../../common/utils/operating-mode.util';
import {
  Controller,
  Post,
  Get,
  Param,
  ParseUUIDPipe,
  Body,
  BadRequestException,
  NotFoundException,
  HttpCode,
  HttpStatus,
  Logger,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository, In } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
import { shopAvailability } from './shop-availability';
import { EventPhaseService } from './event-phase.service';
import {
  Event,
  EventStatus,
  Organization,
  Category,
  Product,
  Order,
  OrderItem,
  Payment,
  ShopCheckout,
} from '../../database/entities';
import {
  ShopCheckoutStatus,
  ShopCheckoutCustomerName,
  ShopCheckoutFulfillment,
  ShopCheckoutItem,
  ShopCheckoutItemOption,
} from '../../database/entities/shop-checkout.entity';
import {
  OrderSource,
  OrderStatus,
  PaymentStatus as OrderPaymentStatus,
  OrderFulfillmentType,
} from '../../database/entities/order.entity';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { SumUpApiService, sumUpApiBaseUrl } from '../sumup/sumup-api.service';
import { assertIntegrationEnabled } from '../integrations/integration-catalog';
import { EmailService } from '../email/email.service';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { GatewayService } from '../gateway/gateway.service';
import { orderTaxTotal } from '../print-jobs/receipt-tax.util';
import { SERVICE_FEE_TAX_RATE, serviceFeeOf } from '../refunds/refund-calc';
import { saveOrderWithNumbers } from '../orders/order-numbering';
import { findTableIdByLabel } from '../tables/table-lookup';
import { escapeHtml } from '../email/email-template';
import { assertTestEventOrderLimitNotReached } from '../../common/utils/test-event-order-limit.util';
import { assertLegalInfoComplete } from '../organizations/legal/legal-settings.util';
import { TseSigningService } from '../tse/tse-signing.service';
import type { TseReceiptView } from '../tse/tse-view';

interface CreateCheckoutBody {
  email: string;
  customerName?: ShopCheckoutCustomerName;
  fulfillmentType?: ShopCheckoutFulfillment;
  tableNumber?: string | null;
  items: Array<{
    productId: string;
    quantity: number;
    options?: ShopCheckoutItemOption[];
  }>;
}

function lineUnitPrice(
  unit: number,
  options?: ShopCheckoutItemOption[],
): number {
  if (!options) return unit;
  const extras = options
    .filter((o) => !o.excluded && o.priceModifier > 0)
    .reduce((acc, o) => acc + Number(o.priceModifier), 0);
  return unit + extras;
}

@ApiTags('Shop Checkout (Public)')
@Controller('public/shop')
@Public()
export class EventsShopCheckoutController {
  private readonly logger = new Logger(EventsShopCheckoutController.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(ShopCheckout)
    private readonly shopCheckoutRepository: Repository<ShopCheckout>,
    private readonly sumupApi: SumUpApiService,
    private readonly emailService: EmailService,
    private readonly orderPrintService: OrderPrintService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    // Optional mit Rueckfall fuer von Hand gebaute Tests (Standardwerte).
    @Optional()
    private readonly eventPhaseService?: EventPhaseService,
    // Cloud-TSE: Kassenbeleg der Online-Zahlung (ohne aktive TSE nichts).
    @Optional()
    private readonly tseSigning?: TseSigningService,
  ) {}

  private get eventPhase(): EventPhaseService {
    return (
      this.eventPhaseService ??
      EventPhaseService.standalone(
        this.organizationRepository,
        this.orderRepository,
        this.configService,
      )
    );
  }

  private async loadShopEvent(eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });
    const shopEnabled = event?.settings?.shop?.enabled === true;
    const isLive =
      event?.status === EventStatus.ACTIVE ||
      event?.status === EventStatus.TEST;
    if (!event || !shopEnabled || !isLive) {
      throw new NotFoundException({
        code: 'SHOP_NOT_FOUND',
        message: 'Shop nicht gefunden oder nicht aktiviert',
      });
    }
    return event;
  }

  /**
   * Ausserhalb der Oeffnungszeiten wird nicht bestellt. Der Shop blendet die
   * Kasse dann zwar aus, aber ein offener Tab oder ein direkter Aufruf kaeme
   * sonst durch — und eine Bestellung, die um vier Uhr morgens in einer
   * leeren Kueche landet, ist niemandem geholfen. Im Test-Modus gilt die
   * Sperre nicht, sonst waere der Shop vor der Veranstaltung nicht pruefbar.
   *
   * Dazu die Phase der Veranstaltung (shopAvailability): vor dem
   * Verkaufsfenster nur mit Vorverkauf (403 SHOP_PRESALE_DISABLED), nach dem
   * Ende gar nicht mehr (403 EVENT_ENDED).
   */
  private async assertShopOpen(event: Event): Promise<void> {
    if (event.status === EventStatus.TEST) return;

    const organization = await this.organizationRepository.findOne({
      where: { id: event.organizationId },
    });
    const now = new Date();
    const phase = this.eventPhase.resolveWith(event, organization, now);
    if (phase.phase === 'ended' || phase.phase === 'planned') {
      // Gleiche Pruefung und Meldung wie an der Kasse.
      await this.eventPhase.prepareOrder(event, 'shop', { organization });
    }
    const availability = shopAvailability(
      event,
      organization?.settings?.timezone || 'Europe/Berlin',
      phase,
      now,
    );

    if (!availability.isOpenNow) {
      throw new BadRequestException({
        code: 'SHOP_CLOSED',
        message: 'Der Shop ist derzeit geschlossen',
        params: { nextOpening: availability.nextOpening },
      });
    }
  }

  @Post(':eventId/checkout')
  @ApiOperation({
    summary: 'Create a pending shop checkout + SumUp Online Checkout session',
  })
  async createCheckout(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() body: CreateCheckoutBody,
  ) {
    const event = await this.loadShopEvent(eventId);
    // Betriebsart „Nur Bons“: keine Online-Bestellung mit Vorkasse.
    const modeOrg = await this.organizationRepository.findOne({
      where: { id: event.organizationId },
      select: OPERATING_MODE_SELECT,
    });
    assertPaymentsAllowed(modeOrg);
    // Positivliste „Bargeldlos“: der Shop nimmt nur SumUp Online.
    assertCashAllowed(modeOrg, PaymentMethod.SUMUP_ONLINE);
    await this.assertShopOpen(event);

    if (event.status === EventStatus.TEST) {
      const existingOrderCount = await this.orderRepository.count({
        where: { eventId: event.id },
      });
      assertTestEventOrderLimitNotReached(
        event.status,
        existingOrderCount,
        this.configService.get<number>('billing.testEventMaxOrders', 25),
      );
    }

    if (!body || typeof body.email !== 'string' || !body.email.includes('@')) {
      throw new BadRequestException({
        code: 'INVALID_EMAIL',
        message: 'Eine gültige E-Mail-Adresse ist erforderlich',
      });
    }
    if (!body.customerName?.firstName?.trim()) {
      throw new BadRequestException({
        code: 'NAME_REQUIRED',
        message: 'Bitte einen Namen angeben',
      });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new BadRequestException({
        code: 'EMPTY_CART',
        message: 'Der Warenkorb ist leer',
      });
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: event.organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: 'ORG_NOT_FOUND',
        message: 'Organisation nicht gefunden',
      });
    }
    // Ohne Impressum und Datenschutzhinweis des Vereins keine Bestellung.
    assertLegalInfoComplete(organization);
    /* Nur das Anlegen neuer Checkouts wird gesperrt. Pruefung und Webhook
       eines bereits begonnenen Checkouts laufen weiter: dort ist das Geld
       womoeglich schon bezahlt, und ohne Abschluss fehlte die Bestellung. */
    assertIntegrationEnabled(organization.settings, 'sumup');
    const orgSettings = organization.settings as {
      sumup?: { apiKey?: string; merchantCode?: string };
      currency?: string;
    } | null;
    const apiKey = orgSettings?.sumup?.apiKey;
    const merchantCode = orgSettings?.sumup?.merchantCode;
    if (!apiKey || !merchantCode) {
      throw new BadRequestException({
        code: 'SUMUP_NOT_CONFIGURED',
        message:
          'Online-Bezahlung ist für diese Organisation nicht konfiguriert',
      });
    }
    const currency = orgSettings.currency || 'EUR';

    const productIds = body.items.map((i) => i.productId);
    const products = await this.productRepository.find({
      where: { id: In(productIds), eventId, isActive: true, isAvailable: true },
    });
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException({
        code: 'INVALID_ITEMS',
        message: 'Mindestens ein Artikel ist nicht mehr verfügbar',
      });
    }

    const items: ShopCheckoutItem[] = body.items.map((line) => {
      const product = products.find((p) => p.id === line.productId)!;
      const quantity = Math.max(1, Math.floor(Number(line.quantity) || 0));
      // Preise der Optionen aus der Produktdefinition, nie aus der Anfrage.
      const options = Array.isArray(line.options)
        ? priceSelectedOptions(product, line.options).selected
        : undefined;
      return {
        productId: product.id,
        name: product.name,
        quantity,
        unitPrice: Number(product.price),
        options,
      };
    });

    const itemsTotal = items.reduce(
      (acc, i) => acc + lineUnitPrice(i.unitPrice, i.options) * i.quantity,
      0,
    );
    if (itemsTotal <= 0) {
      throw new BadRequestException({
        code: 'INVALID_TOTAL',
        message: 'Gesamtbetrag ungültig',
      });
    }

    const rawFee = event.settings?.shop?.serviceFee;
    const serviceFee =
      typeof rawFee === 'number' && rawFee > 0 ? Number(rawFee.toFixed(2)) : 0;
    const totalAmount = Number((itemsTotal + serviceFee).toFixed(2));

    const fulfillmentType =
      body.fulfillmentType === ShopCheckoutFulfillment.TABLE_SERVICE
        ? ShopCheckoutFulfillment.TABLE_SERVICE
        : ShopCheckoutFulfillment.COUNTER_PICKUP;
    const tableNumber =
      fulfillmentType === ShopCheckoutFulfillment.TABLE_SERVICE
        ? String(body.tableNumber ?? '')
            .trim()
            .slice(0, 50) || ''
        : '';
    if (
      fulfillmentType === ShopCheckoutFulfillment.TABLE_SERVICE &&
      !tableNumber
    ) {
      throw new BadRequestException({
        code: 'TABLE_NUMBER_REQUIRED',
        message: 'Bitte gib eine Tischnummer an',
      });
    }

    const checkout = this.shopCheckoutRepository.create({
      organizationId: organization.id,
      eventId: event.id,
      email: body.email.trim().toLowerCase(),
      customerName: body.customerName ?? null,
      items,
      totalAmount: totalAmount.toFixed(2),
      serviceFee: serviceFee.toFixed(2),
      fulfillmentType,
      tableNumber: tableNumber || null,
      currency,
      status: ShopCheckoutStatus.PENDING,
    });
    await this.shopCheckoutRepository.save(checkout);

    // Browser redirect after payment -> shop return page (polls verify).
    const returnBase =
      process.env.SHOP_RETURN_URL_BASE || 'https://shop.openeos.de';
    const returnUrl = `${returnBase}/${event.id}/checkout/return?checkoutId=${checkout.id}`;

    // Server webhook -> settles the checkout (creates the order) even when
    // the customer never makes it back to the shop after paying.
    const apiBase = process.env.API_PUBLIC_URL || 'https://api.openeos.de';
    const webhookUrl = `${apiBase}/api/public/shop/checkout/${checkout.id}/webhook`;

    const sumup = await this.sumupApi.createOnlineCheckout(
      apiKey,
      merchantCode,
      {
        amount: Number(totalAmount.toFixed(2)),
        currency,
        description: `Shop · ${event.name}`,
        checkoutReference: checkout.id,
        returnUrl: webhookUrl,
        redirectUrl: returnUrl,
      },
    );

    checkout.sumupCheckoutId = sumup.id;
    checkout.sumupCheckoutUrl = sumup.checkoutUrl;
    await this.shopCheckoutRepository.save(checkout);

    return {
      data: {
        checkoutId: checkout.id,
        sumupCheckoutUrl: sumup.checkoutUrl,
        returnUrl,
      },
    };
  }

  @Get('checkout/:checkoutId/verify')
  @ApiOperation({
    summary:
      'Verify SumUp checkout status; idempotently create the Order on PAID',
  })
  async verifyCheckout(@Param('checkoutId', ParseUUIDPipe) checkoutId: string) {
    const checkout = await this.shopCheckoutRepository.findOne({
      where: { id: checkoutId },
    });
    if (!checkout) {
      throw new NotFoundException({
        code: 'CHECKOUT_NOT_FOUND',
        message: 'Checkout nicht gefunden',
      });
    }

    return { data: await this.settleCheckout(checkout) };
  }

  /**
   * SumUp posts asynchronous payment-status updates here (the checkout's
   * return_url). The payload is NOT trusted — settleCheckout re-verifies the
   * status against the SumUp API before creating the order. This makes order
   * creation independent of the customer returning to the shop.
   */
  @Post('checkout/:checkoutId/webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'SumUp payment-status webhook; settles the checkout server-side',
  })
  async checkoutWebhook(
    @Param('checkoutId', ParseUUIDPipe) checkoutId: string,
  ) {
    const checkout = await this.shopCheckoutRepository.findOne({
      where: { id: checkoutId },
    });
    if (!checkout) {
      // Always answer 200 — SumUp retries on errors and the checkout may
      // simply be unknown (e.g. deleted test data).
      return { received: true };
    }

    try {
      const result = await this.settleCheckout(checkout);
      this.logger.log(`Shop checkout webhook ${checkoutId}: ${result.status}`);
    } catch (error) {
      this.logger.error(
        `Shop checkout webhook ${checkoutId} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    return { received: true };
  }

  private async settleCheckout(checkout: ShopCheckout): Promise<{
    status: 'pending' | 'paid' | 'failed' | 'cancelled';
    orderNumber?: string | null;
  }> {
    if (checkout.status === ShopCheckoutStatus.PAID && checkout.orderId) {
      const order = await this.orderRepository.findOne({
        where: { id: checkout.orderId },
      });
      return {
        status: 'paid' as const,
        orderNumber: order?.orderNumber ?? null,
      };
    }

    if (!checkout.sumupCheckoutId) {
      return { status: checkout.status as 'pending' | 'failed' | 'cancelled' };
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: checkout.organizationId },
    });
    const orgSettings = organization?.settings as {
      sumup?: { apiKey?: string };
    } | null;
    const apiKey = orgSettings?.sumup?.apiKey;
    if (!apiKey) {
      return { status: checkout.status as 'pending' | 'failed' | 'cancelled' };
    }

    let sumupStatus: string | undefined;
    try {
      const res = await fetch(
        `${sumUpApiBaseUrl()}/v0.1/checkouts/${encodeURIComponent(checkout.sumupCheckoutId)}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
        },
      );
      if (res.ok) {
        const json = (await res.json()) as { status?: string };
        sumupStatus = json.status;
      }
    } catch {
      // Network error — keep pending
    }

    if (sumupStatus === 'PAID') {
      // Claim the PENDING -> PAID transition atomically: the webhook and the
      // return-page polling may settle concurrently, only the claimer creates
      // the order.
      const claim = await this.shopCheckoutRepository.update(
        { id: checkout.id, status: ShopCheckoutStatus.PENDING },
        { status: ShopCheckoutStatus.PAID, paidAt: new Date() },
      );
      if (!claim.affected) {
        const fresh = await this.shopCheckoutRepository.findOne({
          where: { id: checkout.id },
        });
        if (fresh?.status === ShopCheckoutStatus.PAID && fresh.orderId) {
          const order = await this.orderRepository.findOne({
            where: { id: fresh.orderId },
          });
          return {
            status: 'paid' as const,
            orderNumber: order?.orderNumber ?? null,
          };
        }
        // Another request is mid-settlement — report pending so pollers retry.
        return { status: 'pending' as const };
      }

      let settled: { order: Order; payment: Payment };
      try {
        settled = await this.createOrderFromCheckout(checkout);
        checkout.status = ShopCheckoutStatus.PAID;
        checkout.orderId = settled.order.id;
        await this.shopCheckoutRepository.save(checkout);
      } catch (error) {
        // Release the claim so a later verify/webhook retries order creation.
        await this.shopCheckoutRepository.update(
          { id: checkout.id },
          { status: ShopCheckoutStatus.PENDING, paidAt: null },
        );
        throw error;
      }
      // Only the claimer gets here, once per checkout: sign, then print.
      await this.signAndPrint(settled.order, settled.payment);
      // Fire-and-forget — a failed mail must never fail the settlement.
      void this.sendOrderConfirmation(checkout, settled.order);
      return {
        status: 'paid' as const,
        orderNumber: settled.order.orderNumber,
      };
    }

    if (sumupStatus === 'FAILED' || sumupStatus === 'EXPIRED') {
      checkout.status = ShopCheckoutStatus.FAILED;
      await this.shopCheckoutRepository.save(checkout);
      return { status: 'failed' as const };
    }

    if (sumupStatus === 'CANCELLED' || sumupStatus === 'CANCELED') {
      checkout.status = ShopCheckoutStatus.CANCELLED;
      await this.shopCheckoutRepository.save(checkout);
      return { status: 'cancelled' as const };
    }

    return { status: 'pending' as const };
  }

  /** Confirmation/receipt mail to the shopper, sent once the order exists. */
  private async sendOrderConfirmation(
    checkout: ShopCheckout,
    order: Order,
  ): Promise<void> {
    try {
      if (!checkout.email) return;

      const [event, organization] = await Promise.all([
        this.eventRepository.findOne({ where: { id: checkout.eventId } }),
        this.organizationRepository.findOne({
          where: { id: checkout.organizationId },
        }),
      ]);

      const formatAmount = (value: number) =>
        new Intl.NumberFormat('de-DE', {
          style: 'currency',
          currency: checkout.currency || 'EUR',
        }).format(value);

      const rows = checkout.items
        .map((item) => {
          const lineTotal =
            lineUnitPrice(Number(item.unitPrice), item.options) * item.quantity;
          const optionsText = (item.options || [])
            .map((o) => (o.excluded ? `ohne ${o.option}` : o.option))
            .join(', ');
          // itemsHtml ist fertiges HTML: Namen aus dem Warenkorb maskieren.
          return `<tr>
            <td style="padding: 4px 8px 4px 0;">${item.quantity}× ${escapeHtml(item.name)}${
              optionsText
                ? `<br><span style="color: #666; font-size: 12px;">${escapeHtml(optionsText)}</span>`
                : ''
            }</td>
            <td style="padding: 4px 0; text-align: right; white-space: nowrap;">${formatAmount(lineTotal)}</td>
          </tr>`;
        })
        .join('');

      const serviceFee = Number(checkout.serviceFee || 0);
      const feeRow =
        serviceFee > 0
          ? `<tr>
            <td style="padding: 4px 8px 4px 0; color: #666;">Servicegebühr</td>
            <td style="padding: 4px 0; text-align: right;">${formatAmount(serviceFee)}</td>
          </tr>`
          : '';

      const name = [
        checkout.customerName?.firstName,
        checkout.customerName?.lastName,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();

      await this.emailService.sendShopOrderConfirmationEmail({
        to: checkout.email,
        name,
        organizationName: organization?.name || 'OpenEOS',
        eventName: event?.name || 'Event',
        orderNumber: order.orderNumber,
        tableNumber: checkout.tableNumber,
        itemsHtml: `<table style="width: 100%; border-collapse: collapse; font-size: 14px;">${rows}${feeRow}</table>`,
        totalFormatted: formatAmount(Number(checkout.totalAmount)),
      });
      this.logger.log(
        `Order confirmation sent for ${order.orderNumber} to ${checkout.email}`,
      );
    } catch (error) {
      this.logger.warn(
        `Order confirmation mail for ${order.orderNumber} failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  private async createOrderFromCheckout(
    checkout: ShopCheckout,
  ): Promise<{ order: Order; payment: Payment }> {
    const nameParts = [
      checkout.customerName?.firstName,
      checkout.customerName?.lastName,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    const customerName = nameParts || null;

    const productIds = checkout.items.map((i) => i.productId);
    const products = await this.productRepository.find({
      where: { id: In(productIds), eventId: checkout.eventId },
    });
    const categoryIds = Array.from(
      new Set(
        products.map((p) => p.categoryId).filter((id): id is string => !!id),
      ),
    );
    const categories = categoryIds.length
      ? await this.categoryRepository.find({ where: { id: In(categoryIds) } })
      : [];

    const total = Number(checkout.totalAmount);
    const fee = Number(checkout.serviceFee || 0);
    const subtotal = Number((total - fee).toFixed(2));
    const feeNote =
      fee > 0 ? ` · Servicegebühr: ${fee.toFixed(2)} ${checkout.currency}` : '';

    const isTableService =
      checkout.fulfillmentType === ShopCheckoutFulfillment.TABLE_SERVICE;
    const orderFulfillmentType = isTableService
      ? OrderFulfillmentType.TABLE_SERVICE
      : OrderFulfillmentType.COUNTER_PICKUP;
    const orderTableNumber = isTableService ? checkout.tableNumber : null;
    const fulfillmentNote = isTableService
      ? ` · An den Tisch ${checkout.tableNumber ?? '-'}`
      : ' · Abholung';

    // Tisch best effort ueber die Bezeichnung zuordnen; ohne Treffer bleibt
    // es bei der freien Tischnummer (strenge Pruefung erst mit Tischauswahl).
    const orderTableId = orderTableNumber
      ? await findTableIdByLabel(
          this.orderRepository.manager,
          checkout.organizationId,
          orderTableNumber,
        )
      : null;

    // Order number (S-YYYYMMDD-NNNN) and daily number are allocated
    // together with the insert.
    const order = await saveOrderWithNumbers(
      this.orderRepository,
      {
        organizationId: checkout.organizationId,
        eventId: checkout.eventId,
        prefix: 'S-',
      },
      {
        tableNumber: orderTableNumber,
        tableId: orderTableId,
        customerName,
        status: OrderStatus.OPEN,
        paymentStatus: OrderPaymentStatus.PAID,
        fulfillmentType: orderFulfillmentType,
        source: OrderSource.ONLINE,
        subtotal,
        total,
        paidAmount: total,
        tipAmount: 0,
        // Eigene Leistung des Vereins mit eigenem Satz (Bon, Kassenbeleg,
        // DSFinV-K), nicht anteilig in den Waren.
        serviceFee: fee,
        serviceFeeTaxRate: fee > 0 ? SERVICE_FEE_TAX_RATE : null,
        discountAmount: 0,
        // Wird nach dem Anlegen der Positionen berechnet (unten).
        taxTotal: 0,
        notes: `Shop-Bestellung (online bezahlt) · ${checkout.email}${fulfillmentNote}${feeNote}`,
      },
    );

    const items = checkout.items.map((line) => {
      const product = products.find((p) => p.id === line.productId);
      const category = product?.categoryId
        ? categories.find((c) => c.id === product.categoryId)
        : undefined;
      const selectedOptions = (line.options ?? []).filter((o) => !o.excluded);
      const optionsPrice = selectedOptions.reduce(
        (acc, o) =>
          acc + (Number(o.priceModifier) > 0 ? Number(o.priceModifier) : 0),
        0,
      );
      const linePrice = line.unitPrice + optionsPrice;
      return this.orderItemRepository.create({
        orderId: order.id,
        productId: line.productId,
        categoryId: product?.categoryId ?? '',
        productName: line.name,
        categoryName: category?.name ?? '',
        // Snapshot the production station (Standort) so per_station kitchen
        // printing routes shop items to the right station printer.
        productionStationId:
          product?.productionStationId ?? category?.productionStationId ?? null,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        optionsPrice,
        // Satz des Produkts wie an der Kasse — bisher stand hier fest 0.
        taxRate: Number(product?.taxRate) || 0,
        totalPrice: linePrice * line.quantity,
        options: {
          selected: selectedOptions.map((o) => ({
            group: o.group,
            option: o.option,
            priceModifier: Number(o.priceModifier) || 0,
          })),
        },
      });
    });
    await this.orderItemRepository.save(items);

    /* Die Steuer ergibt sich erst aus den Positionen; die Servicegebuehr
       (nicht in `subtotal`) zaehlt mit ihrem eigenen Satz. */
    const organization = await this.organizationRepository.findOne({
      where: { id: order.organizationId },
      select: ['id', 'settings'],
    });
    order.taxTotal = orderTaxTotal(
      items,
      0,
      organization?.settings?.vatExempt,
      serviceFeeOf(order),
    );
    await this.orderRepository.save(order);

    const payment = this.paymentRepository.create({
      orderId: order.id,
      amount: total,
      paymentMethod: PaymentMethod.SUMUP_ONLINE,
      paymentProvider: PaymentProvider.SUMUP,
      providerTransactionId: checkout.sumupCheckoutId,
      status: PaymentTransactionStatus.CAPTURED,
      metadata: { receiptUrl: checkout.sumupCheckoutUrl ?? undefined },
    });
    await this.paymentRepository.save(payment);

    // Kassen und Verwaltung sehen die Gastbestellung sofort (Tischstatus
    // „wartet“, Bestellliste) statt erst beim naechsten Abfragen.
    this.gatewayService.notifyOrderCreated(
      order.organizationId,
      order.eventId,
      {
        id: order.id,
        orderNumber: order.orderNumber,
        dailyNumber: order.dailyNumber,
        tableNumber: order.tableNumber || undefined,
        customerName: order.customerName || undefined,
        status: order.status,
        fulfillmentType: order.fulfillmentType,
        source: order.source,
        items: items.map((item) => ({
          id: item.id,
          productName: item.productName,
          quantity: item.quantity,
          status: item.status,
          notes: item.notes || undefined,
          kitchenNotes: item.kitchenNotes || undefined,
        })),
      },
    );

    return { order, payment };
  }

  /**
   * Nach dem Speichern von Bestellung, Zahlung und Checkout: mit aktiver
   * Cloud-TSE zuerst der Kassenbeleg der Online-Zahlung (Kassenbeleg-V1,
   * Zahlart Unbar, DSFinV-K `ElZahlungsdienstleister`), dann Kuechenbon
   * und Kassenbon mit den TSE-Daten. Ohne TSE wie bisher. Die Signatur
   * wirft nie (bei Ausfall ein Vorgang `failed`, der Bon traegt den
   * Vermerk); gedruckt wird ohne zu warten — ein Druckfehler bricht den
   * Checkout nie ab.
   */
  private async signAndPrint(order: Order, payment: Payment): Promise<void> {
    let tse: TseReceiptView | null = null;
    if (
      this.tseSigning &&
      (await this.tseSigning.isActive(order.organizationId))
    ) {
      tse = await this.tseSigning.signPayment(payment.id);
    }

    // Kitchen ticket + receipt for the paid shop order. There is no POS
    // device, so routing relies on the org print settings / production-station
    // printers.
    this.orderPrintService
      .handleOrderCreated(order.organizationId, {
        order,
        orderId: order.id,
        orderNumber: order.orderNumber,
        tableNumber: order.tableNumber,
        total: Number(order.total),
        source: order.source,
        tse,
      })
      .catch((err) =>
        this.logger.error(
          `Shop order ${order.id} kitchen print failed: ${(err as Error)?.message}`,
        ),
      );
    this.orderPrintService
      .handlePaymentReceived(order.organizationId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: payment.id,
        amount: Number(payment.amount),
        paymentMethod: 'online',
        isFullyPaid: true,
        order,
        tse,
      })
      .catch((err) =>
        this.logger.error(
          `Shop order ${order.id} receipt print failed: ${(err as Error)?.message}`,
        ),
      );
  }
}
