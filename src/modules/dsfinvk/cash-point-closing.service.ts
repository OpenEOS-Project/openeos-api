import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { unguessableSuffix } from '../../common/storage/private-storage';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import { ErrorCodes } from '../../common/constants/error-codes';
import { CronLockService } from '../../common/redis/cron-lock.service';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import { CashPointClosing } from '../../database/entities/cash-point-closing.entity';
import { Device } from '../../database/entities/device.entity';
import { Order } from '../../database/entities/order.entity';
import { Organization } from '../../database/entities/organization.entity';
import { TseTransaction } from '../../database/entities/tse-transaction.entity';
import { TseUnit } from '../../database/entities/tse-unit.entity';
import { User } from '../../database/entities/user.entity';
import { businessDayEnd } from '../tse/tse-dates';
import { rowsOf } from '../tse/tse-sql.util';
import { clientIdForOrganization } from '../tse/tse-process-data';
import { TseConfig } from '../tse/tse.config';
import { TseUnitService, type RequestMeta } from '../tse/tse-unit.service';
import { buildClosing } from './dsfinvk-builder';
import {
  buildExportZip,
  contentHash,
  mergeRows,
  sha256,
} from './dsfinvk-export';
import { rfc3339Berlin } from './dsfinvk-format';
import {
  businessDateOf,
  businessDayRange,
  businessDayStartHour,
  dsfinvkSettings,
  isBusinessDate,
  masterData,
  taxMasterData,
  terminalOf,
  tseUnitOf,
} from './dsfinvk-master';
import type {
  ClosingTotals,
  DsfinvkReference,
  DsfinvkRows,
  DsfinvkTransaction,
} from './dsfinvk-types';

/** Laengster Zeitraum fuer einen Export auf Knopfdruck. */
const MAX_EXPORT_DAYS = 366;

export interface CashPointClosingView {
  id: string;
  zNr: number;
  registerId: string;
  businessDate: string;
  periodFrom: string | null;
  periodTo: string;
  createdAt: string;
  trigger: CashPointClosing['trigger'];
  firstBonId: number | null;
  lastBonId: number | null;
  transactionCount: number;
  totals: ClosingTotals;
  contentSha256: string;
  exportSha256: string | null;
  exportSizeBytes: number | null;
  exportedAt: string | null;
  archivedAt: string | null;
}

export function closingView(c: CashPointClosing): CashPointClosingView {
  return {
    id: c.id,
    zNr: c.zNr,
    registerId: c.registerId,
    businessDate: c.businessDate,
    periodFrom: c.periodFrom?.toISOString() ?? null,
    periodTo: c.periodTo.toISOString(),
    createdAt: c.closingCreatedAt.toISOString(),
    trigger: c.trigger,
    firstBonId: c.firstBonId !== null ? Number(c.firstBonId) : null,
    lastBonId: c.lastBonId !== null ? Number(c.lastBonId) : null,
    transactionCount: c.transactionCount,
    totals: c.totals as unknown as ClosingTotals,
    contentSha256: c.contentSha256,
    exportSha256: c.exportSha256,
    exportSizeBytes:
      c.exportSizeBytes !== null ? Number(c.exportSizeBytes) : null,
    exportedAt: c.exportedAt?.toISOString() ?? null,
    archivedAt: c.archivedAt?.toISOString() ?? null,
  };
}

const ms = (d: Date | string | null | undefined) =>
  d ? new Date(d).getTime() : 0;

/**
 * Kassenabschluesse (DSFinV-K) und Export, openeos-api#102.
 *
 * - **Eine Kasse je Organisation** (Z_KASSE_ID = TSE-Client-ID), Geraete
 *   sind Terminals (tse-swissbit-plan.md §7).
 * - **Ein Abschluss je Geschaeftstag** (6–6 Uhr Berlin), automatisch
 *   stuendlich fuer abgelaufene Tage; auf Knopfdruck zusaetzlich jederzeit
 *   („Kassenabschluss jetzt erstellen“, schliesst bis jetzt ab). Abschluesse
 *   sind lueckenlos: jeder Vorgang steht in genau einem Abschluss.
 * - **Unveraenderlich**: die fertigen Zeilen aller 20 Tabellen werden mit
 *   SHA-256 gespeichert; Exporte setzen sie nur zusammen.
 * - **Ablage**: je Abschluss ein ZIP unter `TSE_EXPORT_DIR/<org>/dsfinvk/`
 *   mit SHA-256 (`archived_at` frei fuer ELeFANT).
 */
@Injectable()
export class CashPointClosingService {
  private readonly logger = new Logger(CashPointClosingService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(CashPointClosing)
    private readonly closingRepository: Repository<CashPointClosing>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly units: TseUnitService,
    private readonly config: TseConfig,
    private readonly cronLock: CronLockService,
  ) {}

  // ---------------------------------------------------------- Zeitplan

  /** Stuendlich: abgelaufene Geschaeftstage abschliessen, Exporte ablegen. */
  @Cron('20 * * * *', { name: 'dsfinvk-closings', timeZone: 'Europe/Berlin' })
  async hourlyJob(): Promise<void> {
    await this.cronLock.runExclusive('dsfinvk-closings', () => this.runAll());
  }

  async runAll(now = new Date()): Promise<void> {
    const until = businessDayRange(businessDateOf(now)).from;
    const rows = rowsOf<{ organization_id: string }>(
      await this.dataSource.query(
        `SELECT DISTINCT organization_id FROM tse_transactions
        WHERE cash_point_closing_id IS NULL AND created_at < $1`,
        [until],
      ),
    );
    for (const row of rows) {
      try {
        await this.closeUpTo(row.organization_id, until, {
          trigger: 'scheduled',
        });
      } catch (error) {
        this.logger.warn(
          `DSFinV-K closing for org ${row.organization_id} postponed: ${(error as Error).message}`,
        );
      }
    }
    await this.storePendingExports();
  }

  /**
   * Schliesst alle offenen Vorgaenge vor `until` ab, je Geschaeftstag ein
   * Abschluss (aeltester zuerst).
   */
  async closeUpTo(
    organizationId: string,
    until: Date,
    options: { trigger: CashPointClosing['trigger']; userId?: string | null },
  ): Promise<CashPointClosing[]> {
    const created: CashPointClosing[] = [];
    for (let guard = 0; guard < 400; guard++) {
      const oldest = rowsOf<{ at: Date | null }>(
        await this.dataSource.query(
          `SELECT MIN(created_at) AS at FROM tse_transactions
          WHERE organization_id = $1 AND cash_point_closing_id IS NULL AND created_at < $2`,
          [organizationId, until],
        ),
      );
      const at = oldest[0]?.at;
      if (!at) break;
      const dayEnd = businessDayEnd(new Date(at), businessDayStartHour());
      const periodTo = dayEnd.getTime() < until.getTime() ? dayEnd : until;
      const closing = await this.createClosing(
        organizationId,
        periodTo,
        options,
      );
      if (!closing) break;
      created.push(closing);
    }
    for (const closing of created) void this.storeExport(closing.id);
    return created;
  }

  // ----------------------------------------------------------- Abschluss

  async createClosing(
    organizationId: string,
    periodTo: Date,
    options: { trigger: CashPointClosing['trigger']; userId?: string | null },
  ): Promise<CashPointClosing | null> {
    return this.dataSource.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `dsfinvk:${organizationId}`,
      ]);
      // Laufende TSE-Vorgaenge abwarten (der Abgleich setzt haengende nach
      // 2 Minuten auf `failed`); was laenger haengt, geht als Ausfall mit.
      const pending = rowsOf<{ n: number }>(
        await m.query(
          `SELECT count(*)::int AS n FROM tse_transactions
          WHERE organization_id = $1 AND cash_point_closing_id IS NULL
            AND status = 'pending' AND created_at < $2
            AND created_at > now() - interval '15 minutes'`,
          [organizationId, periodTo],
        ),
      );
      if ((pending[0]?.n ?? 0) > 0) {
        throw new ConflictException({
          code: ErrorCodes.DSFINVK_PENDING_TRANSACTIONS,
          message:
            'Es laufen gerade noch TSE-Vorgänge – bitte versuch es in einer Minute noch einmal',
        });
      }
      const txs = await m
        .getRepository(TseTransaction)
        .createQueryBuilder('t')
        .where('t.organizationId = :organizationId', { organizationId })
        .andWhere('t.cashPointClosingId IS NULL')
        .andWhere('t.createdAt < :periodTo', { periodTo })
        .orderBy('t.bon_id', 'ASC')
        .addOrderBy('t.createdAt', 'ASC')
        .getMany();
      if (txs.length === 0) return null;

      const organization = await m
        .getRepository(Organization)
        // Auch geloeschte: offene Vorgaenge werden noch abgeschlossen.
        .findOneOrFail({ where: { id: organizationId }, withDeleted: true });
      const registerId = clientIdForOrganization(organizationId);
      const previous = await m.getRepository(CashPointClosing).findOne({
        where: { organizationId },
        order: { zNr: 'DESC' },
      });
      const counter = rowsOf<{ last_z_nr: number }>(
        await m.query(
          `INSERT INTO cash_registers (organization_id, client_id) VALUES ($1, $2)
         ON CONFLICT (organization_id) DO UPDATE SET updated_at = now()
         RETURNING last_z_nr`,
          [organizationId, registerId],
        ),
      );
      const zNr = Math.max(counter[0]?.last_z_nr ?? 0, previous?.zNr ?? 0) + 1;
      const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const businessDate = businessDateOf(new Date(periodTo.getTime() - 1));

      const transactions = await this.toDsfinvk(m, organizationId, txs, {
        zNr,
        createdAt,
        registerId,
      });
      const terminalIds = [
        ...new Set(
          transactions.map((t) => t.terminal).filter((t): t is string => !!t),
        ),
      ];
      const devices = terminalIds.length
        ? await m.getRepository(Device).find({
            where: { id: In(terminalIds) },
            select: { id: true, name: true, type: true },
          })
        : [];
      const unitIds = [
        ...new Set(txs.map((t) => t.tseUnitId).filter((u): u is string => !!u)),
      ];
      const units = unitIds.length
        ? await m
            .getRepository(TseUnit)
            .find({ where: { id: In(unitIds) }, order: { createdAt: 'ASC' } })
        : [];
      const master = masterData(
        organization,
        terminalIds.map((id) =>
          terminalOf(id, devices.find((d) => d.id === id) ?? null),
        ),
        units.map(tseUnitOf),
      );
      const built = buildClosing({
        zNr,
        createdAt,
        businessDate,
        master,
        settings: dsfinvkSettings(organization),
        transactions,
      });

      const closing = m.getRepository(CashPointClosing).create({
        organizationId,
        registerId,
        zNr,
        businessDate,
        periodFrom: previous?.periodTo ?? txs[0].createdAt,
        periodTo,
        closingCreatedAt: createdAt,
        trigger: options.trigger,
        createdByUserId: options.userId ?? null,
        firstBonId:
          built.totals.firstBonId !== null
            ? String(built.totals.firstBonId)
            : null,
        lastBonId:
          built.totals.lastBonId !== null
            ? String(built.totals.lastBonId)
            : null,
        transactionCount: txs.length,
        totals: built.totals as unknown as Record<string, unknown>,
        masterData: master as unknown as Record<string, unknown>,
        rows: built.rows as unknown as Record<string, string[][]>,
        contentSha256: contentHash(built.rows),
      });
      const saved = await m.getRepository(CashPointClosing).save(closing);
      await m.query(
        `UPDATE tse_transactions SET cash_point_closing_id = $1 WHERE id = ANY($2::uuid[])`,
        [saved.id, txs.map((t) => t.id)],
      );
      await m.query(
        `UPDATE cash_registers SET last_z_nr = $2, updated_at = now() WHERE organization_id = $1`,
        [organizationId, zNr],
      );
      this.logger.log(
        `DSFinV-K closing Z${zNr} for org ${organizationId} (${businessDate}, ${txs.length} transactions)`,
      );
      return saved;
    });
  }

  /** `tse_transactions` → Eingabe des Generators (Bediener, Bestellungen, Verweise). */
  private async toDsfinvk(
    m: EntityManager,
    organizationId: string,
    txs: TseTransaction[],
    current: { zNr: number; createdAt: Date; registerId: string },
  ): Promise<DsfinvkTransaction[]> {
    const ids = new Set(txs.map((t) => t.id));
    const userIds = [
      ...new Set(
        txs
          .filter((t) => !t.operatorName)
          .map((t) => t.userId)
          .filter((u): u is string => !!u),
      ),
    ];
    const users = userIds.length
      ? await m.getRepository(User).find({
          where: { id: In(userIds) },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const orderIds = [
      ...new Set(txs.map((t) => t.orderId).filter((o): o is string => !!o)),
    ];
    const orders = orderIds.length
      ? await m.getRepository(Order).find({
          where: { id: In(orderIds) },
          select: { id: true, orderNumber: true, tableNumber: true },
          withDeleted: true,
        })
      : [];

    // Verweise: Erstattung/Abbruch → Original; Zahlung/Storno → Bestellvorgaenge.
    const refIds = txs
      .map((t) => t.referencesTseTransactionId)
      .filter((r): r is string => !!r);
    const targets = rowsOf<{
      id: string;
      bon_id: string | null;
      cash_point_closing_id: string | null;
      amount: string | null;
      order_id: string | null;
      kind: string;
      created_at: Date;
      start_time: Date | null;
    }>(
      await m.query(
        `SELECT id, bon_id, cash_point_closing_id, amount, order_id, kind, created_at, start_time
         FROM tse_transactions
        WHERE organization_id = $1
          AND (id = ANY($2::uuid[])
               OR (order_id = ANY($3::uuid[]) AND kind IN ('order', 'order_cancellation')))`,
        [organizationId, refIds, orderIds],
      ),
    );
    const closingIds = [
      ...new Set(
        targets
          .map((t) => t.cash_point_closing_id)
          .filter((c): c is string => !!c),
      ),
    ];
    const closings = closingIds.length
      ? await m.getRepository(CashPointClosing).find({
          where: { id: In(closingIds) },
          select: {
            id: true,
            zNr: true,
            closingCreatedAt: true,
            registerId: true,
          },
        })
      : [];
    const refOf = (
      target: (typeof targets)[number],
    ): DsfinvkReference | null => {
      if (target.bon_id === null) return null;
      if (target.cash_point_closing_id) {
        const c = closings.find((x) => x.id === target.cash_point_closing_id);
        return c
          ? {
              zNr: c.zNr,
              closingCreatedAt: c.closingCreatedAt,
              registerId: c.registerId,
              bonId: Number(target.bon_id),
            }
          : null;
      }
      if (ids.has(target.id)) {
        return {
          zNr: current.zNr,
          closingCreatedAt: current.createdAt,
          registerId: current.registerId,
          bonId: Number(target.bon_id),
        };
      }
      return null;
    };

    return txs.map((tx): DsfinvkTransaction => {
      const lines = tx.lines ?? null;
      const order = tx.orderId
        ? orders.find((o) => o.id === tx.orderId)
        : undefined;
      const user = tx.userId
        ? users.find((u) => u.id === tx.userId)
        : undefined;
      const references: DsfinvkReference[] = [];
      let originalAmountCents: number | null = null;
      let startTime = tx.startTime;
      if (tx.referencesTseTransactionId) {
        const target = targets.find(
          (t) => t.id === tx.referencesTseTransactionId,
        );
        if (target) {
          const ref = refOf(target);
          if (ref) references.push(ref);
          originalAmountCents =
            target.amount !== null
              ? Math.round(Number(target.amount) * 100)
              : null;
          if (tx.kind === 'abort' && !startTime) startTime = target.start_time;
        }
      }
      if (
        tx.orderId &&
        (tx.kind === 'receipt' || tx.kind === 'order_cancellation')
      ) {
        const orderTxs = targets
          .filter(
            (t) =>
              t.order_id === tx.orderId &&
              t.id !== tx.id &&
              t.bon_id !== null &&
              Number(t.bon_id) < Number(tx.bonId),
          )
          .filter((t) =>
            tx.kind === 'order_cancellation' ? t.kind === 'order' : true,
          )
          .sort((a, b) => Number(a.bon_id) - Number(b.bon_id));
        for (const t of tx.kind === 'order_cancellation'
          ? orderTxs.slice(0, 1)
          : orderTxs) {
          const ref = refOf(t);
          if (ref && !references.some((r) => r.bonId === ref.bonId))
            references.push(ref);
        }
      }
      const status = tx.status === 'pending' ? 'failed' : tx.status;
      return {
        id: tx.id,
        bonId: Number(tx.bonId),
        kind: tx.kind,
        processType: tx.processType,
        processData: tx.processData,
        training: tx.training,
        status,
        tseUnitId: tx.tseUnitId,
        transactionNumber:
          tx.transactionNumber !== null ? Number(tx.transactionNumber) : null,
        signatureCounter:
          tx.signatureCounter !== null ? Number(tx.signatureCounter) : null,
        startTime,
        finishTime: tx.finishTime,
        signatureValue: tx.signatureValue,
        errorCode: tx.errorCode,
        errorMessage: tx.errorMessage,
        recovered: !!tx.recoveredAt,
        createdAt: tx.createdAt,
        endedAt:
          tx.finishTime && ms(tx.finishTime) >= ms(tx.createdAt)
            ? tx.finishTime
            : new Date(ms(tx.createdAt) + (tx.durationMs ?? 0)),
        terminal: tx.terminal,
        // BEDIENER_ID: Bedienung vor Mitglied; BEDIENER_NAME aus dem
        // Snapshot beim Signieren, Rueckfall Live-Name (Altbestand).
        userId: tx.waiterId ?? tx.userId,
        userName:
          tx.operatorName?.trim() ||
          (user
            ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || null
            : null),
        lines,
        amountCents:
          tx.amount !== null ? Math.round(Number(tx.amount) * 100) : null,
        orderId: tx.orderId,
        orderNumber:
          order?.orderNumber ??
          (typeof lines?.orderNumber === 'string' ||
          typeof lines?.orderNumber === 'number'
            ? String(lines.orderNumber)
            : null),
        tableNumber:
          order?.tableNumber ??
          (typeof lines?.tableNumber === 'string' ||
          typeof lines?.tableNumber === 'number'
            ? String(lines.tableNumber)
            : null),
        originalAmountCents,
        references,
      };
    });
  }

  // ------------------------------------------------------- Verwaltung

  async list(
    organizationId: string,
    user: User,
    query: { from?: string; to?: string; limit?: number },
  ) {
    await this.units.assertAdmin(organizationId, user);
    const qb = this.closingRepository
      .createQueryBuilder('c')
      .where('c.organizationId = :organizationId', { organizationId })
      .orderBy('c.zNr', 'DESC')
      .take(Math.min(Math.max(query.limit ?? 100, 1), 500));
    if (isBusinessDate(query.from))
      qb.andWhere('c.businessDate >= :from', { from: query.from });
    if (isBusinessDate(query.to))
      qb.andWhere('c.businessDate <= :to', { to: query.to });
    const rows = await qb.getMany();
    const open = rowsOf<{ n: number; since: Date | null }>(
      await this.dataSource.query(
        `SELECT count(*)::int AS n, MIN(created_at) AS since FROM tse_transactions
        WHERE organization_id = $1 AND cash_point_closing_id IS NULL`,
        [organizationId],
      ),
    );
    return {
      items: rows.map(closingView),
      registerId: clientIdForOrganization(organizationId),
      open: {
        transactions: open[0]?.n ?? 0,
        since: open[0]?.since ? new Date(open[0].since).toISOString() : null,
      },
    };
  }

  async requestClosing(
    organizationId: string,
    user: User,
    meta: RequestMeta,
  ): Promise<CashPointClosingView[]> {
    await this.units.assertAdmin(organizationId, user);
    const created = await this.closeUpTo(organizationId, new Date(), {
      trigger: 'manual',
      userId: user.id,
    });
    if (created.length === 0) {
      throw new ConflictException({
        code: ErrorCodes.DSFINVK_NOTHING_TO_CLOSE,
        message: 'Seit dem letzten Kassenabschluss gab es keine Vorgänge',
      });
    }
    await this.units.audit(
      AdminAction.DSFINVK_CLOSING_REQUESTED,
      organizationId,
      null,
      {
        userId: user.id,
        meta,
        details: { zNr: created.map((c) => c.zNr) },
      },
    );
    return created.map(closingView);
  }

  /**
   * Steuerstatus wechseln (Steuerberater 2026-11-10, Frage 9/10): z. B.
   * Kleinunternehmer → „ab sofort umsatzsteuerpflichtig“, weil 25.000 €
   * im Vorjahr bzw. 100.000 € im laufenden Jahr ueberschritten sind (schon
   * der Umsatz, mit dem die Grenze ueberschritten wird, ist steuerpflichtig).
   *
   * Erst ein Kassenabschluss bis jetzt — alle bisherigen Vorgaenge werden
   * mit dem alten Status (USt-Schluessel 6 bzw. 1/2) abgeschlossen —, dann
   * der Stammdatenwechsel (DSFinV-K Tz. 3: Stammdaten je Abschluss; der
   * naechste Abschluss traegt den neuen Status). Protokoll
   * `vat_status_changed` und Verlauf in `settings.vatStatusHistory`.
   * Laufende Vorgaenge → 409 DSFINVK_PENDING_TRANSACTIONS (kurz warten).
   */
  async changeVatStatus(
    organizationId: string,
    user: User,
    vatExempt: boolean,
    meta: RequestMeta,
  ): Promise<{
    vatExempt: boolean;
    changed: boolean;
    closings: CashPointClosingView[];
  }> {
    const organization = await this.units.assertAdmin(organizationId, user);
    const before =
      (organization.settings as { vatExempt?: boolean } | null)?.vatExempt !==
      false;
    if (before === vatExempt) {
      return { vatExempt, changed: false, closings: [] };
    }
    const at = new Date();
    const created = await this.closeUpTo(organizationId, at, {
      trigger: 'manual',
      userId: user.id,
    });
    const entry = {
      at: at.toISOString(),
      vatExempt,
      userId: user.id,
      zNr: created.length ? created[created.length - 1].zNr : null,
    };
    await this.dataSource.query(
      `UPDATE organizations
          SET settings = jsonb_set(
                jsonb_set(COALESCE(settings, '{}'::jsonb), '{vatExempt}', to_jsonb($2::boolean), true),
                '{vatStatusHistory}',
                COALESCE(settings->'vatStatusHistory', '[]'::jsonb) || jsonb_build_array($3::jsonb),
                true),
              updated_at = now()
        WHERE id = $1`,
      [organizationId, vatExempt, JSON.stringify(entry)],
    );
    await this.units.audit(
      AdminAction.VAT_STATUS_CHANGED,
      organizationId,
      null,
      {
        userId: user.id,
        meta,
        details: {
          from: before ? 'vat_exempt' : 'vat_liable',
          to: vatExempt ? 'vat_exempt' : 'vat_liable',
          closings: created.map((c) => c.zNr),
          at: entry.at,
        },
      },
    );
    this.logger.log(
      `VAT status of ${organizationId} changed to ${vatExempt ? 'exempt' : 'liable'} after ${created.length} closing(s)`,
    );
    return { vatExempt, changed: true, closings: created.map(closingView) };
  }

  /**
   * Abschluesse fuer einen Export: nach Geschaeftstagen (`from`/`to`,
   * inklusive) oder Z-Nummern (`zFrom`/`zTo`).
   */
  async closingsFor(
    organizationId: string,
    range: { from?: string; to?: string; zFrom?: number; zTo?: number },
  ): Promise<CashPointClosing[]> {
    const qb = this.closingRepository
      .createQueryBuilder('c')
      .addSelect('c.rows')
      .where('c.organizationId = :organizationId', { organizationId })
      .orderBy('c.zNr', 'ASC');
    if (range.zFrom !== undefined || range.zTo !== undefined) {
      const zFrom = range.zFrom ?? 1;
      const zTo = range.zTo ?? zFrom;
      if (
        !Number.isInteger(zFrom) ||
        !Number.isInteger(zTo) ||
        zFrom < 1 ||
        zTo < zFrom ||
        zTo - zFrom > 5000
      ) {
        throw this.rangeError();
      }
      qb.andWhere('c.zNr BETWEEN :zFrom AND :zTo', { zFrom, zTo });
    } else {
      if (
        !isBusinessDate(range.from) ||
        !isBusinessDate(range.to ?? range.from)
      )
        throw this.rangeError();
      const from = range.from;
      const to = range.to ?? range.from;
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      if (days < 0 || days > MAX_EXPORT_DAYS) throw this.rangeError();
      qb.andWhere('c.businessDate BETWEEN :from AND :to', { from, to });
    }
    return qb.getMany();
  }

  private rangeError() {
    return new BadRequestException({
      code: ErrorCodes.DSFINVK_RANGE_INVALID,
      message: 'Bitte gib einen gültigen Zeitraum an (höchstens ein Jahr)',
    });
  }

  /** ZIP fuer einen Zeitraum (Kassen-Nachschau, Pruefung). */
  async exportZip(
    organizationId: string,
    user: User,
    range: { from?: string; to?: string; zFrom?: number; zTo?: number },
    meta: RequestMeta,
  ): Promise<{
    data: Buffer;
    filename: string;
    sha256: string;
    closings: number;
  }> {
    const organization = await this.units.assertAdmin(organizationId, user);
    const closings = await this.closingsFor(organizationId, range);
    if (closings.length === 0) {
      throw new NotFoundException({
        code: ErrorCodes.DSFINVK_NO_CLOSINGS,
        message: 'Für diesen Zeitraum gibt es keinen Kassenabschluss',
      });
    }
    const data = this.zipFor(organization, closings);
    const first = closings[0];
    const last = closings[closings.length - 1];
    const filename = `DSFinV-K_${first.registerId}_Z${first.zNr}-Z${last.zNr}_${first.businessDate}_${last.businessDate}.zip`;
    const digest = sha256(data);
    await this.units.audit(AdminAction.DSFINVK_EXPORTED, organizationId, null, {
      userId: user.id,
      meta,
      details: {
        zFrom: first.zNr,
        zTo: last.zNr,
        from: first.businessDate,
        to: last.businessDate,
        sha256: digest,
      },
    });
    return { data, filename, sha256: digest, closings: closings.length };
  }

  private zipFor(
    organization: Organization,
    closings: CashPointClosing[],
  ): Buffer {
    const rows = mergeRows(
      closings.map((c) => c.rows as unknown as DsfinvkRows),
    );
    const tax = taxMasterData(organization);
    const last = closings[closings.length - 1];
    return buildExportZip(
      rows,
      { name: tax.legalName, location: tax.city },
      last.closingCreatedAt,
    );
  }

  // -------------------------------------------------------------- Ablage

  private baseDir(): string {
    return resolve(this.config.settings.exportDir);
  }

  /** Legt das ZIP eines Abschlusses mit SHA-256 ab (idempotent). */
  async storeExport(closingId: string): Promise<void> {
    try {
      const closing = await this.closingRepository
        .createQueryBuilder('c')
        .addSelect('c.rows')
        .where('c.id = :closingId', { closingId })
        .getOne();
      if (!closing || closing.exportFilePath) return;
      const organization = await this.organizationRepository.findOne({
        where: { id: closing.organizationId },
        withDeleted: true,
      });
      if (!organization) return;
      const data = this.zipFor(organization, [closing]);
      const dir = join(this.baseDir(), closing.organizationId, 'dsfinvk');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      /* Zufaelliger Namensteil: der Pfad steht in der Zeile, erraten
         laesst er sich nicht. */
      const target = join(
        dir,
        `Z${String(closing.zNr).padStart(6, '0')}_${closing.businessDate}_${unguessableSuffix()}.zip`,
      );
      await writeFile(`${target}.part`, data, { mode: 0o600 });
      await rename(`${target}.part`, target);
      await this.closingRepository.update(closing.id, {
        exportFilePath: relative(this.baseDir(), target),
        exportSha256: sha256(data),
        exportSizeBytes: String(data.length),
        exportedAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `Storing DSFinV-K export of closing ${closingId} failed: ${(error as Error).message}`,
      );
    }
  }

  async storePendingExports(): Promise<void> {
    const rows = await this.closingRepository.find({
      where: { exportFilePath: IsNull() },
      select: { id: true },
      order: { createdAt: 'ASC' },
      take: 200,
    });
    for (const row of rows) await this.storeExport(row.id);
  }

  /** Abgelegtes ZIP eines Abschlusses (oder neu erzeugt, falls die Datei fehlt). */
  async closingFile(
    organizationId: string,
    closingId: string,
    user: User,
  ): Promise<{ data: Buffer; filename: string; sha256: string }> {
    const organization = await this.units.assertAdmin(organizationId, user);
    const closing = await this.closingRepository
      .createQueryBuilder('c')
      .addSelect('c.rows')
      .where('c.id = :closingId AND c.organizationId = :organizationId', {
        closingId,
        organizationId,
      })
      .getOne();
    if (!closing) {
      throw new NotFoundException({
        code: ErrorCodes.DSFINVK_CLOSING_NOT_FOUND,
        message: 'Kassenabschluss nicht gefunden',
      });
    }
    const filename = `DSFinV-K_${closing.registerId}_Z${closing.zNr}_${closing.businessDate}.zip`;
    if (closing.exportFilePath) {
      const full = join(this.baseDir(), closing.exportFilePath);
      if (existsSync(full)) {
        const data = await readFile(full);
        if (sha256(data) === closing.exportSha256)
          return { data, filename, sha256: closing.exportSha256 };
        this.logger.error(
          `DSFinV-K export ${closing.exportFilePath} checksum mismatch – regenerating`,
        );
      }
    }
    const data = this.zipFor(organization, [closing]);
    return { data, filename, sha256: sha256(data) };
  }

  /** Fuer die Verfahrensdokumentation/Pruefung: Zeitstempel wie im Export. */
  static zErstellung(
    closing: Pick<CashPointClosing, 'closingCreatedAt'>,
  ): string {
    return rfc3339Berlin(closing.closingCreatedAt);
  }
}
