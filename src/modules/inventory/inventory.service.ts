import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  InventoryCount,
  InventoryCountItem,
  StockMovement,
  Product,
} from '../../database/entities';
import { InventoryCountStatus } from '../../database/entities/inventory-count.entity';
import { StockMovementType } from '../../database/entities/stock-movement.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import {
  CreateInventoryCountDto,
  UpdateInventoryCountDto,
  AddInventoryItemDto,
  BulkAddInventoryItemsDto,
  UpdateInventoryItemDto,
  QueryInventoryCountsDto,
  QueryStockMovementsDto,
} from './dto';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectRepository(InventoryCount)
    private readonly inventoryCountRepository: Repository<InventoryCount>,
    @InjectRepository(InventoryCountItem)
    private readonly inventoryCountItemRepository: Repository<InventoryCountItem>,
    @InjectRepository(StockMovement)
    private readonly stockMovementRepository: Repository<StockMovement>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
  ) {}

  // === Inventory Counts ===

  async findAllCounts(
    eventId: string,
    queryDto: QueryInventoryCountsDto,
  ): Promise<{ data: InventoryCount[]; total: number; page: number; limit: number }> {
    const { status, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.inventoryCountRepository
      .createQueryBuilder('count')
      .leftJoinAndSelect('count.createdByUser', 'creator')
      .where('count.eventId = :eventId', { eventId });

    if (status) {
      queryBuilder.andWhere('count.status = :status', { status });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('count.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async findOneCount(eventId: string, countId: string): Promise<InventoryCount> {
    const count = await this.inventoryCountRepository.findOne({
      where: { id: countId, eventId },
      relations: ['items', 'items.product', 'createdByUser', 'completedByUser'],
    });

    if (!count) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Inventur nicht gefunden',
      });
    }

    return count;
  }

  async createCount(
    eventId: string,
    userId: string,
    createDto: CreateInventoryCountDto,
  ): Promise<InventoryCount> {
    // Check if there's an in-progress count
    const inProgress = await this.inventoryCountRepository.findOne({
      where: {
        eventId,
        status: InventoryCountStatus.IN_PROGRESS,
      },
    });

    if (inProgress) {
      throw new BadRequestException({
        code: ErrorCodes.INVENTORY_IN_PROGRESS,
        message: 'Es läuft bereits eine Inventur',
      });
    }

    const count = this.inventoryCountRepository.create({
      eventId,
      ...createDto,
      status: InventoryCountStatus.DRAFT,
      createdByUserId: userId,
    });

    await this.inventoryCountRepository.save(count);

    this.logger.log(`Inventory count created: ${count.id}`);

    return count;
  }

  async updateCount(
    eventId: string,
    countId: string,
    updateDto: UpdateInventoryCountDto,
  ): Promise<InventoryCount> {
    const count = await this.findOneCount(eventId, countId);

    if (count.status === InventoryCountStatus.COMPLETED) {
      throw new BadRequestException({
        code: ErrorCodes.INVENTORY_ALREADY_COMPLETED,
        message: 'Inventur ist bereits abgeschlossen',
      });
    }

    Object.assign(count, updateDto);
    await this.inventoryCountRepository.save(count);

    return count;
  }

  async deleteCount(eventId: string, countId: string): Promise<void> {
    const count = await this.findOneCount(eventId, countId);

    if (count.status === InventoryCountStatus.COMPLETED) {
      throw new BadRequestException({
        code: ErrorCodes.INVENTORY_ALREADY_COMPLETED,
        message: 'Abgeschlossene Inventur kann nicht gelöscht werden',
      });
    }

    await this.inventoryCountRepository.remove(count);
  }

  async startCount(eventId: string, countId: string): Promise<InventoryCount> {
    const count = await this.findOneCount(eventId, countId);

    if (count.status !== InventoryCountStatus.DRAFT) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Inventur kann nur im Entwurfsstatus gestartet werden',
      });
    }

    if (count.items.length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Inventur hat keine Artikel zum Zählen',
      });
    }

    count.status = InventoryCountStatus.IN_PROGRESS;
    count.startedAt = new Date();
    await this.inventoryCountRepository.save(count);

    this.logger.log(`Inventory count started: ${count.id}`);

    return count;
  }

  async completeCount(
    eventId: string,
    countId: string,
    userId: string,
  ): Promise<InventoryCount> {
    const count = await this.findOneCount(eventId, countId);

    if (count.status !== InventoryCountStatus.IN_PROGRESS) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Inventur muss im Status "In Bearbeitung" sein',
      });
    }

    // Check all items are counted
    const uncounted = count.items.filter((item) => item.countedQuantity === null);
    if (uncounted.length > 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `${uncounted.length} Artikel wurden noch nicht gezählt`,
      });
    }

    // Apply stock adjustments
    for (const item of count.items) {
      if (item.difference !== null && item.difference !== 0) {
        await this.applyStockAdjustment(
          eventId,
          item.productId,
          item.difference,
          countId,
          userId,
        );
      }
    }

    count.status = InventoryCountStatus.COMPLETED;
    count.completedAt = new Date();
    count.completedByUserId = userId;
    await this.inventoryCountRepository.save(count);

    this.logger.log(`Inventory count completed: ${count.id}`);

    return this.findOneCount(eventId, countId);
  }

  async cancelCount(eventId: string, countId: string): Promise<InventoryCount> {
    const count = await this.findOneCount(eventId, countId);

    if (count.status === InventoryCountStatus.COMPLETED) {
      throw new BadRequestException({
        code: ErrorCodes.INVENTORY_ALREADY_COMPLETED,
        message: 'Abgeschlossene Inventur kann nicht abgebrochen werden',
      });
    }

    count.status = InventoryCountStatus.CANCELLED;
    await this.inventoryCountRepository.save(count);

    this.logger.log(`Inventory count cancelled: ${count.id}`);

    return count;
  }

  // === Inventory Count Items ===

  async addItem(
    eventId: string,
    countId: string,
    addDto: AddInventoryItemDto,
  ): Promise<InventoryCountItem> {
    const count = await this.findOneCount(eventId, countId);

    if (count.status !== InventoryCountStatus.DRAFT) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Artikel können nur im Entwurfsstatus hinzugefügt werden',
      });
    }

    const product = await this.productRepository.findOne({
      where: { id: addDto.productId, eventId },
    });

    if (!product) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Produkt nicht gefunden',
      });
    }

    // Check if item already exists
    const existing = count.items.find((i) => i.productId === addDto.productId);
    if (existing) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Produkt ist bereits in der Inventur',
      });
    }

    const item = this.inventoryCountItemRepository.create({
      inventoryCountId: countId,
      productId: addDto.productId,
      expectedQuantity: product.stockQuantity,
    });

    await this.inventoryCountItemRepository.save(item);

    return this.inventoryCountItemRepository.findOne({
      where: { id: item.id },
      relations: ['product'],
    }) as Promise<InventoryCountItem>;
  }

  async bulkAddItems(
    eventId: string,
    countId: string,
    bulkDto: BulkAddInventoryItemsDto,
  ): Promise<InventoryCountItem[]> {
    const count = await this.findOneCount(eventId, countId);

    if (count.status !== InventoryCountStatus.DRAFT) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Artikel können nur im Entwurfsstatus hinzugefügt werden',
      });
    }

    let products: Product[];

    if (bulkDto.categoryId) {
      // Get all products in category
      products = await this.productRepository.find({
        where: { eventId, categoryId: bulkDto.categoryId, trackInventory: true },
      });
    } else if (bulkDto.productIds && bulkDto.productIds.length > 0) {
      products = await this.productRepository.find({
        where: { eventId, id: In(bulkDto.productIds) },
      });
    } else {
      // Get all products with inventory tracking
      products = await this.productRepository.find({
        where: { eventId, trackInventory: true },
      });
    }

    // Filter out already added products
    const existingProductIds = count.items.map((i) => i.productId);
    products = products.filter((p) => !existingProductIds.includes(p.id));

    const items: InventoryCountItem[] = [];
    for (const product of products) {
      const item = this.inventoryCountItemRepository.create({
        inventoryCountId: countId,
        productId: product.id,
        expectedQuantity: product.stockQuantity,
      });
      await this.inventoryCountItemRepository.save(item);
      items.push(item);
    }

    this.logger.log(`Added ${items.length} items to inventory count ${countId}`);

    return items;
  }

  async updateItem(
    eventId: string,
    countId: string,
    itemId: string,
    userId: string,
    updateDto: UpdateInventoryItemDto,
  ): Promise<InventoryCountItem> {
    const count = await this.findOneCount(eventId, countId);

    if (count.status !== InventoryCountStatus.IN_PROGRESS) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Zählung nur im Status "In Bearbeitung" möglich',
      });
    }

    const item = count.items.find((i) => i.id === itemId);
    if (!item) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Artikel nicht gefunden',
      });
    }

    item.countedQuantity = updateDto.countedQuantity;
    item.difference = updateDto.countedQuantity - item.expectedQuantity;
    item.notes = updateDto.notes || item.notes;
    item.countedByUserId = userId;
    item.countedAt = new Date();

    await this.inventoryCountItemRepository.save(item);

    return this.inventoryCountItemRepository.findOne({
      where: { id: item.id },
      relations: ['product'],
    }) as Promise<InventoryCountItem>;
  }

  // === Stock Movements ===

  async findAllMovements(
    eventId: string,
    queryDto: QueryStockMovementsDto,
  ): Promise<{ data: StockMovement[]; total: number; page: number; limit: number }> {
    const { productId, type, startDate, endDate, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.stockMovementRepository
      .createQueryBuilder('movement')
      .leftJoinAndSelect('movement.product', 'product')
      .leftJoinAndSelect('movement.createdByUser', 'user')
      .where('movement.eventId = :eventId', { eventId });

    if (productId) {
      queryBuilder.andWhere('movement.productId = :productId', { productId });
    }

    if (type) {
      queryBuilder.andWhere('movement.type = :type', { type });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('movement.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('movement.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async findOneMovement(eventId: string, movementId: string): Promise<StockMovement> {
    const movement = await this.stockMovementRepository.findOne({
      where: { id: movementId, eventId },
      relations: ['product', 'createdByUser'],
    });

    if (!movement) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Lagerbewegung nicht gefunden',
      });
    }

    return movement;
  }

  // === Private Helpers ===

  private async applyStockAdjustment(
    eventId: string,
    productId: string,
    difference: number,
    inventoryCountId: string,
    userId: string,
  ): Promise<void> {
    const product = await this.productRepository.findOne({
      where: { id: productId },
    });

    if (!product) return;

    const quantityBefore = product.stockQuantity;
    const quantityAfter = quantityBefore + difference;

    // Update product stock
    product.stockQuantity = Math.max(0, quantityAfter);
    await this.productRepository.save(product);

    // Create stock movement record
    const movement = this.stockMovementRepository.create({
      eventId,
      productId,
      type: StockMovementType.INVENTORY_COUNT,
      quantity: difference,
      quantityBefore,
      quantityAfter: product.stockQuantity,
      referenceType: 'inventory_count',
      referenceId: inventoryCountId,
      reason: 'Inventurzählung',
      createdByUserId: userId,
    });

    await this.stockMovementRepository.save(movement);
  }
}
