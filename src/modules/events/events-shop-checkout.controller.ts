import {
  Controller,
  Post,
  Get,
  Param,
  ParseUUIDPipe,
  Body,
  BadRequestException,
  NotFoundException,
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
  ShopCheckoutAddress,
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

interface CreateCheckoutBody {
  email: string;
  customerName?: ShopCheckoutCustomerName;
  address?: ShopCheckoutAddress;
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
      address: body.address ?? null,
      items,
      totalAmount: totalAmount.toFixed(2),
      serviceFee: serviceFee.toFixed(2),
      fulfillmentType,
      tableNumber: tableNumber || null,
      currency,
      status: ShopCheckoutStatus.PENDING,
    });
    await this.shopCheckoutRepository.save(checkout);

    const returnBase = process.env.SHOP_RETURN_URL_BASE || 'http://localhost:3004';
    const returnUrl = `${returnBase}/${event.id}/checkout/return?checkoutId=${checkout.id}`;

    const sumup = await this.sumupApi.createOnlineCheckout(apiKey, merchantCode, {
      amount: Number(totalAmount.toFixed(2)),
      currency,
      description: `Shop · ${event.name}`,
      checkoutReference: checkout.id,
      returnUrl,
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

    if (checkout.status === ShopCheckoutStatus.PAID && checkout.orderId) {
      const order = await this.orderRepository.findOne({ where: { id: checkout.orderId } });
      return {
        data: {
          status: 'paid' as const,
          orderNumber: order?.orderNumber ?? null,
        },
      };
    }

    if (!checkout.sumupCheckoutId) {
      return { data: { status: checkout.status as 'pending' | 'failed' | 'cancelled' } };
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: checkout.organizationId },
    });
    const orgSettings = organization?.settings as
      | { sumup?: { apiKey?: string } }
      | null;
    const apiKey = orgSettings?.sumup?.apiKey;
    if (!apiKey) {
      return { data: { status: checkout.status as 'pending' | 'failed' | 'cancelled' } };
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
      const order = await this.createOrderFromCheckout(checkout);
      checkout.status = ShopCheckoutStatus.PAID;
      checkout.orderId = order.id;
      checkout.paidAt = new Date();
      await this.shopCheckoutRepository.save(checkout);
      return { data: { status: 'paid' as const, orderNumber: order.orderNumber } };
    }

    if (sumupStatus === 'FAILED' || sumupStatus === 'EXPIRED') {
      checkout.status = ShopCheckoutStatus.FAILED;
      await this.shopCheckoutRepository.save(checkout);
      return { data: { status: 'failed' as const } };
    }

    if (sumupStatus === 'CANCELLED' || sumupStatus === 'CANCELED') {
      checkout.status = ShopCheckoutStatus.CANCELLED;
      await this.shopCheckoutRepository.save(checkout);
      return { data: { status: 'cancelled' as const } };
    }

    return { data: { status: 'pending' as const } };
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
