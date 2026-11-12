import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Not, QueryFailedError, Repository } from 'typeorm';
import {
  Category,
  Product,
  User,
  UserOrganization,
  Event,
} from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  ReorderCategoriesDto,
} from './dto';
import { GatewayService } from '../gateway/gateway.service';
import {
  assertReferencesInOrganization,
  referenceNotFound,
} from '../../common/utils/organization-references';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    private readonly dataSource: DataSource,
  ) {}

  async create(
    eventId: string,
    createDto: CreateCategoryDto,
    user: User,
  ): Promise<Category> {
    const event = await this.getEventAndCheckPermission(
      eventId,
      user.id,
      'products',
    );

    await this.assertReferences(event, createDto);

    const category = this.categoryRepository.create({
      eventId: event.id,
      ...createDto,
    });

    await this.categoryRepository.save(category);
    this.logger.log(`Category created: ${category.name} (${category.id})`);

    // Notify menu displays
    this.gatewayService.notifyCategoryUpdated(event.organizationId, eventId, {
      id: category.id,
      name: category.name,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    });

    return category;
  }

  async findAll(eventId: string, user: User): Promise<Category[]> {
    await this.getEventAndCheckMembership(eventId, user.id);

    return this.categoryRepository.find({
      where: { eventId },
      relations: ['children', 'products'],
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async findOne(
    eventId: string,
    categoryId: string,
    user: User,
  ): Promise<Category> {
    await this.getEventAndCheckMembership(eventId, user.id);

    const category = await this.categoryRepository.findOne({
      where: { id: categoryId, eventId },
      relations: ['children', 'products', 'parent'],
    });

    if (!category) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.CATEGORY_NOT_FOUND,
        message: 'Kategorie nicht gefunden',
      });
    }

    return category;
  }

  async update(
    eventId: string,
    categoryId: string,
    updateDto: UpdateCategoryDto,
    user: User,
  ): Promise<Category> {
    const event = await this.getEventAndCheckPermission(
      eventId,
      user.id,
      'products',
    );

    const category = await this.findOne(eventId, categoryId, user);
    await this.assertReferences(event, updateDto, category.id);
    Object.assign(category, updateDto);
    await this.categoryRepository.save(category);

    this.logger.log(`Category updated: ${category.name} (${category.id})`);

    // Notify menu displays
    this.gatewayService.notifyCategoryUpdated(event.organizationId, eventId, {
      id: category.id,
      name: category.name,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    });

    return category;
  }

  /**
   * Loescht eine Kategorie endgueltig. Produkte, die noch sichtbar sind,
   * blockieren das (409 CATEGORY_HAS_PRODUCTS) — sie muessen erst
   * verschoben oder geloescht werden. Produkte, die nur noch soft-geloescht
   * sind (`deleted_at`), sind fuer Nutzer laengst weg; sie wuerden sonst
   * die Fremdschluessel-Pruefung ausloesen (`category_id` ist NOT NULL,
   * Issue #88) und werden deshalb mit der Kategorie endgueltig entfernt.
   * Haengen daran noch Bestellungen, bleibt die Kategorie mit 409
   * CATEGORY_IN_USE bestehen statt mit 500 zu scheitern.
   */
  async remove(eventId: string, categoryId: string, user: User): Promise<void> {
    const event = await this.getEventAndCheckAdmin(eventId, user.id);

    const category = await this.findOne(eventId, categoryId, user);

    const activeProducts = await this.productRepository.count({
      where: { categoryId: category.id, deletedAt: IsNull() },
    });
    if (activeProducts > 0) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.CATEGORY_HAS_PRODUCTS,
        message:
          activeProducts === 1
            ? 'In dieser Kategorie ist noch ein Produkt – verschieb oder lösch es zuerst'
            : `In dieser Kategorie sind noch ${activeProducts} Produkte – verschieb oder lösch sie zuerst`,
        params: { count: activeProducts },
      });
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.delete(Product, {
          categoryId: category.id,
          deletedAt: Not(IsNull()),
        });
        await manager.delete(Category, { id: category.id, eventId });
      });
    } catch (error) {
      if (isReferenceViolation(error)) {
        throw new ConflictException({
          code: ErrorCodes.CONFLICT,
          reason: ErrorReasons.CATEGORY_IN_USE,
          message:
            'Diese Kategorie wird noch von Bestellungen verwendet und kann nicht gelöscht werden',
        });
      }
      throw error;
    }

    this.logger.log(`Category deleted: ${category.name} (${category.id})`);

    // Notify menu displays
    this.gatewayService.notifyCategoryDeleted(
      event.organizationId,
      eventId,
      categoryId,
    );
  }

  /**
   * Uebergeordnete Kategorie und Produktionsstandort muessen zur selben
   * Veranstaltung gehoeren; eine Kategorie kann nicht unter sich selbst
   * oder unter einer ihrer Unterkategorien haengen.
   */
  private async assertReferences(
    event: Event,
    dto: { parentId?: string | null; productionStationId?: string | null },
    categoryId?: string,
  ): Promise<void> {
    await assertReferencesInOrganization(
      this.dataSource,
      { organizationId: event.organizationId, eventId: event.id },
      [
        { kind: 'category', ids: dto.parentId, field: 'parentId' },
        {
          kind: 'productionStation',
          ids: dto.productionStationId,
          field: 'productionStationId',
        },
      ],
    );
    if (!categoryId || !dto.parentId) return;
    const rows = (await this.dataSource.query(
      `WITH RECURSIVE ancestors(id, parent_id) AS (
         SELECT id, parent_id FROM categories WHERE id = $1 AND event_id = $2
         UNION
         SELECT c.id, c.parent_id FROM categories c
           JOIN ancestors a ON c.id = a.parent_id
          WHERE c.event_id = $2
       )
       SELECT 1 FROM ancestors WHERE id = $3 LIMIT 1`,
      [dto.parentId, event.id, categoryId],
    )) as unknown[];
    if (rows.length > 0) {
      throw referenceNotFound('category', 'parentId');
    }
  }

  async reorder(
    eventId: string,
    reorderDto: ReorderCategoriesDto,
    user: User,
  ): Promise<void> {
    const event = await this.getEventAndCheckPermission(
      eventId,
      user.id,
      'products',
    );

    for (let i = 0; i < reorderDto.categoryIds.length; i++) {
      await this.categoryRepository.update(
        { id: reorderDto.categoryIds[i], eventId },
        { sortOrder: i },
      );
    }

    this.logger.log(`Categories reordered for event ${eventId}`);

    // Notify menu displays to refresh
    this.gatewayService.notifyMenuRefresh(
      event.organizationId,
      eventId,
      'reorder',
    );
  }

  private async getEvent(eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    return event;
  }

  private async getEventAndCheckMembership(
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
        reason: ErrorReasons.EVENT_ACCESS_DENIED,
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
        reason: ErrorReasons.EVENT_ACCESS_DENIED,
        message: 'Kein Zugriff auf dieses Event',
      });
    }

    if (
      membership.role !== OrganizationRole.ADMIN &&
      !membership.permissions?.[permission]
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
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
        reason: ErrorReasons.EVENT_ACCESS_DENIED,
        message: 'Kein Zugriff auf dieses Event',
      });
    }

    if (membership.role !== OrganizationRole.ADMIN) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return event;
  }
}

/**
 * Postgres meldet Verweise auf die Kategorie als Fremdschluessel-Verstoss
 * (23503) oder — bei `ON DELETE SET NULL` auf einer NOT-NULL-Spalte wie
 * `order_items.category_id` — als NOT-NULL-Verstoss (23502).
 */
function isReferenceViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const code = (error as QueryFailedError & { driverError?: { code?: string } })
    .driverError?.code;
  return code === '23502' || code === '23503';
}
