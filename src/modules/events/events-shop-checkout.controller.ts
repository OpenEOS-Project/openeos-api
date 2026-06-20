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
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
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
import { SumUpApiService } from '../sumup/sumup-api.service';
import { EmailService } from '../email/email.service';
import { OrderPrintService } from '../print-jobs/order-print.service';

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

function lineUnitPrice(unit: number, options?: ShopCheckoutItemOption[]): number {
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
  ) {}

  private async loadShopEvent(eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({ where: { id: eventId } });
    const shopEnabled = event?.settings?.shop?.enabled === true;
    const isLive = event?.status === EventStatus.ACTIVE || event?.status === EventStatus.TEST;
    if (!event || !shopEnabled || !isLive) {
      throw new NotFoundException({
        code: 'SHOP_NOT_FOUND',
        message: 'Shop nicht gefunden oder nicht aktiviert',
      });
    }
    return event;
  }

  @Post(':eventId/checkout')
  @ApiOperation({ summary: 'Create a pending shop checkout + SumUp Online Checkout session' })
  async createCheckout(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() body: CreateCheckoutBody,
  ) {
    const event = await this.loadShopEvent(eventId);

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
      throw new NotFoundException({ code: 'ORG_NOT_FOUND', message: 'Organisation nicht gefunden' });
    }
    const orgSettings = organization.settings as
      | { sumup?: { apiKey?: string; merchantCode?: string }; currency?: string }
      | null;
    const apiKey = orgSettings?.sumup?.apiKey;
    const merchantCode = orgSettings?.sumup?.merchantCode;
    if (!apiKey || !merchantCode) {
      throw new BadRequestException({
        code: 'SUMUP_NOT_CONFIGURED',
        message: 'Online-Bezahlung ist für diese Organisation nicht konfiguriert',
      });
    }
    const currency = orgSettings.currency || 'EUR';

    const productIds = body.items.map((i) => i.productId);
    const products = await this.productRepository.find({
      where: { id: In(productIds), eventId, isActive: true, isAvailable: true },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException({
        code: 'INVALID_ITEMS',
        message: 'Mindestens ein Artikel ist nicht mehr verfügbar',
      });
    }

    const items: ShopCheckoutItem[] = body.items.map((line) => {
      const product = products.find((p) => p.id === line.productId)!;
      const quantity = Math.max(1, Math.floor(Number(line.quantity) || 0));
      const options = Array.isArray(line.options)
        ? line.options.map((o) => ({
            group: String(o.group ?? ''),
            option: String(o.option ?? ''),
            priceModifier: Number(o.priceModifier) || 0,
            excluded: o.excluded === true ? true : undefined,
          }))
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
    const serviceFee = typeof rawFee === 'number' && rawFee > 0 ? Number(rawFee.toFixed(2)) : 0;
    const totalAmount = Number((itemsTotal + serviceFee).toFixed(2));

    const fulfillmentType =
      body.fulfillmentType === ShopCheckoutFulfillment.TABLE_SERVICE
        ? ShopCheckoutFulfillment.TABLE_SERVICE
        : ShopCheckoutFulfillment.COUNTER_PICKUP;
    const tableNumber =
      fulfillmentType === ShopCheckoutFulfillment.TABLE_SERVICE
        ? String(body.tableNumber ?? '').trim().slice(0, 50) || ''
        : '';
    if (fulfillmentType === ShopCheckoutFulfillment.TABLE_SERVICE && !tableNumber) {
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
    const returnBase = process.env.SHOP_RETURN_URL_BASE || 'https://shop.openeos.de';
    const returnUrl = `${returnBase}/${event.id}/checkout/return?checkoutId=${checkout.id}`;

    // Server webhook -> settles the checkout (creates the order) even when
    // the customer never makes it back to the shop after paying.
    const apiBase = process.env.API_PUBLIC_URL || 'https://api.openeos.de';
    const webhookUrl = `${apiBase}/api/public/shop/checkout/${checkout.id}/webhook`;

    const sumup = await this.sumupApi.createOnlineCheckout(apiKey, merchantCode, {
      amount: Number(totalAmount.toFixed(2)),
      currency,
      description: `Shop · ${event.name}`,
      checkoutReference: checkout.id,
      returnUrl: webhookUrl,
      redirectUrl: returnUrl,
    });

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
  @ApiOperation({ summary: 'Verify SumUp checkout status; idempotently create the Order on PAID' })
  async verifyCheckout(@Param('checkoutId', ParseUUIDPipe) checkoutId: string) {
    const checkout = await this.shopCheckoutRepository.findOne({ where: { id: checkoutId } });
    if (!checkout) {
      throw new NotFoundException({ code: 'CHECKOUT_NOT_FOUND', message: 'Checkout nicht gefunden' });
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
  @ApiOperation({ summary: 'SumUp payment-status webhook; settles the checkout server-side' })
  async checkoutWebhook(@Param('checkoutId', ParseUUIDPipe) checkoutId: string) {
    const checkout = await this.shopCheckoutRepository.findOne({ where: { id: checkoutId } });
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
      const order = await this.orderRepository.findOne({ where: { id: checkout.orderId } });
      return { status: 'paid' as const, orderNumber: order?.orderNumber ?? null };
    }

    if (!checkout.sumupCheckoutId) {
      return { status: checkout.status as 'pending' | 'failed' | 'cancelled' };
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: checkout.organizationId },
    });
    const orgSettings = organization?.settings as
      | { sumup?: { apiKey?: string } }
      | null;
    const apiKey = orgSettings?.sumup?.apiKey;
    if (!apiKey) {
      return { status: checkout.status as 'pending' | 'failed' | 'cancelled' };
    }

    let sumupStatus: string | undefined;
    try {
      const res = await fetch(
        `https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(checkout.sumupCheckoutId)}`,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
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
        const fresh = await this.shopCheckoutRepository.findOne({ where: { id: checkout.id } });
        if (fresh?.status === ShopCheckoutStatus.PAID && fresh.orderId) {
          const order = await this.orderRepository.findOne({ where: { id: fresh.orderId } });
          return { status: 'paid' as const, orderNumber: order?.orderNumber ?? null };
        }
        // Another request is mid-settlement — report pending so pollers retry.
        return { status: 'pending' as const };
      }

      try {
        const order = await this.createOrderFromCheckout(checkout);
        checkout.status = ShopCheckoutStatus.PAID;
        checkout.orderId = order.id;
        await this.shopCheckoutRepository.save(checkout);
        // Fire-and-forget — a failed mail must never fail the settlement.
        void this.sendOrderConfirmation(checkout, order);
        return { status: 'paid' as const, orderNumber: order.orderNumber };
      } catch (error) {
        // Release the claim so a later verify/webhook retries order creation.
        await this.shopCheckoutRepository.update(
          { id: checkout.id },
          { status: ShopCheckoutStatus.PENDING, paidAt: null },
        );
        throw error;
      }
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
  private async sendOrderConfirmation(checkout: ShopCheckout, order: Order): Promise<void> {
    try {
      if (!checkout.email) return;

      const [event, organization] = await Promise.all([
        this.eventRepository.findOne({ where: { id: checkout.eventId } }),
        this.organizationRepository.findOne({ where: { id: checkout.organizationId } }),
      ]);

      const formatAmount = (value: number) =>
        new Intl.NumberFormat('de-DE', {
          style: 'currency',
          currency: checkout.currency || 'EUR',
        }).format(value);

      const rows = checkout.items
        .map((item) => {
          const lineTotal = lineUnitPrice(Number(item.unitPrice), item.options) * item.quantity;
          const optionsText = (item.options || [])
            .map((o) => (o.excluded ? `ohne ${o.option}` : o.option))
            .join(', ');
          return `<tr>
            <td style="padding: 4px 8px 4px 0;">${item.quantity}× ${item.name}${
              optionsText ? `<br><span style="color: #666; font-size: 12px;">${optionsText}</span>` : ''
            }</td>
            <td style="padding: 4px 0; text-align: right; white-space: nowrap;">${formatAmount(lineTotal)}</td>
          </tr>`;
        })
        .join('');

      const serviceFee = Number(checkout.serviceFee || 0);
      const feeRow = serviceFee > 0
        ? `<tr>
            <td style="padding: 4px 8px 4px 0; color: #666;">Servicegebühr</td>
            <td style="padding: 4px 0; text-align: right;">${formatAmount(serviceFee)}</td>
          </tr>`
        : '';

      const name = [checkout.customerName?.firstName, checkout.customerName?.lastName]
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
      this.logger.log(`Order confirmation sent for ${order.orderNumber} to ${checkout.email}`);
    } catch (error) {
      this.logger.warn(
        `Order confirmation mail for ${order.orderNumber} failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  private async createOrderFromCheckout(checkout: ShopCheckout): Promise<Order> {
    const nameParts = [checkout.customerName?.firstName, checkout.customerName?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    const customerName = nameParts || null;

    const productIds = checkout.items.map((i) => i.productId);
    const products = await this.productRepository.find({ where: { id: In(productIds) } });
    const categoryIds = Array.from(
      new Set(products.map((p) => p.categoryId).filter((id): id is string => !!id)),
    );
    const categories = categoryIds.length
      ? await this.categoryRepository.find({ where: { id: In(categoryIds) } })
      : [];

    const dailyNumber = await this.getNextDailyNumber(checkout.organizationId);
    const orderNumber = `S-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${dailyNumber.toString().padStart(4, '0')}`;

    const total = Number(checkout.totalAmount);
    const fee = Number(checkout.serviceFee || 0);
    const subtotal = Number((total - fee).toFixed(2));
    const feeNote = fee > 0 ? ` · Servicegebühr: ${fee.toFixed(2)} ${checkout.currency}` : '';

    const isTableService = checkout.fulfillmentType === ShopCheckoutFulfillment.TABLE_SERVICE;
    const orderFulfillmentType = isTableService
      ? OrderFulfillmentType.TABLE_SERVICE
      : OrderFulfillmentType.COUNTER_PICKUP;
    const orderTableNumber = isTableService ? checkout.tableNumber : null;
    const fulfillmentNote = isTableService
      ? ` · An den Tisch ${checkout.tableNumber ?? '-'}`
      : ' · Abholung';

    const order = this.orderRepository.create({
      organizationId: checkout.organizationId,
      eventId: checkout.eventId,
      orderNumber,
      dailyNumber,
      tableNumber: orderTableNumber,
      customerName,
      status: OrderStatus.OPEN,
      paymentStatus: OrderPaymentStatus.PAID,
      fulfillmentType: orderFulfillmentType,
      source: OrderSource.ONLINE,
      subtotal,
      total,
      paidAmount: total,
      tipAmount: 0,
      discountAmount: 0,
      taxTotal: 0,
      notes: `Shop-Bestellung (online bezahlt) · ${checkout.email}${fulfillmentNote}${feeNote}`,
    });
    await this.orderRepository.save(order);

    const items = checkout.items.map((line) => {
      const product = products.find((p) => p.id === line.productId);
      const category = product?.categoryId
        ? categories.find((c) => c.id === product.categoryId)
        : undefined;
      const selectedOptions = (line.options ?? []).filter((o) => !o.excluded);
      const optionsPrice = selectedOptions.reduce(
        (acc, o) => acc + (Number(o.priceModifier) > 0 ? Number(o.priceModifier) : 0),
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
        taxRate: 0,
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

    // Print kitchen ticket + receipt for the paid shop order. There is no POS
    // device, so routing relies on the org print settings / production-station
    // printers. Fire-and-forget so a printing hiccup never fails checkout.
    this.orderPrintService
      .handleOrderCreated(order.organizationId, {
        order,
        orderId: order.id,
        orderNumber: order.orderNumber,
        tableNumber: order.tableNumber,
        total: Number(order.total),
        source: order.source,
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
      })
      .catch((err) =>
        this.logger.error(
          `Shop order ${order.id} receipt print failed: ${(err as Error)?.message}`,
        ),
      );

    return order;
  }

  private async getNextDailyNumber(organizationId: string): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const count = await this.orderRepository
      .createQueryBuilder('o')
      .where('o.organization_id = :orgId', { orgId: organizationId })
      .andWhere('o.created_at >= :today', { today })
      .getCount();
    return count + 1;
  }
}
