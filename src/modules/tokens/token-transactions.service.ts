import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type EntityManager } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { endOfDay, startOfDay } from '../../common/utils/date-range.util';
import {
  OPERATING_MODE_SELECT,
  assertCashAllowed,
} from '../../common/utils/operating-mode.util';
import { assertSumUpAllowedInMode } from '../../common/utils/sumup-test-mode.util';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { TokenType } from '../../database/entities/token-type.entity';
import {
  TokenTransaction,
  type TokenTransactionKind,
  type TokenTransactionLine,
} from '../../database/entities/token-transaction.entity';
import type { User } from '../../database/entities/user.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { EventPhaseService } from '../events/event-phase.service';
import { GatewayService } from '../gateway/gateway.service';
import { assertIntegrationEnabled } from '../integrations/integration-catalog';
import { orderDay, resolveOrderTimeZone } from '../orders/order-numbering';
import { OrderPrintService } from '../print-jobs/order-print.service';
import { TseSigningService } from '../tse/tse-signing.service';
import type { TseReceiptView } from '../tse/tse-view';
import type {
  CreateTokenBuybackDto,
  CreateTokenSaleDto,
  TokenReportQueryDto,
  TokenTransactionQueryDto,
} from './dto';
import {
  assertTokensAllowed,
  cents,
  effectiveKind,
  outstandingCents,
  tokenTaxLines,
} from './token-rules';

/** Namensraum der Advisory-Lock (Bestellnummern 41_201, Pfand 41_202). */
export const TOKEN_NUMBER_LOCK_NAMESPACE = 41_203;
/** Belegnummer `W-JJJJMMTT-NNNN` (Verkauf und Ruecktausch zusammen). */
export const TOKEN_NUMBER_PREFIX = 'W-';

export interface TokenTransactionContext {
  deviceId?: string | null;
  deviceName?: string | null;
  userId?: string | null;
  waiterId?: string | null;
  actorName?: string | null;
  cashDrawerPrinterId?: string | null;
}

export type TokenTransactionResult = TokenTransaction & {
  tse: TseReceiptView | null;
  printed: boolean;
};

/** Bewegungen je Markentyp (Stueck und Cent, ohne Vorzeichen). */
export interface TokenFigures {
  count: number;
  amount: number;
}

export interface TokenReportRow {
  tokenTypeId: string;
  name: string;
  kind: string;
  value: number;
  eventId: string | null;
  eventName: string | null;
  sold: TokenFigures;
  redeemed: TokenFigures;
  /** Bei Storno/Erstattung an den Gast zurueckgegeben. */
  returned: TokenFigures;
  boughtBack: TokenFigures;
  /** Im Umlauf: verkauft − eingeloest + zurueckgegeben − zurueckgetauscht. */
  outstanding: TokenFigures;
}

export interface TokenReport {
  /** Je Markentyp (alle Veranstaltungen bzw. gefiltert). */
  types: TokenReportRow[];
  /** Je Markentyp und Veranstaltung. */
  byEvent: TokenReportRow[];
  totals: Omit<
    TokenReportRow,
    'tokenTypeId' | 'name' | 'kind' | 'value' | 'eventId' | 'eventName'
  >;
}

type MoveKind = 'sale' | 'buyback' | 'redeemed' | 'returned';

interface MoveRow {
  type_id: string;
  event_id: string | null;
  kind: MoveKind;
  cnt: string | null;
  amount: string | null;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const zero = (): TokenFigures => ({ count: 0, amount: 0 });

/**
 * Alle Bewegungen von Wertmarken (Verkauf, Ruecktausch, Einloesung,
 * Rueckgabe bei Storno) als eine Abfrage. `$1` Organisation, `$2` Test.
 */
const MOVES_SQL = `
  SELECT l->>'tokenTypeId' AS type_id, t.event_id, t.kind::text AS kind,
         abs((l->>'count')::numeric) AS cnt, abs((l->>'amount')::numeric) AS amount,
         t.created_at AS at
    FROM token_transactions t, jsonb_array_elements(t.lines) l
   WHERE t.organization_id = $1 AND t.is_test = $2
  UNION ALL
  SELECT l->>'tokenTypeId', o.event_id, 'redeemed',
         abs((l->>'count')::numeric), abs((l->>'amount')::numeric), p.created_at
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    CROSS JOIN LATERAL jsonb_array_elements(p.token_lines) l
   WHERE o.organization_id = $1 AND o.is_test = $2
     AND p.status IN ('captured', 'refunded')
  UNION ALL
  SELECT l->>'tokenTypeId', r.event_id, 'returned',
         abs((l->>'count')::numeric), abs((l->>'amount')::numeric), r.created_at
    FROM refunds r
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.metadata->'tokenLines', '[]'::jsonb)) l
   WHERE r.organization_id = $1 AND r.is_test = $2 AND r.payment_method = 'tokens'`;

/**
 * Verkauf und Ruecktausch von Wertmarken an der Kasse, Bestand und
 * Auswertung.
 *
 * - **Verkauf**: Geld rein (bar, Karte), kein Umsatz — Mehrzweckgutschein
 *   nicht steuerbar, Einzweckgutschein mit seinem Satz. Kassenbuch: bar.
 * - **Ruecktausch**: ausdruecklich, nur fuer Typen mit „Rücktausch
 *   erlaubt“, Recht „Erstattung“, hoechstens der Bestand im Umlauf, immer
 *   bar, Beleg mit Unterschriftszeile. Kein voraussetzungsloser
 *   Ruecktausch (sonst Guthabenkarte, Steuerberater 2026-11-10, Frage 13).
 * - Jede Buchung ist mit Cloud-TSE ein eigener Kassenbeleg.
 */
@Injectable()
export class TokenTransactionsService {
  private readonly logger = new Logger(TokenTransactionsService.name);

  constructor(
    @InjectRepository(TokenTransaction)
    private readonly txRepository: Repository<TokenTransaction>,
    @InjectRepository(TokenType)
    private readonly typeRepository: Repository<TokenType>,
    @InjectRepository(UserOrganization)
    private readonly membershipRepository: Repository<UserOrganization>,
    private readonly gatewayService: GatewayService,
    @Optional()
    private readonly tseSigning?: TseSigningService,
    @Optional()
    private readonly eventPhaseService?: EventPhaseService,
    @Optional()
    @Inject(forwardRef(() => OrderPrintService))
    private readonly orderPrintService?: OrderPrintService,
  ) {}

  private get manager(): EntityManager {
    return this.txRepository.manager;
  }

  // ------------------------------------------------------------ Kasse

  async sell(
    organizationId: string,
    dto: CreateTokenSaleDto,
    context: TokenTransactionContext = {},
  ): Promise<TokenTransactionResult> {
    return this.book(organizationId, 'sale', dto, context);
  }

  async buyback(
    organizationId: string,
    dto: CreateTokenBuybackDto,
    context: TokenTransactionContext = {},
  ): Promise<TokenTransactionResult> {
    return this.book(organizationId, 'buyback', dto, context);
  }

  private async book(
    organizationId: string,
    kind: TokenTransactionKind,
    dto: CreateTokenSaleDto | CreateTokenBuybackDto,
    context: TokenTransactionContext,
  ): Promise<TokenTransactionResult> {
    // Wiederholung nach Netzfehler: derselbe Vorgang, nichts doppelt.
    if (dto.clientRequestId) {
      const existing = await this.txRepository.findOne({
        where: { organizationId, clientRequestId: dto.clientRequestId },
      });
      if (existing) {
        const tse =
          (await this.tseSigning?.forTokenTransaction(existing.id)) ?? null;
        return Object.assign(existing, { tse, printed: false });
      }
    }

    const organization = await this.manager.findOne(Organization, {
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    assertTokensAllowed(organization);
    const sale = kind === 'sale';
    const paymentMethod = sale
      ? (dto as CreateTokenSaleDto).paymentMethod
      : 'cash';
    if (paymentMethod === 'cash') {
      assertCashAllowed(organization);
    } else if (paymentMethod === 'sumup_terminal') {
      assertIntegrationEnabled(organization?.settings, 'sumup');
    }

    const event = dto.eventId
      ? await this.manager.findOne(Event, {
          where: { id: dto.eventId, organizationId },
        })
      : null;
    if (dto.eventId && !event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Veranstaltung nicht gefunden',
      });
    }
    const phase =
      this.eventPhaseService ??
      EventPhaseService.standalone(this.manager.getRepository(Organization));
    const isTest =
      event?.status === EventStatus.TEST || (await phase.isTestModeNow(event));
    if (sale && paymentMethod === 'sumup_terminal') {
      assertSumUpAllowedInMode(
        isTest ? EventStatus.TEST : event?.status,
        paymentMethod,
      );
    }

    // Positionen: Typen der Organisation, aktiv, passende Veranstaltung.
    const merged = new Map<string, number>();
    for (const line of dto.lines) {
      merged.set(
        line.tokenTypeId,
        (merged.get(line.tokenTypeId) ?? 0) + line.count,
      );
    }
    const types = await this.typeRepository.find({
      where: { id: In([...merged.keys()]), organizationId },
    });
    const typeById = new Map(types.map((t) => [t.id, t]));
    const vatExempt = organization?.settings?.vatExempt;
    const lines: TokenTransactionLine[] = [];
    for (const [typeId, count] of merged) {
      const type = typeById.get(typeId);
      if (!type) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.TOKEN_TYPE_NOT_FOUND,
          message: 'Diesen Markentyp gibt es nicht (mehr).',
        });
      }
      // Verkauf nur aktiver Typen; zuruecktauschen geht auch bei
      // deaktivierten (die Marken sind ja im Umlauf).
      if (sale && !type.isActive) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.TOKEN_TYPE_INACTIVE,
          message: `${type.name} ist deaktiviert und wird nicht mehr verkauft.`,
          params: { tokenType: type.name },
        });
      }
      if (sale && type.eventId && event && type.eventId !== event.id) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.TOKEN_NOT_ELIGIBLE,
          message: `${type.name} gilt nur für eine andere Veranstaltung.`,
          params: { tokenTypes: [type.name] },
        });
      }
      if (!sale && !type.buybackAllowed) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.TOKEN_BUYBACK_NOT_ALLOWED,
          message: `Für ${type.name} ist kein Rücktausch vorgesehen. Schalte ihn in der Verwaltung frei, wenn ihr Marken zurücknehmt (Bedingungen in der Verfahrensdokumentation).`,
          params: { tokenType: type.name },
        });
      }
      const kindOfType = effectiveKind(type.kind, vatExempt);
      const unit = cents(type.value);
      lines.push({
        tokenTypeId: type.id,
        name: type.name,
        kind: kindOfType,
        unitValue: unit / 100,
        count,
        amount: (sale ? 1 : -1) * ((unit * count) / 100),
        vatRate:
          kindOfType === 'single_purpose' && type.vatRate !== null
            ? Number(type.vatRate)
            : null,
      });
    }
    const totalCents = lines.reduce((s, l) => s + cents(l.amount), 0);
    if (totalCents === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TOKEN_LINES_INVALID,
        message: 'Wähle mindestens eine Marke.',
      });
    }
    const amountReceived = sale
      ? (dto as CreateTokenSaleDto).amountReceived
      : undefined;
    if (
      paymentMethod === 'cash' &&
      amountReceived !== undefined &&
      cents(amountReceived) < totalCents
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PAYMENT_AMOUNT_MISMATCH,
        message: `Gegeben (${amountReceived.toFixed(2)} €) ist weniger als der Betrag (${(totalCents / 100).toFixed(2)} €).`,
        params: { expected: totalCents / 100, received: amountReceived },
      });
    }

    const tx = this.txRepository.create({
      organizationId,
      eventId: event?.id ?? null,
      kind,
      transactionNumber: '',
      lines,
      totalAmount: totalCents / 100,
      taxLines: tokenTaxLines(lines, vatExempt),
      paymentMethod,
      providerTransactionId: sale
        ? ((dto as CreateTokenSaleDto).providerTransactionId ?? null)
        : null,
      amountReceived:
        paymentMethod === 'cash' && amountReceived !== undefined
          ? amountReceived
          : null,
      deviceId: context.deviceId ?? null,
      userId: context.userId ?? null,
      waiterId: context.waiterId ?? null,
      actorName: context.actorName ?? null,
      reason: sale
        ? null
        : (dto as CreateTokenBuybackDto).reason?.trim() || null,
      isTest,
      clientRequestId: dto.clientRequestId ?? null,
      metadata: {},
    });

    // Nummer, Bestandspruefung (Ruecktausch) und Insert unter einer Sperre
    // je Organisation: zwei Kassen tauschen nie mehr zurueck als im Umlauf.
    await this.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        TOKEN_NUMBER_LOCK_NAMESPACE,
        organizationId,
      ]);
      if (!sale) {
        const stock = await this.stockByType(manager, organizationId, isTest);
        for (const line of lines) {
          const s = stock.get(line.tokenTypeId);
          const left = s ? Math.floor(s.outstanding.count + 1e-6) : 0;
          if (line.count > left) {
            throw new ConflictException({
              code: ErrorCodes.CONFLICT,
              reason: ErrorReasons.TOKEN_BUYBACK_EXCEEDS_OUTSTANDING,
              message: `Von ${line.name} sind laut OpenEOS nur ${left} Stück im Umlauf – mehr kannst du nicht zurücktauschen.`,
              params: { tokenType: line.name, max: left },
            });
          }
        }
      }
      tx.transactionNumber = await this.nextNumber(manager, organizationId);
      await manager.save(TokenTransaction, tx);
    });

    this.logger.log(
      `Token ${kind} ${tx.transactionNumber}: ${(totalCents / 100).toFixed(2)} € (${paymentMethod})`,
    );

    // Bar: Kassenlade oeffnen (Verkauf: Geld rein, Ruecktausch: Geld raus).
    if (paymentMethod === 'cash' && context.cashDrawerPrinterId) {
      try {
        this.gatewayService.sendOpenCashDrawer(
          organizationId,
          context.cashDrawerPrinterId,
        );
      } catch (error) {
        this.logger.warn(
          `Cash drawer open failed for token transaction ${tx.id}: ${(error as Error).message}`,
        );
      }
    }

    // Kassenbeleg ueber die Cloud-TSE (wirft nie), erst dann der Beleg.
    const tse = (await this.tseSigning?.signTokenTransaction(tx)) ?? null;
    let printed = false;
    if (
      this.orderPrintService &&
      // Ruecktausch immer drucken (Beleg mit Unterschrift), Verkauf nach
      // der Einstellung „Kassenbon“.
      (!sale ||
        (await this.orderPrintService.autoPrintsReceipts(organizationId)))
    ) {
      printed = await this.orderPrintService.printTokenReceipt(organizationId, {
        tokenTransaction: tx,
        deviceName: context.deviceName ?? null,
        actorName: context.actorName ?? null,
        tse,
      });
    }
    return Object.assign(tx, { tse, printed });
  }

  async printReceipt(
    organizationId: string,
    id: string,
    context: {
      deviceId?: string | null;
      deviceName?: string | null;
      reprint?: boolean;
    },
  ): Promise<{ printed: boolean }> {
    const tx = await this.txRepository.findOne({
      where: { id, organizationId },
    });
    if (!tx) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.TOKEN_TRANSACTION_NOT_FOUND,
        message: 'Buchung nicht gefunden',
      });
    }
    if (!this.orderPrintService) return { printed: false };
    const printed = await this.orderPrintService.printTokenReceipt(
      organizationId,
      {
        tokenTransaction: {
          ...tx,
          deviceId: context.deviceId ?? tx.deviceId,
        } as TokenTransaction,
        deviceName: context.deviceName ?? null,
        actorName: tx.actorName,
        reprint: context.reprint === true,
        tse: (await this.tseSigning?.forTokenTransaction(tx.id)) ?? null,
      },
    );
    return { printed };
  }

  private async nextNumber(
    manager: EntityManager,
    organizationId: string,
  ): Promise<string> {
    const organization = await manager.findOne(Organization, {
      where: { id: organizationId },
      select: { id: true, settings: true },
    });
    const day = orderDay(
      new Date(),
      resolveOrderTimeZone(organization?.settings?.timezone),
    );
    const base = `${TOKEN_NUMBER_PREFIX}${day.key}-`;
    const rows = await manager.query<{ max: number | string | null }[]>(
      `SELECT MAX(
         CASE WHEN SUBSTRING(transaction_number FROM $3::int) ~ '^[0-9]{1,9}$'
              THEN CAST(SUBSTRING(transaction_number FROM $3::int) AS integer)
         END
       ) AS max
       FROM token_transactions
       WHERE organization_id = $1 AND transaction_number LIKE $2`,
      [organizationId, `${base}%`, base.length + 1],
    );
    const max = Number(rows?.[0]?.max ?? 0) || 0;
    return `${base}${String(max + 1).padStart(4, '0')}`;
  }

  // ------------------------------------------------------- Auswertung

  /** Bestand je Markentyp (ohne Test bzw. nur Test). */
  async stockByType(
    manager: EntityManager,
    organizationId: string,
    isTest = false,
  ): Promise<Map<string, { outstanding: TokenFigures }>> {
    const rows = await manager.query<MoveRow[]>(
      `SELECT type_id, NULL::uuid AS event_id, kind, SUM(cnt) AS cnt, SUM(amount) AS amount
         FROM (${MOVES_SQL}) m
        GROUP BY type_id, kind`,
      [organizationId, isTest],
    );
    const out = new Map<string, { outstanding: TokenFigures }>();
    for (const [typeId, figures] of aggregate(rows)) {
      out.set(typeId, { outstanding: figures.outstanding });
    }
    return out;
  }

  /**
   * Verkauft, eingeloest, bei Storno zurueckgegeben, zurueckgetauscht und
   * im Umlauf — je Markentyp und je Veranstaltung (ohne Testbuchungen).
   * Mit Zeitraum zaehlen nur die Bewegungen darin (der Umlauf ist dann die
   * Differenz des Zeitraums).
   */
  async report(
    organizationId: string,
    user: User,
    query: TokenReportQueryDto,
  ): Promise<TokenReport> {
    await this.checkReportPermission(organizationId, user.id);
    const params: unknown[] = [organizationId, false];
    const where: string[] = [];
    if (query.eventId) {
      params.push(query.eventId);
      where.push(`event_id = $${params.length}`);
    }
    if (query.startDate) {
      params.push(startOfDay(query.startDate));
      where.push(`at >= $${params.length}`);
    }
    if (query.endDate) {
      params.push(endOfDay(query.endDate));
      where.push(`at <= $${params.length}`);
    }
    const rows = await this.manager.query<MoveRow[]>(
      `SELECT type_id, event_id, kind, SUM(cnt) AS cnt, SUM(amount) AS amount
         FROM (${MOVES_SQL}) m
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY type_id, event_id, kind`,
      params,
    );
    const types = await this.typeRepository.find({ where: { organizationId } });
    const typeById = new Map(types.map((t) => [t.id, t]));
    const eventIds = [
      ...new Set(rows.map((r) => r.event_id).filter(Boolean)),
    ] as string[];
    const events = eventIds.length
      ? await this.manager.find(Event, {
          where: { id: In(eventIds) },
          select: { id: true, name: true },
        })
      : [];
    const eventName = new Map(events.map((e) => [e.id, e.name]));
    const describe = (typeId: string) => {
      const type = typeById.get(typeId);
      return {
        tokenTypeId: typeId,
        name: type?.name ?? 'Unbekannte Marke',
        kind: type?.kind ?? 'multi_purpose',
        value: Number(type?.value ?? 0),
      };
    };

    const byEvent: TokenReportRow[] = [];
    const byEventKey = new Map<string, MoveRow[]>();
    for (const row of rows) {
      const key = `${row.type_id}|${row.event_id ?? ''}`;
      byEventKey.set(key, [...(byEventKey.get(key) ?? []), row]);
    }
    for (const group of byEventKey.values()) {
      for (const [typeId, figures] of aggregate(group)) {
        const eventId = group[0].event_id;
        byEvent.push({
          ...describe(typeId),
          eventId,
          eventName: eventId ? (eventName.get(eventId) ?? null) : null,
          ...figures,
        });
      }
    }
    const typeRows: TokenReportRow[] = [];
    const aggregated = aggregate(rows);
    // Auch Typen ohne Bewegung zeigen (Bestand 0).
    for (const type of types) {
      if (query.eventId && type.eventId && type.eventId !== query.eventId)
        continue;
      if (!aggregated.has(type.id)) {
        aggregated.set(type.id, {
          sold: zero(),
          redeemed: zero(),
          returned: zero(),
          boughtBack: zero(),
          outstanding: zero(),
        });
      }
    }
    for (const [typeId, figures] of aggregated) {
      typeRows.push({
        ...describe(typeId),
        eventId: null,
        eventName: null,
        ...figures,
      });
    }
    const order = (a: TokenReportRow, b: TokenReportRow) =>
      (typeById.get(a.tokenTypeId)?.sortOrder ?? 0) -
        (typeById.get(b.tokenTypeId)?.sortOrder ?? 0) ||
      a.name.localeCompare(b.name) ||
      (a.eventName ?? '').localeCompare(b.eventName ?? '');
    typeRows.sort(order);
    byEvent.sort(order);
    const sum = (key: keyof TokenReport['totals']): TokenFigures => ({
      count: round3(typeRows.reduce((s, r) => s + r[key].count, 0)),
      amount:
        Math.round(typeRows.reduce((s, r) => s + r[key].amount * 100, 0)) / 100,
    });
    return {
      types: typeRows,
      byEvent,
      totals: {
        sold: sum('sold'),
        redeemed: sum('redeemed'),
        returned: sum('returned'),
        boughtBack: sum('boughtBack'),
        outstanding: sum('outstanding'),
      },
    };
  }

  async list(
    organizationId: string,
    user: User,
    query: TokenTransactionQueryDto,
  ): Promise<TokenTransaction[]> {
    await this.checkReportPermission(organizationId, user.id);
    const qb = this.txRepository
      .createQueryBuilder('t')
      .where('t.organizationId = :organizationId', { organizationId })
      .orderBy('t.createdAt', 'DESC')
      .take(query.limit ?? 50);
    if (query.eventId)
      qb.andWhere('t.eventId = :eventId', { eventId: query.eventId });
    if (query.kind) qb.andWhere('t.kind = :kind', { kind: query.kind });
    if (query.startDate)
      qb.andWhere('t.createdAt >= :from', {
        from: startOfDay(query.startDate),
      });
    if (query.endDate)
      qb.andWhere('t.createdAt <= :to', { to: endOfDay(query.endDate) });
    return qb.getMany();
  }

  private async checkReportPermission(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.membershipRepository.findOne({
      where: { organizationId, userId },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
    if (
      membership.role !== OrganizationRole.ADMIN &&
      !membership.permissions?.reports &&
      !membership.permissions?.products
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}

/** Bewegungen je Typ zu Kennzahlen (Stueck, Euro) zusammenfassen. */
export function aggregate(
  rows: Pick<MoveRow, 'type_id' | 'kind' | 'cnt' | 'amount'>[],
): Map<
  string,
  {
    sold: TokenFigures;
    redeemed: TokenFigures;
    returned: TokenFigures;
    boughtBack: TokenFigures;
    outstanding: TokenFigures;
  }
> {
  const out = new Map<
    string,
    {
      sold: TokenFigures;
      redeemed: TokenFigures;
      returned: TokenFigures;
      boughtBack: TokenFigures;
      outstanding: TokenFigures;
    }
  >();
  for (const row of rows) {
    if (!row.type_id) continue;
    const entry = out.get(row.type_id) ?? {
      sold: zero(),
      redeemed: zero(),
      returned: zero(),
      boughtBack: zero(),
      outstanding: zero(),
    };
    const target =
      row.kind === 'sale'
        ? entry.sold
        : row.kind === 'buyback'
          ? entry.boughtBack
          : row.kind === 'redeemed'
            ? entry.redeemed
            : entry.returned;
    target.count = round3(target.count + Number(row.cnt ?? 0));
    target.amount =
      Math.round(target.amount * 100 + Number(row.amount ?? 0) * 100) / 100;
    out.set(row.type_id, entry);
  }
  for (const entry of out.values()) {
    entry.outstanding = {
      count: round3(
        entry.sold.count -
          entry.redeemed.count +
          entry.returned.count -
          entry.boughtBack.count,
      ),
      amount:
        outstandingCents({
          soldCents: cents(entry.sold.amount),
          redeemedCents: cents(entry.redeemed.amount),
          boughtBackCents: cents(entry.boughtBack.amount),
          reversedCents: cents(entry.returned.amount),
        }) / 100,
    };
  }
  return out;
}
