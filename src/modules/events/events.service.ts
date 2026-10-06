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
  TableArea,
} from '../../database/entities';
import {
  EVENT_TABLE_MODES,
  EventSettings,
  EventTableMode,
  EventStatus,
  EVENT_PAID_BILLING_STATUSES,
  isEventBillingUnlocked,
} from '../../database/entities/event.entity';
import { DeploymentService } from '../../common/services/deployment.service';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  PaginationDto,
  PaginatedResult,
  createPaginatedResult,
} from '../../common/dto/pagination.dto';
import { CreateEventDto, UpdateEventDto, CopyProductsDto } from './dto';
import { GatewayService } from '../gateway/gateway.service';
import { countEventDays } from '../../common/utils/event-schedule.util';
import { TestOrderCleanupService } from './test-order-cleanup.service';

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
    @InjectRepository(TableArea)
    private readonly tableAreaRepository: Repository<TableArea>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    private readonly deployment: DeploymentService,
    private readonly testOrderCleanupService: TestOrderCleanupService,
  ) {}

  private emitStatusChanged(event: Event): void {
    this.gatewayService.notifyEventStatusChanged(event.organizationId, {
      eventId: event.id,
      organizationId: event.organizationId,
      status: event.status,
      name: event.name,
    });
  }

  private assertChronological(
    startDate: Date | null,
    endDate: Date | null,
  ): void {
    if (!startDate || !endDate) return;
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.INVALID_DATE,
        message: 'Ungültiges Datum',
      });
    }
    if (endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EVENT_END_BEFORE_START,
        message: 'Das Ende der Veranstaltung darf nicht vor dem Beginn liegen',
      });
    }
  }

  /**
   * Eine bereits bezahlte Veranstaltung darf nachtraeglich nicht laenger
   * werden. Sonst liesse sich ein Tag buchen und anschliessend auf eine Woche
   * verlaengern, ohne dass je eine zweite Rechnung entstuende. Verschieben und
   * verkuerzen bleiben erlaubt.
   */
  private async assertPaidDurationNotExtended(
    event: Event,
    nextStart: Date | null,
    nextEnd: Date | null,
  ): Promise<void> {
    // Ohne Abrechnung gibt es keine bezahlte Dauer, die sich ausdehnen liesse.
    if (!this.deployment.billingEnabled) return;
    if (!EVENT_PAID_BILLING_STATUSES.includes(event.billingStatus)) return;

    const organization = await this.organizationRepository.findOne({
      where: { id: event.organizationId },
    });
    const timezone = organization?.settings?.timezone || 'Europe/Berlin';

    const paidDays = countEventDays(event.startDate, event.endDate, timezone);
    const nextDays = countEventDays(nextStart, nextEnd, timezone);

    if (nextDays > paidDays) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EVENT_PAID_DAYS_EXCEEDED,
        message: `Die Veranstaltung ist für ${paidDays} Tag(e) freigeschaltet und kann nicht auf ${nextDays} Tage verlängert werden`,
        params: { paidDays, requestedDays: nextDays },
      });
    }
  }

  async create(
    organizationId: string,
    createDto: CreateEventDto,
    user: User,
  ): Promise<Event> {
    await this.checkPermission(organizationId, user.id, 'events');

    const startDate = new Date(createDto.startDate);
    // Ohne eigenes Ende endet die Veranstaltung mit ihrem Beginn — daraus wird
    // ein eintaegiger Zeitraum, der Shop hat dann rund um die Uhr offen.
    const endDate = createDto.endDate ? new Date(createDto.endDate) : startDate;
    this.assertChronological(startDate, endDate);
    const settings = await this.withTablesSettings(
      organizationId,
      {},
      (createDto.settings || {}) as EventSettings,
    );

    const event = this.eventRepository.create({
      organizationId,
      name: createDto.name,
      description: createDto.description,
      startDate,
      endDate,
      status: EventStatus.INACTIVE,
      settings,
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
        reason: ErrorReasons.EVENT_NOT_FOUND,
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

    const datesChanged =
      updateDto.startDate !== undefined || updateDto.endDate !== undefined;
    if (datesChanged) {
      const nextStart = updateDto.startDate
        ? new Date(updateDto.startDate)
        : event.startDate;
      const nextEnd = updateDto.endDate
        ? new Date(updateDto.endDate)
        : updateDto.startDate
          ? new Date(updateDto.startDate)
          : event.endDate;
      this.assertChronological(nextStart, nextEnd);
      await this.assertPaidDurationNotExtended(event, nextStart, nextEnd);
      event.startDate = nextStart;
      event.endDate = nextEnd;
    }

    if (updateDto.name) event.name = updateDto.name;
    if (updateDto.description !== undefined)
      event.description = updateDto.description;
    let settingsChanged = false;
    if (updateDto.settings) {
      const next = await this.withTablesSettings(
        organizationId,
        event.settings ?? {},
        updateDto.settings as EventSettings,
      );
      settingsChanged =
        JSON.stringify(next) !== JSON.stringify(event.settings ?? {});
      event.settings = next;
    }

    await this.eventRepository.save(event);

    this.logger.log(`Event updated: ${event.name} (${event.id})`);

    // Kassen laden Tischmodus, Kassiermodus usw. neu.
    if (settingsChanged) {
      this.gatewayService.notifyMenuRefresh(
        organizationId,
        event.id,
        'event-settings',
      );
    }

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
        reason: ErrorReasons.EVENT_ACTIVE_CANNOT_DELETE,
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
    const event = await this.getEventAndCheckPermission(
      organizationId,
      eventId,
      user.id,
      'events',
    );

    if (event.status === EventStatus.ACTIVE) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EVENT_ALREADY_ACTIVE,
        message: 'Event ist bereits aktiv',
      });
    }

    // Im Self-Hosted-Betrieb gibt es keine kostenpflichtige Freischaltung,
    // also auch nichts zu pruefen. Der Zustand `billingStatus` bleibt dort
    // auf 'none' stehen — bewusst nicht auf 'waived' gesetzt: "erlassen"
    // hiesse, es haette etwas gekostet.
    if (
      this.deployment.billingEnabled &&
      !isEventBillingUnlocked(event.billingStatus)
    ) {
      throw new BadRequestException({
        code: ErrorCodes.EVENT_NOT_PAID,
        message:
          'Veranstaltung ist noch nicht freigeschaltet — bitte zuerst kostenpflichtig bestellen',
      });
    }

    /* Aktivieren loescht die Testbuchungen — Oberflaeche, Doku und AGB
       versprechen das. Alles in einer Transaktion: schlaegt das Loeschen
       fehl, bleibt auch der Status, wie er war. Die Zeile der
       Veranstaltung wird exklusiv gesperrt; eine gleichzeitig angelegte
       Bestellung (sperrt sie geteilt) landet so entweder vorher als
       Testbestellung oder nachher als echte. */
    const { deactivatedSiblings, purge } =
      await this.eventRepository.manager.transaction(async (manager) => {
        await manager.query(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [
          event.id,
        ]);

        const purgeResult = await this.testOrderCleanupService.purge(
          manager,
          organizationId,
          event.id,
        );

        const repository = manager.getRepository(Event);
        const siblings = await this.deactivateActiveOrTestSiblings(
          organizationId,
          event.id,
          repository,
        );

        event.status = EventStatus.ACTIVE;
        await repository.save(event);

        return { deactivatedSiblings: siblings, purge: purgeResult };
      });

    this.logger.log(`Event activated: ${event.name} (${event.id})`);

    this.emitStatusChanged(event);
    for (const sibling of deactivatedSiblings) {
      this.emitStatusChanged(sibling);
    }
    this.testOrderCleanupService.notify(purge);

    return event;
  }

  async deactivate(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<Event> {
    const event = await this.getEventAndCheckPermission(
      organizationId,
      eventId,
      user.id,
      'events',
    );

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
    const event = await this.getEventAndCheckPermission(
      organizationId,
      eventId,
      user.id,
      'events',
    );

    if (event.status === EventStatus.TEST) {
      return event;
    }

    const deactivatedSiblings = await this.deactivateActiveOrTestSiblings(
      organizationId,
      event.id,
    );

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
    repository: Repository<Event> = this.eventRepository,
  ): Promise<Event[]> {
    const siblings = await repository.find({
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
      await repository.save(toDeactivate);
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
        reason: ErrorReasons.SOURCE_EVENT_NOT_FOUND,
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

    const topLevelCategories = sourceCategories.filter((c) => !c.parentId);
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

    const childCategories = sourceCategories.filter((c) => c.parentId);
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
        icon: sourceProduct.icon,
        isFavorite: sourceProduct.isFavorite,
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
        reason: ErrorReasons.EVENT_NOT_FOUND,
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
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    return event;
  }

  /**
   * Fuehrt `patch` in `current` zusammen. Enthaelt `patch` den Block
   * `tables` (Tischmodus + Bereiche), wird er geprueft und in Normalform
   * `{ mode, areaIds }` gebracht; `tables: null` entfernt ihn (dann gilt
   * wieder `free`). Bereiche muessen zur Organisation gehoeren. Ohne
   * `tables` im Patch bleibt der gespeicherte Block unangetastet.
   */
  private async withTablesSettings(
    organizationId: string,
    current: EventSettings,
    patch: EventSettings,
  ): Promise<EventSettings> {
    const next: EventSettings = { ...current, ...patch };
    if (!('tables' in patch)) return next;

    const raw = patch.tables as unknown;
    if (raw === null || raw === undefined) {
      delete next.tables;
      return next;
    }

    const value = raw as { mode?: unknown; areaIds?: unknown };
    if (
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !EVENT_TABLE_MODES.includes(value.mode as EventTableMode)
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TABLE_MODE_INVALID,
        message:
          'Wähle einen gültigen Tischmodus (keine, frei oder vordefiniert)',
      });
    }

    let areaIds: string[] | null = null;
    if (value.areaIds !== undefined && value.areaIds !== null) {
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        !Array.isArray(value.areaIds) ||
        value.areaIds.some((id) => typeof id !== 'string' || !uuid.test(id))
      ) {
        throw this.tableAreaMissing();
      }
      areaIds = [...new Set(value.areaIds as string[])];
      if (areaIds.length) {
        const found = await this.tableAreaRepository.count({
          where: { organizationId, id: In(areaIds) },
        });
        if (found !== areaIds.length) throw this.tableAreaMissing();
      }
    }

    next.tables = { mode: value.mode as EventTableMode, areaIds };
    return next;
  }

  private tableAreaMissing() {
    return new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.TABLE_AREA_NOT_FOUND,
      message: 'Mindestens ein gewählter Bereich existiert nicht mehr',
    });
  }

  // Helper methods
  private async checkMembership(
    organizationId: string,
    userId: string,
  ): Promise<UserOrganization> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
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
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
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
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return membership;
  }
}
