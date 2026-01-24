import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product, User, UserOrganization, StockMovement, Event } from '../../database/entities';
import { StockMovementType } from '../../database/entities/stock-movement.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreateProductDto, UpdateProductDto, AdjustStockDto } from './dto';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(StockMovement)
    private readonly stockMovementRepository: Repository<StockMovement>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
  ) {}

  async create(
    eventId: string,
    createDto: CreateProductDto,
    user: User,
  ): Promise<Product> {
    const event = await this.getEventAndCheckRole(eventId, user.id, OrganizationRole.MANAGER);

    const product = this.productRepository.create({
      eventId: event.id,
      ...createDto,
    });

    await this.productRepository.save(product);
    this.logger.log(`Product created: ${product.name} (${product.id})`);

    return product;
  }

  async findAll(
    eventId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<Product>> {
    await this.getEventAndCheckMembership(eventId, user.id);

    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.productRepository.findAndCount({
      where: { eventId },
      relations: ['category'],
      skip,
      take: limit,
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(eventId: string, productId: string, user: User): Promise<Product> {
    await this.getEventAndCheckMembership(eventId, user.id);

    const product = await this.productRepository.findOne({
      where: { id: productId, eventId },
      relations: ['category'],
    });

    if (!product) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Produkt nicht gefunden',
      });
    }

    return product;
  }

  async update(
    eventId: string,
    productId: string,
    updateDto: UpdateProductDto,
    user: User,
  ): Promise<Product> {
    await this.getEventAndCheckRole(eventId, user.id, OrganizationRole.MANAGER);

    const product = await this.findOne(eventId, productId, user);
    Object.assign(product, updateDto);
    await this.productRepository.save(product);

    this.logger.log(`Product updated: ${product.name} (${product.id})`);

    return product;
  }

  async remove(eventId: string, productId: string, user: User): Promise<void> {
    await this.getEventAndCheckRole(eventId, user.id, OrganizationRole.ADMIN);

    const product = await this.findOne(eventId, productId, user);
    await this.productRepository.softRemove(product);

    this.logger.log(`Product deleted: ${product.name} (${product.id})`);
  }

  async updateAvailability(
    eventId: string,
    productId: string,
    isAvailable: boolean,
    user: User,
  ): Promise<Product> {
    await this.getEventAndCheckRole(eventId, user.id, OrganizationRole.CASHIER);

    const product = await this.findOne(eventId, productId, user);
    product.isAvailable = isAvailable;
    await this.productRepository.save(product);

    this.logger.log(`Product availability updated: ${product.name} - ${isAvailable}`);

    return product;
  }

  async adjustStock(
    eventId: string,
    productId: string,
    adjustDto: AdjustStockDto,
    user: User,
  ): Promise<Product> {
    await this.getEventAndCheckRole(eventId, user.id, OrganizationRole.MANAGER);

    const product = await this.findOne(eventId, productId, user);

    if (!product.trackInventory) {
      throw new ForbiddenException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Dieses Produkt hat keine Bestandsverfolgung',
      });
    }

    const previousQuantity = product.stockQuantity;
    product.stockQuantity += adjustDto.quantity;
    if (product.stockQuantity < 0) product.stockQuantity = 0;

    await this.productRepository.save(product);

    // Create stock movement record
    const stockMovement = this.stockMovementRepository.create({
      productId: product.id,
      eventId,
      quantity: adjustDto.quantity,
      quantityBefore: previousQuantity,
      quantityAfter: product.stockQuantity,
      reason: adjustDto.reason || 'Manuelle Anpassung',
      type: adjustDto.quantity > 0 ? StockMovementType.ADJUSTMENT_PLUS : StockMovementType.ADJUSTMENT_MINUS,
      createdByUserId: user.id,
    });
    await this.stockMovementRepository.save(stockMovement);

    this.logger.log(`Stock adjusted for product ${product.id}: ${adjustDto.quantity}`);

    return product;
  }

  async getLowStock(eventId: string, user: User): Promise<Product[]> {
    await this.getEventAndCheckMembership(eventId, user.id);

    // Using raw query since TypeORM doesn't easily handle comparing two columns
    return this.productRepository
      .createQueryBuilder('product')
      .where('product.eventId = :eventId', { eventId })
      .andWhere('product.trackInventory = true')
      .andWhere('product.lowStockThreshold IS NOT NULL')
      .andWhere('product.stockQuantity <= product.lowStockThreshold')
      .andWhere('product.deletedAt IS NULL')
      .getMany();
  }

  private async getEvent(eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    return event;
  }

  private async getEventAndCheckMembership(eventId: string, userId: string): Promise<Event> {
    const event = await this.getEvent(eventId);

    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId: event.organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf dieses Event',
      });
    }

    return event;
  }

  private async getEventAndCheckRole(
    eventId: string,
    userId: string,
    requiredRole: OrganizationRole,
  ): Promise<Event> {
    const event = await this.getEvent(eventId);

    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId: event.organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf dieses Event',
      });
    }

    const roleHierarchy: Record<OrganizationRole, number> = {
      [OrganizationRole.ADMIN]: 100,
      [OrganizationRole.MANAGER]: 80,
      [OrganizationRole.CASHIER]: 40,
      [OrganizationRole.KITCHEN]: 20,
      [OrganizationRole.DELIVERY]: 20,
    };

    if (roleHierarchy[membership.role] < roleHierarchy[requiredRole]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return event;
  }
}
