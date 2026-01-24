import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  Event,
  Organization,
  User,
  UserOrganization,
  EventLicense,
  Category,
  Product,
} from '../../database/entities';
import { EventStatus } from '../../database/entities/event.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreateEventDto, UpdateEventDto, CopyProductsDto } from './dto';

// Credits required per day for event activation
const CREDITS_PER_DAY = 10;

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
    @InjectRepository(EventLicense)
    private readonly eventLicenseRepository: Repository<EventLicense>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
  ) {}

  async create(
    organizationId: string,
    createDto: CreateEventDto,
    user: User,
  ): Promise<Event> {
    // Check user has permission
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    // Validate dates
    const startDate = new Date(createDto.startDate);
    const endDate = new Date(createDto.endDate);

    if (endDate <= startDate) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Enddatum muss nach dem Startdatum liegen',
      });
    }

    const event = this.eventRepository.create({
      organizationId,
      name: createDto.name,
      description: createDto.description,
      startDate,
      endDate,
      status: EventStatus.DRAFT,
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
      order: { startDate: 'DESC' },
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
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const event = await this.findOne(organizationId, eventId, user);

    // Don't allow updating active or completed events (except settings)
    if (event.status === EventStatus.ACTIVE || event.status === EventStatus.COMPLETED) {
      if (updateDto.name || updateDto.description || updateDto.startDate || updateDto.endDate) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Aktive oder abgeschlossene Events können nicht mehr geändert werden',
        });
      }
    }

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

    // Update fields
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
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

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
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const event = await this.findOne(organizationId, eventId, user);

    if (event.status !== EventStatus.DRAFT) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nur Events im Status "Entwurf" können aktiviert werden',
      });
    }

    // Calculate credits needed
    const creditsNeeded = this.calculateCreditsNeeded(event);

    // Check organization credits
    const organization = await this.organizationRepository.findOneOrFail({
      where: { id: organizationId },
    });

    if (organization.eventCredits < creditsNeeded) {
      throw new BadRequestException({
        code: ErrorCodes.INSUFFICIENT_CREDITS,
        message: `Nicht genug Guthaben. Benötigt: ${creditsNeeded}, Verfügbar: ${organization.eventCredits}`,
      });
    }

    // Deduct credits
    organization.eventCredits -= creditsNeeded;
    await this.organizationRepository.save(organization);

    // Create event license
    const eventLicense = this.eventLicenseRepository.create({
      eventId: event.id,
      organizationId,
      licenseDate: new Date(),
      creditsUsed: creditsNeeded,
      activatedAt: new Date(),
      activatedByUserId: user.id,
    });
    await this.eventLicenseRepository.save(eventLicense);

    // Activate event
    event.status = EventStatus.ACTIVE;
    await this.eventRepository.save(event);

    this.logger.log(`Event activated: ${event.name} (${event.id}), Credits used: ${creditsNeeded}`);

    return event;
  }

  async complete(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<Event> {
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const event = await this.findOne(organizationId, eventId, user);

    if (event.status !== EventStatus.ACTIVE) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nur aktive Events können abgeschlossen werden',
      });
    }

    event.status = EventStatus.COMPLETED;
    await this.eventRepository.save(event);

    this.logger.log(`Event completed: ${event.name} (${event.id})`);

    return event;
  }

  async cancel(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<Event> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const event = await this.findOne(organizationId, eventId, user);

    if (event.status === EventStatus.COMPLETED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Abgeschlossene Events können nicht storniert werden',
      });
    }

    // If event was active, refund credits partially (mock implementation)
    if (event.status === EventStatus.ACTIVE) {
      const eventLicense = await this.eventLicenseRepository.findOne({
        where: { eventId: event.id },
      });

      if (eventLicense) {
        // Calculate refund (e.g., 50% of unused days)
        const now = new Date();
        const totalDays = Math.ceil(
          (event.endDate.getTime() - event.startDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        const usedDays = Math.ceil(
          (now.getTime() - event.startDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        const unusedDays = Math.max(0, totalDays - usedDays);
        const refund = Math.floor((unusedDays / totalDays) * eventLicense.creditsUsed * 0.5);

        if (refund > 0) {
          const organization = await this.organizationRepository.findOneOrFail({
            where: { id: organizationId },
          });
          organization.eventCredits += refund;
          await this.organizationRepository.save(organization);

          this.logger.log(`Refunded ${refund} credits for cancelled event ${event.id}`);
        }
      }
    }

    event.status = EventStatus.CANCELLED;
    await this.eventRepository.save(event);

    this.logger.log(`Event cancelled: ${event.name} (${event.id})`);

    return event;
  }

  // Credit Check
  async checkCredits(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<{
    creditsNeeded: number;
    creditsAvailable: number;
    canActivate: boolean;
  }> {
    await this.checkMembership(organizationId, user.id);

    const event = await this.findOne(organizationId, eventId, user);
    const organization = await this.organizationRepository.findOneOrFail({
      where: { id: organizationId },
    });

    const creditsNeeded = this.calculateCreditsNeeded(event);

    return {
      creditsNeeded,
      creditsAvailable: organization.eventCredits,
      canActivate: organization.eventCredits >= creditsNeeded,
    };
  }

  // Copy categories and products from another event
  async copyFromEvent(
    organizationId: string,
    targetEventId: string,
    sourceEventId: string,
    copyDto: CopyProductsDto,
    user: User,
  ): Promise<{ categoriesCopied: number; productsCopied: number }> {
    // Check permissions on target event
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    // Verify target event exists and belongs to the organization
    const targetEvent = await this.findOne(organizationId, targetEventId, user);

    // Verify source event exists and user has access
    const sourceEvent = await this.eventRepository.findOne({
      where: { id: sourceEventId },
    });

    if (!sourceEvent) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Quell-Event nicht gefunden',
      });
    }

    // Check if user has access to source event's organization
    await this.checkMembership(sourceEvent.organizationId, user.id);

    // Get categories to copy
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

    // Create a mapping of old category IDs to new category IDs
    const categoryIdMap = new Map<string, string>();

    // Copy categories (first pass: top-level categories)
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

    // Copy categories (second pass: child categories)
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

    // Get products to copy
    let sourceProducts: Product[];
    if (copyDto.productIds && copyDto.productIds.length > 0) {
      sourceProducts = await this.productRepository.find({
        where: { eventId: sourceEventId, id: In(copyDto.productIds) },
      });
    } else if (copyDto.categoryIds && copyDto.categoryIds.length > 0) {
      // Only copy products from selected categories
      sourceProducts = await this.productRepository.find({
        where: { eventId: sourceEventId, categoryId: In(copyDto.categoryIds) },
      });
    } else {
      sourceProducts = await this.productRepository.find({
        where: { eventId: sourceEventId },
      });
    }

    // Copy products
    let productsCopied = 0;
    for (const sourceProduct of sourceProducts) {
      const newCategoryId = categoryIdMap.get(sourceProduct.categoryId);
      if (!newCategoryId) {
        // Category was not copied, skip this product or create in first available category
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

    // Update target event to track source
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

  // Helper methods
  private calculateCreditsNeeded(event: Event): number {
    const days = Math.ceil(
      (event.endDate.getTime() - event.startDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    return days * CREDITS_PER_DAY;
  }

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

  private async checkRole(
    organizationId: string,
    userId: string,
    requiredRole: OrganizationRole,
  ): Promise<UserOrganization> {
    const membership = await this.checkMembership(organizationId, userId);

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

    return membership;
  }
}
