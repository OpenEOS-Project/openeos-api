import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  assertCashAllowed,
  OPERATING_MODE_SELECT,
} from '../../common/utils/operating-mode.util';
import { Organization } from '../../database/entities/organization.entity';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { TseSigningService } from '../tse/tse-signing.service';
import { rowsOf } from '../tse/tse-sql.util';
import type { TseReceiptView } from '../tse/tse-view';
import {
  printDateTime,
  WaiterSettlementsService,
  type SettlementSubject,
  type WaiterSummaryView,
} from './waiter-settlements.service';

const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100);
const euros = (value: number) => Math.round(value) / 100;

/** Eine Zeile des Live-Kassensturzes. */
export interface LiveCashAuditRow {
  subject: WaiterSummaryView['subject'];
  periodFrom: Date | null;
  /** Soll bar seit der letzten Abrechnung (Schublade je Geraet). */
  cashExpected: number | null;
  cashByDevice: WaiterSummaryView['totals']['cashByDevice'];
  payments: WaiterSummaryView['totals']['payments'];
  tips: number | null;
  refunds: WaiterSummaryView['totals']['refunds'];
  pfandReturns: WaiterSummaryView['totals']['pfandReturns'];
  tokens?: WaiterSummaryView['totals']['tokens'];
  openTables: number;
  /** Arbeitnehmer (Lohnkonto): noch nicht ausgezahltes Kartentrinkgeld. */
  openCardTips: number | null;
  lastSettlement: WaiterSummaryView['lastSettlement'];
}

export interface LiveCashAudit {
  generatedAt: string;
  eventId: string | null;
  eventName: string | null;
  rows: LiveCashAuditRow[];
  total: { cashExpected: number; payments: number; tips: number };
}

export interface TipPayoutView {
  id: string;
  waiterId: string;
  waiterName: string;
  amount: number;
  isTest: boolean;
  settlementId: string | null;
  deviceId: string | null;
  note: string | null;
  tse: TseReceiptView | null;
  createdAt: string;
}

/**
 * Kassen-Nachschau und Trinkgeld (Steuerberater 2026-11-10, Fragen 5, 7):
 *
 * - **Live-Kassensturz**: Soll jeder Bedienung jederzeit aus den Daten
 *   (§ 146b AO): je Person seit ihrer letzten Abrechnung kassiert, Trinkgeld,
 *   Erstattungen, Pfand, Soll bar und wo das Bargeld liegt.
 * - **Kartentrinkgeld auszahlen**: nur fuer Bedienungen mit „Arbeitnehmer
 *   (Lohnkonto)“. Eigener Kassenbeleg (TrinkgeldAN −x, Bar −x) mit
 *   Empfaenger und Quittung; mindert den Soll-Bestand der Schublade. Bei
 *   Ehrenamtlichen gehoert das Kartentrinkgeld dem Verein — eine Weitergabe
 *   waere eine Zuwendung des Vereins, kein Trinkgeld (gesperrt).
 */
@Injectable()
export class WaiterCashAuditService {
  private readonly logger = new Logger(WaiterCashAuditService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settlements: WaiterSettlementsService,
    @Optional() private readonly tseSigning?: TseSigningService,
    @Optional() private readonly orderPrint?: OrderPrintService,
  ) {}

  // ------------------------------------------------- Live-Kassensturz

  async live(
    organizationId: string,
    eventId: string | null = null,
    now: Date = new Date(),
  ): Promise<LiveCashAudit> {
    const event = await this.resolveEvent(organizationId, eventId);
    if (!event) {
      return {
        generatedAt: now.toISOString(),
        eventId: null,
        eventName: null,
        rows: [],
        total: { cashExpected: 0, payments: 0, tips: 0 },
      };
    }
    const subjects = rowsOf<{
      waiter_id: string | null;
      user_id: string | null;
    }>(
      await this.dataSource.query(
        `SELECT DISTINCT waiter_id, user_id FROM (
           SELECT p.processed_by_waiter_id AS waiter_id,
                  CASE WHEN p.processed_by_waiter_id IS NULL THEN p.processed_by_user_id END AS user_id
             FROM payments p JOIN orders o ON o.id = p.order_id
            WHERE o.organization_id = $1 AND o.event_id = $2
              AND p.status IN ('captured', 'refunded')
           UNION
           SELECT r.waiter_id, CASE WHEN r.waiter_id IS NULL THEN r.user_id END
             FROM refunds r WHERE r.organization_id = $1 AND r.event_id = $2
           UNION
           SELECT pr.waiter_id, CASE WHEN pr.waiter_id IS NULL THEN pr.created_by_user_id END
             FROM pfand_returns pr WHERE pr.organization_id = $1 AND pr.event_id = $2
           UNION
           SELECT t.waiter_id, CASE WHEN t.waiter_id IS NULL THEN t.user_id END
             FROM token_transactions t WHERE t.organization_id = $1 AND t.event_id = $2
         ) s WHERE waiter_id IS NOT NULL OR user_id IS NOT NULL`,
        [organizationId, event.id],
      ),
    );
    const rows: LiveCashAuditRow[] = [];
    for (const s of subjects) {
      const subject: SettlementSubject = s.waiter_id
        ? { kind: 'waiter', waiterId: s.waiter_id }
        : { kind: 'member', userId: s.user_id! };
      let summary: WaiterSummaryView;
      try {
        summary = await this.settlements.summary(
          organizationId,
          subject,
          event.id,
          now,
        );
      } catch {
        continue;
      }
      if (summary.empty) continue;
      const t = summary.totals;
      rows.push({
        subject: summary.subject,
        periodFrom: summary.periodFrom,
        cashExpected: t.cashExpected ?? null,
        cashByDevice: t.cashByDevice,
        payments: t.payments,
        tips: t.tips ?? null,
        refunds: t.refunds,
        pfandReturns: t.pfandReturns,
        tokens: t.tokens,
        openTables: summary.openTables.length,
        openCardTips:
          subject.kind === 'waiter'
            ? await this.openCardTipsIfEmployee(
                organizationId,
                subject.waiterId,
              )
            : null,
        lastSettlement: summary.lastSettlement,
      });
    }
    rows.sort((a, b) => a.subject.name.localeCompare(b.subject.name, 'de'));
    const sum = (pick: (r: LiveCashAuditRow) => number | null | undefined) =>
      euros(rows.reduce((acc, r) => acc + cents(pick(r) ?? 0), 0));
    return {
      generatedAt: now.toISOString(),
      eventId: event.id,
      eventName: event.name,
      rows,
      total: {
        cashExpected: sum((r) => r.cashExpected),
        payments: sum((r) => r.payments?.total.amount),
        tips: sum((r) => r.tips),
      },
    };
  }

  // ------------------------------------------ Kartentrinkgeld auszahlen

  /**
   * Noch nicht ausgezahltes Kartentrinkgeld einer Bedienung (Cent):
   * Trinkgeld unbarer Zahlungen, die sie kassiert hat, abzueglich
   * erstatteten Trinkgelds und bisheriger Auszahlungen (ohne Test).
   */
  async openCardTipsCents(
    organizationId: string,
    waiterId: string,
  ): Promise<number> {
    const [row] = rowsOf<{
      tips: string | null;
      refunded: string | null;
      paid: string | null;
    }>(
      await this.dataSource.query(
        `SELECT
           (SELECT COALESCE(SUM(p.tip_amount), 0) FROM payments p JOIN orders o ON o.id = p.order_id
             WHERE o.organization_id = $1 AND o.is_test = false AND p.processed_by_waiter_id = $2
               AND p.payment_method NOT IN ('cash', 'tokens') AND p.status IN ('captured', 'refunded')) AS tips,
           (SELECT COALESCE(SUM(ABS(r.tip_amount)), 0) FROM refunds r JOIN payments p ON p.id = r.payment_id
             WHERE r.organization_id = $1 AND r.is_test = false AND p.processed_by_waiter_id = $2
               AND p.payment_method NOT IN ('cash', 'tokens')) AS refunded,
           (SELECT COALESCE(SUM(t.amount), 0) FROM tip_payouts t
             WHERE t.organization_id = $1 AND t.waiter_id = $2 AND t.is_test = false) AS paid`,
        [organizationId, waiterId],
      ),
    );
    return Math.max(
      0,
      cents(row?.tips) - cents(row?.refunded) - cents(row?.paid),
    );
  }

  private async openCardTipsIfEmployee(
    organizationId: string,
    waiterId: string,
  ): Promise<number | null> {
    const waiter = await this.waiter(organizationId, waiterId);
    if (!waiter?.is_employee) return null;
    return euros(await this.openCardTipsCents(organizationId, waiterId));
  }

  /** Stand fuer die Oberflaeche: Arbeitnehmer?, offen, bisherige Auszahlungen. */
  async tipPayoutStatus(
    organizationId: string,
    waiterId: string,
  ): Promise<{
    isEmployee: boolean;
    openCardTips: number;
    payouts: TipPayoutView[];
  }> {
    const waiter = await this.waiter(organizationId, waiterId);
    if (!waiter) throw this.notFound();
    return {
      isEmployee: waiter.is_employee === true,
      openCardTips: waiter.is_employee
        ? euros(await this.openCardTipsCents(organizationId, waiterId))
        : 0,
      payouts: await this.payouts(organizationId, waiterId),
    };
  }

  async payOut(
    organizationId: string,
    waiterId: string,
    actor: {
      userId: string | null;
      waiterId: string | null;
      deviceId?: string | null;
      deviceName?: string | null;
    },
    options: {
      amount?: number | null;
      eventId?: string | null;
      note?: string | null;
      settlementId?: string | null;
      printerId?: string | null;
      print?: boolean;
    } = {},
  ): Promise<{ payout: TipPayoutView; printed: boolean }> {
    const organization = await this.dataSource
      .getRepository(Organization)
      .findOne({
        where: { id: organizationId },
        select: OPERATING_MODE_SELECT,
      });
    const waiter = await this.waiter(organizationId, waiterId);
    if (!organization || !waiter) throw this.notFound();
    if (!waiter.is_employee) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.TIP_PAYOUT_NOT_EMPLOYEE,
        message:
          'Kartentrinkgeld auszahlen geht nur für Bedienungen mit „Arbeitnehmer (Lohnkonto)“. Bei Ehrenamtlichen gehört das Trinkgeld dem Verein – eine Weitergabe wäre eine Zuwendung des Vereins und kein Trinkgeld.',
      });
    }
    // Ausgezahlt wird bar aus der Kasse.
    assertCashAllowed(organization);

    const saved = await this.dataSource.transaction(async (manager) => {
      // Je Organisation nacheinander: nie doppelt auszahlen.
      await manager.query(
        `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
        [organizationId],
      );
      const open = await this.openCardTipsCents(organizationId, waiterId);
      const amountCents =
        options.amount === undefined || options.amount === null
          ? open
          : cents(options.amount);
      if (amountCents <= 0 || amountCents > open) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.TIP_PAYOUT_AMOUNT_INVALID,
          message:
            open > 0
              ? `Auszahlen kannst du höchstens ${(open / 100).toFixed(2).replace('.', ',')} € (offenes Kartentrinkgeld).`
              : 'Es ist kein Kartentrinkgeld offen.',
          params: { open: euros(open) },
        });
      }
      const isTest = await this.isTestEvent(options.eventId ?? null);
      const [row] = rowsOf<{ id: string; created_at: Date }>(
        await manager.query(
          `INSERT INTO tip_payouts (organization_id, event_id, waiter_id, waiter_name, amount, is_test,
             settlement_id, device_id, paid_by_user_id, paid_by_waiter_id, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, created_at`,
          [
            organizationId,
            options.eventId ?? null,
            waiterId,
            waiter.name.slice(0, 100),
            (amountCents / 100).toFixed(2),
            isTest,
            options.settlementId ?? null,
            actor.deviceId ?? null,
            actor.userId,
            actor.waiterId,
            options.note?.trim().slice(0, 500) || null,
          ],
        ),
      );
      return { id: row.id, amountCents, isTest };
    });

    // TSE vor der Quittung (Beleg erst nach der Signatur).
    const tse =
      (await this.tseSigning?.signTipPayout({
        organizationId,
        tipPayoutId: saved.id,
        eventId: options.eventId ?? null,
        amountCents: saved.amountCents,
        recipientWaiterId: waiterId,
        recipientName: waiter.name,
        training: saved.isTest,
        terminal: actor.deviceId ?? null,
        userId: actor.userId,
        waiterId: actor.waiterId,
      })) ?? null;
    if (tse) {
      await this.dataSource.query(
        `UPDATE tip_payouts SET tse_transaction_id = $2 WHERE id = $1`,
        [saved.id, tse.id],
      );
    }
    this.logger.log(
      `Tip payout ${saved.id} (${(saved.amountCents / 100).toFixed(2)} €) to waiter ${waiterId}`,
    );

    let printed = false;
    if (
      options.print !== false &&
      this.orderPrint &&
      (options.printerId || actor.deviceId)
    ) {
      printed = await this.orderPrint.printWaiterSettlement(
        organizationId,
        {
          printerId: options.printerId ?? null,
          deviceId: actor.deviceId ?? null,
        },
        tipPayoutPrintData({
          waiterName: waiter.name,
          amount: euros(saved.amountCents),
          isTest: saved.isTest,
          deviceName: actor.deviceName ?? null,
          tse,
        }),
      );
      if (printed) {
        await this.dataSource.query(
          `UPDATE tip_payouts SET printed_at = now() WHERE id = $1`,
          [saved.id],
        );
      }
    }
    const [payout] = await this.payouts(organizationId, waiterId, saved.id);
    return { payout, printed };
  }

  async payouts(
    organizationId: string,
    waiterId: string,
    id?: string,
  ): Promise<TipPayoutView[]> {
    const rows = rowsOf<{
      id: string;
      waiter_id: string;
      waiter_name: string;
      amount: string;
      is_test: boolean;
      settlement_id: string | null;
      device_id: string | null;
      note: string | null;
      tse_transaction_id: string | null;
      created_at: Date;
    }>(
      await this.dataSource.query(
        `SELECT * FROM tip_payouts WHERE organization_id = $1 AND waiter_id = $2
           ${id ? 'AND id = $3' : ''} ORDER BY created_at DESC LIMIT 200`,
        id ? [organizationId, waiterId, id] : [organizationId, waiterId],
      ),
    );
    const out: TipPayoutView[] = [];
    for (const r of rows) {
      let tse: TseReceiptView | null = null;
      if (r.tse_transaction_id && this.tseSigning) {
        tse = await this.tseSigning.forTransaction(r.tse_transaction_id);
      }
      out.push({
        id: r.id,
        waiterId: r.waiter_id,
        waiterName: r.waiter_name,
        amount: Number(r.amount),
        isTest: r.is_test,
        settlementId: r.settlement_id,
        deviceId: r.device_id,
        note: r.note,
        tse,
        createdAt: new Date(r.created_at).toISOString(),
      });
    }
    return out;
  }

  // ------------------------------------------------------------ Hilfen

  private async waiter(
    organizationId: string,
    waiterId: string,
  ): Promise<{ id: string; name: string; is_employee: boolean } | null> {
    const [row] = rowsOf<{ id: string; name: string; is_employee: boolean }>(
      await this.dataSource.query(
        `SELECT id, name, is_employee FROM waiters
          WHERE id = $1 AND organization_id = $2 AND anonymized_at IS NULL`,
        [waiterId, organizationId],
      ),
    );
    return row ?? null;
  }

  private async isTestEvent(eventId: string | null): Promise<boolean> {
    if (!eventId) return false;
    const [row] = rowsOf<{ status: string }>(
      await this.dataSource.query(`SELECT status FROM events WHERE id = $1`, [
        eventId,
      ]),
    );
    return row?.status === 'test';
  }

  private async resolveEvent(
    organizationId: string,
    eventId: string | null,
  ): Promise<{ id: string; name: string } | null> {
    const [row] = rowsOf<{ id: string; name: string }>(
      await this.dataSource.query(
        eventId
          ? `SELECT id, name FROM events WHERE id = $2 AND organization_id = $1 AND deleted_at IS NULL`
          : `SELECT id, name FROM events WHERE organization_id = $1 AND deleted_at IS NULL
              AND status IN ('active', 'test') ORDER BY start_date DESC NULLS LAST LIMIT 1`,
        eventId ? [organizationId, eventId] : [organizationId],
      ),
    );
    return row ?? null;
  }

  private notFound() {
    return new NotFoundException({
      code: ErrorCodes.NOT_FOUND,
      reason: ErrorReasons.WAITER_NOT_FOUND,
      message: 'Bedienung nicht gefunden',
    });
  }
}

/** Quittung der Auszahlung (Vorlage der Abrechnung, eigener Titel). */
export function tipPayoutPrintData(input: {
  waiterName: string;
  amount: number;
  isTest: boolean;
  deviceName: string | null;
  tse: TseReceiptView | null;
}): Record<string, unknown> {
  return {
    title: 'TRINKGELD',
    number: null,
    is_test: input.isTest,
    reprint: false,
    waiter_name: input.waiterName,
    event_name: null,
    period_from: null,
    period_to: printDateTime(new Date()),
    device_name: input.deviceName,
    settled_by: null,
    blocks: [
      {
        title: 'Auszahlung Kartentrinkgeld (Arbeitnehmer)',
        rows: [{ label: 'Bar ausgezahlt', amount: input.amount }],
      },
    ],
    tse: input.tse
      ? {
          failed:
            input.tse.status === 'failed' || input.tse.status === 'pending',
          bon_number: input.tse.bonNumber,
          transaction_number: input.tse.transactionNumber,
          signature_counter: input.tse.signatureCounter,
        }
      : null,
    open_tables: [],
    forced: false,
    // Quittung: Unterschrift der Bedienung.
    signatures: true,
    printed_at: printDateTime(new Date()),
  };
}
