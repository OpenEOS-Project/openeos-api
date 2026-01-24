import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  OnlineOrderSession,
  QrCode,
  Product,
  Category,
  Order,
  OrderItem,
} from '../../database/entities';
import { OnlineOrderSessionStatus } from '../../database/entities/online-order-session.entity';
import { OrderStatus, PaymentStatus, OrderSource } from '../../database/entities/order.entity';
import { OrderItemStatus } from '../../database/entities/order-item.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { StartSessionDto, AddCartItemDto, UpdateCartItemDto, SubmitOrderDto } from './dto';

@Injectable()
export class OnlineOrdersService {
  private readonly logger = new Logger(OnlineOrdersService.name);
  private readonly SESSION_TTL_HOURS = 2;

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
  ) {}

  async startSession(startDto: StartSessionDto): Promise<{ sessionToken: string; session: OnlineOrderSession }> {
    const qrCode = await this.qrCodeRepository.findOne({
      where: { code: startDto.code, isActive: true },
      relations: ['organization', 'event'],
    });

    if (!qrCode) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'QR-Code nicht gefunden oder nicht aktiv',
      });
    }

    // Generate session token
    const sessionToken = this.generateSessionToken();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.SESSION_TTL_HOURS);

    const session = this.sessionRepository.create({
      organizationId: qrCode.organizationId,
      eventId: qrCode.eventId,
      qrCodeId: qrCode.id,
      sessionToken,
      tableNumber: qrCode.tableNumber,
      status: OnlineOrderSessionStatus.ACTIVE,
      cart: { items: [], updatedAt: new Date().toISOString() },
      expiresAt,
    });

    await this.sessionRepository.save(session);

    // Update QR code scan count
    qrCode.scanCount += 1;
    qrCode.lastScannedAt = new Date();
    await this.qrCodeRepository.save(qrCode);

    this.logger.log(`Session started: ${session.id} for QR ${qrCode.code}`);

    return { sessionToken, session };
  }

  async getSession(sessionToken: string): Promise<OnlineOrderSession> {
    const session = await this.sessionRepository.findOne({
      where: { sessionToken },
      relations: ['qrCode', 'organization'],
    });

    if (!session) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Sitzung nicht gefunden',
      });
    }

    if (session.isExpired()) {
      session.status = OnlineOrderSessionStatus.EXPIRED;
      await this.sessionRepository.save(session);
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Sitzung abgelaufen',
      });
    }

    return session;
  }

  async getMenu(sessionToken: string): Promise<{ categories: Category[]; products: Product[] }> {
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

  async addToCart(sessionToken: string, addDto: AddCartItemDto): Promise<OnlineOrderSession> {
    const session = await this.getSession(sessionToken);

    if (!session.eventId) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
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
        message: 'Produkt nicht gefunden oder nicht verfügbar',
      });
    }

    // Check stock
    if (product.trackInventory && product.stockQuantity < addDto.quantity) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nicht genügend Bestand verfügbar',
      });
    }

    // Find existing item in cart
    const existingIndex = session.cart.items.findIndex(
      item => item.productId === addDto.productId &&
              JSON.stringify(item.options) === JSON.stringify(addDto.options || [])
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

  async submitOrder(sessionToken: string, submitDto: SubmitOrderDto): Promise<Order> {
    const session = await this.getSession(sessionToken);

    if (session.cart.items.length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Warenkorb ist leer',
      });
    }

    // Generate order number
    const orderNumber = await this.generateOrderNumber(session.organizationId);
    const dailyNumber = await this.getDailyNumber(session.organizationId, session.eventId);

    // Create order
    const order = this.orderRepository.create({
      organizationId: session.organizationId,
      eventId: session.eventId,
      orderNumber,
      dailyNumber,
      tableNumber: session.tableNumber,
      customerName: submitDto.customerName || session.customerName || null,
      notes: submitDto.notes || null,
      status: OrderStatus.OPEN,
      paymentStatus: PaymentStatus.UNPAID,
      source: OrderSource.QR_ORDER,
      onlineSessionId: session.id,
    });

    await this.orderRepository.save(order);

    // Create order items
    let subtotal = 0;
    let sortOrder = 0;

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

      const totalPrice = (cartItem.unitPrice + optionsPrice) * cartItem.quantity;
      subtotal += totalPrice;

      const orderItem = this.orderItemRepository.create({
        orderId: order.id,
        productId: product.id,
        categoryId: product.categoryId,
        productName: product.name,
        categoryName: product.category?.name || '',
        quantity: cartItem.quantity,
        unitPrice: cartItem.unitPrice,
        optionsPrice,
        taxRate: 19.0, // Default German VAT rate
        totalPrice,
        options: { selected: cartItem.options },
        notes: cartItem.notes || null,
        status: OrderItemStatus.PENDING,
        sortOrder,
      });

      await this.orderItemRepository.save(orderItem);
      sortOrder++;
    }

    // Update order totals
    order.subtotal = subtotal;
    order.total = subtotal;
    await this.orderRepository.save(order);

    // Update session
    session.status = OnlineOrderSessionStatus.ORDERING;
    session.customerName = submitDto.customerName || null;
    await this.sessionRepository.save(session);

    this.logger.log(`Order submitted via online session: ${order.orderNumber}`);

    return this.orderRepository.findOne({
      where: { id: order.id },
      relations: ['items'],
    }) as Promise<Order>;
  }

  async getOrderStatus(sessionToken: string): Promise<Order[]> {
    const session = await this.getSession(sessionToken);

    const orders = await this.orderRepository.find({
      where: { onlineSessionId: session.id },
      relations: ['items'],
      order: { createdAt: 'DESC' },
    });

    return orders;
  }

  private generateSessionToken(): string {
    return `sess_${uuidv4().replace(/-/g, '')}`;
  }

  private async generateOrderNumber(organizationId: string): Promise<string> {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');

    const count = await this.orderRepository.count({
      where: { organizationId },
    });

    return `${dateStr}-${String(count + 1).padStart(4, '0')}`;
  }

  private async getDailyNumber(organizationId: string, eventId: string | null): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.createdAt >= :startOfDay', { startOfDay });

    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    const count = await queryBuilder.getCount();
    return count + 1;
  }
}
