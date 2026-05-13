import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  Event,
  Organization,
  User,
  UserOrganization,
  Category,
  Product,
  Order,
  OrderItem,
} from '../../database/entities';
import { EventStatus } from '../../database/entities/event.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreateEventDto, UpdateEventDto, CopyProductsDto } from './dto';
import { GatewayService } from '../gateway/gateway.service';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
  ) {}

  private emitStatusChanged(event: Event): void {
    this.gatewayService.notifyEventStatusChanged(event.organizationId, {
      eventId: event.id,
      organizationId: event.organizationId,
      status: event.status,
      name: event.name,
    });
  }

  async create(
    organizationId: string,
    createDto: CreateEventDto,
    user: User,
  ): Promise<Event> {
    await this.checkPermission(organizationId, user.id, 'events');

    // Validate dates if both provided
    if (createDto.startDate && createDto.endDate) {
      const startDate = new Date(createDto.startDate);
      const endDate = new Date(createDto.endDate);

      if (endDate <= startDate) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Enddatum muss nach dem Startdatum liegen',
        });
      }
    }

    const event = this.eventRepository.create({
      organizationId,
      name: createDto.name,
      description: createDto.description,
      startDate: createDto.startDate ? new Date(createDto.startDate) : null,
      endDate: createDto.endDate ? new Date(createDto.endDate) : null,
      status: EventStatus.INACTIVE,
      settings: createDto.settings || {},
    });

    await this.eventRepository.save(event);

    this.logger.log(`Event created: ${event.name} (${event.id})`);

    return event;
  }

  async findAll(
    organizationId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<Event>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 20 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.eventRepository.findAndCount({
      where: { organizationId },
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<Event> {
    await this.checkMembership(organizationId, user.id);

    const event = await this.eventRepository.findOne({
      where: { id: eventId, organizationId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    return event;
  }

  async update(
    organizationId: string,
    eventId: string,
    updateDto: UpdateEventDto,
    user: User,
  ): Promise<Event> {
    await this.checkPermission(organizationId, user.id, 'events');

    const event = await this.findOne(organizationId, eventId, user);

    // Validate dates if both are provided
    if (updateDto.startDate && updateDto.endDate) {
      const startDate = new Date(updateDto.startDate);
      const endDate = new Date(updateDto.endDate);

      if (endDate <= startDate) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Enddatum muss nach dem Startdatum liegen',
        });
      }
    }

    if (updateDto.name) event.name = updateDto.name;
    if (updateDto.description !== undefined) event.description = updateDto.description;
    if (updateDto.startDate) event.startDate = new Date(updateDto.startDate);
    if (updateDto.endDate) event.endDate = new Date(updateDto.endDate);
    if (updateDto.settings) event.settings = { ...event.settings, ...updateDto.settings };

    await this.eventRepository.save(event);

    this.logger.log(`Event updated: ${event.name} (${event.id})`);

    return event;
  }

  async remove(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<void> {
    await this.checkAdmin(organizationId, user.id);

    const event = await this.findOne(organizationId, eventId, user);

    if (event.status === EventStatus.ACTIVE) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Aktive Events können nicht gelöscht werden',
      });
    }

    await this.eventRepository.softRemove(event);

    this.logger.log(`Event deleted: ${event.name} (${event.id})`);
  }

  // Event Lifecycle

  async activate(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<Event> {
    const event = await this.getEventAndCheckPermission(organizationId, eventId, user.id, 'events');

    if (event.status === EventStatus.ACTIVE) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Event ist bereits aktiv',
      });
    }

    const deactivatedSiblings = await this.deactivateActiveOrTestSiblings(organizationId, event.id);

    event.status = EventStatus.ACTIVE;
    await this.eventRepository.save(event);

    this.logger.log(`Event activated: ${event.name} (${event.id})`);

    this.emitStatusChanged(event);
    for (const sibling of deactivatedSiblings) {
      this.emitStatusChanged(sibling);
    }

    return event;
  }

  async deactivate(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<Event> {
    const event = await this.getEventAndCheckPermission(organizationId, eventId, user.id, 'events');

    if (event.status === EventStatus.INACTIVE) {
      return event;
    }

    event.status = EventStatus.INACTIVE;
    await this.eventRepository.save(event);

    this.logger.log(`Event deactivated: ${event.name} (${event.id})`);

    this.emitStatusChanged(event);

    return event;
  }

  async setTestMode(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<Event> {
    const event = await this.getEventAndCheckPermission(organizationId, eventId, user.id, 'events');

    if (event.status === EventStatus.TEST) {
      return event;
    }

    const deactivatedSiblings = await this.deactivateActiveOrTestSiblings(organizationId, event.id);

    event.status = EventStatus.TEST;
    await this.eventRepository.save(event);

    this.logger.log(`Event set to test mode: ${event.name} (${event.id})`);

    this.emitStatusChanged(event);
    for (const sibling of deactivatedSiblings) {
      this.emitStatusChanged(sibling);
    }

    return event;
  }

  async getActiveOrTestForUser(
    organizationId: string,
    user: User,
  ): Promise<Event | null> {
    await this.checkMembership(organizationId, user.id);
    return this.getActiveOrTest(organizationId);
  }

  async getActiveOrTest(organizationId: string): Promise<Event | null> {
    const candidates = await this.eventRepository.find({
      where: {
        organizationId,
        status: In([EventStatus.ACTIVE, EventStatus.TEST]),
      },
    });

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => {
      if (a.status === b.status) return 0;
      return a.status === EventStatus.ACTIVE ? -1 : 1;
    });

    return candidates[0];
  }

  // Returns the events that were deactivated (with their new INACTIVE status).
  private async deactivateActiveOrTestSiblings(
    organizationId: string,
    excludeEventId: string,
  ): Promise<Event[]> {
    const siblings = await this.eventRepository.find({
      where: {
        organizationId,
        status: In([EventStatus.ACTIVE, EventStatus.TEST]),
      },
    });

    const toDeactivate = siblings.filter((e) => e.id !== excludeEventId);

    for (const sibling of toDeactivate) {
      sibling.status = EventStatus.INACTIVE;
    }

    if (toDeactivate.length > 0) {
      await this.eventRepository.save(toDeactivate);
    }

    return toDeactivate;
  }

  // Copy categories and products from another event
  async copyFromEvent(
    organizationId: string,
    targetEventId: string,
    sourceEventId: string,
    copyDto: CopyProductsDto,
    user: User,
  ): Promise<{ categoriesCopied: number; productsCopied: number }> {
    await this.checkPermission(organizationId, user.id, 'events');

    const targetEvent = await this.findOne(organizationId, targetEventId, user);

    const sourceEvent = await this.eventRepository.findOne({
      where: { id: sourceEventId },
    });

    if (!sourceEvent) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Quell-Event nicht gefunden',
      });
    }

    await this.checkMembership(sourceEvent.organizationId, user.id);

    let sourceCategories: Category[];
    if (copyDto.categoryIds && copyDto.categoryIds.length > 0) {
      sourceCategories = await this.categoryRepository.find({
        where: { eventId: sourceEventId, id: In(copyDto.categoryIds) },
      });
    } else {
      sourceCategories = await this.categoryRepository.find({
        where: { eventId: sourceEventId },
      });
    }

    const categoryIdMap = new Map<string, string>();

    const topLevelCategories = sourceCategories.filter(c => !c.parentId);
    for (const sourceCategory of topLevelCategories) {
      const newCategory = this.categoryRepository.create({
        eventId: targetEventId,
        name: sourceCategory.name,
        description: sourceCategory.description,
        color: sourceCategory.color,
        icon: sourceCategory.icon,
        sortOrder: sourceCategory.sortOrder,
        isActive: sourceCategory.isActive,
        printSettings: sourceCategory.printSettings,
        parentId: null,
      });
      await this.categoryRepository.save(newCategory);
      categoryIdMap.set(sourceCategory.id, newCategory.id);
    }

    const childCategories = sourceCategories.filter(c => c.parentId);
    for (const sourceCategory of childCategories) {
      const newParentId = categoryIdMap.get(sourceCategory.parentId!) || null;
      const newCategory = this.categoryRepository.create({
        eventId: targetEventId,
        name: sourceCategory.name,
        description: sourceCategory.description,
        color: sourceCategory.color,
        icon: sourceCategory.icon,
        sortOrder: sourceCategory.sortOrder,
        isActive: sourceCategory.isActive,
        printSettings: sourceCategory.printSettings,
        parentId: newParentId,
      });
      await this.categoryRepository.save(newCategory);
      categoryIdMap.set(sourceCategory.id, newCategory.id);
    }

    let sourceProducts: Product[];
    if (copyDto.productIds && copyDto.productIds.length > 0) {
      sourceProducts = await this.productRepository.find({
        where: { eventId: sourceEventId, id: In(copyDto.productIds) },
      });
    } else if (copyDto.categoryIds && copyDto.categoryIds.length > 0) {
      sourceProducts = await this.productRepository.find({
        where: { eventId: sourceEventId, categoryId: In(copyDto.categoryIds) },
      });
    } else {
      sourceProducts = await this.productRepository.find({
        where: { eventId: sourceEventId },
      });
    }

    let productsCopied = 0;
    for (const sourceProduct of sourceProducts) {
      const newCategoryId = categoryIdMap.get(sourceProduct.categoryId);
      if (!newCategoryId) {
        continue;
      }

      const newProduct = this.productRepository.create({
        eventId: targetEventId,
        categoryId: newCategoryId,
        name: sourceProduct.name,
        description: sourceProduct.description,
        price: sourceProduct.price,
        imageUrl: sourceProduct.imageUrl,
        isActive: sourceProduct.isActive,
        isAvailable: sourceProduct.isAvailable,
        trackInventory: sourceProduct.trackInventory,
        stockQuantity: copyDto.copyStock ? sourceProduct.stockQuantity : 0,
        stockUnit: sourceProduct.stockUnit,
        options: sourceProduct.options,
        printSettings: sourceProduct.printSettings,
        sortOrder: sourceProduct.sortOrder,
      });
      await this.productRepository.save(newProduct);
      productsCopied++;
    }

    targetEvent.copiedFromEventId = sourceEventId;
    await this.eventRepository.save(targetEvent);

    this.logger.log(
      `Copied ${categoryIdMap.size} categories and ${productsCopied} products from event ${sourceEventId} to ${targetEventId}`,
    );

    return {
      categoriesCopied: categoryIdMap.size,
      productsCopied,
    };
  }

  // Internal helper used by other modules (e.g. orders) to get event and check membership
  async getEventAndCheckMembership(
    organizationId: string,
    eventId: string,
    userId: string,
  ): Promise<Event> {
    await this.checkMembership(organizationId, userId);

    const event = await this.eventRepository.findOne({
      where: { id: eventId, organizationId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    return event;
  }

  private async getEventAndCheckPermission(
    organizationId: string,
    eventId: string,
    userId: string,
    permission: 'products' | 'events' | 'devices' | 'members' | 'shiftPlans',
  ): Promise<Event> {
    await this.checkPermission(organizationId, userId, permission);

    const event = await this.eventRepository.findOne({
      where: { id: eventId, organizationId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    return event;
  }

  // Helper methods
  private async checkMembership(organizationId: string, userId: string): Promise<UserOrganization> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }

    return membership;
  }

  private async checkPermission(
    organizationId: string,
    userId: string,
    permission: 'products' | 'events' | 'devices' | 'members' | 'shiftPlans',
  ): Promise<UserOrganization> {
    const membership = await this.checkMembership(organizationId, userId);

    if (membership.role === OrganizationRole.ADMIN) {
      return membership;
    }

    if (!membership.permissions?.[permission]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return membership;
  }

  private async checkAdmin(
    organizationId: string,
    userId: string,
  ): Promise<UserOrganization> {
    const membership = await this.checkMembership(organizationId, userId);

    if (membership.role !== OrganizationRole.ADMIN) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return membership;
  }
}
