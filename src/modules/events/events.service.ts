import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
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
import {
  countBillableDays,
  normalizeBusinessDayStartHour,
} from '../../common/utils/event-schedule.util';
import { TestOrderCleanupService } from './test-order-cleanup.service';
import { retireEventWaiters } from '../waiters/waiter-retire';
import {
  EventPhaseFields,
  EventPhaseService,
  toPhaseFields,
} from './event-phase.service';
import { EventPhaseInfo } from '../../common/utils/event-phase.util';

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
    private readonly configService: ConfigService,
    // Optional mit Rueckfall fuer von Hand gebaute Tests (Standardwerte).
    @Optional()
    private readonly eventPhaseService?: EventPhaseService,
  ) {}

  private get eventPhase(): EventPhaseService {
    return (
      this.eventPhaseService ??
      EventPhaseService.standalone(
        this.organizationRepository,
        this.orderRepository,
        this.configService,
        this.deployment,
      )
    );
  }

  private emitStatusChanged(event: Event): void {
    const phase = (event as Partial<EventPhaseFields>).phase;
    this.gatewayService.notifyEventStatusChanged(event.organizationId, {
      eventId: event.id,
      organizationId: event.organizationId,
      status: event.status,
      name: event.name,
      ...(phase ? { phase } : {}),
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
   *
   * Bezahlt sind die beim Freischalten festgehaltenen Tage (`billedDays`).
   * Gezaehlt wird wie beim Preis nach Geschaeftstagen; ergibt der jetzige
   * Zeitraum danach mehr Tage als festgehalten — etwa bei einer noch nach
   * Kalendertagen bezahlten Veranstaltung, die vor 6 Uhr beginnt —, gilt
   * der jetzige Zeitraum als bezahlt, damit eine unveraenderte
   * Veranstaltung nicht ploetzlich als verlaengert abgelehnt wird.
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

    const dayStartHour = normalizeBusinessDayStartHour(
      this.configService.get<number>('billing.businessDayStartHour'),
    );

    const paidDays = Math.max(
      event.billedDays ?? 0,
      countBillableDays(event.startDate, event.endDate, timezone, dayStartHour),
    );
    const nextDays = countBillableDays(
      nextStart,
      nextEnd,
      timezone,
      dayStartHour,
    );

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
    return this.applyUpdate(event, updateDto, { override: false });
  }

  /**
   * Support verschiebt eine Veranstaltung, deren Verkaufsfenster schon
   * begonnen hat (`POST /admin/events/:id/dates`). Die bezahlte Dauer gilt
   * weiter; protokolliert wird im Admin-Controller.
   */
  async moveDatesAsSupport(
    eventId: string,
    dates: { startDate?: string; endDate?: string },
  ): Promise<{
    event: Event;
    before: { startDate: Date | null; endDate: Date | null };
  }> {
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
    const before = { startDate: event.startDate, endDate: event.endDate };
    await this.applyUpdate(
      event,
      { startDate: dates.startDate, endDate: dates.endDate },
      { override: true },
    );
    return { event, before };
  }

  /**
   * Verschieben nach den Phasen (Entscheidung 2026-11-08):
   * - „Geplant“ (bzw. vor dem Kauf, eigene Installation): frei, mit
   *   Abrechnung innerhalb der bezahlten Tage.
   * - Ab Beginn des Verkaufsfensters: Beginn fest. Das Ende darf nur noch
   *   frueher werden (z. B. ein Tag faellt aus) und nicht vor „jetzt“
   *   enden; nach dem Ende ist nichts mehr zu verschieben.
   * - Support mit Grund (`override`) uebersteuert die Sperre.
   * Der eigene Vorlauf (`settings.sales.earlyStartHours`) verschiebt den
   * Beginn des Fensters und ist damit ebenso gesperrt.
   */
  private async applyUpdate(
    event: Event,
    updateDto: UpdateEventDto,
    options: { override: boolean },
  ): Promise<Event> {
    const organizationId = event.organizationId;
    const organization = await this.eventPhase.loadOrganization(organizationId);
    const now = new Date();
    const before = this.eventPhase.resolveWith(event, organization, now);

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
      if (before.datesLocked && !options.override) {
        this.assertLockedDateChange(
          event,
          before,
          nextStart,
          nextEnd,
          now,
          organization,
        );
      }
      await this.assertPaidDurationNotExtended(event, nextStart, nextEnd);
      event.startDate = nextStart;
      event.endDate = nextEnd;
    }

    if (updateDto.name) event.name = updateDto.name;
    if (updateDto.description !== undefined)
      event.description = updateDto.description;
    let settingsChanged = false;
    if (updateDto.settings) {
      const withTables = await this.withTablesSettings(
        organizationId,
        event.settings ?? {},
        updateDto.settings as EventSettings,
      );
      const next = this.withSalesSettings(
        event.settings ?? {},
        withTables,
        updateDto.settings as EventSettings,
      );
      const earlyStartChanged =
        (next.sales?.earlyStartHours ?? null) !==
        (event.settings?.sales?.earlyStartHours ?? null);
      if (earlyStartChanged && before.datesLocked && !options.override) {
        throw this.datesLockedError(before);
      }
      settingsChanged =
        JSON.stringify(next) !== JSON.stringify(event.settings ?? {});
      event.settings = next;
    }

    // Verkaufsfenster liegt wieder in der Zukunft (Support hat nach hinten
    // verschoben) — auch bei einer gerade ausgeschalteten Veranstaltung:
    // beim naechsten Beginn wieder aufraeumen.
    const after = this.eventPhase.resolveWith(event, organization, now);
    if (event.salesStartedAt && salesWindowAhead(after, now)) {
      event.salesStartedAt = null;
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
    if (after.phase !== before.phase) {
      this.emitStatusChanged(
        Object.assign(event, toPhaseFields(after)) as Event,
      );
    }

    return event;
  }

  private datesLockedError(info: EventPhaseInfo): BadRequestException {
    return new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.EVENT_DATES_LOCKED,
      message:
        'Der Verkauf dieser Veranstaltung hat begonnen – Beginn und Vorlauf lassen sich nicht mehr verschieben. Das Ende kannst du nur noch vorziehen.',
      params: {
        phase: info.phase,
        realSalesFrom: info.realSalesFrom,
        realSalesUntil: info.realSalesUntil,
      },
    });
  }

  private assertLockedDateChange(
    event: Event,
    info: EventPhaseInfo,
    nextStart: Date | null,
    nextEnd: Date | null,
    now: Date,
    organization: Awaited<ReturnType<EventPhaseService['loadOrganization']>>,
  ): void {
    const time = (d: Date | null) => (d ? new Date(d).getTime() : null);
    const startChanged = time(nextStart) !== time(event.startDate);
    const currentEnd = time(event.endDate ?? event.startDate);
    const endChanged = time(nextEnd) !== currentEnd;
    if (!startChanged && !endChanged) return;

    const ended =
      !!info.realSalesUntil &&
      now.getTime() >= new Date(info.realSalesUntil).getTime();
    if (startChanged || ended) throw this.datesLockedError(info);

    // Nur vorziehen — und nicht in die Vergangenheit.
    const nextEndTime = time(nextEnd);
    if (
      nextEndTime === null ||
      currentEnd === null ||
      nextEndTime > currentEnd
    ) {
      throw this.datesLockedError(info);
    }
    const shortened = this.eventPhase.resolveWith(
      { ...event, endDate: nextEnd } as Event,
      organization,
      now,
    );
    const until = shortened.realSalesUntil
      ? new Date(shortened.realSalesUntil).getTime()
      : null;
    if (until !== null && until <= now.getTime()) {
      throw this.datesLockedError(info);
    }
  }

  /**
   * `settings.sales` pruefen und mit dem Bestand zusammenfuehren (ein Patch
   * mit nur `presale` laesst den Vorlauf stehen).
   */
  private withSalesSettings(
    current: EventSettings,
    next: EventSettings,
    patch: EventSettings,
  ): EventSettings {
    if (!('sales' in patch)) return next;
    const raw = patch.sales as unknown;
    if (raw === null || raw === undefined) {
      const rest = { ...next };
      delete rest.sales;
      return rest;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw this.earlyStartInvalid();
    }
    const value = raw as { earlyStartHours?: unknown; presale?: unknown };
    const sales: NonNullable<EventSettings['sales']> = {
      ...(current.sales ?? {}),
    };
    if ('earlyStartHours' in value) {
      const hours = value.earlyStartHours;
      if (hours === null || hours === undefined || hours === '') {
        delete sales.earlyStartHours;
      } else {
        const n = Number(hours);
        const max = this.eventPhase.settings.maxEarlyStartHours;
        if (!Number.isFinite(n) || n < 0 || n > max) {
          throw this.earlyStartInvalid();
        }
        sales.earlyStartHours = Math.round(n * 4) / 4;
      }
    }
    if ('presale' in value) {
      if (typeof value.presale !== 'boolean') throw this.earlyStartInvalid();
      sales.presale = value.presale;
    }
    return { ...next, sales };
  }

  private earlyStartInvalid(): BadRequestException {
    const max = this.eventPhase.settings.maxEarlyStartHours;
    return new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.EVENT_EARLY_START_INVALID,
      message: `Der Vorlauf muss zwischen 0 und ${max} Stunden liegen, Vorverkauf an oder aus`,
      params: { max },
    });
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

    // Bedienungen dieser Veranstaltung koennen sich nicht mehr anmelden:
    // ohne Buchungen geloescht, sonst deaktiviert (die Zuordnung in
    // Zahlungen und Erstattungen bleibt; der Loeschlauf anonymisiert sie).
    const retired = await this.eventRepository.manager.transaction(
      async (manager) => {
        const result = await retireEventWaiters(
          manager,
          organizationId,
          event.id,
        );
        await manager.getRepository(Event).softRemove(event);
        return result;
      },
    );
    for (const waiterId of retired.waiterIds) {
      this.gatewayService.notifyWaiterUpdated(organizationId, {
        waiterId,
        change: 'deactivated',
      });
    }

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
        // Liegt das Verkaufsfenster noch vor uns, raeumt der Uebergangslauf
        // zu seinem Beginn (wieder) auf.
        if (
          event.salesStartedAt &&
          salesWindowAhead(
            this.eventPhase.resolveWith(
              event,
              await this.eventPhase.loadOrganization(organizationId, manager),
            ),
            new Date(),
          )
        ) {
          event.salesStartedAt = null;
        }
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

    // Nur innerhalb der Organisation: Karte, Preise und Pfand-Typen
    // passen nur dort zueinander.
    const sourceEvent = await this.eventRepository.findOne({
      where: { id: sourceEventId, organizationId },
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

    // All or nothing: a copy that fails halfway must not leave a partial
    // menu in the target event.
    const categoryIdMap = new Map<string, string>();
    let productsCopied = 0;
    await this.eventRepository.manager.transaction(async (manager) => {
      const categoryRepo = manager.getRepository(Category);
      const productRepo = manager.getRepository(Product);

      const topLevelCategories = sourceCategories.filter((c) => !c.parentId);
      for (const sourceCategory of topLevelCategories) {
        const newCategory = categoryRepo.create({
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
        await categoryRepo.save(newCategory);
        categoryIdMap.set(sourceCategory.id, newCategory.id);
      }

      const childCategories = sourceCategories.filter((c) => c.parentId);
      for (const sourceCategory of childCategories) {
        const newParentId = categoryIdMap.get(sourceCategory.parentId!) || null;
        const newCategory = categoryRepo.create({
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
        await categoryRepo.save(newCategory);
        categoryIdMap.set(sourceCategory.id, newCategory.id);
      }

      for (const sourceProduct of sourceProducts) {
        const newCategoryId = categoryIdMap.get(sourceProduct.categoryId);
        if (!newCategoryId) {
          continue;
        }

        const newProduct = productRepo.create({
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
        await productRepo.save(newProduct);
        productsCopied++;
      }

      targetEvent.copiedFromEventId = sourceEventId;
      await manager.getRepository(Event).save(targetEvent);
    });

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

/** Beginnt das Verkaufsfenster erst noch? */
function salesWindowAhead(info: EventPhaseInfo, now: Date): boolean {
  return (
    !!info.realSalesFrom &&
    now.getTime() < new Date(info.realSalesFrom).getTime()
  );
}
