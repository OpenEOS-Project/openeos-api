import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { CronLockService } from '../../common/redis/cron-lock.service';
import { DeploymentService } from '../../common/services/deployment.service';
import {
  AdminAction,
  AdminAuditLog,
  SYSTEM_AUDIT_IP,
  type AuditLogDetails,
} from '../../database/entities/admin-audit-log.entity';
import {
  EVENT_UNLOCKED_BILLING_STATUSES,
  Event,
} from '../../database/entities/event.entity';
import { OrganizationOperatingModeChange } from '../../database/entities/organization-operating-mode-change.entity';
import { Organization } from '../../database/entities/organization.entity';
import { TseTransaction } from '../../database/entities/tse-transaction.entity';
import {
  TseUnit,
  type TseUnitTrigger,
} from '../../database/entities/tse-unit.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import type { User } from '../../database/entities/user.entity';
import {
  assertIntegrationEnabled,
  isIntegrationEnabled,
} from '../integrations/integration-catalog';
import {
  SwissbitError,
  SwissbitAuthError,
  SwissbitNotFoundError,
  SwissbitRequestError,
  errorCodeOf,
  errorMessageOf,
} from './swissbit/swissbit.errors';
import { SwissbitClientProvider } from './swissbit/swissbit-client.provider';
import type { TseInfo } from './swissbit/swissbit.types';
import { missingMasterData } from '../dsfinvk/dsfinvk-master';
import { TseConfig } from './tse.config';
import { TseCryptoService } from './tse-crypto.service';
import { autoCreateHorizon, localDate, startOfLocalMonth } from './tse-dates';
import { plannedDeactivationFor, type PaidEventSpan } from './tse-monthly';
import { TseNotifyService } from './tse-notify.service';
import { TseOutageService } from './tse-outage.service';
import { clientIdForOrganization } from './tse-process-data';
import { rowsOf } from './tse-sql.util';
import { TseUnitCache } from './tse-unit-cache.service';

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Eine Veranstaltung, die eine TSE-Anlage rechtfertigt. */
export interface QualifyingEvent {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date | null;
}

export interface Eligibility {
  ok: boolean;
  /** `TSE_REQUIRES_PAID_EVENT` | `TSE_TOO_EARLY` | `TSE_COUNTRY_NOT_SUPPORTED` | `INTEGRATION_DISABLED` | `TSE_NOT_AVAILABLE` */
  reason: string | null;
  /** Ab wann die Anlage moeglich ist (YYYY-MM-DD, Berlin). */
  availableFrom: string | null;
  event: { id: string; name: string; startDate: string } | null;
  /** Bei `TSE_MASTER_DATA_REQUIRED`: fehlende Angaben (`taxNumber`, `street`, `zip`, `city`). */
  missing?: string[];
}

const CREATION_POLL_MS = 5_000;
const CREATION_POLLS_PER_RUN = 24; // 2 Minuten je Lauf
const MAX_CREATION_ATTEMPTS = 30;
const LIVE_STATUS_TTL_MS = 60_000;
const MAX_FAILED_AUTO_PER_DAY = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lebenszyklus der Cloud-TSE einer Organisation (tse-swissbit-plan.md §8):
 *
 *   (keine) ──anlegen──▶ creating ──Swissbit fertig + Client──▶ active ──deaktivieren──▶ deactivated
 *                           │
 *                           └──Anlage gescheitert──▶ failed
 *
 * - **Kosten**: Jede TSE kostet Aktivierung + volle Monate bis zur
 *   endgueltigen Deaktivierung. Angelegt wird deshalb nur mit einer
 *   bezahlten Veranstaltung (paid/invoice/waived), die heute oder spaeter
 *   endet, und fruehestens im Kalendermonat ihres Beginns. Der Support
 *   kann uebersteuern (mit Grund, protokolliert).
 * - **Automatik**: stuendlich ab 5 Uhr legt ein Lauf die TSE am ersten
 *   Geschaeftstag einer bezahlten Veranstaltung an (DE, Integration an,
 *   Betriebsart nicht „Nur Bons“).
 * - **TSE_LIFECYCLE=monthly** (Standard): die TSE laeuft fuer den
 *   Kalendermonat ihrer Veranstaltung (weitere Veranstaltungen im selben
 *   Monat nutzen sie mit) und wird am letzten Tag um 20:00 abgemeldet
 *   (`plannedDeactivationAt`, TseMonthlyCycleService); die naechste
 *   Veranstaltung bekommt eine neue TSE (neue Seriennummer).
 * - Mehrere API-Instanzen: Hintergrundschritte je TSE ueber
 *   `job_locked_until`, Cron-Laeufe ueber CronLockService.
 */
@Injectable()
export class TseUnitService {
  private readonly logger = new Logger(TseUnitService.name);
  /** Wartezeiten der Anlage-Abfrage (Tests setzen sie auf 0). */
  pollDelays = { firstMs: 1_000, nextMs: CREATION_POLL_MS };
  private readonly liveCache = new Map<
    string,
    { value: TseInfo | null; error: string | null; fetchedAt: number }
  >();

  constructor(
    @InjectRepository(TseUnit)
    private readonly unitRepository: Repository<TseUnit>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly membershipRepository: Repository<UserOrganization>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(TseTransaction)
    private readonly txRepository: Repository<TseTransaction>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly config: TseConfig,
    private readonly swissbit: SwissbitClientProvider,
    private readonly crypto: TseCryptoService,
    private readonly cache: TseUnitCache,
    private readonly notify: TseNotifyService,
    private readonly outages: TseOutageService,
    private readonly cronLock: CronLockService,
    private readonly deployment: DeploymentService,
  ) {}

  // ------------------------------------------------------------ Rechte

  /** Org-Admin oder Super-Admin, sonst 403. Liefert die Organisation. */
  async assertAdmin(organizationId: string, user: User): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    if (user.isSuperAdmin) return organization;
    const membership = await this.membershipRepository.findOne({
      where: { organizationId, userId: user.id },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.NOT_ORGANIZATION_MEMBER,
        message: 'Du bist kein Mitglied dieser Organisation',
      });
    }
    if (membership.role !== OrganizationRole.ADMIN) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Nur Admins der Organisation können die Cloud-TSE verwalten',
      });
    }
    return organization;
  }

  // -------------------------------------------------------- Abfragen

  /** Laufende TSE (creating/active) der Organisation. */
  findLive(organizationId: string): Promise<TseUnit | null> {
    return this.unitRepository.findOne({
      where: { organizationId, state: In(['creating', 'active']) },
    });
  }

  /** Neueste TSE (auch deaktivierte/gescheiterte). */
  findLatest(organizationId: string): Promise<TseUnit | null> {
    return this.unitRepository.findOne({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Neueste TSE je Organisation in einer Abfrage (Organisationslisten beim
   * Anmelden). Organisationen ohne TSE fehlen in der Map.
   */
  async findLatestFor(
    organizationIds: readonly string[],
  ): Promise<Map<string, TseUnit>> {
    const latest = new Map<string, TseUnit>();
    const ids = [...new Set(organizationIds)];
    if (ids.length === 0) return latest;
    const units = await this.unitRepository.find({
      where: { organizationId: In(ids) },
      order: { createdAt: 'DESC' },
    });
    for (const unit of units) {
      if (!latest.has(unit.organizationId)) {
        latest.set(unit.organizationId, unit);
      }
    }
    return latest;
  }

  history(organizationId: string): Promise<TseUnit[]> {
    return this.unitRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  // ------------------------------------------------------ Bedingungen

  /** Bezahlte Veranstaltungen, die heute oder spaeter enden (frueheste zuerst). */
  async qualifyingEvents(
    organizationId: string,
    now = new Date(),
  ): Promise<QualifyingEvent[]> {
    const selfHosted = this.deployment.isSelfHosted;
    const qb = this.eventRepository
      .createQueryBuilder('event')
      .select(['event.id', 'event.name', 'event.startDate', 'event.endDate'])
      .where('event.organizationId = :organizationId', { organizationId })
      .andWhere('event.startDate IS NOT NULL')
      .andWhere(
        `COALESCE(event.endDate, event.startDate + interval '1 day') > :now`,
        { now },
      )
      .orderBy('event.startDate', 'ASC');
    // Eigene Installation: keine Abrechnung, jede Veranstaltung zaehlt.
    if (!selfHosted) {
      qb.andWhere('event.billingStatus IN (:...statuses)', {
        statuses: [...EVENT_UNLOCKED_BILLING_STATUSES],
      });
    }
    const events = await qb.getMany();
    return events.map((e) => ({
      id: e.id,
      name: e.name,
      startDate: e.startDate as Date,
      endDate: e.endDate,
    }));
  }

  /**
   * Darf jetzt eine TSE angelegt werden? Prueft Server, Land, Integration,
   * bezahlte Veranstaltung und Monat (keine Kosten fuer einen Leermonat).
   */
  async eligibility(
    organization: Pick<Organization, 'id' | 'country' | 'settings'>,
    now = new Date(),
  ): Promise<Eligibility & { qualifying: QualifyingEvent | null }> {
    const result = (
      reason: string | null,
      extra: Partial<Eligibility> = {},
      qualifying: QualifyingEvent | null = null,
    ) => ({
      ok: reason === null,
      reason,
      availableFrom: null,
      event: null,
      ...extra,
      qualifying,
    });
    if (!this.config.enabled) return result(ErrorCodes.TSE_NOT_AVAILABLE);
    if ((organization.country ?? '').toUpperCase() !== 'DE') {
      return result(ErrorCodes.TSE_COUNTRY_NOT_SUPPORTED);
    }
    if (!isIntegrationEnabled(organization.settings, 'tse')) {
      return result(ErrorCodes.INTEGRATION_DISABLED);
    }
    // Steuernummer/USt-IdNr. und Anschrift braucht der DSFinV-K-Export
    // (Stamm_Abschluss, § 14 Abs. 4 Nr. 2 UStG) — vor der ersten Signatur.
    const missing = missingMasterData({
      name: '',
      settings: organization.settings,
    });
    if (missing.length > 0) {
      return result(ErrorCodes.TSE_MASTER_DATA_REQUIRED, { missing });
    }
    const events = await this.qualifyingEvents(organization.id, now);
    if (events.length === 0) return result(ErrorCodes.TSE_REQUIRES_PAID_EVENT);
    const first = events[0];
    const eventView = {
      id: first.id,
      name: first.name,
      startDate: first.startDate.toISOString(),
    };
    const allowedFrom = startOfLocalMonth(first.startDate);
    if (now.getTime() < allowedFrom.getTime()) {
      return result(
        ErrorCodes.TSE_TOO_EARLY,
        { availableFrom: localDate(allowedFrom), event: eventView },
        first,
      );
    }
    return result(null, { event: eventView }, first);
  }

  // ---------------------------------------------------------- Anlegen

  /**
   * `POST /organizations/:id/tse`. Idempotent: gibt es schon eine TSE in
   * Anlage oder aktiv, kommt sie zurueck. Die Anlage selbst laeuft im
   * Hintergrund weiter (`advance`).
   */
  async requestCreation(
    organizationId: string,
    user: User,
    options: { override?: boolean; reason?: string | null },
    meta: RequestMeta,
  ): Promise<TseUnit> {
    const organization = await this.assertAdmin(organizationId, user);
    if (!this.config.enabled) {
      throw new ServiceUnavailableException({
        code: ErrorCodes.TSE_NOT_AVAILABLE,
        message: 'Auf diesem Server ist keine Cloud-TSE eingerichtet',
      });
    }
    if ((organization.country ?? '').toUpperCase() !== 'DE') {
      throw new BadRequestException({
        code: ErrorCodes.TSE_COUNTRY_NOT_SUPPORTED,
        message: 'Die Cloud-TSE gibt es nur für Organisationen in Deutschland',
      });
    }
    assertIntegrationEnabled(organization.settings, 'tse');

    const existing = await this.findLive(organizationId);
    if (existing) {
      if (existing.state === 'creating') void this.advance(existing.id);
      return existing;
    }

    const override = options.override === true && user.isSuperAdmin;
    const reason = (options.reason ?? '').trim();
    if (override && !reason) {
      throw new BadRequestException({
        code: ErrorCodes.TSE_OVERRIDE_REASON_REQUIRED,
        message: 'Bitte gib einen Grund für die Ausnahme an',
      });
    }

    const eligibility = await this.eligibility(organization);
    if (!eligibility.ok && !override) {
      if (eligibility.reason === ErrorCodes.TSE_TOO_EARLY) {
        throw new ConflictException({
          code: ErrorCodes.TSE_TOO_EARLY,
          message: `Die Cloud-TSE kann erst ab dem ${formatGermanDate(eligibility.availableFrom)} angelegt werden – im Monat deiner Veranstaltung „${eligibility.event?.name ?? ''}“. So zahlst du keinen Monat ohne Veranstaltung.`,
          params: {
            availableFrom: eligibility.availableFrom,
            eventId: eligibility.event?.id ?? null,
            eventName: eligibility.event?.name ?? null,
          },
        });
      }
      if (eligibility.reason === ErrorCodes.TSE_MASTER_DATA_REQUIRED) {
        throw new ConflictException({
          code: ErrorCodes.TSE_MASTER_DATA_REQUIRED,
          message:
            'Für die Cloud-TSE brauchen wir Steuernummer oder USt-IdNr. und die Anschrift deiner Organisation. Trag sie unter Einstellungen → Organisation ein.',
          params: { missing: (eligibility.missing ?? []).join(',') },
        });
      }
      throw new ConflictException({
        code: ErrorCodes.TSE_REQUIRES_PAID_EVENT,
        message:
          'Eine Cloud-TSE kostet ab dem Anlegen jeden Monat Gebühren. Sie wird deshalb erst angelegt, wenn eine bezahlte Veranstaltung ansteht. Schalte zuerst eine Veranstaltung frei.',
      });
    }

    return this.createUnit(organization.id, {
      trigger: override ? 'super_admin' : 'manual',
      eventId: eligibility.qualifying?.id ?? null,
      userId: user.id,
      overrideReason: override ? reason : null,
      meta,
    });
  }

  /** Legt die Zeile `creating` an und stoesst die Anlage an. */
  async createUnit(
    organizationId: string,
    options: {
      trigger: TseUnitTrigger;
      eventId: string | null;
      userId: string | null;
      overrideReason?: string | null;
      meta?: RequestMeta;
    },
  ): Promise<TseUnit> {
    let unit: TseUnit;
    try {
      unit = await this.unitRepository.save(
        this.unitRepository.create({
          organizationId,
          provider: 'swissbit',
          state: 'creating',
          productType: this.config.settings.swissbit.productType,
          clientId: clientIdForOrganization(organizationId),
          trigger: options.trigger,
          triggerEventId: options.eventId,
          createdByUserId: options.userId,
          overrideReason: options.overrideReason ?? null,
          metadata: {},
        }),
      );
    } catch (error) {
      // Gleichzeitige Anfrage: Teilindex „eine laufende TSE je Org“.
      if ((error as { code?: string }).code === '23505') {
        const live = await this.findLive(organizationId);
        if (live) return live;
      }
      throw error;
    }
    await this.audit(
      AdminAction.TSE_CREATION_REQUESTED,
      organizationId,
      unit.id,
      {
        userId: options.userId,
        meta: options.meta,
        details: {
          trigger: options.trigger,
          eventId: options.eventId,
          productType: unit.productType,
          clientId: unit.clientId,
          lifecycle: this.config.lifecycle,
        },
        reason: options.overrideReason ?? null,
      },
    );
    this.logger.log(
      `TSE creation requested for org ${organizationId} (${options.trigger}, event ${options.eventId ?? '-'})`,
    );
    void this.advance(unit.id);
    return unit;
  }

  /**
   * Fuehrt die Anlage so weit wie moeglich: Swissbit-Anlage → Abfrage bis
   * fertig (Access Token sofort verschluesselt speichern, es kommt nur
   * einmal) → Status lesen → Client registrieren → aktiv.
   * Wiederaufnehmbar; Sperre je TSE ueber `job_locked_until`.
   */
  async advance(unitId: string): Promise<void> {
    const claimed = rowsOf<{ id: string }>(
      await this.unitRepository.query(
        `UPDATE tse_units
            SET job_locked_until = now() + interval '3 minutes'
          WHERE id = $1 AND state = 'creating'
            AND (job_locked_until IS NULL OR job_locked_until < now())
          RETURNING id`,
        [unitId],
      ),
    );
    if (claimed.length === 0) return;

    try {
      await this.advanceLocked(unitId);
    } catch (error) {
      this.logger.error(
        `TSE creation step for unit ${unitId} failed: ${errorMessageOf(error)}`,
      );
    } finally {
      await this.unitRepository
        .query(`UPDATE tse_units SET job_locked_until = NULL WHERE id = $1`, [
          unitId,
        ])
        .catch(() => undefined);
    }
  }

  private async loadWithToken(unitId: string): Promise<TseUnit | null> {
    return this.unitRepository
      .createQueryBuilder('unit')
      .addSelect('unit.accessTokenEnc')
      .where('unit.id = :unitId', { unitId })
      .getOne();
  }

  private async advanceLocked(unitId: string): Promise<void> {
    const unit = await this.loadWithToken(unitId);
    if (!unit || unit.state !== 'creating') return;
    const client = this.swissbit.client;
    const credit = this.swissbit.credit;

    try {
      if (!unit.serialNumber || !unit.accessTokenEnc) {
        if (!unit.creationId) {
          const created = await client.createTse(credit, {
            productType: unit.productType,
            metadata: JSON.stringify({
              organizationId: unit.organizationId,
              clientId: unit.clientId,
              unitId: unit.id,
            }).slice(0, 512),
          });
          unit.creationId = created.value.creationId;
          await this.unitRepository.update(unit.id, {
            creationId: unit.creationId,
          });
        }

        let done = false;
        for (let poll = 0; poll < CREATION_POLLS_PER_RUN && !done; poll++) {
          await sleep(
            poll === 0 ? this.pollDelays.firstMs : this.pollDelays.nextMs,
          );
          const status = await client.creationStatus(credit, unit.creationId);
          if (status.value.status === 'pending') continue;
          if (
            status.value.status === 'success' &&
            status.value.tseSerialNumber &&
            status.value.tseAccessToken
          ) {
            unit.serialNumber = status.value.tseSerialNumber;
            unit.accessTokenEnc = this.crypto.encrypt(
              status.value.tseAccessToken,
            );
            // Sofort speichern: Swissbit liefert das Token kein zweites Mal.
            await this.unitRepository.update(unit.id, {
              serialNumber: unit.serialNumber,
              accessTokenEnc: unit.accessTokenEnc,
            });
            done = true;
            break;
          }
          await this.markFailed(
            unit,
            status.value.errorCode || 'E_CREATION_FAILED',
            status.value.errorMessage ||
              'Swissbit reported a failed TSE creation',
          );
          return;
        }
        if (!done) return; // noch in Arbeit – der naechste Lauf fragt weiter
      }

      if (!unit.serialNumber || !unit.accessTokenEnc) return;
      const credentials = {
        serialNumber: unit.serialNumber,
        accessToken: this.crypto.decrypt(unit.accessTokenEnc),
      };
      const info = await client.info(credentials);
      Object.assign(unit, infoColumns(info.value));
      await this.unitRepository.update(unit.id, infoColumns(info.value));

      if (!unit.clientRegisteredAt) {
        try {
          await client.registerClient(credentials, unit.clientId);
        } catch (error) {
          if (
            !(error instanceof SwissbitError) ||
            error.errorCode !== 'E_CLIENT_ALREADY_REGISTERED'
          ) {
            throw error;
          }
        }
        unit.clientRegisteredAt = new Date();
        await this.unitRepository.update(unit.id, {
          clientRegisteredAt: unit.clientRegisteredAt,
        });
      }

      await this.activate(unit);
    } catch (error) {
      await this.handleCreationError(unit, error);
    }
  }

  private async handleCreationError(
    unit: TseUnit,
    error: unknown,
  ): Promise<void> {
    const code = errorCodeOf(error);
    const message = errorMessageOf(error);
    const attempts = unit.attempts + 1;
    await this.unitRepository.update(unit.id, {
      attempts,
      lastErrorCode: code.slice(0, 60),
      lastErrorMessage: message,
      lastErrorAt: new Date(),
    });
    const hasTse = !!unit.serialNumber && !!unit.accessTokenEnc;
    // Die TSE existiert schon (und kostet): nie aufgeben, weiter versuchen.
    if (hasTse) return;
    const permanent =
      error instanceof SwissbitAuthError ||
      (error instanceof SwissbitRequestError &&
        [
          'E_CREDIT_TOKEN_TERMINATED',
          'E_PRODUCT_TYPE_INVALID',
          'E_CREDIT_TOKEN_TSE_LIMIT_REACHED',
        ].includes(error.errorCode)) ||
      // Erfolgsantwort schon abgeholt (z. B. Abbruch zwischen Abruf und
      // Speichern): das Token ist verloren, die TSE nicht nutzbar.
      (error instanceof SwissbitNotFoundError && !!unit.creationId) ||
      attempts >= MAX_CREATION_ATTEMPTS;
    if (permanent) await this.markFailed(unit, code, message);
  }

  private async markFailed(unit: TseUnit, code: string, message: string) {
    await this.unitRepository.update(unit.id, {
      state: 'failed',
      failedAt: new Date(),
      lastErrorCode: code.slice(0, 60),
      lastErrorMessage: message.slice(0, 500),
      lastErrorAt: new Date(),
    });
    this.logger.error(
      `TSE creation for org ${unit.organizationId} failed: ${code} ${message}`,
    );
    await this.audit(
      AdminAction.TSE_CREATION_FAILED,
      unit.organizationId,
      unit.id,
      {
        details: { code, message, creationId: unit.creationId },
      },
    );
    void this.notify.notifyAdmins(unit.organizationId, 'creation_failed', [
      ['Fehler', code],
    ]);
  }

  private async activate(unit: TseUnit): Promise<void> {
    const activatedAt = new Date();
    // Lebenszyklus `monthly`: Abmeldung am letzten Tag dieses Monats 20:00.
    const plannedDeactivationAt =
      this.config.lifecycle === 'monthly'
        ? plannedDeactivationFor(activatedAt)
        : null;
    const switched = await this.dataSource.transaction(async (manager) => {
      await manager.update(TseUnit, unit.id, {
        state: 'active',
        activatedAt,
        plannedDeactivationAt,
        deactivationAttempts: 0,
        deactivationNextAttemptAt: null,
        deactivationAlertedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      await manager.query(
        `UPDATE organizations SET tse_active = true, updated_at = now() WHERE id = $1`,
        [unit.organizationId],
      );
      // „Bargeldlos“ war die Betriebsart ohne TSE; mit TSE ist Bargeld
      // moeglich, also „Alle Funktionen“ (protokolliert wie ein Wechsel).
      const rows = rowsOf<{ id: string }>(
        await manager.query(
          `UPDATE organizations
              SET operating_mode = 'full', operating_mode_legacy = false,
                  operating_mode_since = now(), updated_at = now()
            WHERE id = $1 AND operating_mode = 'cashless'
            RETURNING id`,
          [unit.organizationId],
        ),
      );
      if (rows.length > 0) {
        await manager.insert(OrganizationOperatingModeChange, {
          organizationId: unit.organizationId,
          fromMode: 'cashless',
          toMode: 'full',
          reason: 'Cloud-TSE aktiv – Bargeld freigeschaltet',
          bySupport: false,
          changedByUserId: null,
          changedByName: 'OpenEOS (Cloud-TSE)',
        });
      }
      return rows.length > 0;
    });
    this.cache.invalidate(unit.organizationId);
    this.logger.log(`TSE active for org ${unit.organizationId}`);
    await this.audit(AdminAction.TSE_ACTIVATED, unit.organizationId, unit.id, {
      details: {
        serialNumber: unit.serialNumber,
        clientId: unit.clientId,
        productType: unit.productType,
        certificationId: unit.certificationId,
        operatingModeSwitchedToFull: switched,
        lifecycle: this.config.lifecycle,
        plannedDeactivationAt: plannedDeactivationAt?.toISOString() ?? null,
      },
    });
    this.notify.statusChanged(unit.organizationId, {
      state: 'ok',
      outage: false,
    });
    this.notify.settingsChanged(unit.organizationId);
    void this.notify.notifyAdmins(unit.organizationId, 'activated', [
      ['TSE-Seriennummer', unit.serialNumber ?? ''],
      ['Kasse (Client)', unit.clientId],
    ]);
  }

  /** Jede Minute: haengende Anlagen weiterfuehren (nach Neustart, Fehler). */
  @Cron('30 * * * * *', { name: 'tse-advance-creating' })
  async advanceCreatingJob(): Promise<void> {
    if (!this.config.enabled) return;
    await this.cronLock.runExclusive('tse-advance-creating', async () => {
      const units = await this.unitRepository.find({
        where: { state: 'creating' },
        select: { id: true },
      });
      for (const unit of units) await this.advance(unit.id);
    });
  }

  // --------------------------------------------------- Automatik

  /**
   * Stuendlich 5–22 Uhr (Berlin): TSE fuer Organisationen anlegen, deren
   * bezahlte Veranstaltung heute (Geschaeftstag) beginnt oder laeuft — der
   * Verein muss nichts tun. Bedingungen: DE, Integration an, Betriebsart
   * nicht „Nur Bons“, keine laufende TSE, hoechstens 3 gescheiterte
   * Versuche in 24 h.
   */
  @Cron('0 5-22 * * *', { name: 'tse-auto-create', timeZone: 'Europe/Berlin' })
  async autoCreateJob(): Promise<void> {
    if (!this.config.enabled) return;
    await this.cronLock.runExclusive('tse-auto-create', async () => {
      await this.autoCreate();
    });
  }

  /**
   * `organizationId`: nur diese Organisation — fuer die sofortige Anlage
   * nach einem Kauf, wenn die Veranstaltung schon laeuft
   * (TseAutoActivationService). Sonst alle.
   */
  async autoCreate(
    now = new Date(),
    organizationId: string | null = null,
  ): Promise<string[]> {
    const horizon = autoCreateHorizon(now);
    const selfHosted = this.deployment.isSelfHosted;
    const rows = rowsOf<{ organization_id: string; event_id: string }>(
      await this.dataSource.query(
        `SELECT DISTINCT ON (o.id) o.id AS organization_id, e.id AS event_id
         FROM organizations o
         JOIN events e ON e.organization_id = o.id AND e.deleted_at IS NULL
        WHERE o.deleted_at IS NULL
          AND upper(coalesce(o.country, '')) = 'DE'
          AND o.settings -> 'integrations' -> 'tse' -> 'enabled' = 'true'::jsonb
          AND o.operating_mode <> 'orders_only'
          AND e.start_date IS NOT NULL
          AND e.start_date < $1
          AND COALESCE(e.end_date, e.start_date + interval '1 day') > $2
          AND ($3::boolean OR e.billing_status::text = ANY($4))
          AND NOT EXISTS (
            SELECT 1 FROM tse_units u
             WHERE u.organization_id = o.id AND u.state IN ('creating', 'active'))
          AND (SELECT count(*) FROM tse_units u
                WHERE u.organization_id = o.id AND u.state = 'failed'
                  AND u.failed_at > now() - interval '1 day') < $5
          AND ($6::uuid IS NULL OR o.id = $6::uuid)
        ORDER BY o.id, e.start_date ASC`,
        [
          horizon,
          now,
          selfHosted,
          [...EVENT_UNLOCKED_BILLING_STATUSES],
          MAX_FAILED_AUTO_PER_DAY,
          organizationId,
        ],
      ),
    );

    const created: string[] = [];
    for (const row of rows) {
      try {
        const organization = await this.organizationRepository.findOne({
          where: { id: row.organization_id },
          select: { id: true, settings: true },
        });
        if (
          organization &&
          missingMasterData({ name: '', settings: organization.settings })
            .length > 0
        ) {
          this.logger.warn(
            `Automatic TSE creation for org ${row.organization_id} skipped: tax number/address missing`,
          );
          continue;
        }
        const unit = await this.createUnit(row.organization_id, {
          trigger: 'auto',
          eventId: row.event_id,
          userId: null,
        });
        created.push(unit.id);
      } catch (error) {
        this.logger.error(
          `Automatic TSE creation for org ${row.organization_id} failed: ${errorMessageOf(error)}`,
        );
      }
    }
    if (created.length)
      this.logger.log(`Automatic TSE creation: ${created.length} started`);
    return created;
  }

  // -------------------------------------------------- Deaktivieren

  /**
   * `POST /organizations/:id/tse/deactivate`. Endgueltig (Swissbit
   * `disableSecureElement`); der Rest wird automatisch exportiert und vom
   * Export-Lauf abgeholt. Schaltet die Integration aus, damit die
   * Automatik keine neue TSE anlegt.
   */
  async deactivateByUser(
    organizationId: string,
    user: User,
    body: { confirm?: boolean; reason?: string | null },
    meta: RequestMeta,
  ): Promise<TseUnit> {
    await this.assertAdmin(organizationId, user);
    if (body.confirm !== true) {
      throw new BadRequestException({
        code: ErrorCodes.TSE_DEACTIVATION_CONFIRM_REQUIRED,
        message:
          'Das Deaktivieren der Cloud-TSE ist endgültig – bitte bestätige es ausdrücklich (confirm: true)',
      });
    }
    const unit = await this.loadLiveWithToken(organizationId);
    if (!unit || !unit.serialNumber || !unit.accessTokenEnc) {
      throw new ConflictException({
        code: ErrorCodes.TSE_NOT_ACTIVE,
        message: 'Die Cloud-TSE ist nicht aktiv',
      });
    }
    return this.deactivate(unit, {
      reason: (body.reason ?? '').trim() || 'manual',
      userId: user.id,
      disableIntegration: true,
      meta,
    });
  }

  private loadLiveWithToken(organizationId: string): Promise<TseUnit | null> {
    return this.unitRepository
      .createQueryBuilder('unit')
      .addSelect('unit.accessTokenEnc')
      .where('unit.organizationId = :organizationId', { organizationId })
      .andWhere(`unit.state IN ('creating', 'active')`)
      .getOne();
  }

  async deactivate(
    unit: TseUnit,
    options: {
      reason: string;
      userId: string | null;
      disableIntegration: boolean;
      meta?: RequestMeta;
    },
  ): Promise<TseUnit> {
    if (unit.serialNumber && unit.accessTokenEnc) {
      try {
        await this.swissbit.client.disableSecureElement({
          serialNumber: unit.serialNumber,
          accessToken: this.crypto.decrypt(unit.accessTokenEnc),
        });
      } catch (error) {
        if (
          !(error instanceof SwissbitError) ||
          error.errorCode !== 'E_TSE_DISABLED'
        ) {
          throw new ServiceUnavailableException({
            code: ErrorCodes.TSE_PROVIDER_ERROR,
            message:
              'Die Cloud-TSE hat gerade nicht geantwortet – bitte versuch es später noch einmal',
            params: {
              requestId:
                error instanceof SwissbitError ? error.requestId : null,
              errorCode: errorCodeOf(error),
            },
          });
        }
      }
    }
    const deactivatedAt = new Date();
    await this.dataSource.transaction(async (manager) => {
      await manager.update(TseUnit, unit.id, {
        state: 'deactivated',
        deactivatedAt,
        deactivatedByUserId: options.userId,
        deactivationReason: options.reason.slice(0, 500),
        deactivationNextAttemptAt: null,
        jobLockedUntil: null,
      });
      await manager.query(
        `UPDATE organizations SET tse_active = false, updated_at = now() WHERE id = $1`,
        [unit.organizationId],
      );
      if (options.disableIntegration) {
        await manager.query(
          `UPDATE organizations
              SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
                    '{integrations,tse}', '{"enabled": false}'::jsonb, true)
            WHERE id = $1 AND jsonb_typeof(settings -> 'integrations') = 'object'`,
          [unit.organizationId],
        );
      }
      await manager.query(
        `UPDATE tse_outages SET ended_at = now(), updated_at = now()
          WHERE tse_unit_id = $1 AND ended_at IS NULL`,
        [unit.id],
      );
    });
    this.cache.invalidate(unit.organizationId);
    this.liveCache.delete(unit.id);
    await this.audit(
      AdminAction.TSE_DEACTIVATED,
      unit.organizationId,
      unit.id,
      {
        userId: options.userId,
        meta: options.meta,
        details: {
          serialNumber: unit.serialNumber,
          clientId: unit.clientId,
          reason: options.reason,
          // Eintrag fuer die Verfahrensdokumentation (TSE-Wechsel).
          period: {
            activatedAt: unit.activatedAt?.toISOString() ?? null,
            deactivatedAt: deactivatedAt.toISOString(),
          },
        },
        reason: options.reason,
      },
    );
    this.logger.log(
      `TSE ${unit.serialNumber ?? unit.id} of org ${unit.organizationId} deactivated (${options.reason})`,
    );
    this.notify.statusChanged(unit.organizationId, {
      state: 'inactive',
      outage: false,
    });
    this.notify.settingsChanged(unit.organizationId);
    const monthly = isMonthlyCycleReason(options.reason);
    void this.notify.notifyAdmins(
      unit.organizationId,
      monthly ? 'monthly_deactivated' : 'deactivated',
      [
        ['TSE-Seriennummer', unit.serialNumber ?? ''],
        [
          'Grund',
          monthly ? 'Monatsende – automatisch abgemeldet' : options.reason,
        ],
      ],
    );
    return (
      (await this.unitRepository.findOne({ where: { id: unit.id } })) ?? unit
    );
  }

  /**
   * Bezahlte Veranstaltungen der Organisation, die nach `from` enden (fuer
   * den Monatslauf und die Gesundheitspruefung). Eigene Installation: jede
   * Veranstaltung zaehlt.
   */
  async paidEventsAround(
    organizationId: string,
    from: Date,
  ): Promise<PaidEventSpan[]> {
    const qb = this.eventRepository
      .createQueryBuilder('event')
      .select(['event.id', 'event.name', 'event.startDate', 'event.endDate'])
      .where('event.organizationId = :organizationId', { organizationId })
      .andWhere('event.startDate IS NOT NULL')
      .andWhere(`COALESCE(event.endDate, event.startDate) > :from`, {
        from: new Date(from.getTime() - 2 * 24 * 3600_000),
      });
    if (!this.deployment.isSelfHosted) {
      qb.andWhere('event.billingStatus IN (:...statuses)', {
        statuses: [...EVENT_UNLOCKED_BILLING_STATUSES],
      });
    }
    const events = await qb.getMany();
    return events.map((e) => ({
      id: e.id,
      name: e.name,
      startDate: e.startDate as Date,
      endDate: e.endDate,
    }));
  }

  // ---------------------------------------------------------- Status

  /** Live-Status von Swissbit, 60 s zwischengespeichert. */
  async liveStatus(unit: TseUnit): Promise<{
    value: TseInfo | null;
    error: string | null;
    fetchedAt: string | null;
  }> {
    if (!unit.serialNumber || unit.state === 'failed') {
      return { value: null, error: null, fetchedAt: null };
    }
    const cached = this.liveCache.get(unit.id);
    if (cached && Date.now() - cached.fetchedAt < LIVE_STATUS_TTL_MS) {
      return { ...cached, fetchedAt: new Date(cached.fetchedAt).toISOString() };
    }
    let value: TseInfo | null = null;
    let error: string | null = null;
    try {
      if (unit.state === 'deactivated' && this.swissbit.hasVendorCredentials) {
        value = (await this.swissbit.client.vendorTseInfo(unit.serialNumber))
          .value;
      } else {
        const withToken = await this.loadWithToken(unit.id);
        if (withToken?.accessTokenEnc) {
          value = (
            await this.swissbit.client.info({
              serialNumber: unit.serialNumber,
              accessToken: this.crypto.decrypt(withToken.accessTokenEnc),
            })
          ).value;
        }
      }
    } catch (e) {
      error = errorCodeOf(e);
    }
    // Fehlende Angaben fuer die DSFinV-K (Stamm_TSE) nachtragen, z. B.
    // bei TSEs, die vor dem Speichern des Zertifikats angelegt wurden.
    const backfill: Partial<
      Pick<TseUnit, 'certificate' | 'publicKey' | 'signatureAlgorithm'>
    > = {};
    if (value?.certificate && !unit.certificate)
      backfill.certificate = value.certificate;
    if (value?.publicKey && !unit.publicKey)
      backfill.publicKey = value.publicKey;
    if (value?.signatureAlgorithm && !unit.signatureAlgorithm)
      backfill.signatureAlgorithm = value.signatureAlgorithm;
    if (Object.keys(backfill).length > 0) {
      Object.assign(unit, backfill);
      void this.unitRepository.update(unit.id, backfill).catch(() => undefined);
    }
    const fetchedAt = Date.now();
    this.liveCache.set(unit.id, { value, error, fetchedAt });
    return { value, error, fetchedAt: new Date(fetchedAt).toISOString() };
  }

  async transactionCounts(
    tseUnitId: string,
    since: Date,
  ): Promise<Record<'signed' | 'training' | 'failed' | 'pending', number>> {
    const rows = rowsOf<{ status: string; count: number }>(
      await this.txRepository.query(
        `SELECT status, count(*)::int AS count FROM tse_transactions
        WHERE tse_unit_id = $1 AND created_at >= $2 GROUP BY status`,
        [tseUnitId, since],
      ),
    );
    const counts = { signed: 0, training: 0, failed: 0, pending: 0 };
    for (const row of rows) {
      if (row.status in counts)
        counts[row.status as keyof typeof counts] = row.count;
    }
    return counts;
  }

  // ------------------------------------------------------------ Audit

  async audit(
    action: AdminAction,
    organizationId: string,
    unitId: string | null,
    entry: {
      userId?: string | null;
      meta?: RequestMeta;
      details: Record<string, unknown>;
      reason?: string | null;
    },
  ): Promise<void> {
    try {
      const repository = this.dataSource.getRepository(AdminAuditLog);
      await repository.save(
        repository.create({
          adminUserId: entry.userId ?? null,
          organizationId,
          action,
          resourceType: 'tse',
          resourceId: unitId,
          details: entry.details as AuditLogDetails,
          reason: entry.reason ?? null,
          ipAddress: (entry.meta?.ipAddress || SYSTEM_AUDIT_IP).slice(0, 45),
          userAgent: entry.meta?.userAgent?.slice(0, 500) ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(
        `Audit ${action} for org ${organizationId} not written: ${errorMessageOf(error)}`,
      );
    }
  }
}

function infoColumns(
  info: TseInfo,
): Pick<
  TseUnit,
  | 'publicKey'
  | 'signatureAlgorithm'
  | 'logTimeFormat'
  | 'certificationId'
  | 'certificateExpiresAt'
> &
  Partial<Pick<TseUnit, 'certificate'>> {
  return {
    ...(info.certificate ? { certificate: info.certificate } : {}),
    publicKey: info.publicKey,
    signatureAlgorithm: info.signatureAlgorithm,
    logTimeFormat: info.logTimeFormat,
    certificationId: info.certificationId,
    certificateExpiresAt: info.certificateExpirationDate
      ? new Date(info.certificateExpirationDate * 1000)
      : null,
  };
}

/** Abmeldung durch den Monatslauf (auch der fruehere Name `per_event_cycle`). */
export function isMonthlyCycleReason(reason: string | null | undefined) {
  return reason === 'monthly_cycle' || reason === 'per_event_cycle';
}

function formatGermanDate(isoDate: string | null): string {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}
