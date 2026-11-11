import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  getOperatingMode,
  OPERATING_MODE_SELECT,
  type OperatingMode,
} from '../../common/utils/operating-mode.util';
import {
  AdminAction,
  AdminAuditLog,
  SYSTEM_AUDIT_IP,
} from '../../database/entities/admin-audit-log.entity';
import { Organization } from '../../database/entities/organization.entity';
import {
  WaiterSettlement,
  type SettlementOpenTable,
  type SettlementTotals,
} from '../../database/entities/waiter-settlement.entity';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { TseSigningService } from '../tse/tse-signing.service';
import { rowsOf } from '../tse/tse-sql.util';
import {
  buildSettlementTotals,
  round2,
  settlementIsEmpty,
  settlementIsTrainingOnly,
  type ItemGroupRow,
  type PaymentGroupRow,
  type PfandGroupRow,
  type TokenRedemptionGroupRow,
  type TokenTransactionGroupRow,
  type RefundGroupRow,
  type TakenGroupRow,
} from './waiter-settlement-math';
import { waiterSettings } from './waiter-operator';

/** Wessen Zahlen: Bedienung oder Mitglied (Mitglieds-PIN an der Kasse). */
export type SettlementSubject =
  | { kind: 'waiter'; waiterId: string }
  | { kind: 'member'; userId: string };

/** Wer abrechnet (Verwaltung: Benutzer; Kasse: Bedienung bzw. Mitglied). */
export interface SettlementActor {
  userId: string | null;
  waiterId: string | null;
  /** Darf trotz offener Tische abrechnen (Schichtleitung, Admin). */
  mayForce: boolean;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SettleOptions {
  eventId?: string | null;
  countedCash?: number | null;
  force?: boolean;
  note?: string | null;
  /** Drucker (Verwaltung); an der Kasse der Bondrucker des Geraets. */
  printerId?: string | null;
  print?: boolean;
}

export interface SubjectView {
  kind: 'waiter' | 'member';
  id: string;
  waiterId: string | null;
  userId: string | null;
  name: string;
  shortName: string | null;
  color: string | null;
  anonymized: boolean;
}

export interface WaiterSummaryView {
  subject: SubjectView;
  eventId: string;
  eventName: string | null;
  periodFrom: Date | null;
  periodTo: Date;
  totals: SettlementTotals;
  openTables: SettlementOpenTable[];
  /** Ohne Kellnerbrieftasche (bis zur Antwort des Steuerberaters) immer aus. */
  wallet: boolean;
  lastSettlement: { id: string; number: number | null; createdAt: Date } | null;
  /** Nichts seit der letzten Abrechnung. */
  empty: boolean;
}

export interface SettlementView {
  id: string;
  number: number | null;
  isTest: boolean;
  subject: SubjectView;
  eventId: string | null;
  eventName: string | null;
  periodFrom: Date | null;
  periodTo: Date;
  totals: SettlementTotals;
  cashExpected: number | null;
  cashCounted: number | null;
  difference: number | null;
  wallet: boolean;
  openTables: SettlementOpenTable[];
  forced: boolean;
  note: string | null;
  settledBy: { kind: 'user' | 'waiter'; id: string; name: string } | null;
  deviceId: string | null;
  deviceName: string | null;
  printedAt: Date | null;
  /**
   * Cloud-TSE: die Abrechnung ist als `SonstigerVorgang` mit Soll, Ist und
   * Differenz abgesichert (Steuerberater 2026-11-10, Frage 7). null ohne
   * TSE bzw. bei Training.
   */
  tse: SettlementTse | null;
  createdAt: Date;
}

export interface SettlementTse {
  status: string;
  failed: boolean;
  bonNumber: number | null;
  transactionNumber: number | null;
  signatureCounter: number | null;
  finishTime: string | null;
}

const BERLIN = 'Europe/Berlin';
const DATE_TIME = new Intl.DateTimeFormat('de-DE', {
  timeZone: BERLIN,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function printDateTime(value: Date | string | null): string {
  return value ? DATE_TIME.format(new Date(value)).replace(',', '') : '';
}

/** Person einer gespeicherten Abrechnung. */
function subject_(
  s: Pick<WaiterSettlement, 'waiterId' | 'userId'>,
): SettlementSubject {
  return s.waiterId
    ? { kind: 'waiter', waiterId: s.waiterId }
    : { kind: 'member', userId: s.userId ?? '' };
}

/** Spalten der Person je Tabelle (feste Liste, nie aus der Anfrage). */
function subjectColumns(subject: SettlementSubject) {
  return subject.kind === 'waiter'
    ? {
        id: subject.waiterId,
        payment: 'p.processed_by_waiter_id',
        refund: 'r.waiter_id',
        pfand: 'pr.waiter_id',
        token: 't.waiter_id',
        orderCreator: 'o.created_by_waiter_id',
        itemSender: 'oi.added_by_waiter_id',
        owner: 'o.waiter_id',
        settlement: 'waiter_id',
      }
    : {
        id: subject.userId,
        payment: 'p.processed_by_user_id',
        refund: 'r.user_id',
        pfand: 'pr.created_by_user_id',
        token: 't.user_id',
        orderCreator: 'o.created_by_user_id',
        itemSender: 'oi.added_by_user_id',
        // Mitglieder besitzen keine Tische (Bestellungen ohne Bedienung).
        owner: 'o.created_by_user_id',
        settlement: 'user_id',
      };
}

/**
 * Kellnerabrechnung (bedienungen-plan.md §7): Zwischenstand jederzeit,
 * Abrechnung unveraenderlich mit Nummer je Organisation. Zeitraum: seit
 * der letzten Abrechnung dieser Person in dieser Veranstaltung (sonst ab
 * Beginn) bis jetzt. Ohne Kellnerbrieftasche ist „Soll bar“ nur
 * informativ (das Bargeld liegt in der Schublade des Geraets).
 */
@Injectable()
export class WaiterSettlementsService {
  private readonly logger = new Logger(WaiterSettlementsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly orderPrint?: OrderPrintService,
    @Optional() private readonly tseSigning?: TseSigningService,
  ) {}

  // ------------------------------------------------------------ Lesen

  async summary(
    organizationId: string,
    subject: SettlementSubject,
    eventId?: string | null,
    now: Date = new Date(),
  ): Promise<WaiterSummaryView> {
    return this.computeSummary(
      this.dataSource.manager,
      organizationId,
      subject,
      eventId ?? null,
      now,
    );
  }

  async computeSummary(
    manager: EntityManager,
    organizationId: string,
    subject: SettlementSubject,
    requestedEventId: string | null,
    now: Date,
  ): Promise<WaiterSummaryView> {
    const person = await this.subjectView(manager, organizationId, subject);
    const event = await this.resolveEvent(
      manager,
      organizationId,
      subject,
      requestedEventId,
    );
    const organization = await this.organization(manager, organizationId);
    const mode = getOperatingMode(organization);
    const cols = subjectColumns(subject);

    const [last] = rowsOf<{
      id: string;
      number: number | null;
      period_to: Date;
      created_at: Date;
    }>(
      await manager.query(
        `SELECT id, number, period_to, created_at FROM waiter_settlements
          WHERE organization_id = $1 AND event_id = $2 AND ${cols.settlement} = $3
          ORDER BY period_to DESC LIMIT 1`,
        [organizationId, event.id, cols.id],
      ),
    );
    const from: Date | null = last ? new Date(last.period_to) : null;
    const params = [organizationId, event.id, cols.id, from, now];
    const window = (column: string) =>
      `${column} <= $5 AND ($4::timestamptz IS NULL OR ${column} > $4)`;

    const payments = rowsOf<PaymentGroupRow>(
      await manager.query(
        `SELECT p.payment_method::text AS method, o.is_test AS "isTest",
                p.processed_by_device_id AS "deviceId", d.name AS "deviceName",
                count(*)::int AS count, COALESCE(sum(p.amount), 0) AS amount,
                COALESCE(sum(p.tip_amount), 0) AS tip
           FROM payments p
           JOIN orders o ON o.id = p.order_id
           LEFT JOIN devices d ON d.id = p.processed_by_device_id
          WHERE o.organization_id = $1 AND o.event_id = $2 AND ${cols.payment} = $3
            AND p.status IN ('captured', 'refunded') AND ${window('p.created_at')}
          GROUP BY 1, 2, 3, 4`,
        params,
      ),
    );
    const refunds = rowsOf<RefundGroupRow>(
      await manager.query(
        `SELECT r.payment_method::text AS method, r.is_test AS "isTest",
                r.device_id AS "deviceId", d.name AS "deviceName",
                count(*)::int AS count, COALESCE(sum(r.amount), 0) AS amount
           FROM refunds r
           LEFT JOIN devices d ON d.id = r.device_id
          WHERE r.organization_id = $1 AND r.event_id = $2 AND ${cols.refund} = $3
            AND ${window('r.created_at')}
          GROUP BY 1, 2, 3, 4`,
        params,
      ),
    );
    const pfandReturns = rowsOf<PfandGroupRow>(
      await manager.query(
        `SELECT pr.is_test AS "isTest", pr.device_id AS "deviceId", d.name AS "deviceName",
                count(*)::int AS count, COALESCE(sum(pr.total_amount), 0) AS amount
           FROM pfand_returns pr
           LEFT JOIN devices d ON d.id = pr.device_id
          WHERE pr.organization_id = $1 AND pr.event_id = $2 AND ${cols.pfand} = $3
            AND ${window('pr.created_at')}
          GROUP BY 1, 2, 3`,
        params,
      ),
    );
    // Wertmarken: angenommen (eingeloest) je Typ und selbst verkauft bzw.
    // zurueckgetauscht — die Person gibt angenommene Marken ab wie Bargeld.
    const tokenRedemptions = rowsOf<TokenRedemptionGroupRow>(
      await manager.query(
        `SELECT o.is_test AS "isTest", l->>'tokenTypeId' AS "tokenTypeId",
                MAX(l->>'name') AS name, MAX((l->>'unitValue')::numeric) AS "unitValue",
                COALESCE(sum((l->>'count')::numeric), 0) AS count,
                COALESCE(sum((l->>'amount')::numeric), 0) AS amount
           FROM payments p
           JOIN orders o ON o.id = p.order_id
           CROSS JOIN LATERAL jsonb_array_elements(p.token_lines) l
          WHERE o.organization_id = $1 AND o.event_id = $2 AND ${cols.payment} = $3
            AND p.status IN ('captured', 'refunded') AND ${window('p.created_at')}
          GROUP BY 1, 2`,
        params,
      ),
    );
    const tokenTransactions = rowsOf<TokenTransactionGroupRow>(
      await manager.query(
        `SELECT t.kind AS kind, t.payment_method AS method, t.is_test AS "isTest",
                t.device_id AS "deviceId", d.name AS "deviceName",
                COALESCE(sum((SELECT sum(abs((l->>'count')::numeric)) FROM jsonb_array_elements(t.lines) l)), 0) AS count,
                COALESCE(sum(t.total_amount), 0) AS amount
           FROM token_transactions t
           LEFT JOIN devices d ON d.id = t.device_id
          WHERE t.organization_id = $1 AND t.event_id = $2 AND ${cols.token} = $3
            AND ${window('t.created_at')}
          GROUP BY 1, 2, 3, 4, 5`,
        params,
      ),
    );
    const taken = rowsOf<TakenGroupRow>(
      await manager.query(
        `SELECT o.is_test AS "isTest", count(*)::int AS orders,
                COALESCE(sum(o.discount_amount), 0) AS discounts
           FROM orders o
          WHERE o.organization_id = $1 AND o.event_id = $2 AND ${cols.orderCreator} = $3
            AND o.status <> 'cancelled' AND ${window('o.created_at')}
          GROUP BY 1`,
        params,
      ),
    );
    const items = rowsOf<ItemGroupRow>(
      await manager.query(
        `SELECT o.is_test AS "isTest",
                COALESCE(sum(oi.quantity - COALESCE(oi.refunded_quantity, 0)), 0)::int AS items,
                COALESCE(sum(oi.total_price), 0) AS revenue
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE o.organization_id = $1 AND o.event_id = $2 AND ${cols.itemSender} = $3
            AND oi.status <> 'cancelled' AND o.status <> 'cancelled'
            AND ${window('oi.created_at')}
          GROUP BY 1`,
        params,
      ),
    );

    const totals = buildSettlementTotals({
      operatingMode: mode,
      payments,
      refunds,
      pfandReturns,
      taken,
      items,
      tokenRedemptions,
      tokenTransactions,
    });
    const openTables =
      mode === 'orders_only'
        ? []
        : await this.openTables(manager, organizationId, event.id, subject);

    return {
      subject: person,
      eventId: event.id,
      eventName: event.name,
      periodFrom: from,
      periodTo: now,
      totals,
      openTables,
      wallet: waiterSettings(organization).wallet,
      lastSettlement: last
        ? { id: last.id, number: last.number, createdAt: last.created_at }
        : null,
      empty: settlementIsEmpty(totals),
    };
  }

  /** Offene (unbezahlte) Bestellungen, fuer die die Person verantwortlich ist. */
  async openTables(
    manager: EntityManager,
    organizationId: string,
    eventId: string,
    subject: SettlementSubject,
  ): Promise<SettlementOpenTable[]> {
    const cols = subjectColumns(subject);
    const memberOnly =
      subject.kind === 'member' ? 'AND o.waiter_id IS NULL' : '';
    const rows = rowsOf<{
      id: string;
      order_number: string;
      daily_number: number | null;
      table_number: string | null;
      open_amount: string;
    }>(
      await manager.query(
        `SELECT o.id, o.order_number, o.daily_number, o.table_number,
                (o.total - o.paid_amount) AS open_amount
           FROM orders o
          WHERE o.organization_id = $1 AND o.event_id = $2 AND ${cols.owner} = $3
            ${memberOnly}
            AND o.is_test = false
            AND o.status NOT IN ('cancelled', 'completed')
            AND o.payment_status IN ('unpaid', 'partly_paid')
            AND o.closed_without_payment_at IS NULL
          ORDER BY o.table_number NULLS LAST, o.created_at`,
        [organizationId, eventId, cols.id],
      ),
    );
    return rows.map((r) => ({
      orderId: r.id,
      orderNumber: r.order_number,
      dailyNumber: r.daily_number,
      tableNumber: r.table_number,
      openAmount: round2(Number(r.open_amount)),
    }));
  }

  // ------------------------------------------------------------ Abrechnen

  async settle(
    organizationId: string,
    subject: SettlementSubject,
    actor: SettlementActor,
    options: SettleOptions = {},
  ): Promise<{ settlement: SettlementView; printed: boolean }> {
    const note = options.note?.trim() || null;
    const countedCash =
      options.countedCash === undefined || options.countedCash === null
        ? null
        : round2(Number(options.countedCash));
    if (
      countedCash !== null &&
      (!Number.isFinite(countedCash) || countedCash < 0)
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.WAITER_SETTLEMENT_COUNTED_INVALID,
        message: 'Der gezählte Betrag ist ungültig.',
        params: { field: 'countedCash' },
      });
    }
    if (options.force) {
      if (!actor.mayForce) {
        throw new ForbiddenException({
          code: ErrorCodes.FORBIDDEN,
          reason: ErrorReasons.WAITER_NOT_PERMITTED,
          message:
            'Trotz offener Tische abrechnen darf nur eine Schichtleitung oder ein Admin.',
          params: { permission: 'settle' },
        });
      }
      if (!note) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.WAITER_SETTLEMENT_NOTE_REQUIRED,
          message:
            'Bitte gib eine Notiz an, warum trotz offener Tische abgerechnet wird.',
        });
      }
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      // Organisation sperren: fortlaufende Nummer, keine doppelte Abrechnung.
      await manager.query(
        `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
        [organizationId],
      );
      const summary = await this.computeSummary(
        manager,
        organizationId,
        subject,
        options.eventId ?? null,
        new Date(),
      );
      if (summary.empty) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.WAITER_SETTLEMENT_EMPTY,
          message: 'Seit der letzten Abrechnung gibt es nichts abzurechnen.',
        });
      }
      if (summary.openTables.length && !options.force) {
        throw new ConflictException({
          code: ErrorCodes.CONFLICT,
          reason: ErrorReasons.WAITER_OPEN_TABLES,
          message:
            'Es gibt noch offene Tische. Übergib sie an eine andere Bedienung oder rechne mit Notiz trotzdem ab (Schichtleitung).',
          params: {
            count: summary.openTables.length,
            openTables: summary.openTables,
          },
        });
      }
      const isTest = settlementIsTrainingOnly(summary.totals);
      let number: number | null = null;
      if (!isTest) {
        const [row] = rowsOf<{ next: number }>(
          await manager.query(
            `SELECT COALESCE(max(number), 0) + 1 AS next FROM waiter_settlements WHERE organization_id = $1`,
            [organizationId],
          ),
        );
        number = Number(row.next);
      }
      const cashExpected =
        summary.totals.cashExpected === undefined
          ? null
          : summary.totals.cashExpected;
      const counted = cashExpected === null ? null : countedCash;
      const repo = manager.getRepository(WaiterSettlement);
      return repo.save(
        repo.create({
          organizationId,
          number,
          isTest,
          waiterId: subject.kind === 'waiter' ? subject.waiterId : null,
          userId: subject.kind === 'member' ? subject.userId : null,
          eventId: summary.eventId,
          periodFrom: summary.periodFrom,
          periodTo: summary.periodTo,
          totals: summary.totals,
          openingFloat: 0,
          cashExpected,
          cashCounted: counted,
          difference:
            counted === null || cashExpected === null
              ? null
              : round2(counted - cashExpected),
          wallet: false,
          openTables: summary.openTables,
          forced: options.force === true && summary.openTables.length > 0,
          note,
          settledByUserId: actor.userId,
          settledByWaiterId: actor.waiterId,
          deviceId: actor.deviceId ?? null,
          cashbookEntryIds: [],
        }),
      );
    });

    this.logger.log(
      `Waiter settlement ${saved.id} (Nr. ${saved.number ?? 'training'}) in organization ${organizationId}`,
    );
    await this.audit(organizationId, saved, actor);

    // Cloud-TSE: Abrechnung als SonstigerVorgang absichern — vor dem Bon
    // (Training ohne Nummer nicht). Wirft nie.
    if (!saved.isTest && this.tseSigning) {
      const subject = await this.subjectView(
        this.dataSource.manager,
        organizationId,
        subject_(saved),
      );
      await this.tseSigning.signSettlement({
        organizationId,
        settlementId: saved.id,
        number: saved.number,
        eventId: saved.eventId,
        subjectName: subject.name,
        expected: saved.cashExpected,
        counted: saved.cashCounted,
        difference: saved.difference,
        terminal: actor.deviceId ?? null,
        userId: actor.userId,
        waiterId: actor.waiterId,
      });
    }

    let printed = false;
    if (options.print !== false && (options.printerId || actor.deviceId)) {
      printed = await this.print(organizationId, saved.id, {
        printerId: options.printerId ?? null,
        deviceId: actor.deviceId ?? null,
      });
    }
    return {
      settlement: await this.findOne(organizationId, saved.id),
      printed,
    };
  }

  // ------------------------------------------------------------ Liste

  async list(
    organizationId: string,
    filter: {
      eventId?: string | null;
      waiterId?: string | null;
      limit?: number;
    } = {},
  ): Promise<SettlementView[]> {
    const params: unknown[] = [organizationId];
    let where = 's.organization_id = $1';
    if (filter.eventId) {
      params.push(filter.eventId);
      where += ` AND s.event_id = $${params.length}`;
    }
    if (filter.waiterId) {
      params.push(filter.waiterId);
      where += ` AND s.waiter_id = $${params.length}`;
    }
    params.push(Math.min(Math.max(filter.limit ?? 200, 1), 500));
    const ids = rowsOf<{ id: string }>(
      await this.dataSource.query(
        `SELECT s.id FROM waiter_settlements s WHERE ${where}
          ORDER BY s.created_at DESC LIMIT $${params.length}`,
        params,
      ),
    ).map((r) => r.id);
    return this.views(organizationId, ids);
  }

  async findOne(
    organizationId: string,
    settlementId: string,
  ): Promise<SettlementView> {
    const [view] = await this.views(organizationId, [settlementId]);
    if (!view) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.WAITER_SETTLEMENT_NOT_FOUND,
        message: 'Abrechnung nicht gefunden',
      });
    }
    return view;
  }

  // ------------------------------------------------------------ Druck

  /** Abrechnung (erneut) drucken; setzt `printed_at` beim ersten Druck. */
  async print(
    organizationId: string,
    settlementId: string,
    target: { printerId?: string | null; deviceId?: string | null },
    reprint = false,
  ): Promise<boolean> {
    if (!this.orderPrint) return false;
    const view = await this.findOne(organizationId, settlementId);
    const ok = await this.orderPrint.printWaiterSettlement(
      organizationId,
      {
        printerId: target.printerId,
        deviceId: target.deviceId ?? view.deviceId,
      },
      settlementPrintData(view, { reprint }),
    );
    if (ok && !view.printedAt) {
      await this.dataSource.query(
        `UPDATE waiter_settlements SET printed_at = now() WHERE id = $1 AND printed_at IS NULL`,
        [settlementId],
      );
    }
    return ok;
  }

  /** Zwischenstand drucken (unverbindlich, ohne Nummer und Unterschriften). */
  async printSummary(
    organizationId: string,
    summary: WaiterSummaryView,
    target: { printerId?: string | null; deviceId?: string | null },
    deviceName: string | null,
  ): Promise<boolean> {
    if (!this.orderPrint) return false;
    return this.orderPrint.printWaiterSettlement(
      organizationId,
      target,
      summaryPrintData(summary, deviceName),
    );
  }

  /** TSE-Vorgang je Abrechnung (Bezug ueber `lines.settlementId`). */
  private async settlementTse(
    ids: string[],
  ): Promise<Map<string, SettlementTse>> {
    const out = new Map<string, SettlementTse>();
    if (!ids.length) return out;
    try {
      const rows = rowsOf<{
        settlement_id: string;
        status: string;
        bon_id: string | null;
        transaction_number: string | null;
        signature_counter: string | null;
        finish_time: Date | null;
      }>(
        await this.dataSource.query(
          `SELECT DISTINCT ON (lines->>'settlementId') lines->>'settlementId' AS settlement_id,
                  status, bon_id, transaction_number, signature_counter, finish_time
             FROM tse_transactions
            WHERE kind = 'settlement' AND lines->>'settlementId' = ANY($1::text[])
            ORDER BY lines->>'settlementId', created_at DESC`,
          [ids],
        ),
      );
      const n = (v: string | null) => (v === null ? null : Number(v));
      for (const r of rows) {
        const signed = r.status === 'signed' || r.status === 'training';
        out.set(r.settlement_id, {
          status: r.status,
          failed: !signed,
          bonNumber: n(r.bon_id),
          transactionNumber: n(r.transaction_number),
          signatureCounter: signed ? n(r.signature_counter) : null,
          finishTime:
            signed && r.finish_time
              ? new Date(r.finish_time).toISOString()
              : null,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Settlement TSE lookup failed: ${(error as Error).message}`,
      );
    }
    return out;
  }

  // ------------------------------------------------------------ Hilfen

  private async organization(
    manager: EntityManager,
    organizationId: string,
  ): Promise<Organization> {
    const organization = await manager.getRepository(Organization).findOne({
      where: { id: organizationId },
      select: { ...OPERATING_MODE_SELECT },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    return organization;
  }

  async operatingMode(organizationId: string): Promise<OperatingMode> {
    return getOperatingMode(
      await this.organization(this.dataSource.manager, organizationId),
    );
  }

  /**
   * Veranstaltung der Abrechnung: angegeben, sonst die der
   * veranstaltungsgebundenen Bedienung, sonst die laufende (aktiv/Test).
   */
  private async resolveEvent(
    manager: EntityManager,
    organizationId: string,
    subject: SettlementSubject,
    eventId: string | null,
  ): Promise<{ id: string; name: string | null }> {
    let id = eventId;
    if (!id && subject.kind === 'waiter') {
      const [row] = rowsOf<{ event_id: string | null }>(
        await manager.query(
          `SELECT event_id FROM waiters WHERE id = $1 AND organization_id = $2`,
          [subject.waiterId, organizationId],
        ),
      );
      id = row?.event_id ?? null;
    }
    if (!id) {
      const [row] = rowsOf<{ id: string }>(
        await manager.query(
          `SELECT id FROM events WHERE organization_id = $1 AND status IN ('active', 'test')
             AND deleted_at IS NULL
           ORDER BY (status = 'active') DESC, start_date DESC NULLS LAST LIMIT 1`,
          [organizationId],
        ),
      );
      id = row?.id ?? null;
    }
    const [event] = id
      ? rowsOf<{ id: string; name: string }>(
          await manager.query(
            `SELECT id, name FROM events WHERE id = $1 AND organization_id = $2`,
            [id, organizationId],
          ),
        )
      : [];
    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Keine Veranstaltung für die Abrechnung gefunden.',
      });
    }
    return event;
  }

  private async subjectView(
    manager: EntityManager,
    organizationId: string,
    subject: SettlementSubject,
  ): Promise<SubjectView> {
    if (subject.kind === 'waiter') {
      const [row] = rowsOf<{
        id: string;
        name: string;
        short_name: string | null;
        color: string | null;
        anonymized_at: Date | null;
      }>(
        await manager.query(
          `SELECT id, name, short_name, color, anonymized_at FROM waiters WHERE id = $1 AND organization_id = $2`,
          [subject.waiterId, organizationId],
        ),
      );
      if (!row) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.WAITER_NOT_FOUND,
          message: 'Bedienung nicht gefunden',
        });
      }
      return {
        kind: 'waiter',
        id: row.id,
        waiterId: row.id,
        userId: null,
        name: row.name,
        shortName: row.short_name,
        color: row.color,
        anonymized: !!row.anonymized_at,
      };
    }
    const [row] = rowsOf<{
      first_name: string | null;
      last_name: string | null;
    }>(
      await manager.query(
        `SELECT u.first_name, u.last_name FROM users u
           JOIN user_organizations uo ON uo.user_id = u.id AND uo.organization_id = $2
          WHERE u.id = $1`,
        [subject.userId, organizationId],
      ),
    );
    if (!row) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.WAITER_NOT_FOUND,
        message: 'Mitglied nicht gefunden',
      });
    }
    const name =
      [row.first_name, row.last_name]
        .map((p) => p?.trim())
        .filter(Boolean)
        .join(' ') || '—';
    return {
      kind: 'member',
      id: subject.userId,
      waiterId: null,
      userId: subject.userId,
      name,
      shortName: row.first_name?.trim().slice(0, 12) || null,
      color: null,
      anonymized: false,
    };
  }

  private async views(
    organizationId: string,
    ids: string[],
  ): Promise<SettlementView[]> {
    if (!ids.length) return [];
    const rows = rowsOf<{
      id: string;
      number: number | null;
      is_test: boolean;
      waiter_id: string | null;
      user_id: string | null;
      event_id: string | null;
      event_name: string | null;
      period_from: Date | null;
      period_to: Date;
      totals: SettlementTotals;
      cash_expected: string | null;
      cash_counted: string | null;
      difference: string | null;
      wallet: boolean;
      open_tables: SettlementOpenTable[];
      forced: boolean;
      note: string | null;
      settled_by_user_id: string | null;
      settled_by_waiter_id: string | null;
      device_id: string | null;
      device_name: string | null;
      printed_at: Date | null;
      created_at: Date;
      waiter_name: string | null;
      waiter_short_name: string | null;
      waiter_color: string | null;
      waiter_anonymized_at: Date | null;
      user_first_name: string | null;
      user_last_name: string | null;
      settler_user_name: string | null;
      settler_waiter_name: string | null;
    }>(
      await this.dataSource.query(
        `SELECT s.*, e.name AS event_name, d.name AS device_name,
                w.name AS waiter_name, w.short_name AS waiter_short_name,
                w.color AS waiter_color, w.anonymized_at AS waiter_anonymized_at,
                u.first_name AS user_first_name, u.last_name AS user_last_name,
                NULLIF(trim(concat_ws(' ', su.first_name, su.last_name)), '') AS settler_user_name,
                sw.name AS settler_waiter_name
           FROM waiter_settlements s
           LEFT JOIN events e ON e.id = s.event_id
           LEFT JOIN devices d ON d.id = s.device_id
           LEFT JOIN waiters w ON w.id = s.waiter_id
           LEFT JOIN users u ON u.id = s.user_id
           LEFT JOIN users su ON su.id = s.settled_by_user_id
           LEFT JOIN waiters sw ON sw.id = s.settled_by_waiter_id
          WHERE s.organization_id = $1 AND s.id = ANY($2::uuid[])`,
        [organizationId, ids],
      ),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const tseById = await this.settlementTse(ids);
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is (typeof rows)[number] => !!r)
      .map((r) => {
        const memberName =
          [r.user_first_name, r.user_last_name]
            .map((p) => p?.trim())
            .filter(Boolean)
            .join(' ') || null;
        const subject: SubjectView = r.waiter_id
          ? {
              kind: 'waiter',
              id: r.waiter_id,
              waiterId: r.waiter_id,
              userId: null,
              name: r.waiter_name ?? 'Bedienung (gelöscht)',
              shortName: r.waiter_short_name,
              color: r.waiter_color,
              anonymized: !!r.waiter_anonymized_at,
            }
          : {
              kind: 'member',
              id: r.user_id!,
              waiterId: null,
              userId: r.user_id,
              name: memberName ?? 'Mitglied (gelöscht)',
              shortName: r.user_first_name?.trim().slice(0, 12) || null,
              color: null,
              anonymized: false,
            };
        const settledBy = r.settled_by_waiter_id
          ? {
              kind: 'waiter' as const,
              id: r.settled_by_waiter_id,
              name: r.settler_waiter_name ?? 'Bedienung (gelöscht)',
            }
          : r.settled_by_user_id
            ? {
                kind: 'user' as const,
                id: r.settled_by_user_id,
                name: r.settler_user_name ?? 'Mitglied (gelöscht)',
              }
            : null;
        const money = (value: string | null) =>
          value === null ? null : Number(value);
        return {
          id: r.id,
          number: r.number,
          isTest: r.is_test,
          subject,
          eventId: r.event_id,
          eventName: r.event_name,
          periodFrom: r.period_from,
          periodTo: r.period_to,
          totals: r.totals,
          cashExpected: money(r.cash_expected),
          cashCounted: money(r.cash_counted),
          difference: money(r.difference),
          wallet: r.wallet,
          openTables: r.open_tables ?? [],
          forced: r.forced,
          note: r.note,
          settledBy,
          deviceId: r.device_id,
          deviceName: r.device_name,
          printedAt: r.printed_at,
          tse: tseById.get(r.id) ?? null,
          createdAt: r.created_at,
        };
      });
  }

  private async audit(
    organizationId: string,
    settlement: WaiterSettlement,
    actor: SettlementActor,
  ): Promise<void> {
    try {
      const repo = this.dataSource.getRepository(AdminAuditLog);
      await repo.save(
        repo.create({
          adminUserId: actor.userId,
          organizationId,
          action: AdminAction.WAITER_SETTLED,
          resourceType: 'waiter_settlement',
          resourceId: settlement.id,
          details: {
            number: settlement.number,
            isTest: settlement.isTest,
            waiterId: settlement.waiterId,
            userId: settlement.userId,
            eventId: settlement.eventId,
            forced: settlement.forced,
            openTables: settlement.openTables.length,
            settledByWaiterId: actor.waiterId,
            deviceId: actor.deviceId ?? null,
          },
          ipAddress: (actor.ipAddress || SYSTEM_AUDIT_IP).slice(0, 45),
          userAgent: actor.userAgent?.slice(0, 500) ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(
        `Audit waiter_settled for org ${organizationId} not written: ${(error as Error).message}`,
      );
    }
  }
}

// ---------------------------------------------------------------- Druckdaten

interface PrintRow {
  label: string;
  amount: number | null;
  text?: string;
}

function formatCount(count: number): string {
  const rounded = Math.round(count * 1000) / 1000;
  return Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace('.', ',');
}

function countLabel(label: string, count: number): string {
  return `${label} (${count})`;
}

/** Bloecke des Bons aus den Zahlen (Vorlage `waiter_settlement`). */
export function settlementBlocks(totals: SettlementTotals) {
  const blocks: { title: string; rows: PrintRow[] }[] = [];
  if (totals.payments) {
    const p = totals.payments;
    blocks.push({
      title: 'KASSIERT',
      rows: [
        { label: countLabel('Bar', p.cash.count), amount: p.cash.amount },
        { label: countLabel('Karte', p.card.count), amount: p.card.amount },
        ...(p.other.count
          ? [
              {
                label: countLabel('Sonstige', p.other.count),
                amount: p.other.amount,
              },
            ]
          : []),
        { label: countLabel('Gesamt', p.total.count), amount: p.total.amount },
        { label: 'davon Trinkgeld', amount: totals.tips ?? 0 },
      ],
    });
  }
  if (totals.refunds || totals.pfandReturns) {
    const rows: PrintRow[] = [];
    if (totals.refunds) {
      rows.push(
        {
          label: countLabel('Storno/Erst. bar', totals.refunds.cash.count),
          amount: -totals.refunds.cash.amount,
        },
        {
          label: countLabel('Storno/Erst. unbar', totals.refunds.nonCash.count),
          amount: -totals.refunds.nonCash.amount,
        },
      );
    }
    if (totals.pfandReturns) {
      rows.push({
        label: countLabel('Pfand ausgezahlt', totals.pfandReturns.count),
        amount: -totals.pfandReturns.amount,
      });
    }
    blocks.push({ title: 'ERSTATTET', rows });
  }
  const taken: PrintRow[] = [
    { label: 'Bestellungen', amount: null, text: String(totals.taken.orders) },
    { label: 'Positionen', amount: null, text: String(totals.taken.items) },
  ];
  if (totals.taken.revenue !== undefined) {
    taken.push({ label: 'Umsatz brutto', amount: totals.taken.revenue });
  }
  if (totals.taken.discounts) {
    taken.push({ label: 'Rabatte', amount: -totals.taken.discounts });
  }
  blocks.push({ title: 'AUFGENOMMEN', rows: taken });
  const tokens = totals.tokens;
  if (tokens) {
    const rows: PrintRow[] = tokens.receivedByType.map((t) => ({
      label: `${formatCount(t.count)} x ${t.name}`,
      amount: t.amount,
    }));
    rows.push({
      label: 'Marken angenommen',
      amount: tokens.received.amount,
    });
    if (tokens.sold.count) {
      rows.push({
        label: countLabel('Marken verkauft', tokens.sold.count),
        amount: tokens.sold.amount,
      });
    }
    if (tokens.boughtBack.count) {
      rows.push({
        label: countLabel('Rücktausch bar', tokens.boughtBack.count),
        amount: -tokens.boughtBack.amount,
      });
    }
    // Angenommene Marken gibt die Person ab wie Bargeld (gezaehlt, nicht
    // im Soll bar).
    blocks.push({ title: 'WERTMARKEN (abgeben)', rows });
  }
  return blocks;
}

function trainingText(totals: SettlementTotals): string | null {
  const t = totals.training;
  if (!t.orders && !t.payments) return null;
  const parts = [`${t.orders} Best.`];
  if (t.payments) parts.push(`${t.payments} Zahl.`);
  return parts.join(', ');
}

function cashPart(totals: SettlementTotals) {
  if (totals.cashExpected === undefined) return {};
  return {
    cash_expected: totals.cashExpected,
    cash_by_device: (totals.cashByDevice ?? []).map((d) => ({
      name: d.deviceName ?? 'Kasse',
      amount: d.amount,
    })),
    cash_hint: 'Bargeld liegt in der Schublade der genannten Kasse.',
  };
}

function tableLabel(t: SettlementOpenTable): string {
  const table = t.tableNumber
    ? `Tisch ${t.tableNumber}`
    : `#${t.dailyNumber ?? t.orderNumber}`;
  return t.openAmount !== undefined
    ? `${table}: ${t.openAmount.toFixed(2).replace('.', ',')}`
    : table;
}

export function settlementPrintData(
  view: SettlementView,
  options: { reprint?: boolean } = {},
): Record<string, unknown> {
  return {
    title: 'ABRECHNUNG',
    number: view.number,
    is_test: view.isTest,
    reprint: options.reprint === true,
    // Nachdruck = Kopie; die Abrechnung entsteht und bleibt elektronisch
    // (Steuerberater 2026-11-10, Frage 8).
    copy: options.reprint === true,
    tse: view.tse
      ? {
          failed: view.tse.failed,
          bon_number: view.tse.bonNumber,
          transaction_number: view.tse.transactionNumber,
          signature_counter: view.tse.signatureCounter,
          finish_time: view.tse.finishTime,
        }
      : null,
    waiter_name: view.subject.name,
    event_name: view.eventName,
    period_from: printDateTime(view.periodFrom),
    period_to: printDateTime(view.periodTo),
    device_name: view.deviceName,
    settled_by: view.settledBy?.name ?? null,
    blocks: settlementBlocks(view.totals),
    ...cashPart(view.totals),
    cash_counted: view.cashCounted,
    difference: view.difference,
    open_tables: view.openTables.map((t) => ({ label: tableLabel(t) })),
    forced: view.forced,
    note: view.note,
    training: trainingText(view.totals),
    signatures: true,
    printed_at: printDateTime(new Date()),
  };
}

export function summaryPrintData(
  summary: WaiterSummaryView,
  deviceName: string | null,
): Record<string, unknown> {
  return {
    title: 'ZWISCHENSTAND',
    number: null,
    is_test: false,
    reprint: false,
    waiter_name: summary.subject.name,
    event_name: summary.eventName,
    period_from: printDateTime(summary.periodFrom),
    period_to: printDateTime(summary.periodTo),
    device_name: deviceName,
    settled_by: null,
    blocks: settlementBlocks(summary.totals),
    ...cashPart(summary.totals),
    cash_counted: null,
    difference: null,
    open_tables: summary.openTables.map((t) => ({ label: tableLabel(t) })),
    forced: false,
    note: null,
    training: trainingText(summary.totals),
    signatures: false,
    printed_at: printDateTime(new Date()),
  };
}
