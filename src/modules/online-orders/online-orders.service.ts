import {
  assertCashAllowed,
  assertPaymentsAllowed,
} from '../../common/utils/operating-mode.util';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';
import {
  OnlineOrderSession,
  QrCode,
  Product,
  Category,
  Order,
  OrderItem,
  Organization,
  Payment,
} from '../../database/entities';
import { Event } from '../../database/entities/event.entity';
import { OnlineOrderSessionStatus } from '../../database/entities/online-order-session.entity';
import { QrCodeType } from '../../database/entities/qr-code.entity';
import {
  OrderStatus,
  PaymentStatus,
  OrderSource,
  OrderFulfillmentType,
} from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentTransactionStatus,
} from '../../database/entities/payment.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { EventPhaseService } from '../events/event-phase.service';
import { GatewayService } from '../gateway/gateway.service';
import { findTableIdByLabel } from '../tables/table-lookup';
import {
  StartSessionDto,
  AddCartItemDto,
  UpdateCartItemDto,
  SubmitOrderDto,
  CreateOnlinePaymentDto,
  OnlinePaymentMethod,
} from './dto';
import { SumUpService } from '../sumup/sumup.service';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { orderTaxTotal } from '../print-jobs/receipt-tax.util';
import { saveOrderWithNumbers } from '../orders/order-numbering';
import { assertLegalInfoComplete } from '../organizations/legal/legal-settings.util';
import { TseSigningService } from '../tse/tse-signing.service';
import type { TseReceiptView } from '../tse/tse-view';
import { CronLockService } from '../../common/redis/cron-lock.service';

/** Mindestabstand zweier SumUp-Nachfragen je Zahlung aus der Statusseite. */
const SUMUP_LOOKUP_INTERVAL_MS = 3_000;

@Injectable()
export class OnlineOrdersService {
  private readonly logger = new Logger(OnlineOrdersService.name);
  private readonly SESSION_TTL_HOURS = 2;
  /** Letzte Nachfrage bei SumUp je Zahlung (Statusseite pollt). */
  private readonly sumUpLookups = new Map<string, number>();

  constructor(
    @InjectRepository(OnlineOrderSession)
    private readonly sessionRepository: Repository<OnlineOrderSession>,
    @InjectRepository(QrCode)
    private readonly qrCodeRepository: Repository<QrCode>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    private readonly sumUpService: SumUpService,
    private readonly configService: ConfigService,
    private readonly orderPrintService: OrderPrintService,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    // Optional mit Rueckfall fuer von Hand gebaute Tests (Standardwerte).
    @Optional()
    private readonly eventPhaseService?: EventPhaseService,
    // Cloud-TSE: Kassenbeleg der Online-Zahlung (ohne aktive TSE nichts).
    @Optional()
    private readonly tseSigning?: TseSigningService,
    // Abgleich offener SumUp-Zahlungen nur auf einer Instanz.
    @Optional()
    private readonly cronLock?: CronLockService,
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

  async startSession(
    startDto: StartSessionDto,
  ): Promise<{ sessionToken: string; session: OnlineOrderSession }> {
    // Bestellen am Tisch beginnt mit dem Scan eines QR-Codes: er bindet die
    // Sitzung an Organisation, Veranstaltung und Tisch (qr_code_id ist
    // NOT NULL). Der fruehere Weg „nur organizationId“ endete deshalb in
    // einem 500 — jetzt eine klare Antwort.
    const code = startDto.code?.trim();
    if (!code) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.QR_CODE_REQUIRED,
        message:
          'Zum Bestellen am Tisch bitte den QR-Code scannen — ohne QR-Code geht es nicht.',
      });
    }

    const qrCode = await this.qrCodeRepository.findOne({
      where: { code, isActive: true },
      relations: ['organization', 'event'],
    });

    if (!qrCode) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.QR_CODE_NOT_FOUND,
        message: 'QR-Code nicht gefunden oder nicht aktiv',
      });
    }

    const organizationId = qrCode.organizationId;
    const eventId = qrCode.eventId;
    const qrCodeId = qrCode.id;
    const tableNumber = qrCode.tableNumber || startDto.tableNumber || null;

    // Update scan count
    qrCode.scanCount += 1;
    qrCode.lastScannedAt = new Date();
    await this.qrCodeRepository.save(qrCode);

    this.logger.log(`Session started via QR: ${qrCode.code}`);

    // Generate session token
    const sessionToken = this.generateSessionToken();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.SESSION_TTL_HOURS);

    const session = this.sessionRepository.create({
      organizationId,
      eventId,
      qrCodeId,
      sessionToken,
      tableNumber,
      status: OnlineOrderSessionStatus.ACTIVE,
      cart: { items: [], updatedAt: new Date().toISOString() },
      expiresAt,
    });

    await this.sessionRepository.save(session);
    // Fuer die Antwort (eventName, organizationName) — erst nach dem
    // Speichern, damit nichts ueber die Relationen mitgeschrieben wird.
    session.organization = qrCode.organization;
    session.event = qrCode.event ?? null;

    return { sessionToken, session };
  }

  async getPublicEvents(organizationId: string) {
    const events = await this.orderRepository.manager
      .getRepository(Event)
      .find({
        where: { organizationId, status: In(['active', 'test']) },
        order: { startDate: 'ASC' },
        select: ['id', 'name', 'startDate', 'endDate', 'status'],
      });
    return { data: events };
  }

  async getSession(sessionToken: string): Promise<OnlineOrderSession> {
    const session = await this.sessionRepository.findOne({
      where: { sessionToken },
      relations: ['qrCode', 'organization'],
    });

    if (!session) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORDER_SESSION_NOT_FOUND,
        message: 'Sitzung nicht gefunden',
      });
    }

    if (session.isExpired()) {
      session.status = OnlineOrderSessionStatus.EXPIRED;
      await this.sessionRepository.save(session);
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.ORDER_SESSION_EXPIRED,
        message: 'Sitzung abgelaufen',
      });
    }

    return session;
  }

  async getMenu(
    sessionToken: string,
  ): Promise<{ categories: Category[]; products: Product[] }> {
    const session = await this.getSession(sessionToken);

    if (!session.eventId) {
      return { categories: [], products: [] };
    }

    // Get active categories
    const categories = await this.categoryRepository.find({
      where: { eventId: session.eventId, isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    // Get active and available products
    const products = await this.productRepository.find({
      where: {
        eventId: session.eventId,
        isActive: true,
        isAvailable: true,
      },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    return { categories, products };
  }

  async addToCart(
    sessionToken: string,
    addDto: AddCartItemDto,
  ): Promise<OnlineOrderSession> {
    const session = await this.getSession(sessionToken);
    // Betriebsart „Nur Bons“: keine Bestellung per QR-Code (403).
    assertPaymentsAllowed(session.organization);

    if (!session.eventId) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.NO_EVENT_ASSIGNED,
        message: 'Kein Event zugeordnet',
      });
    }

    const product = await this.productRepository.findOne({
      where: {
        id: addDto.productId,
        eventId: session.eventId,
        isActive: true,
        isAvailable: true,
      },
    });

    if (!product) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.PRODUCT_NOT_FOUND_OR_UNAVAILABLE,
        message: 'Produkt nicht gefunden oder nicht verfügbar',
      });
    }

    // Check stock
    if (product.trackInventory && product.stockQuantity < addDto.quantity) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.INSUFFICIENT_STOCK,
        message: 'Nicht genügend Bestand verfügbar',
      });
    }

    // Find existing item in cart
    const existingIndex = session.cart.items.findIndex(
      (item) =>
        item.productId === addDto.productId &&
        JSON.stringify(item.options) === JSON.stringify(addDto.options || []),
    );

    if (existingIndex >= 0) {
      // Update quantity
      session.cart.items[existingIndex].quantity += addDto.quantity;
      if (addDto.notes) {
        session.cart.items[existingIndex].notes = addDto.notes;
      }
    } else {
      // Add new item
      session.cart.items.push({
        productId: product.id,
        productName: product.name,
        quantity: addDto.quantity,
        unitPrice: Number(product.price),
        options: addDto.options || [],
        notes: addDto.notes,
      });
    }

    session.cart.updatedAt = new Date().toISOString();
    session.status = OnlineOrderSessionStatus.ORDERING;
    await this.sessionRepository.save(session);

    return session;
  }

  async updateCartItem(
    sessionToken: string,
    itemIndex: number,
    updateDto: UpdateCartItemDto,
  ): Promise<OnlineOrderSession> {
    const session = await this.getSession(sessionToken);

    if (itemIndex < 0 || itemIndex >= session.cart.items.length) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.CART_ITEM_NOT_FOUND,
        message: 'Artikel nicht im Warenkorb',
      });
    }

    if (updateDto.quantity === 0) {
      // Remove item
      session.cart.items.splice(itemIndex, 1);
    } else {
      // Update quantity
      session.cart.items[itemIndex].quantity = updateDto.quantity;
      if (updateDto.notes !== undefined) {
        session.cart.items[itemIndex].notes = updateDto.notes;
      }
    }

    session.cart.updatedAt = new Date().toISOString();
    await this.sessionRepository.save(session);

    return session;
  }

  async clearCart(sessionToken: string): Promise<OnlineOrderSession> {
    const session = await this.getSession(sessionToken);

    session.cart = { items: [], updatedAt: new Date().toISOString() };
    session.status = OnlineOrderSessionStatus.ACTIVE;
    await this.sessionRepository.save(session);

    return session;
  }

  async submitOrder(
    sessionToken: string,
    submitDto: SubmitOrderDto,
  ): Promise<Order> {
    const session = await this.getSession(sessionToken);
    // Betriebsart „Nur Bons“: keine Bestellung per QR-Code (403).
    assertPaymentsAllowed(session.organization);
    /* Ohne Impressum und Datenschutzhinweis des Vereins keine Bestellung —
       gleiche Regel wie im Shop (403 LEGAL_INFO_MISSING). Gesperrt wird nur
       das Aufgeben; Bezahlen und Status einer schon aufgegebenen
       Bestellung laufen weiter. */
    assertLegalInfoComplete(
      session.organization,
      'Bestellen per QR-Code ist noch nicht möglich: Es fehlen Impressum oder Datenschutzhinweis des Veranstalters.',
    );

    if (session.cart.items.length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EMPTY_CART,
        message: 'Warenkorb ist leer',
      });
    }

    // Phase der Veranstaltung: inaktiv oder beendet keine Bestellung, vor
    // dem Verkaufsfenster („Geplant“) und im Testmodus eine Testbestellung.
    let plannedTest = false;
    if (session.eventId) {
      const event = await this.orderRepository.manager
        .getRepository(Event)
        .findOne({
          where: {
            id: session.eventId,
            organizationId: session.organizationId,
          },
        });
      if (!event) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.EVENT_NOT_FOUND,
          message: 'Event nicht gefunden',
        });
      }
      plannedTest = (
        await this.eventPhase.prepareOrder(event, 'qr', {
          organization: session.organization,
        })
      ).plannedTest;
    }

    // Tisch best effort ueber die Bezeichnung zuordnen; ohne Treffer bleibt
    // es bei der Tischnummer.
    const tableId = await findTableIdByLabel(
      this.orderRepository.manager,
      session.organizationId,
      session.tableNumber,
    );

    // Create order (order number and daily number are allocated with it)
    const order = await saveOrderWithNumbers(
      this.orderRepository,
      {
        organizationId: session.organizationId,
        eventId: session.eventId,
        plannedTest,
      },
      {
        tableNumber: session.tableNumber,
        tableId,
        customerName: submitDto.customerName || session.customerName || null,
        notes: submitDto.notes || null,
        status: OrderStatus.OPEN,
        paymentStatus: PaymentStatus.UNPAID,
        source: OrderSource.QR_ORDER,
        fulfillmentType:
          session.qrCode?.type === QrCodeType.TABLE
            ? OrderFulfillmentType.TABLE_SERVICE
            : OrderFulfillmentType.COUNTER_PICKUP,
        onlineSessionId: session.id,
      },
    );

    // Create order items
    let subtotal = 0;
    let sortOrder = 0;
    const createdItems: OrderItem[] = [];

    for (const cartItem of session.cart.items) {
      const product = await this.productRepository.findOne({
        where: { id: cartItem.productId },
        relations: ['category'],
      });

      if (!product) continue;

      let optionsPrice = 0;
      for (const opt of cartItem.options) {
        optionsPrice += opt.priceModifier;
      }

      const totalPrice =
        (cartItem.unitPrice + optionsPrice) * cartItem.quantity;
      subtotal += totalPrice;

      const orderItem = this.orderItemRepository.create({
        orderId: order.id,
        productId: product.id,
        categoryId: product.categoryId,
        productName: product.name,
        categoryName: product.category?.name || '',
        // Snapshot the production station (Standort) like the POS path does, so
        // per_station kitchen printing can route online items by station.
        productionStationId:
          product.productionStationId ??
          product.category?.productionStationId ??
          null,
        quantity: cartItem.quantity,
        unitPrice: cartItem.unitPrice,
        optionsPrice,
        // Satz des Produkts festhalten; daraus rechnen Bon und taxTotal.
        taxRate: Number(product.taxRate) || 0,
        totalPrice,
        options: { selected: cartItem.options },
        notes: cartItem.notes || null,
        status: OrderItemStatus.PENDING,
        sortOrder,
      });

      await this.orderItemRepository.save(orderItem);
      createdItems.push(orderItem);
      sortOrder++;
    }

    // Update order totals
    order.subtotal = subtotal;
    order.total = subtotal;
    // Enthaltene Steuer wie an der Kasse und auf dem Bon.
    const organization = await this.organizationRepository.findOne({
      where: { id: session.organizationId },
      select: ['id', 'settings'],
    });
    order.taxTotal = orderTaxTotal(
      createdItems,
      0,
      organization?.settings?.vatExempt,
    );
    await this.orderRepository.save(order);

    // Update session
    session.status = OnlineOrderSessionStatus.ORDERING;
    session.customerName = submitDto.customerName || null;
    await this.sessionRepository.save(session);

    this.logger.log(`Order submitted via online session: ${order.orderNumber}`);

    const completeOrder = (await this.orderRepository.findOne({
      where: { id: order.id },
      relations: ['items'],
    })) as Order;

    // Kassen und Verwaltung sehen die Gastbestellung sofort (Tischstatus).
    this.gatewayService.notifyOrderCreated(
      completeOrder.organizationId,
      completeOrder.eventId,
      {
        id: completeOrder.id,
        orderNumber: completeOrder.orderNumber,
        dailyNumber: completeOrder.dailyNumber,
        tableNumber: completeOrder.tableNumber || undefined,
        customerName: completeOrder.customerName || undefined,
        status: completeOrder.status,
        fulfillmentType: completeOrder.fulfillmentType,
        source: completeOrder.source,
        items: (completeOrder.items ?? []).map((item) => ({
          id: item.id,
          productName: item.productName,
          quantity: item.quantity,
          status: item.status,
          notes: item.notes || undefined,
          kitchenNotes: item.kitchenNotes || undefined,
        })),
      },
    );

    return completeOrder;
  }

  async getOrderStatus(sessionToken: string): Promise<Order[]> {
    const session = await this.getSession(sessionToken);

    // Die Statusseite pollt: offene SumUp-Zahlungen dieser Sitzung bei
    // SumUp nachsehen (gedrosselt), damit eine bezahlte Bestellung auch
    // ohne Webhook und ohne „pay/confirm“ als bezahlt erscheint.
    await this.refreshPendingSumUpPayments(session.id);

    const orders = await this.orderRepository.find({
      where: { onlineSessionId: session.id },
      relations: ['items'],
      order: { createdAt: 'DESC' },
    });

    return orders;
  }

  private async refreshPendingSumUpPayments(sessionId: string): Promise<void> {
    try {
      const pending = await this.paymentRepository.find({
        where: {
          status: PaymentTransactionStatus.PENDING,
          paymentProvider: PaymentProvider.SUMUP,
          order: { onlineSessionId: sessionId },
        },
        relations: ['order'],
      });
      const now = Date.now();
      for (const payment of pending) {
        const last = this.sumUpLookups.get(payment.id) ?? 0;
        if (now - last < SUMUP_LOOKUP_INTERVAL_MS) continue;
        if (this.sumUpLookups.size > 1000) this.sumUpLookups.clear();
        this.sumUpLookups.set(payment.id, now);
        await this.settleSumUpPayment(payment);
      }
    } catch (error) {
      this.logger.warn(
        `Refreshing SumUp payments of session ${sessionId} failed: ${(error as Error).message}`,
      );
    }
  }

  async initiatePayment(
    sessionToken: string,
    payDto: CreateOnlinePaymentDto,
  ): Promise<{ data: unknown }> {
    const session = await this.getSession(sessionToken);
    // Betriebsart „Nur Bons“: keine Bestellung per QR-Code (403).
    assertPaymentsAllowed(session.organization);

    const order = await this.orderRepository.findOne({
      where: {
        onlineSessionId: session.id,
        paymentStatus: PaymentStatus.UNPAID,
      },
      order: { createdAt: 'DESC' },
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.NO_OPEN_ORDER,
        message: 'Keine offene Bestellung gefunden',
      });
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: session.organizationId },
    });

    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    // Positivliste „Bargeldlos“ (Karte, SumUp, Online): eine Zahlart, die
    // dort nicht steht, wird abgewiesen, bevor beim Anbieter etwas entsteht.
    assertCashAllowed(organization, payDto.paymentMethod);

    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || '';
    const returnUrl =
      this.allowedReturnUrl(payDto.returnUrl) || `${frontendUrl}/status`;
    const cancelUrl = `${frontendUrl}/checkout`;
    const description = `OpenEOS Bestellung #${order.dailyNumber}`;

    let paymentData: unknown;

    switch (payDto.paymentMethod) {
      case OnlinePaymentMethod.SUMUP_ONLINE:
      case OnlinePaymentMethod.GOOGLE_PAY:
      case OnlinePaymentMethod.APPLE_PAY: {
        /* Die Zahlung bekommt ihre ID vorab: SumUp meldet den Stand an
           den Webhook dieser Zahlung (`return_url`), der Browser des Gasts
           geht zurueck auf die Bestellseite (`redirect_url`). Gebucht wird
           erst, wenn SumUp selbst „bezahlt“ sagt (settleSumUpPayment). */
        const paymentId = uuidv4();
        const checkoutReference = qrCheckoutReference(paymentId);
        const checkout = await this.sumUpService.createOnlineCheckout(
          session.organizationId,
          Number(order.total),
          'EUR',
          description,
          {
            redirectUrl: returnUrl,
            webhookUrl: `${this.apiPublicUrl()}/api/public/order/pay/${paymentId}/webhook`,
          },
          checkoutReference,
        );

        const paymentMethod =
          payDto.paymentMethod === OnlinePaymentMethod.GOOGLE_PAY
            ? PaymentMethod.GOOGLE_PAY
            : payDto.paymentMethod === OnlinePaymentMethod.APPLE_PAY
              ? PaymentMethod.APPLE_PAY
              : PaymentMethod.SUMUP_ONLINE;

        const payment = this.paymentRepository.create({
          id: paymentId,
          orderId: order.id,
          amount: order.total,
          paymentMethod,
          paymentProvider: PaymentProvider.SUMUP,
          status: PaymentTransactionStatus.PENDING,
          providerTransactionId: checkout.checkoutId,
          metadata: { checkoutId: checkout.checkoutId, checkoutReference },
        });
        await this.paymentRepository.save(payment);

        paymentData = {
          provider: 'sumup',
          paymentId: payment.id,
          checkoutUrl: checkout.checkoutUrl,
          checkoutId: checkout.checkoutId,
        };
        break;
      }

      default:
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.PAYMENT_METHOD_UNSUPPORTED,
          // Dem Typ nach `never` (alle Werte sind oben behandelt); zur
          // Laufzeit steht hier, was der Client tatsaechlich geschickt hat.
          message: `Nicht unterstützte Zahlungsmethode: ${payDto.paymentMethod as string}`,
          params: { method: payDto.paymentMethod as string },
        });
    }

    return { data: paymentData };
  }

  async confirmPayment(
    sessionToken: string,
    paymentId: string,
  ): Promise<{ data: { status: string } }> {
    const session = await this.getSession(sessionToken);

    const payment = await this.paymentRepository.findOne({
      where: { id: paymentId },
      relations: ['order'],
    });

    if (!payment || payment.order.onlineSessionId !== session.id) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.PAYMENT_NOT_FOUND,
        message: 'Zahlung nicht gefunden',
      });
    }

    if (payment.status === PaymentTransactionStatus.CAPTURED) {
      return { data: { status: 'already_captured' } };
    }

    // SumUp (Karte, Google Pay, Apple Pay): bei SumUp nachsehen und bei
    // „bezahlt“ buchen — dieselbe Pruefung wie Webhook und Statusabfrage.
    if (payment.paymentProvider === PaymentProvider.SUMUP) {
      const status = await this.settleSumUpPayment(payment);
      return { data: { status } };
    }

    if (
      payment.paymentProvider === PaymentProvider.PAYPAL &&
      payment.status === PaymentTransactionStatus.PENDING
    ) {
      // PayPal ist seit 1.8 entfernt. Eine offene PayPal-Zahlung von davor
      // wird nie mehr erfasst (ohne Erfassung bucht PayPal nichts ab); der
      // Gast waehlt eine andere Zahlart.
      await this.paymentRepository.update(
        { id: payment.id, status: PaymentTransactionStatus.PENDING },
        { status: PaymentTransactionStatus.FAILED },
      );
      return { data: { status: PaymentTransactionStatus.FAILED } };
    }

    return { data: { status: payment.status } };
  }

  /**
   * SumUp meldet einen neuen Stand des Checkouts dieser Zahlung (Webhook,
   * `return_url`). Der Inhalt der Meldung zaehlt nicht — nachgesehen wird
   * direkt bei SumUp. Wirft nie (SumUp wiederholt sonst).
   */
  async handleSumUpWebhook(paymentId: string): Promise<void> {
    try {
      const payment = await this.paymentRepository.findOne({
        where: { id: paymentId },
        relations: ['order'],
      });
      if (
        !payment ||
        payment.paymentProvider !== PaymentProvider.SUMUP ||
        !payment.order?.onlineSessionId
      ) {
        return;
      }
      const status = await this.settleSumUpPayment(payment);
      this.logger.log(`SumUp webhook for QR payment ${paymentId}: ${status}`);
    } catch (error) {
      this.logger.error(
        `SumUp webhook for QR payment ${paymentId} failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Offene SumUp-Zahlungen der Bestellseite nachpruefen, deren Webhook nie
   * ankam und deren Gast nicht zurueckkam (alle 2 Minuten, eine Instanz).
   */
  @Cron('25 */2 * * * *', { name: 'qr-sumup-reconcile' })
  async reconcilePendingSumUpPayments(): Promise<void> {
    const run = async () => {
      const pending = await this.paymentRepository
        .createQueryBuilder('payment')
        .innerJoinAndSelect('payment.order', 'order')
        .where('payment.status = :status', {
          status: PaymentTransactionStatus.PENDING,
        })
        .andWhere('payment.payment_provider = :provider', {
          provider: PaymentProvider.SUMUP,
        })
        .andWhere('order.online_session_id IS NOT NULL')
        .andWhere("payment.created_at > now() - interval '24 hours'")
        .andWhere("payment.created_at < now() - interval '1 minute'")
        .orderBy('payment.created_at', 'ASC')
        .take(50)
        .getMany();
      for (const payment of pending) {
        try {
          await this.settleSumUpPayment(payment);
        } catch (error) {
          this.logger.error(
            `Reconciling QR payment ${payment.id} failed: ${(error as Error).message}`,
          );
        }
      }
    };
    try {
      if (this.cronLock) {
        await this.cronLock.runExclusive('qr-sumup-reconcile', run);
      } else {
        await run();
      }
    } catch (error) {
      this.logger.error(
        `QR payment reconcile run failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Stand einer SumUp-Zahlung der Bestellseite bei SumUp abfragen und
   * uebernehmen: „bezahlt“ (Betrag, Waehrung und Referenz passen) → genau
   * einmal buchen, signieren und drucken; „fehlgeschlagen“/„abgelaufen“ →
   * Zahlung fehlgeschlagen; sonst bleibt sie offen. Idempotent: Webhook,
   * Rueckkehrseite, Statusabfrage und Abgleich duerfen gleichzeitig kommen.
   */
  async settleSumUpPayment(
    payment: Payment,
  ): Promise<PaymentTransactionStatus> {
    if (payment.status !== PaymentTransactionStatus.PENDING) {
      return payment.status;
    }
    const checkoutId = payment.providerTransactionId;
    const organizationId = payment.order?.organizationId;
    if (!checkoutId || !organizationId) return payment.status;

    const checkout = await this.sumUpService.getOnlineCheckout(
      organizationId,
      checkoutId,
    );
    if (!checkout) return PaymentTransactionStatus.PENDING;

    if (checkout.status === 'PAID') {
      const expectedReference = (
        payment.metadata as { checkoutReference?: string } | null
      )?.checkoutReference;
      const mismatch =
        checkout.id !== checkoutId
          ? 'checkout id'
          : checkout.amount === null ||
              Math.round(checkout.amount * 100) !==
                Math.round(Number(payment.amount) * 100)
            ? 'amount'
            : checkout.currency && checkout.currency !== 'EUR'
              ? 'currency'
              : expectedReference &&
                  checkout.checkoutReference &&
                  checkout.checkoutReference !== expectedReference
                ? 'reference'
                : null;
      if (mismatch) {
        // Nie etwas anderes buchen, als SumUp bestaetigt — bleibt offen
        // und faellt im Log auf.
        this.logger.error(
          `SumUp checkout ${checkoutId} for QR payment ${payment.id} is PAID but the ${mismatch} does not match — not booked`,
        );
        return PaymentTransactionStatus.PENDING;
      }

      const claim = await this.paymentRepository.update(
        { id: payment.id, status: PaymentTransactionStatus.PENDING },
        {
          status: PaymentTransactionStatus.CAPTURED,
          metadata: {
            ...(payment.metadata ?? {}),
            ...(checkout.transactionCode
              ? { transactionCode: checkout.transactionCode }
              : {}),
            ...(checkout.transactionId
              ? { transactionId: checkout.transactionId }
              : {}),
          },
        },
      );
      if (!claim.affected) return PaymentTransactionStatus.CAPTURED;
      payment.status = PaymentTransactionStatus.CAPTURED;
      await this.bookCapturedPayment(payment);
      return PaymentTransactionStatus.CAPTURED;
    }

    if (checkout.status === 'FAILED' || checkout.status === 'EXPIRED') {
      const claim = await this.paymentRepository.update(
        { id: payment.id, status: PaymentTransactionStatus.PENDING },
        { status: PaymentTransactionStatus.FAILED },
      );
      if (claim.affected) payment.status = PaymentTransactionStatus.FAILED;
      return payment.status;
    }

    return PaymentTransactionStatus.PENDING;
  }

  /**
   * Nach dem gewonnenen Wechsel auf CAPTURED (nur einmal je Zahlung):
   * Bestellung bezahlt, Cloud-TSE-Kassenbeleg (Unbar, DSFinV-K
   * `ElZahlungsdienstleister`), Kassen benachrichtigen, dann Kuechen- und
   * Kassenbon. Signieren und Drucken werfen nie.
   */
  private async bookCapturedPayment(payment: Payment): Promise<void> {
    const order =
      (await this.orderRepository.findOne({
        where: { id: payment.orderId },
      })) ?? payment.order;
    order.paidAmount = Number(order.paidAmount) + Number(payment.amount);
    order.paymentStatus =
      Math.round(order.paidAmount * 100) >=
      Math.round(Number(order.total) * 100)
        ? PaymentStatus.PAID
        : PaymentStatus.PARTLY_PAID;
    await this.orderRepository.save(order);

    // Cloud-TSE: Kassenbeleg der Online-Zahlung nach dem Speichern und
    // vor Kuechen- und Kassenbon (wirft nie; ohne aktive TSE nichts).
    let tse: TseReceiptView | null = null;
    if (
      this.tseSigning &&
      (await this.tseSigning.isActive(order.organizationId))
    ) {
      tse = await this.tseSigning.signPayment(payment.id);
    }

    // Kassen und Verwaltung: Tisch bzw. Bestellung ist bezahlt.
    try {
      this.gatewayService?.notifyPaymentReceived(
        order.organizationId,
        order.eventId,
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          paymentId: payment.id,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          paidAmount: Number(order.paidAmount),
          totalAmount: Number(order.total),
          paymentStatus: order.paymentStatus,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Notifying payment ${payment.id} failed: ${(error as Error).message}`,
      );
    }

    // Online orders have no POS device, so the kitchen ticket + receipt are
    // triggered here once payment is captured (routing falls back to the
    // org-level print settings / production-station printers). Fire-and-
    // forget so a printing hiccup never fails the payment.
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
          `Online order ${order.id} kitchen print failed: ${(err as Error)?.message}`,
        ),
      );
    this.orderPrintService
      .handlePaymentReceived(order.organizationId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        paymentId: payment.id,
        amount: Number(payment.amount),
        paymentMethod: 'online',
        isFullyPaid: order.paymentStatus === PaymentStatus.PAID,
        order,
        tse,
      })
      .catch((err) =>
        this.logger.error(
          `Online order ${order.id} receipt print failed: ${(err as Error)?.message}`,
        ),
      );
  }

  /**
   * Rueckkehr-Adresse nach dem Bezahlen nur auf einer der konfigurierten
   * Oberflaechen (FRONTEND_URL, ONLINE_ORDER_BASE_URL, APP_URL,
   * SHOP_RETURN_URL_BASE); alles andere faellt auf die Standardseite zurueck.
   */
  private allowedReturnUrl(candidate: string | undefined): string | null {
    if (!candidate) return null;
    let origin: string;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      origin = url.origin;
    } catch {
      return null;
    }
    const configured = [
      this.configService.get<string>('FRONTEND_URL'),
      this.configService.get<string>('ONLINE_ORDER_BASE_URL') ||
        'https://order.openeos.de',
      this.configService.get<string>('APP_URL'),
      this.configService.get<string>('SHOP_RETURN_URL_BASE'),
    ];
    const allowed = new Set(
      configured.flatMap((value) => {
        if (!value) return [];
        try {
          return [new URL(value).origin];
        } catch {
          return [];
        }
      }),
    );
    return allowed.has(origin) ? candidate : null;
  }

  /** Oeffentliche Adresse dieser API (ohne /api) fuer SumUp-Webhooks. */
  private apiPublicUrl(): string {
    return (
      this.configService.get<string>('API_PUBLIC_URL') ||
      'https://api.openeos.de'
    ).replace(/\/+$/, '');
  }

  private generateSessionToken(): string {
    return `sess_${uuidv4().replace(/-/g, '')}`;
  }
}

/**
 * `checkout_reference` eines SumUp-Checkouts der Bestellseite: an die
 * Zahlung gebunden, damit eine Bestaetigung nie einer anderen Zahlung
 * zugeordnet wird.
 */
export function qrCheckoutReference(paymentId: string): string {
  return `openeos-qr-${paymentId}`;
}
