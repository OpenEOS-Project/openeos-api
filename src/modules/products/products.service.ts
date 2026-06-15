import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product, User, UserOrganization, StockMovement, Event, Category, PfandType } from '../../database/entities';
import { StockMovementType } from '../../database/entities/stock-movement.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreateProductDto, UpdateProductDto, AdjustStockDto } from './dto';
import { ImportProductsDto } from './dto/import-products.dto';
import { parseProductCsv } from './product-csv';
import { GatewayService } from '../gateway/gateway.service';

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
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(PfandType)
    private readonly pfandTypeRepository: Repository<PfandType>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
  ) {}

  async create(
    eventId: string,
    createDto: CreateProductDto,
    user: User,
  ): Promise<Product> {
    const event = await this.getEventAndCheckPermission(eventId, user.id, 'products');

    const product = this.productRepository.create({
      eventId: event.id,
      ...createDto,
    });

    await this.productRepository.save(product);
    this.logger.log(`Product created: ${product.name} (${product.id})`);

    // Notify menu displays
    this.gatewayService.notifyProductUpdated(event.organizationId, eventId, {
      id: product.id,
      name: product.name,
      categoryId: product.categoryId,
      price: Number(product.price),
      isAvailable: product.isAvailable,
      isActive: product.isActive,
      stockQuantity: product.trackInventory ? product.stockQuantity : undefined,
      trackInventory: product.trackInventory,
    });

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
    const event = await this.getEventAndCheckPermission(eventId, user.id, 'products');

    const product = await this.findOne(eventId, productId, user);
    Object.assign(product, updateDto);
    await this.productRepository.save(product);

    this.logger.log(`Product updated: ${product.name} (${product.id})`);

    // Notify menu displays
    this.gatewayService.notifyProductUpdated(event.organizationId, eventId, {
      id: product.id,
      name: product.name,
      categoryId: product.categoryId,
      price: Number(product.price),
      isAvailable: product.isAvailable,
      isActive: product.isActive,
      stockQuantity: product.trackInventory ? product.stockQuantity : undefined,
      trackInventory: product.trackInventory,
    });

    return product;
  }

  async remove(eventId: string, productId: string, user: User): Promise<void> {
    const event = await this.getEventAndCheckAdmin(eventId, user.id);

    const product = await this.findOne(eventId, productId, user);
    await this.productRepository.softRemove(product);

    this.logger.log(`Product deleted: ${product.name} (${product.id})`);

    // Notify menu displays
    this.gatewayService.notifyProductDeleted(event.organizationId, eventId, productId);
  }

  async updateAvailability(
    eventId: string,
    productId: string,
    isAvailable: boolean,
    user: User,
  ): Promise<Product> {
    const event = await this.getEventAndCheckMembership(eventId, user.id);

    const product = await this.findOne(eventId, productId, user);
    product.isAvailable = isAvailable;
    await this.productRepository.save(product);

    this.logger.log(`Product availability updated: ${product.name} - ${isAvailable}`);

    // Notify menu displays
    this.gatewayService.notifyProductUpdated(event.organizationId, eventId, {
      id: product.id,
      name: product.name,
      categoryId: product.categoryId,
      price: Number(product.price),
      isAvailable: product.isAvailable,
      isActive: product.isActive,
      stockQuantity: product.trackInventory ? product.stockQuantity : undefined,
      trackInventory: product.trackInventory,
    });

    return product;
  }

  async adjustStock(
    eventId: string,
    productId: string,
    adjustDto: AdjustStockDto,
    user: User,
  ): Promise<Product> {
    await this.getEventAndCheckPermission(eventId, user.id, 'products');

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

    // Notify menu displays about stock change
    const event = await this.getEvent(eventId);
    this.gatewayService.notifyProductUpdated(event.organizationId, eventId, {
      id: product.id,
      name: product.name,
      categoryId: product.categoryId,
      price: Number(product.price),
      isAvailable: product.isAvailable,
      isActive: product.isActive,
      stockQuantity: product.stockQuantity,
      trackInventory: product.trackInventory,
    });

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

  /**
   * Import products from a CSV. With dryRun (default) nothing is written and a
   * preview is returned; otherwise categories/pfand-types are created as
   * needed and products are created/updated/skipped per `mode`.
   */
  async importProducts(
    eventId: string,
    dto: ImportProductsDto,
    user: User,
  ): Promise<{
    committed: boolean;
    summary: { create: number; update: number; skip: number; error: number };
    rows: Array<{
      line: number;
      name: string;
      category: string;
      price: number;
      pfand: number | null;
      icon: string | null;
      action: 'create' | 'update' | 'skip' | 'error';
      message?: string;
    }>;
    newCategories: string[];
    newPfandTypes: Array<{ name: string; amount: number }>;
    fatalError: string | null;
  }> {
    const event = await this.getEventAndCheckPermission(eventId, user.id, 'products');
    const mode = dto.mode ?? 'skip';
    const dryRun = dto.dryRun ?? true;

    const parsed = parseProductCsv(dto.csv);
    if (parsed.fatalError) {
      return {
        committed: false,
        summary: { create: 0, update: 0, skip: 0, error: 0 },
        rows: [],
        newCategories: [],
        newPfandTypes: [],
        fatalError: parsed.fatalError,
      };
    }

    // Existing state for matching (case-insensitive by name).
    const existingCategories = await this.categoryRepository.find({ where: { eventId } });
    const categoryByName = new Map(existingCategories.map((c) => [c.name.trim().toLowerCase(), c]));
    const existingProducts = await this.productRepository.find({ where: { eventId } });
    const categoryNameById = new Map(existingCategories.map((c) => [c.id, c.name]));
    const productKey = (name: string, categoryName: string) =>
      `${name.trim().toLowerCase()}|${categoryName.trim().toLowerCase()}`;
    const productByKey = new Map(
      existingProducts.map((p) => [
        productKey(p.name, categoryNameById.get(p.categoryId) ?? ''),
        p,
      ]),
    );
    const existingPfand = await this.pfandTypeRepository.find({
      where: { organizationId: event.organizationId },
    });
    const roundAmount = (a: number) => Math.round(a * 100) / 100;
    const pfandByAmount = new Map(existingPfand.map((p) => [roundAmount(Number(p.amount)), p]));

    // Collect new categories/pfand the import would introduce (preview + plan).
    const newCategoryNames: string[] = [];
    const seenNewCategory = new Set<string>();
    const newPfandAmounts: number[] = [];
    const seenNewPfand = new Set<number>();

    const plan = parsed.rows.map((row) => {
      let action: 'create' | 'update' | 'skip' | 'error';
      let message: string | undefined;

      if (row.error) {
        action = 'error';
        message = row.error;
      } else {
        const catKey = row.category.trim().toLowerCase();
        if (!categoryByName.has(catKey) && !seenNewCategory.has(catKey)) {
          seenNewCategory.add(catKey);
          newCategoryNames.push(row.category.trim());
        }
        if (row.pfand !== null) {
          const amt = roundAmount(row.pfand);
          if (!pfandByAmount.has(amt) && !seenNewPfand.has(amt)) {
            seenNewPfand.add(amt);
            newPfandAmounts.push(amt);
          }
        }
        const existing = productByKey.get(productKey(row.name, row.category));
        if (existing) {
          action = mode === 'skip' ? 'skip' : mode === 'update' ? 'update' : 'create';
          if (mode === 'skip') message = 'Existiert bereits';
        } else {
          action = 'create';
        }
      }

      return { row, action, message };
    });

    const summary = {
      create: plan.filter((p) => p.action === 'create').length,
      update: plan.filter((p) => p.action === 'update').length,
      skip: plan.filter((p) => p.action === 'skip').length,
      error: plan.filter((p) => p.action === 'error').length,
    };

    const pfandName = (amount: number) =>
      `Pfand ${amount.toFixed(2).replace('.', ',')} €`;

    if (!dryRun && (summary.create > 0 || summary.update > 0)) {
      // 1. Create missing categories (sortOrder appended).
      let nextSort =
        existingCategories.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1;
      for (const name of newCategoryNames) {
        const cat = await this.categoryRepository.save(
          this.categoryRepository.create({ eventId, name, sortOrder: nextSort++ }),
        );
        categoryByName.set(name.trim().toLowerCase(), cat);
      }

      // 2. Create missing pfand types.
      let nextPfandSort =
        existingPfand.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1;
      for (const amount of newPfandAmounts) {
        const pf = await this.pfandTypeRepository.save(
          this.pfandTypeRepository.create({
            organizationId: event.organizationId,
            name: pfandName(amount),
            amount,
            sortOrder: nextPfandSort++,
          }),
        );
        pfandByAmount.set(amount, pf);
      }

      // 3. Apply product creates/updates.
      for (const { row, action } of plan) {
        if (action !== 'create' && action !== 'update') continue;
        const category = categoryByName.get(row.category.trim().toLowerCase());
        if (!category) continue; // defensive; should exist after step 1
        const pfandTypeId =
          row.pfand !== null ? pfandByAmount.get(roundAmount(row.pfand))?.id ?? null : null;
        const imageUrl = row.iconId ? `pos-icon:${row.iconId}` : null;

        if (action === 'create') {
          await this.productRepository.save(
            this.productRepository.create({
              eventId,
              categoryId: category.id,
              name: row.name,
              description: row.description,
              price: row.price,
              options: row.options,
              pfandTypeId,
              imageUrl,
              isAvailable: row.isAvailable,
              trackInventory: row.trackInventory,
              stockQuantity: row.stockQuantity,
              ...(row.sortOrder !== null ? { sortOrder: row.sortOrder } : {}),
            }),
          );
        } else {
          const existing = productByKey.get(productKey(row.name, row.category));
          if (!existing) continue;
          existing.categoryId = category.id;
          existing.description = row.description;
          existing.price = row.price;
          existing.options = row.options;
          existing.pfandTypeId = pfandTypeId;
          existing.imageUrl = imageUrl;
          existing.isAvailable = row.isAvailable;
          if (row.sortOrder !== null) existing.sortOrder = row.sortOrder;
          await this.productRepository.save(existing);
        }
      }

      this.gatewayService.notifyMenuRefresh(event.organizationId, eventId, 'product-import');
      this.logger.log(
        `Product import for event ${eventId}: +${summary.create} ~${summary.update} (by ${user.email})`,
      );
    }

    return {
      committed: !dryRun && (summary.create > 0 || summary.update > 0),
      summary,
      rows: plan.map(({ row, action, message }) => ({
        line: row.line,
        name: row.name,
        category: row.category,
        price: row.price,
        pfand: row.pfand,
        icon: row.iconId,
        action,
        message,
      })),
      newCategories: newCategoryNames,
      newPfandTypes: newPfandAmounts.map((amount) => ({ name: pfandName(amount), amount })),
      fatalError: null,
    };
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

  private async getEventAndCheckPermission(
    eventId: string,
    userId: string,
    permission: 'products' | 'events' | 'devices' | 'members' | 'shiftPlans',
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

    if (membership.role !== OrganizationRole.ADMIN && !membership.permissions?.[permission]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return event;
  }

  private async getEventAndCheckAdmin(
    eventId: string,
    userId: string,
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

    if (membership.role !== OrganizationRole.ADMIN) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return event;
  }
}
