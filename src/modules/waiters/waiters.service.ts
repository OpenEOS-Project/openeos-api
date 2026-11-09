import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull, type EntityManager } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  AdminAction,
  AdminAuditLog,
  SYSTEM_AUDIT_IP,
} from '../../database/entities/admin-audit-log.entity';
import { Event } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import type { User } from '../../database/entities/user.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import {
  WAITER_PERMISSION_KEYS,
  Waiter,
  type WaiterPermissions,
  type WaiterRole,
} from '../../database/entities/waiter.entity';
import { GatewayService } from '../gateway/gateway.service';
import type {
  BulkCreateWaitersDto,
  CreateWaiterDto,
  UpdateWaiterDto,
} from './dto/waiter.dto';
import { PinCredentialsService } from './pin-credentials.service';
import { effectiveWaiterPermissions, waiterSettings } from './waiter-operator';
import { WaiterSessionsService } from './waiter-sessions.service';
import {
  retireWaiter,
  revokeWaiterAccess,
  waiterHasBookings,
} from './waiter-retire';
import {
  waiterAnonymizeDueAt,
  waiterRetentionPeriods,
  type WaiterRetentionPeriods,
} from './waiter-retention';
import { loadRetentionConfig } from '../retention/retention.config';
import { rowsOf } from '../tse/tse-sql.util';

/** Farben fuer neue Bedienungen (weisse Schrift lesbar), der Reihe nach. */
export const WAITER_COLORS = [
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#db2777',
  '#4d7c0f',
  '#b45309',
  '#4f46e5',
  '#0f766e',
  '#be123c',
] as const;

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface WaiterView {
  id: string;
  name: string;
  shortName: string | null;
  color: string | null;
  role: WaiterRole;
  permissions: WaiterPermissions;
  effectivePermissions: Record<string, boolean>;
  eventId: string | null;
  isActive: boolean;
  hasPin: boolean;
  pinLength: number | null;
  lastUsedAt: Date | null;
  anonymizedAt: Date | null;
  /** Ab wann der Loeschlauf sie anonymisiert (Hinweis in der Verwaltung). */
  anonymizeDueAt: Date | null;
  createdAt: Date;
}

/** Nur die bekannten Schalter, nur boolesche Werte. */
export function cleanPermissions(
  input: WaiterPermissions | null | undefined,
): WaiterPermissions {
  const out: WaiterPermissions = {};
  for (const key of WAITER_PERMISSION_KEYS) {
    const value = input?.[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/**
 * Bedienungen verwalten (Verwaltung, JWT): Admin oder Recht „Bedienungen“.
 * Nicht fuer API-Tokens oder MCP freigegeben (Entscheidung 14).
 */
@Injectable()
export class WaitersService {
  private readonly logger = new Logger(WaitersService.name);
  /** Fristen des Loeschlaufs (Hinweis „wird am … anonymisiert“). */
  readonly retentionPeriods: WaiterRetentionPeriods = waiterRetentionPeriods(
    loadRetentionConfig(),
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pins: PinCredentialsService,
    private readonly sessions: WaiterSessionsService,
    private readonly config: ConfigService,
    @Optional() private readonly gateway?: GatewayService,
  ) {}

  // ------------------------------------------------------------ Rechte

  async assertCanManage(
    organizationId: string,
    user: Pick<User, 'id'>,
  ): Promise<UserOrganization> {
    const membership = await this.dataSource
      .getRepository(UserOrganization)
      .findOne({ where: { organizationId, userId: user.id } });
    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
    if (
      membership.role !== OrganizationRole.ADMIN &&
      membership.permissions?.waiters !== true
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
    return membership;
  }

  // ------------------------------------------------------------ Lesen

  async list(
    organizationId: string,
    user: Pick<User, 'id'>,
    filter: { eventId?: string | null; active?: boolean | null } = {},
  ): Promise<{
    data: WaiterView[];
    meta: { limit: number; count: number; pinLength: number };
  }> {
    await this.assertCanManage(organizationId, user);
    const qb = this.dataSource
      .getRepository(Waiter)
      .createQueryBuilder('w')
      .where('w.organization_id = :organizationId', { organizationId })
      .andWhere('w.anonymized_at IS NULL');
    if (filter.eventId) {
      // Veranstaltung: ihre eigenen plus die organisationsweiten.
      qb.andWhere('(w.event_id = :eventId OR w.event_id IS NULL)', {
        eventId: filter.eventId,
      });
    }
    if (filter.active === true || filter.active === false) {
      qb.andWhere('w.is_active = :active', { active: filter.active });
    }
    const waiters = await qb
      .orderBy('w.is_active', 'DESC')
      .addOrderBy('lower(w.name)', 'ASC')
      .getMany();
    const views = await this.views(waiters);
    const organization = await this.organization(organizationId);
    return {
      data: views,
      meta: {
        limit: this.limitOf(organization),
        count: await this.countWaiters(this.dataSource.manager, organizationId),
        pinLength: waiterSettings(organization).pinLength,
      },
    };
  }

  async findOne(
    organizationId: string,
    waiterId: string,
    user: Pick<User, 'id'>,
  ): Promise<WaiterView> {
    await this.assertCanManage(organizationId, user);
    const [view] = await this.views([
      await this.load(organizationId, waiterId),
    ]);
    return view;
  }

  // ------------------------------------------------------------ Anlegen

  async create(
    organizationId: string,
    dto: CreateWaiterDto,
    user: User,
    meta: RequestMeta = {},
  ): Promise<WaiterView & { pin: string }> {
    await this.assertCanManage(organizationId, user);
    const { waiter, pin } = await this.dataSource.transaction(
      async (manager) => {
        const organization = await this.lockOrganization(
          manager,
          organizationId,
        );
        await this.assertLimit(manager, organization, 1);
        const eventId = await this.checkEvent(
          manager,
          organizationId,
          dto.eventId,
        );
        const count = await this.countWaiters(manager, organizationId);
        const waiter = await manager.getRepository(Waiter).save(
          manager.getRepository(Waiter).create({
            organizationId,
            eventId,
            name: dto.name,
            shortName: dto.shortName || null,
            color: dto.color ?? WAITER_COLORS[count % WAITER_COLORS.length],
            role: dto.role ?? 'service',
            permissions: cleanPermissions(dto.permissions),
            isActive: true,
            createdByUserId: user.id,
          }),
        );
        const owner = { ownerType: 'waiter' as const, ownerId: waiter.id };
        let pin = dto.pin;
        if (pin) {
          await this.pins.assign(organizationId, owner, pin, manager);
        } else {
          pin = (
            await this.pins.generate(
              organizationId,
              [owner],
              waiterSettings(organization).pinLength,
              manager,
            )
          ).get(waiter.id)!;
        }
        return { waiter, pin };
      },
    );
    await this.audit(
      AdminAction.WAITER_CREATED,
      organizationId,
      waiter.id,
      user,
      meta,
      {
        count: 1,
        eventId: waiter.eventId,
        ownPin: !!dto.pin,
      },
    );
    this.logger.log(
      `Waiter ${waiter.id} created in organization ${organizationId}`,
    );
    const [view] = await this.views([waiter]);
    return { ...view, pin };
  }

  async bulkCreate(
    organizationId: string,
    dto: BulkCreateWaitersDto,
    user: User,
    meta: RequestMeta = {},
  ): Promise<Array<WaiterView & { pin: string }>> {
    await this.assertCanManage(organizationId, user);
    const created = await this.dataSource.transaction(async (manager) => {
      const organization = await this.lockOrganization(manager, organizationId);
      await this.assertLimit(manager, organization, dto.items.length);
      const eventId = await this.checkEvent(
        manager,
        organizationId,
        dto.eventId,
      );
      const count = await this.countWaiters(manager, organizationId);
      const waiters = await manager.getRepository(Waiter).save(
        dto.items.map((item, index) =>
          manager.getRepository(Waiter).create({
            organizationId,
            eventId,
            name: item.name,
            shortName: item.shortName || null,
            color: WAITER_COLORS[(count + index) % WAITER_COLORS.length],
            role: item.role ?? dto.role ?? 'service',
            permissions: {},
            isActive: true,
            createdByUserId: user.id,
          }),
        ),
      );
      const pins = await this.pins.generate(
        organizationId,
        waiters.map((w) => ({ ownerType: 'waiter' as const, ownerId: w.id })),
        waiterSettings(organization).pinLength,
        manager,
      );
      return waiters.map((waiter) => ({ waiter, pin: pins.get(waiter.id)! }));
    });
    await this.audit(
      AdminAction.WAITER_CREATED,
      organizationId,
      null,
      user,
      meta,
      {
        count: created.length,
        eventId: dto.eventId ?? null,
        bulk: true,
      },
    );
    this.logger.log(
      `${created.length} waiters created in organization ${organizationId} (bulk)`,
    );
    const views = await this.views(created.map((c) => c.waiter));
    return views.map((view, i) => ({ ...view, pin: created[i].pin }));
  }

  // ------------------------------------------------------------ Aendern

  async update(
    organizationId: string,
    waiterId: string,
    dto: UpdateWaiterDto,
    user: User,
    meta: RequestMeta = {},
  ): Promise<WaiterView> {
    await this.assertCanManage(organizationId, user);
    const before = await this.load(organizationId, waiterId);
    if (before.anonymizedAt) throw this.notFound();
    const waiter = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Waiter);
      const current = await repo.findOneOrFail({ where: { id: waiterId } });
      if (dto.name !== undefined) current.name = dto.name;
      if (dto.shortName !== undefined)
        current.shortName = dto.shortName || null;
      if (dto.color !== undefined) current.color = dto.color;
      if (dto.role !== undefined) current.role = dto.role;
      if (dto.permissions !== undefined) {
        current.permissions = cleanPermissions(dto.permissions);
      }
      if (dto.eventId !== undefined) {
        current.eventId = await this.checkEvent(
          manager,
          organizationId,
          dto.eventId,
        );
      }
      // Reaktivieren zaehlt nicht neu (inaktive zaehlen schon mit); die
      // PIN vergibt danach „PIN neu vergeben“.
      const deactivated = dto.isActive === false && current.isActive;
      if (dto.isActive !== undefined) current.isActive = dto.isActive;
      // Frist des Loeschlaufs: 30 Tage nach Deaktivierung.
      if (deactivated) current.deactivatedAt = new Date();
      if (dto.isActive === true) current.deactivatedAt = null;
      const saved = await repo.save(current);
      if (deactivated) {
        // Deaktiviert: PIN weg, Sitzungen beendet (Geraet sperrt sofort).
        await this.pins.remove(
          { ownerType: 'waiter', ownerId: waiterId },
          manager,
        );
        await this.sessions.endForWaiter(waiterId, 'revoked', manager);
      }
      return saved;
    });
    this.notifyWaiterUpdated(
      organizationId,
      waiter,
      dto.isActive === false ? 'deactivated' : 'updated',
    );
    await this.audit(
      AdminAction.WAITER_UPDATED,
      organizationId,
      waiterId,
      user,
      meta,
      {
        before: this.auditFields(before),
        after: this.auditFields(waiter),
      },
    );
    const [view] = await this.views([waiter]);
    return view;
  }

  /** Neue PIN (erzeugt oder gewaehlt); beendet offene Sitzungen. */
  async resetPin(
    organizationId: string,
    waiterId: string,
    pin: string | undefined,
    user: User,
    meta: RequestMeta = {},
  ): Promise<{ id: string; pin: string }> {
    await this.assertCanManage(organizationId, user);
    const waiter = await this.load(organizationId, waiterId);
    if (waiter.anonymizedAt) throw this.notFound();
    if (!waiter.isActive) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.WAITER_INACTIVE,
        message: 'Die Bedienung ist deaktiviert. Aktiviere sie zuerst.',
      });
    }
    const result = await this.dataSource.transaction(async (manager) => {
      const organization = await this.organization(organizationId, manager);
      const owner = { ownerType: 'waiter' as const, ownerId: waiterId };
      let next = pin;
      if (next) {
        await this.pins.assign(organizationId, owner, next, manager);
      } else {
        next = (
          await this.pins.generate(
            organizationId,
            [owner],
            waiterSettings(organization).pinLength,
            manager,
          )
        ).get(waiterId)!;
      }
      await this.sessions.endForWaiter(waiterId, 'revoked', manager);
      return next;
    });
    this.notifyWaiterUpdated(organizationId, waiter, 'pin_reset');
    await this.audit(
      AdminAction.WAITER_PIN_RESET,
      organizationId,
      waiterId,
      user,
      meta,
      {
        ownPin: !!pin,
      },
    );
    return { id: waiterId, pin: result };
  }

  /**
   * Ohne Buchungen loeschen, sonst deaktivieren und anonymisieren
   * (Name → „Bedienung N“). Das Steuerarchiv (`operator_name`) bleibt.
   */
  async remove(
    organizationId: string,
    waiterId: string,
    user: User,
    meta: RequestMeta = {},
  ): Promise<{ deleted: boolean; anonymized: boolean }> {
    await this.assertCanManage(organizationId, user);
    const waiter = await this.load(organizationId, waiterId);
    const outcome = await this.dataSource.transaction(async (manager) => {
      if (waiter.anonymizedAt) {
        await revokeWaiterAccess(manager, [waiterId]);
        return { deleted: false, anonymized: true };
      }
      const result = await retireWaiter(manager, waiterId);
      return {
        deleted: result === 'deleted',
        anonymized: result !== 'deleted',
      };
    });
    this.notifyWaiterUpdated(organizationId, waiter, 'deactivated');
    await this.audit(
      AdminAction.WAITER_DELETED,
      organizationId,
      waiterId,
      user,
      meta,
      {
        ...outcome,
      },
    );
    return outcome;
  }

  // ------------------------------------------------------------ Auskunft

  /**
   * Auskunft (Art. 15 DSGVO) ueber eine Bedienung: Stammdaten (ohne PIN),
   * Anmeldungen an Geraeten, Abrechnungen und die Anzahl der zugeordneten
   * Buchungen. JSON oder CSV (Semikolon, UTF-8 mit BOM).
   */
  async exportData(
    organizationId: string,
    waiterId: string,
    user: User,
    meta: RequestMeta = {},
  ) {
    await this.assertCanManage(organizationId, user);
    const waiter = await this.load(organizationId, waiterId);
    const [view] = await this.views([waiter]);
    const event = waiter.eventId
      ? rowsOf<{ name: string }>(
          await this.dataSource.query(`SELECT name FROM events WHERE id = $1`, [
            waiter.eventId,
          ]),
        )[0]
      : null;
    const sessions = rowsOf<{
      started_at: Date;
      last_seen_at: Date;
      ended_at: Date | null;
      end_reason: string | null;
      device_name: string | null;
    }>(
      await this.dataSource.query(
        `SELECT s.started_at, s.last_seen_at, s.ended_at, s.end_reason, d.name AS device_name
           FROM waiter_sessions s LEFT JOIN devices d ON d.id = s.device_id
          WHERE s.waiter_id = $1 AND s.organization_id = $2
          ORDER BY s.started_at`,
        [waiterId, organizationId],
      ),
    );
    const settlements = rowsOf<{
      number: number | null;
      is_test: boolean;
      created_at: Date;
      period_from: Date | null;
      period_to: Date;
      event_name: string | null;
      cash_expected: string | null;
      forced: boolean;
    }>(
      await this.dataSource.query(
        `SELECT s.number, s.is_test, s.created_at, s.period_from, s.period_to,
                e.name AS event_name, s.cash_expected, s.forced
           FROM waiter_settlements s LEFT JOIN events e ON e.id = s.event_id
          WHERE s.waiter_id = $1 AND s.organization_id = $2
          ORDER BY s.created_at`,
        [waiterId, organizationId],
      ),
    );
    const [counts] = rowsOf<Record<string, number>>(
      await this.dataSource.query(
        `SELECT
           (SELECT count(*) FROM orders WHERE created_by_waiter_id = $1)::int AS "ordersTaken",
           (SELECT count(*) FROM orders WHERE waiter_id = $1)::int AS "ordersResponsible",
           (SELECT count(*) FROM order_items WHERE added_by_waiter_id = $1)::int AS "itemsSent",
           (SELECT count(*) FROM payments WHERE processed_by_waiter_id = $1)::int AS "paymentsProcessed",
           (SELECT count(*) FROM refunds WHERE waiter_id = $1)::int AS "refundsTriggered",
           (SELECT count(*) FROM refunds WHERE approved_by_waiter_id = $1)::int AS "refundsApproved",
           (SELECT count(*) FROM pfand_returns WHERE waiter_id = $1)::int AS "pfandReturns",
           (SELECT count(*) FROM order_events WHERE waiter_id = $1)::int AS "orderEvents",
           (SELECT count(*) FROM cashbook_entries WHERE waiter_id = $1)::int AS "cashbookEntries",
           (SELECT count(*) FROM tse_transactions WHERE waiter_id = $1)::int AS "fiscalTransactions"`,
        [waiterId],
      ),
    );
    await this.audit(
      AdminAction.WAITER_UPDATED,
      organizationId,
      waiterId,
      user,
      meta,
      { export: true },
    );
    return {
      exportedAt: new Date(),
      waiter: {
        id: view.id,
        name: view.name,
        shortName: view.shortName,
        color: view.color,
        role: view.role,
        permissions: view.effectivePermissions,
        event: event?.name ?? null,
        isActive: view.isActive,
        hasPin: view.hasPin,
        lastUsedAt: view.lastUsedAt,
        createdAt: view.createdAt,
        anonymizedAt: view.anonymizedAt,
        anonymizeDueAt: view.anonymizeDueAt,
      },
      sessions: sessions.map((s) => ({
        device: s.device_name,
        startedAt: s.started_at,
        lastSeenAt: s.last_seen_at,
        endedAt: s.ended_at,
        endReason: s.end_reason,
      })),
      settlements: settlements.map((s) => ({
        number: s.number,
        training: s.is_test,
        createdAt: s.created_at,
        periodFrom: s.period_from,
        periodTo: s.period_to,
        event: s.event_name,
        cashExpected: s.cash_expected === null ? null : Number(s.cash_expected),
        forced: s.forced,
      })),
      bookings: counts ?? {},
      notes: [
        'Die PIN ist nur als nicht umkehrbarer Prüfwert gespeichert und daher nicht enthalten.',
        'Im Steuerarchiv (TSE, Kassenabschlüsse, Kassenbuch) bleibt der Name beim Buchen zehn Jahre gespeichert.',
      ],
    };
  }

  // ------------------------------------------------------------ Hilfen

  private async load(
    organizationId: string,
    waiterId: string,
  ): Promise<Waiter> {
    const waiter = await this.dataSource
      .getRepository(Waiter)
      .findOne({ where: { id: waiterId, organizationId } });
    if (!waiter) throw this.notFound();
    return waiter;
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: ErrorCodes.NOT_FOUND,
      reason: ErrorReasons.WAITER_NOT_FOUND,
      message: 'Bedienung nicht gefunden',
    });
  }

  private async organization(
    organizationId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Organization> {
    const organization = await manager
      .getRepository(Organization)
      .findOne({ where: { id: organizationId } });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    return organization;
  }

  private async lockOrganization(
    manager: EntityManager,
    organizationId: string,
  ): Promise<Organization> {
    // Zeile sperren: zwei gleichzeitige Anlagen sehen nicht beide „frei“.
    await manager.query(
      `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
      [organizationId],
    );
    return this.organization(organizationId, manager);
  }

  get defaultLimit(): number {
    const value = Number(
      this.config.get<number>('limits.waitersPerOrganization'),
    );
    return Number.isInteger(value) && value >= 0 ? value : 200;
  }

  limitOf(organization: Pick<Organization, 'waiterLimit'>): number {
    return organization.waiterLimit ?? this.defaultLimit;
  }

  /** Bedienungen, die zaehlen: alle nicht anonymisierten (auch inaktive). */
  countWaiters(
    manager: EntityManager,
    organizationId: string,
  ): Promise<number> {
    return manager
      .getRepository(Waiter)
      .count({ where: { organizationId, anonymizedAt: IsNull() } });
  }

  private async assertLimit(
    manager: EntityManager,
    organization: Organization,
    adding: number,
  ): Promise<void> {
    const limit = this.limitOf(organization);
    if (limit === 0) return;
    const count = await this.countWaiters(manager, organization.id);
    if (count + adding > limit) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.WAITER_LIMIT_REACHED,
        message: `Höchstens ${limit} Bedienungen je Organisation (angelegt: ${count}).`,
        params: { limit, count },
      });
    }
  }

  private async checkEvent(
    manager: EntityManager,
    organizationId: string,
    eventId: string | null | undefined,
  ): Promise<string | null> {
    if (!eventId) return null;
    const event = await manager.getRepository(Event).findOne({
      where: { id: eventId, organizationId },
      select: { id: true },
    });
    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }
    return event.id;
  }

  /** Steht die Bedienung in irgendeiner Buchung (oder Abrechnung)? */
  hasBookings(manager: EntityManager, waiterId: string): Promise<boolean> {
    return waiterHasBookings(manager, waiterId);
  }

  private async views(waiters: Waiter[]): Promise<WaiterView[]> {
    const ids = waiters.map((w) => w.id);
    const eventIds = [
      ...new Set(
        waiters.map((w) => w.eventId).filter((id): id is string => !!id),
      ),
    ];
    const events: {
      id: string;
      end_date: Date | null;
      deleted_at: Date | null;
    }[] = eventIds.length
      ? await this.dataSource.query(
          `SELECT id, end_date, deleted_at FROM events WHERE id = ANY($1::uuid[])`,
          [eventIds],
        )
      : [];
    const withPin = await this.pins.ownersWithPin('waiter', ids);
    const lengths: { owner_id: string; pin_length: number }[] = ids.length
      ? await this.dataSource.query(
          `SELECT owner_id, pin_length FROM pin_credentials WHERE owner_type = 'waiter' AND owner_id = ANY($1::uuid[])`,
          [ids],
        )
      : [];
    return waiters.map((w) => ({
      id: w.id,
      name: w.name,
      shortName: w.shortName,
      color: w.color,
      role: w.role,
      permissions: w.permissions ?? {},
      effectivePermissions: effectiveWaiterPermissions(w.role, w.permissions),
      eventId: w.eventId,
      isActive: w.isActive,
      hasPin: withPin.has(w.id),
      pinLength: lengths.find((l) => l.owner_id === w.id)?.pin_length ?? null,
      lastUsedAt: w.lastUsedAt,
      anonymizedAt: w.anonymizedAt,
      anonymizeDueAt: waiterAnonymizeDueAt(
        w,
        events.find((e) => e.id === w.eventId) ?? null,
        this.retentionPeriods,
      ),
      createdAt: w.createdAt,
    }));
  }

  private auditFields(w: Waiter) {
    return {
      name: w.name,
      shortName: w.shortName,
      role: w.role,
      permissions: w.permissions,
      eventId: w.eventId,
      isActive: w.isActive,
    };
  }

  private notifyWaiterUpdated(
    organizationId: string,
    waiter: Pick<Waiter, 'id'>,
    change: 'updated' | 'deactivated' | 'pin_reset',
  ): void {
    try {
      this.gateway?.notifyWaiterUpdated(organizationId, {
        waiterId: waiter.id,
        change,
      });
    } catch (error) {
      this.logger.warn(`waiterUpdated not sent: ${(error as Error).message}`);
    }
  }

  private async audit(
    action: AdminAction,
    organizationId: string,
    waiterId: string | null,
    user: Pick<User, 'id'>,
    meta: RequestMeta,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      const repo = this.dataSource.getRepository(AdminAuditLog);
      await repo.save(
        repo.create({
          adminUserId: user.id,
          organizationId,
          action,
          resourceType: 'waiter',
          resourceId: waiterId,
          details,
          ipAddress: (meta.ipAddress || SYSTEM_AUDIT_IP).slice(0, 45),
          userAgent: meta.userAgent?.slice(0, 500) ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(
        `Audit ${action} for org ${organizationId} not written: ${(error as Error).message}`,
      );
    }
  }
}
