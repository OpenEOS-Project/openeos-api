import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, MoreThanOrEqual, Repository } from 'typeorm';

import { CronLockService } from '../../common/redis/cron-lock.service';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { TseExport } from '../../database/entities/tse-export.entity';
import { TseUnit } from '../../database/entities/tse-unit.entity';
import { CashPointClosingService } from '../dsfinvk/cash-point-closing.service';
import {
  businessDateOf,
  businessDayRange,
  businessDayStartHour,
} from '../dsfinvk/dsfinvk-master';
import { errorCodeOf, errorMessageOf } from './swissbit/swissbit.errors';
import { TseConfig } from './tse.config';
import { localDate, localParts } from './tse-dates';
import { TseExportService } from './tse-export.service';
import {
  EXPORT_GRACE_MS,
  PREPARE_BEFORE_MS,
  backoffMs,
  blockingEvents,
  currentKeep,
  eventsInMonth,
  isDeactivationOverdue,
  keepsOf,
  localMonthRange,
  monthKey,
  monthlyPhase,
  nextMonthEvents,
  plannedDeactivationFor,
  plannedDeactivationOfNextMonth,
  postponedDeactivation,
  type PaidEventSpan,
  type TseKeep,
} from './tse-monthly';
import { TseNotifyService } from './tse-notify.service';
import { rowsOf } from './tse-sql.util';
import { TseUnitService } from './tse-unit.service';

/** Eintrag in `tse_units.metadata.postponements`. */
export interface TsePostponement {
  at: string;
  from: string;
  to: string;
  reason: 'paid_event_running';
  /** Monat, den Swissbit dadurch zusaetzlich berechnet (`YYYY-MM`). */
  extraMonth: string;
  events: {
    id: string;
    name: string;
    startDate: string;
    endDate: string | null;
  }[];
}

export type MonthlyOutcome =
  | 'idle'
  | 'locked'
  | 'postponed'
  | 'keeping'
  | 'kept'
  | 'keep_revoked'
  | 'prepared'
  | 'waiting_for_export'
  | 'backoff'
  | 'failed'
  | 'deactivated';

/** Was die Gesundheitspruefung und die Super-Admin-Liste melden. */
export interface TseHealthIssue {
  unitId: string;
  organizationId: string;
  organizationName: string | null;
  serialNumber: string | null;
  kind:
    | 'no_paid_event_this_month'
    | 'deactivation_overdue'
    | 'no_planned_deactivation';
  month: string;
  plannedDeactivationAt: string | null;
}

/** Wie viele TSEs ein Lauf gleichzeitig bearbeitet (Exporte warten). */
const CONCURRENCY = 5;
/** Je Lauf hoechstens so lange auf einen Abschlussexport warten. */
const EXPORT_WAIT_MS = 60_000;
/** Sperre je TSE (laenger als ein Lauf, kuerzer als zwei). */
const UNIT_LOCK = `interval '20 minutes'`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lebenszyklus `monthly` (TSE_LIFECYCLE, Standard; Entscheidung
 * 2026-11-04, tse-swissbit-plan.md §8.3). Swissbit berechnet volle Monate:
 * eine TSE kostet jeden Monat, in dessen Vormonat sie nicht abgemeldet
 * wurde. Deshalb:
 *
 * - **Termin**: letzter Tag des Monats der Aktivierung, 20:00 Berlin
 *   (`planned_deactivation_at`, Puffer vor dem Monatswechsel auch in UTC).
 *   Weitere Veranstaltungen im selben Monat nutzen die TSE mit.
 * - **Ablauf** (alle 15 min, ab 18:00 des letzten Tages wirksam):
 *   ab 18:00 Kassenabschluesse abgelaufener Geschaeftstage und
 *   Abschlussexport (starten, abholen); ab 20:00 Abmeldung
 *   (`disableSecureElement`, Grund `monthly_cycle`, Protokolleintrag mit
 *   Zeitraum = TSE-Wechsel fuer die Verfahrensdokumentation), danach
 *   Abholen des automatischen Abmelde-Exports (taeglich bis 35 Tage,
 *   TseExportService). Ohne fertigen Abschlussexport wird ab 21:00
 *   trotzdem abgemeldet — die Abmeldung vor dem Monatswechsel hat Vorrang.
 * - **Ausnahme**: laufen zum Termin die Geschaeftstage (6–6 Uhr) einer
 *   bezahlten Veranstaltung (auch ueber den Monatswechsel), bleibt die TSE
 *   und bekommt den Termin am Ende des Folgemonats (Protokoll
 *   `tse_deactivation_postponed` mit Kostenhinweis, `metadata.postponements`).
 * - **Folgemonat** (Entscheidung 2026-11-06): hat der Verein im Folgemonat
 *   schon eine bezahlte Veranstaltung (Geschaeftstag beginnt dort), bleibt
 *   die TSE ebenfalls (spart Aktivierung und Mitteilung ans Finanzamt):
 *   ab 18:00 nur Kassenabschluesse, kein Abschlussexport; um 20:00 neuer
 *   Termin Ende des Folgemonats (`tse_kept_for_next_month`,
 *   `metadata.keeps`). Bis zum Monatswechsel prueft jeder Lauf nach — ist
 *   die Veranstaltung storniert/erstattet, wird doch abgemeldet
 *   (`tse_keep_revoked`).
 * - **Garantie**: Fehler → Wiederholung mit Backoff; um 22:00 noch aktiv →
 *   Mail an den Betreiber (`tse_deactivation_overdue`) und roter Hinweis in
 *   der Super-Admin-Liste. Mehrere Instanzen: CronLockService je Lauf,
 *   `job_locked_until` je TSE; jeder Schritt ist wiederholbar.
 * - **Gesundheitspruefung** taeglich 07:00: aktive TSE in einem Monat ohne
 *   bezahlte Veranstaltung (darf nie vorkommen) → Mail an den Betreiber.
 */
@Injectable()
export class TseMonthlyCycleService {
  private readonly logger = new Logger(TseMonthlyCycleService.name);
  /** Wartezeiten zwischen den Abmeldeversuchen eines Laufs (Tests: 0). */
  retryDelaysMs = [2_000, 10_000];

  constructor(
    @InjectRepository(TseUnit)
    private readonly unitRepository: Repository<TseUnit>,
    @InjectRepository(TseExport)
    private readonly exportRepository: Repository<TseExport>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: TseConfig,
    private readonly units: TseUnitService,
    private readonly exports: TseExportService,
    private readonly notify: TseNotifyService,
    private readonly cronLock: CronLockService,
    private readonly moduleRef: ModuleRef,
  ) {}

  get active(): boolean {
    return this.config.enabled && this.config.lifecycle === 'monthly';
  }

  // ------------------------------------------------------------ Zeitplan

  /**
   * Alle 15 Minuten. Ausserhalb von 18:00–24:00 am Monatsletzten gibt es
   * in der Regel nichts zu tun (eine Abfrage); ueberfaellige Abmeldungen
   * werden aber auch danach weiter versucht.
   */
  @Cron('0 */15 * * * *', { name: 'tse-monthly-cycle' })
  async cycleJob(): Promise<void> {
    if (!this.active) return;
    await this.cronLock.runExclusive('tse-monthly-cycle', async () => {
      await this.run();
    });
  }

  /** Taeglich 07:00 (Berlin): Gesundheitspruefung. */
  @Cron('0 7 * * *', { name: 'tse-monthly-health', timeZone: 'Europe/Berlin' })
  async healthJob(): Promise<void> {
    if (!this.active) return;
    await this.cronLock.runExclusive('tse-monthly-health', async () => {
      await this.healthCheck(new Date(), { alert: true });
    });
  }

  async run(now = new Date()): Promise<Record<string, MonthlyOutcome>> {
    await this.backfillPlanned(now);
    const due = await this.unitRepository
      .createQueryBuilder('unit')
      .addSelect('unit.accessTokenEnc')
      .where(`unit.state = 'active'`)
      .andWhere('unit.plannedDeactivationAt IS NOT NULL')
      .andWhere('unit.plannedDeactivationAt <= :horizon', {
        horizon: new Date(now.getTime() + PREPARE_BEFORE_MS),
      })
      .orderBy('unit.plannedDeactivationAt', 'ASC')
      .getMany();
    const kept = await this.keptAwaitingMonthChange(now);
    const outcomes: Record<string, MonthlyOutcome> = {};
    const work: Array<{ unit: TseUnit; recheck: boolean }> = [
      ...due.map((unit) => ({ unit, recheck: false })),
      ...kept
        .filter((unit) => !due.some((d) => d.id === unit.id))
        .map((unit) => ({ unit, recheck: true })),
    ];
    for (let i = 0; i < work.length; i += CONCURRENCY) {
      const batch = work.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async ({ unit, recheck }) => {
          outcomes[unit.id] = await this.processUnitLocked(unit, now, recheck);
        }),
      );
    }
    await this.alertOverdue(now);
    const counts = Object.values(outcomes).filter((o) => o !== 'idle');
    if (counts.length) {
      this.logger.log(`Monthly TSE cycle: ${JSON.stringify(countBy(counts))}`);
    }
    return outcomes;
  }

  /** Aktive TSEs ohne Termin (vor dieser Version angelegt): Ende dieses Monats. */
  async backfillPlanned(now: Date): Promise<void> {
    await this.unitRepository.query(
      `UPDATE tse_units SET planned_deactivation_at = $1
        WHERE state = 'active' AND planned_deactivation_at IS NULL`,
      [plannedDeactivationFor(now)],
    );
  }

  /**
   * Behaltene TSEs, deren urspruenglicher Termin vorbei ist, deren Monat
   * aber noch laeuft: bis zum Monatswechsel kann eine Stornierung die
   * Entscheidung noch kippen.
   */
  private keptAwaitingMonthChange(now: Date): Promise<TseUnit[]> {
    return this.unitRepository
      .createQueryBuilder('unit')
      .addSelect('unit.accessTokenEnc')
      .where(`unit.state = 'active'`)
      .andWhere(`jsonb_typeof(unit.metadata -> 'keeps') = 'array'`)
      .andWhere(`(unit.metadata -> 'keeps' -> -1 ->> 'revokedAt') IS NULL`)
      .andWhere(
        `(unit.metadata -> 'keeps' -> -1 ->> 'from')::timestamptz <= :now`,
        { now },
      )
      .andWhere(
        `(unit.metadata -> 'keeps' -> -1 ->> 'recheckUntil')::timestamptz > :now`,
        { now },
      )
      .getMany();
  }

  // ------------------------------------------------------------ je TSE

  private async processUnitLocked(
    unit: TseUnit,
    now: Date,
    recheck = false,
  ): Promise<MonthlyOutcome> {
    const claimed = rowsOf<{ id: string }>(
      await this.unitRepository.query(
        `UPDATE tse_units SET job_locked_until = now() + ${UNIT_LOCK}
          WHERE id = $1 AND state = 'active'
            AND (job_locked_until IS NULL OR job_locked_until < now())
          RETURNING id`,
        [unit.id],
      ),
    );
    if (claimed.length === 0) return 'locked';
    try {
      return recheck
        ? await this.recheckKeep(unit, now)
        : await this.processUnit(unit, now);
    } catch (error) {
      this.logger.error(
        `Monthly cycle for TSE unit ${unit.id} failed: ${errorMessageOf(error)}`,
      );
      return 'failed';
    } finally {
      await this.unitRepository
        .query(`UPDATE tse_units SET job_locked_until = NULL WHERE id = $1`, [
          unit.id,
        ])
        .catch(() => undefined);
    }
  }

  async processUnit(unit: TseUnit, now: Date): Promise<MonthlyOutcome> {
    const planned = unit.plannedDeactivationAt
      ? new Date(unit.plannedDeactivationAt)
      : plannedDeactivationFor(now);
    const phase = monthlyPhase(planned, now);
    if (phase === 'idle') return 'idle';

    // Ausnahme: laufen zum Termin (oder jetzt, wenn er vorbei ist) die
    // Geschaeftstage einer bezahlten Veranstaltung, bleibt die TSE.
    const at = now.getTime() > planned.getTime() ? now : planned;
    const events = await this.units.paidEventsAround(unit.organizationId, at);
    const blocking = blockingEvents(events, at, businessDayStartHour());
    if (blocking.length > 0) {
      await this.postpone(unit, planned, at, blocking);
      return 'postponed';
    }

    // Folgemonat schon gebucht: TSE behalten. Entschieden wird erst zum
    // Termin (20:00) — bis dahin kann die Veranstaltung noch storniert oder
    // kurzfristig gebucht werden. Kein Abschlussexport, die taeglichen
    // Exporte laufen weiter; Kassenabschluesse wie sonst.
    const booked = nextMonthEvents(events, planned, businessDayStartHour());
    if (booked.length > 0) {
      await this.closeBusinessDays(unit, now);
      if (phase === 'prepare') return 'keeping';
      await this.keep(unit, planned, booked, now);
      return 'kept';
    }

    // Vorbereitung (ab 18:00) und vor der Abmeldung: Abschlussexport.
    let exportDone = await this.finalExportDone(unit, planned);
    if (!exportDone) {
      await this.startFinalExport(unit);
      exportDone = await this.finalExportDone(unit, planned);
    }
    if (phase === 'prepare') {
      await this.closeBusinessDays(unit, now);
      return 'prepared';
    }

    if (
      unit.deactivationNextAttemptAt &&
      new Date(unit.deactivationNextAttemptAt).getTime() > now.getTime()
    ) {
      return 'backoff';
    }
    if (!exportDone && now.getTime() < planned.getTime() + EXPORT_GRACE_MS) {
      return 'waiting_for_export';
    }
    if (!exportDone) {
      this.logger.warn(
        `TSE ${unit.serialNumber ?? unit.id}: final export not downloaded – deactivating anyway (Swissbit exports the rest on deactivation)`,
      );
    }

    await this.closeBusinessDays(unit, now);
    return this.deactivateWithRetry(unit, now, exportDone);
  }

  private async deactivateWithRetry(
    unit: TseUnit,
    now: Date,
    finalExport: boolean,
  ): Promise<MonthlyOutcome> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(this.retryDelaysMs[attempt - 1]);
      try {
        await this.units.deactivate(unit, {
          reason: 'monthly_cycle',
          userId: null,
          disableIntegration: false,
        });
        this.logger.log(
          `TSE ${unit.serialNumber ?? unit.id} of org ${unit.organizationId} deactivated at month end (final export ${finalExport ? 'downloaded' : 'missing'})`,
        );
        // Den automatischen Abmelde-Export holt der taegliche Lauf bis zu
        // 35 Tage lang ab; hier nur ein erster Versuch.
        void this.exports
          .collect({ ...unit, state: 'deactivated' } as TseUnit, {
            startNew: false,
            trigger: 'deactivation',
          })
          .catch(() => undefined);
        return 'deactivated';
      } catch (error) {
        lastError = error;
      }
    }
    const attempts = (unit.deactivationAttempts ?? 0) + 1;
    const code = deactivationErrorCode(lastError);
    await this.unitRepository.update(unit.id, {
      deactivationAttempts: attempts,
      deactivationNextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
      lastErrorCode: code.slice(0, 60),
      lastErrorMessage: errorMessageOf(lastError).slice(0, 500),
      lastErrorAt: now,
    });
    this.logger.error(
      `Month-end deactivation of TSE ${unit.serialNumber ?? unit.id} failed (attempt ${attempts}): ${code}`,
    );
    return 'failed';
  }

  private async keep(
    unit: TseUnit,
    planned: Date,
    booked: PaidEventSpan[],
    now: Date,
  ): Promise<void> {
    const to = plannedDeactivationOfNextMonth(planned);
    const entry: TseKeep = {
      at: now.toISOString(),
      from: planned.toISOString(),
      to: to.toISOString(),
      reason: 'paid_event_next_month',
      month: monthKey(to),
      events: booked.map((e) => ({
        id: e.id,
        name: e.name,
        startDate: e.startDate.toISOString(),
        endDate: e.endDate ? e.endDate.toISOString() : null,
      })),
      recheckUntil: localMonthRange(planned).to.toISOString(),
      revokedAt: null,
    };
    const keeps = [...keepsOf(unit), entry].slice(-24);
    await this.writePlan(unit, to, 'keeps', keeps);
    const names = booked.map((e) => `„${e.name}“`).join(', ');
    await this.units.audit(
      AdminAction.TSE_KEPT_FOR_NEXT_MONTH,
      unit.organizationId,
      unit.id,
      {
        details: {
          serialNumber: unit.serialNumber,
          plannedDeactivationAt: entry.from,
          newPlannedDeactivationAt: entry.to,
          month: entry.month,
          eventId: booked[0].id,
          events: entry.events,
        },
        reason: `Bezahlte Veranstaltung im ${germanMonth(to)} schon gebucht (${names}) – die TSE bleibt aktiv, keine neue Aktivierung.`,
      },
    );
    this.logger.log(
      `TSE ${unit.serialNumber ?? unit.id} of org ${unit.organizationId}: kept for ${entry.month} (paid event booked: ${names}), next deactivation ${entry.to}`,
    );
  }

  /**
   * Nach der Behalten-Entscheidung bis zum Monatswechsel: gibt es die
   * bezahlte Veranstaltung im Folgemonat noch? Sonst Entscheidung widerrufen
   * und wie sonst zum Monatsende abmelden.
   */
  async recheckKeep(unit: TseUnit, now: Date): Promise<MonthlyOutcome> {
    const keep = currentKeep(unit);
    if (!keep) return 'idle';
    const from = new Date(keep.from);
    const events = await this.units.paidEventsAround(unit.organizationId, from);
    const booked = nextMonthEvents(events, from, businessDayStartHour());
    if (booked.length > 0) return 'kept';

    const keeps = keepsOf(unit).map((k, i, all) =>
      i === all.length - 1 ? { ...k, revokedAt: now.toISOString() } : k,
    );
    await this.writePlan(unit, from, 'keeps', keeps);
    await this.units.audit(
      AdminAction.TSE_KEEP_REVOKED,
      unit.organizationId,
      unit.id,
      {
        details: {
          serialNumber: unit.serialNumber,
          plannedDeactivationAt: keep.from,
          month: keep.month,
          events: keep.events,
        },
        reason: `Keine bezahlte Veranstaltung mehr im ${germanMonth(new Date(keep.to))} – die TSE wird doch zum Monatsende abgemeldet.`,
      },
    );
    this.logger.warn(
      `TSE ${unit.serialNumber ?? unit.id} of org ${unit.organizationId}: keep for ${keep.month} revoked (paid event gone) – deactivating at month end`,
    );
    const outcome = await this.processUnit(unit, now);
    return outcome === 'idle' ? 'keep_revoked' : outcome;
  }

  /** Neuer Termin + Liste in `metadata` (Fehlversuche/Warnung zurueckgesetzt). */
  private async writePlan(
    unit: TseUnit,
    planned: Date,
    key: 'keeps' | 'postponements',
    list: unknown[],
  ): Promise<void> {
    await this.unitRepository.query(
      `UPDATE tse_units
          SET planned_deactivation_at = $2,
              deactivation_attempts = 0,
              deactivation_next_attempt_at = NULL,
              deactivation_alerted_at = NULL,
              metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), $4::text[], $3::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [unit.id, planned, JSON.stringify(list), `{${key}}`],
    );
    unit.plannedDeactivationAt = planned;
    unit.deactivationAttempts = 0;
    unit.deactivationNextAttemptAt = null;
    unit.metadata = { ...(unit.metadata ?? {}), [key]: list };
  }

  private async postpone(
    unit: TseUnit,
    planned: Date,
    at: Date,
    blocking: PaidEventSpan[],
  ): Promise<void> {
    const to = postponedDeactivation(at);
    const entry: TsePostponement = {
      at: new Date().toISOString(),
      from: planned.toISOString(),
      to: to.toISOString(),
      reason: 'paid_event_running',
      extraMonth: monthKey(to),
      events: blocking.map((e) => ({
        id: e.id,
        name: e.name,
        startDate: e.startDate.toISOString(),
        endDate: e.endDate ? e.endDate.toISOString() : null,
      })),
    };
    const previous = Array.isArray(unit.metadata?.postponements)
      ? (unit.metadata.postponements as TsePostponement[])
      : [];
    const postponements = [...previous, entry].slice(-24);
    await this.unitRepository.query(
      `UPDATE tse_units
          SET planned_deactivation_at = $2,
              deactivation_attempts = 0,
              deactivation_next_attempt_at = NULL,
              deactivation_alerted_at = NULL,
              metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{postponements}', $3::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [unit.id, to, JSON.stringify(postponements)],
    );
    unit.plannedDeactivationAt = to;
    unit.metadata = { ...(unit.metadata ?? {}), postponements };
    const names = blocking.map((e) => `„${e.name}“`).join(', ');
    const costNote = `Die TSE bleibt im ${germanMonth(to)} aktiv – Swissbit berechnet dafür einen weiteren Monat.`;
    await this.units.audit(
      AdminAction.TSE_DEACTIVATION_POSTPONED,
      unit.organizationId,
      unit.id,
      {
        details: {
          serialNumber: unit.serialNumber,
          plannedDeactivationAt: entry.from,
          newPlannedDeactivationAt: entry.to,
          extraMonth: entry.extraMonth,
          events: entry.events,
          costNote,
        },
        reason: `Bezahlte Veranstaltung läuft zum Monatsende (${names}). ${costNote}`,
      },
    );
    this.logger.warn(
      `TSE ${unit.serialNumber ?? unit.id} of org ${unit.organizationId}: month-end deactivation postponed to ${entry.to} (paid event running: ${names}) – one more billed month (${entry.extraMonth})`,
    );
  }

  // -------------------------------------------------- Abschlussexport

  /** Abschlussexport dieses Monatslaufs abgeholt (gestartet ab 18:00)? */
  async finalExportDone(unit: TseUnit, planned: Date): Promise<boolean> {
    const count = await this.exportRepository.count({
      where: {
        tseUnitId: unit.id,
        status: 'downloaded',
        trigger: In(['final', 'manual', 'scheduled']),
        createdAt: MoreThanOrEqual(
          new Date(planned.getTime() - PREPARE_BEFORE_MS),
        ),
      },
    });
    return count > 0;
  }

  private async startFinalExport(unit: TseUnit): Promise<void> {
    try {
      await this.exports.collect(unit, {
        startNew: true,
        trigger: 'final',
        waitMs: EXPORT_WAIT_MS,
      });
    } catch (error) {
      this.logger.warn(
        `Final export of TSE ${unit.serialNumber ?? unit.id} not (yet) collected: ${errorCodeOf(error)} ${errorMessageOf(error, 200)}`,
      );
    }
  }

  /**
   * DSFinV-K: Kassenabschluesse aller abgelaufenen Geschaeftstage (6–6 Uhr)
   * vor der Abmeldung. Der laufende Geschaeftstag ist um 20:00 nicht
   * vorbei; den schliesst der stuendliche Lauf nach 6 Uhr ab.
   */
  private async closeBusinessDays(unit: TseUnit, now: Date): Promise<void> {
    let closings: CashPointClosingService | null = null;
    try {
      closings = this.moduleRef.get(CashPointClosingService, { strict: false });
    } catch {
      closings = null;
    }
    if (!closings) return;
    try {
      const until = businessDayRange(businessDateOf(now)).from;
      await closings.closeUpTo(unit.organizationId, until, {
        trigger: 'scheduled',
      });
    } catch (error) {
      this.logger.warn(
        `DSFinV-K closing before month-end deactivation of org ${unit.organizationId} postponed: ${errorMessageOf(error, 200)}`,
      );
    }
  }

  // ------------------------------------------------------------ Warnung

  /**
   * Um 22:00 (Termin + 2 h) noch aktiv → eine Mail an den Betreiber je
   * Termin (atomar beansprucht, mehrere Instanzen senden nicht doppelt).
   */
  async alertOverdue(now: Date): Promise<TseUnit[]> {
    const rows = rowsOf<{ id: string }>(
      await this.unitRepository.query(
        `UPDATE tse_units SET deactivation_alerted_at = $1
          WHERE state = 'active'
            AND planned_deactivation_at IS NOT NULL
            AND planned_deactivation_at <= $2
            AND (deactivation_alerted_at IS NULL
                 OR deactivation_alerted_at < planned_deactivation_at)
          RETURNING id`,
        [now, new Date(now.getTime() - 2 * 3600_000)],
      ),
    );
    if (rows.length === 0) return [];
    const overdue = await this.unitRepository.find({
      where: { id: In(rows.map((r) => r.id)) },
      relations: { organization: true },
    });
    for (const unit of overdue) {
      await this.units.audit(
        AdminAction.TSE_DEACTIVATION_OVERDUE,
        unit.organizationId,
        unit.id,
        {
          details: {
            serialNumber: unit.serialNumber,
            plannedDeactivationAt:
              unit.plannedDeactivationAt?.toISOString() ?? null,
            attempts: unit.deactivationAttempts,
            lastError: unit.lastErrorCode,
          },
          reason:
            'Abmeldung zum Monatsende um 22:00 noch nicht gelungen – Betreiber gewarnt',
        },
      );
    }
    await this.notify.notifyPlatformAdmins({
      subject: `Cloud-TSE: ${overdue.length === 1 ? 'Abmeldung' : `${overdue.length} Abmeldungen`} zum Monatsende überfällig`,
      intro:
        'Diese Cloud-TSEs sind um 22:00 Uhr noch nicht abgemeldet. Gelingt die Abmeldung nicht vor Mitternacht, berechnet Swissbit den nächsten Monat. OpenEOS versucht es weiter alle 15 Minuten.',
      rows: overdue.map((unit) => [
        unit.organization?.name ?? unit.organizationId,
        `TSE ${shortSerial(unit.serialNumber)} · geplant ${formatBerlin(unit.plannedDeactivationAt)} · ${unit.deactivationAttempts} Fehlversuche${unit.lastErrorCode ? ` · ${unit.lastErrorCode}` : ''}`,
      ]),
      todo: {
        title: 'Was du tun solltest',
        text: 'Swissbit-Status prüfen. Notfalls die TSE in der Organisation unter Integrationen → Cloud-TSE von Hand deaktivieren.',
      },
    });
    return overdue;
  }

  // ------------------------------------------------- Gesundheitspruefung

  /**
   * TSEs, die es so nicht geben duerfte: aktiv in einem Monat ohne bezahlte
   * Veranstaltung, ohne Termin oder mit ueberfaelliger Abmeldung.
   */
  async healthCheck(
    now = new Date(),
    options: { alert?: boolean } = {},
  ): Promise<TseHealthIssue[]> {
    if (!this.active) return [];
    const live = await this.unitRepository.find({
      where: { state: 'active' },
      relations: { organization: true },
    });
    const issues: TseHealthIssue[] = [];
    const month = monthKey(now);
    for (const unit of live) {
      const base = {
        unitId: unit.id,
        organizationId: unit.organizationId,
        organizationName: unit.organization?.name ?? null,
        serialNumber: unit.serialNumber,
        month,
        plannedDeactivationAt: unit.plannedDeactivationAt
          ? new Date(unit.plannedDeactivationAt).toISOString()
          : null,
      };
      const planned = unit.plannedDeactivationAt
        ? new Date(unit.plannedDeactivationAt)
        : null;
      if (!planned) {
        issues.push({ ...base, kind: 'no_planned_deactivation' });
      } else if (isDeactivationOverdue(planned, now)) {
        issues.push({ ...base, kind: 'deactivation_overdue' });
      }
      const events = await this.units.paidEventsAround(
        unit.organizationId,
        localMonthRange(now).from,
      );
      if (eventsInMonth(events, now, businessDayStartHour()).length === 0) {
        issues.push({ ...base, kind: 'no_paid_event_this_month' });
      }
    }
    if (options.alert && issues.length > 0) {
      await this.notify.notifyPlatformAdmins({
        subject: 'Cloud-TSE: Auffälligkeiten bei der Prüfung',
        intro:
          'Die tägliche Prüfung hat aktive Cloud-TSEs gefunden, die es so nicht geben dürfte. Jede aktive TSE kostet den ganzen Monat.',
        rows: issues.map((issue) => [
          issue.organizationName ?? issue.organizationId,
          `TSE ${shortSerial(issue.serialNumber)} · ${HEALTH_TEXT[issue.kind]}`,
        ]),
        todo: {
          title: 'Was du tun solltest',
          text: 'In der TSE-Übersicht prüfen, ob die TSE noch gebraucht wird (z. B. Veranstaltung storniert). Abgemeldet wird sie zum Monatsende automatisch.',
        },
      });
    }
    return issues;
  }
}

const HEALTH_TEXT: Record<TseHealthIssue['kind'], string> = {
  no_paid_event_this_month: 'aktiv ohne bezahlte Veranstaltung in diesem Monat',
  deactivation_overdue: 'Abmeldung zum Monatsende überfällig',
  no_planned_deactivation: 'kein Abmeldetermin',
};

/** Swissbit-Fehlercode (steckt bei TSE_PROVIDER_ERROR in `params.errorCode`). */
function deactivationErrorCode(error: unknown): string {
  const response = (
    error as {
      getResponse?: () => { code?: string; params?: { errorCode?: string } };
    }
  )?.getResponse?.();
  if (response && typeof response === 'object') {
    if (response.params?.errorCode) return String(response.params.errorCode);
    if (response.code) return String(response.code);
  }
  return errorCodeOf(error);
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function shortSerial(serial: string | null): string {
  return serial ? `${serial.slice(0, 8)}…` : '–';
}

const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

function germanMonth(at: Date): string {
  const p = localParts(at);
  return `${MONTHS[p.month - 1]} ${p.year}`;
}

function formatBerlin(at: Date | null): string {
  if (!at) return '–';
  const p = localParts(new Date(at));
  const [y, m, d] = localDate(new Date(at)).split('-');
  return `${d}.${m}.${y} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
