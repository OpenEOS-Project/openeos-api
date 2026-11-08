import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { Order } from '../../database/entities/order.entity';
import { Organization } from '../../database/entities/organization.entity';
import { DeploymentService } from '../../common/services/deployment.service';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { normalizeBusinessDayStartHour } from '../../common/utils/event-schedule.util';
import {
  DEFAULT_EVENT_PHASE_SETTINGS,
  EventPhaseInfo,
  EventPhaseOrganization,
  EventPhaseSettings,
  OrderChannel,
  orderModeFor,
  resolveEventPhase,
} from '../../common/utils/event-phase.util';
import { isIntegrationEnabled } from '../integrations/integration-catalog';
import { assertTestEventOrderLimitNotReached } from '../../common/utils/test-event-order-limit.util';

/** Felder, die jede Antwort mit einer Veranstaltung zusaetzlich traegt. */
export interface EventPhaseFields {
  phase: EventPhaseInfo['phase'];
  realSalesFrom: string | null;
  realSalesUntil: string | null;
  presaleEnabled: boolean;
  phaseDetails: Omit<
    EventPhaseInfo,
    'phase' | 'realSalesFrom' | 'realSalesUntil' | 'presaleEnabled'
  >;
}

/** Spalten der Organisation, die die Phase braucht. */
const ORGANIZATION_SELECT = {
  id: true,
  settings: true,
  country: true,
  operatingMode: true,
} as const;

type PhaseOrganization = Pick<
  Organization,
  'id' | 'settings' | 'country' | 'operatingMode'
>;

/** Ergebnis von `prepareOrder`: wie die neue Bestellung gebucht wird. */
export interface OrderPreparation {
  info: EventPhaseInfo;
  /** Im Zustand „Geplant“ als Testbestellung buchen (an saveOrderWithNumbers). */
  plannedTest: boolean;
}

/**
 * Phasen einer Veranstaltung (event-phase.util.ts) mit Konfiguration und
 * Organisation: fuer Antworten (`decorate`) und an jeder Stelle, an der eine
 * Bestellung entsteht (`prepareOrder`).
 */
@Injectable()
export class EventPhaseService {
  readonly settings: EventPhaseSettings;
  readonly testEventMaxOrders: number;
  readonly plannedTestMaxOrders: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly deployment: DeploymentService,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {
    const read = (key: string, fallback: number): number => {
      const value = this.configService.get<number>(key);
      return typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
    };
    this.settings = {
      enabled: this.configService.get<boolean>('eventPhases.enabled') ?? true,
      billingEnabled: this.deployment.billingEnabled,
      dayStartHour: normalizeBusinessDayStartHour(
        this.configService.get<number>('billing.businessDayStartHour'),
      ),
      earlyStartHours: read(
        'eventPhases.earlyStartHours',
        DEFAULT_EVENT_PHASE_SETTINGS.earlyStartHours,
      ),
      maxEarlyStartHours: read(
        'eventPhases.maxEarlyStartHours',
        DEFAULT_EVENT_PHASE_SETTINGS.maxEarlyStartHours,
      ),
      graceHours: read(
        'eventPhases.graceHours',
        DEFAULT_EVENT_PHASE_SETTINGS.graceHours,
      ),
    };
    // Wie bisher an den Pruefstellen: ohne Konfiguration 25.
    this.testEventMaxOrders = read('billing.testEventMaxOrders', 25);
    this.plannedTestMaxOrders = read('eventPhases.plannedTestMaxOrders', 200);
  }

  /**
   * Ohne Dependency Injection, mit Standardwerten — Rueckfall fuer Klassen,
   * die in Tests von Hand gebaut werden (wie `tseSigning`). Mit Abrechnung,
   * ohne Konfiguration: Vorlauf 12 h, Kulanz 6 h.
   */
  static standalone(
    organizationRepository?: Repository<Organization> | null,
    orderRepository?: Repository<Order> | null,
    configService?: Pick<ConfigService, 'get'> | null,
    deployment?: Pick<DeploymentService, 'billingEnabled'> | null,
  ): EventPhaseService {
    const noRepo = {
      findOne: () => Promise.resolve(null),
      count: () => Promise.resolve(0),
      manager: undefined,
    } as unknown as Repository<never>;
    return new EventPhaseService(
      {
        get: (key: string): unknown =>
          typeof configService?.get === 'function'
            ? configService.get(key)
            : undefined,
      } as unknown as ConfigService,
      {
        billingEnabled: deployment?.billingEnabled ?? true,
      } as DeploymentService,
      (organizationRepository ?? noRepo) as Repository<Organization>,
      (orderRepository ?? noRepo) as Repository<Order>,
    );
  }

  /** Zeitzone und Cloud-TSE-Regel aus einer Organisation. */
  static organizationContext(
    organization: Partial<PhaseOrganization> | null | undefined,
  ): EventPhaseOrganization {
    const settings = (organization?.settings ?? null) as {
      timezone?: string;
    } | null;
    return {
      timezone: settings?.timezone || 'Europe/Berlin',
      usesCloudTse:
        (organization?.country ?? '').toUpperCase() === 'DE' &&
        organization?.operatingMode !== 'orders_only' &&
        isIntegrationEnabled(organization?.settings, 'tse'),
    };
  }

  async loadOrganization(
    organizationId: string,
    manager?: EntityManager,
  ): Promise<PhaseOrganization | null> {
    const repository = manager
      ? manager.getRepository(Organization)
      : this.organizationRepository;
    return repository.findOne({
      where: { id: organizationId },
      select: ORGANIZATION_SELECT,
    });
  }

  /** Phase einer Veranstaltung; die Organisation wird bei Bedarf geladen. */
  async resolve(
    event: Event,
    organization?: Partial<PhaseOrganization> | null,
    now: Date = new Date(),
  ): Promise<EventPhaseInfo> {
    const org =
      organization === undefined
        ? await this.loadOrganization(event.organizationId)
        : organization;
    return this.resolveWith(event, org, now);
  }

  resolveWith(
    event: Pick<
      Event,
      'status' | 'billingStatus' | 'startDate' | 'endDate' | 'settings'
    >,
    organization: Partial<PhaseOrganization> | null | undefined,
    now: Date = new Date(),
  ): EventPhaseInfo {
    return resolveEventPhase(
      event,
      EventPhaseService.organizationContext(organization),
      this.settings,
      now,
    );
  }

  /** Veranstaltung samt Phase fuer eine Antwort. */
  async decorate<T extends Event | null | undefined>(
    event: T,
    organization?: Partial<PhaseOrganization> | null,
  ): Promise<T extends Event ? T & EventPhaseFields : T> {
    if (!event) return event as never;
    const info = await this.resolve(event, organization);
    return Object.assign(event, toPhaseFields(info)) as never;
  }

  /** Mehrere Veranstaltungen; je Organisation eine Abfrage. */
  async decorateMany<T extends Event>(
    events: T[],
  ): Promise<(T & EventPhaseFields)[]> {
    const organizations = new Map<string, PhaseOrganization | null>();
    for (const event of events) {
      if (!organizations.has(event.organizationId)) {
        organizations.set(
          event.organizationId,
          await this.loadOrganization(event.organizationId),
        );
      }
    }
    const now = new Date();
    return events.map((event) =>
      Object.assign(
        event,
        toPhaseFields(
          this.resolveWith(event, organizations.get(event.organizationId), now),
        ),
      ),
    );
  }

  /**
   * Phase je Veranstaltungs-ID — fuer Listen, die Veranstaltungen nicht als
   * Entitaet laden (Super-Admin). Liest die Veranstaltungen selbst nach.
   */
  async phaseFieldsByIds(
    ids: string[],
    eventRepository: Repository<Event>,
  ): Promise<Map<string, EventPhaseFields>> {
    const result = new Map<string, EventPhaseFields>();
    if (ids.length === 0) return result;
    const events = await eventRepository.find({ where: { id: In(ids) } });
    for (const event of await this.decorateMany(events)) {
      result.set(event.id, {
        phase: event.phase,
        realSalesFrom: event.realSalesFrom,
        realSalesUntil: event.realSalesUntil,
        presaleEnabled: event.presaleEnabled,
        phaseDetails: event.phaseDetails,
      });
    }
    return result;
  }

  /**
   * Vor dem Anlegen einer Bestellung: darf ueber `channel` bestellt werden,
   * und wird es eine Testbestellung? Wirft 400 EVENT_NOT_ACTIVE (inaktiv),
   * 403 EVENT_ENDED (beendet), 403 SHOP_PRESALE_DISABLED (Shop vor dem
   * Verkaufsfenster ohne Vorverkauf) bzw. 403 TEST_LIMIT_REACHED.
   */
  async prepareOrder(
    event: Event,
    channel: OrderChannel,
    options: { organization?: Partial<PhaseOrganization> | null } = {},
  ): Promise<OrderPreparation> {
    const info = await this.resolve(event, options.organization);
    const mode = orderModeFor(info, channel);

    if (mode === 'reject') {
      if (info.phase === 'ended') throw endedError(info);
      if (info.phase === 'planned') {
        throw new ForbiddenException({
          code: ErrorCodes.FORBIDDEN,
          reason: ErrorReasons.SHOP_PRESALE_DISABLED,
          message:
            'Der Shop nimmt noch keine Bestellungen an – der Verkauf startet mit der Veranstaltung.',
          params: { realSalesFrom: info.realSalesFrom },
        });
      }
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.EVENT_NOT_ACTIVE,
        message: 'Event ist nicht aktiv',
      });
    }

    if (info.phase === 'test') {
      const existing = await this.orderRepository.count({
        where: { eventId: event.id },
      });
      assertTestEventOrderLimitNotReached(
        event.status,
        existing,
        this.testEventMaxOrders,
      );
    } else if (mode === 'test') {
      const existing = await this.orderRepository.count({
        where: { eventId: event.id, isTest: true },
      });
      if (existing >= this.plannedTestMaxOrders) {
        throw new ForbiddenException({
          code: ErrorCodes.TEST_LIMIT_REACHED,
          reason: ErrorReasons.PLANNED_TEST_LIMIT_REACHED,
          message: `Test-Limit im Testbetrieb erreicht (${this.plannedTestMaxOrders} Testbestellungen). Echte Verkäufe starten mit dem Verkaufsfenster der Veranstaltung.`,
          params: {
            maxOrders: this.plannedTestMaxOrders,
            phase: 'planned',
            realSalesFrom: info.realSalesFrom,
          },
        });
      }
    }

    return { info, plannedTest: info.phase === 'planned' && mode === 'test' };
  }

  /** 403 EVENT_ENDED, wenn das Verkaufsfenster samt Kulanz vorbei ist. */
  async assertNotEnded(event: Event): Promise<void> {
    const info = await this.resolve(event);
    if (info.phase === 'ended') throw endedError(info);
  }

  /**
   * Wird gerade test gebucht (Testmodus oder „Geplant“)? Fuer Pfand-
   * Rueckgaben, Testbons und die SumUp-Sperre ohne Bestellung.
   */
  async isTestModeNow(event: Event | null | undefined): Promise<boolean> {
    if (!event) return false;
    if (event.status === EventStatus.TEST) return true;
    if (event.status !== EventStatus.ACTIVE) return false;
    return (await this.resolve(event)).phase === 'planned';
  }
}

function endedError(info: EventPhaseInfo): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.EVENT_ENDED,
    message:
      'Die Veranstaltung ist beendet – neue Bestellungen sind nicht mehr möglich. Offene Bestellungen kannst du weiter kassieren, Tische schließen und erstatten.',
    params: { realSalesUntil: info.realSalesUntil },
  });
}

export function toPhaseFields(info: EventPhaseInfo): EventPhaseFields {
  const { phase, realSalesFrom, realSalesUntil, presaleEnabled, ...details } =
    info;
  return {
    phase,
    realSalesFrom,
    realSalesUntil,
    presaleEnabled,
    phaseDetails: details,
  };
}
