import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Order } from '../../database/entities/order.entity';
import {
  OrderFulfillmentType,
  PaymentStatus,
} from '../../database/entities/order.entity';
import {
  OrderItem,
  OrderItemStatus,
} from '../../database/entities/order-item.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Payment } from '../../database/entities/payment.entity';
import type { PfandReturn } from '../../database/entities/pfand-return.entity';
import type { Refund } from '../../database/entities/refund.entity';
import {
  TseTransaction,
  type TseTransactionKind,
} from '../../database/entities/tse-transaction.entity';
import { TseUnit } from '../../database/entities/tse-unit.entity';
import {
  cents,
  emptyComposition,
  orderComposition,
  pfandFromRecord,
  pfandMap,
  pfandSum,
  rateMapFrom,
  rateRecord,
  scaleComposition,
  unitGross,
  type Composition,
} from '../refunds/refund-calc';
import {
  SwissbitError,
  SwissbitTimeoutError,
  errorCodeOf,
  errorMessageOf,
} from './swissbit/swissbit.errors';
import { SwissbitClientProvider } from './swissbit/swissbit-client.provider';
import type { TransactionResponse } from './swissbit/swissbit.types';
import { TseConfig } from './tse.config';
import { rowsOf } from './tse-sql.util';
import { TseOutageService } from './tse-outage.service';
import {
  PROCESS_TYPE_ORDER,
  PROCESS_TYPE_RECEIPT,
  bestellungProcessData,
  cashbookProcessData,
  depositReturnSlots,
  emptySlots,
  kassenbelegProcessData,
  paymentTypeFor,
  slotsFromComposition,
  slotsTotal,
  type OrderLine,
  type ReceiptAmounts,
  type VatSlots,
} from './tse-process-data';
import { TseUnitCache, type SigningUnit } from './tse-unit-cache.service';
import {
  tseReceiptView,
  type TseReceiptView,
  type TseUnitInfo,
} from './tse-view';

/** Wer einen Vorgang ausgeloest hat. */
export interface TseActor {
  /** Eingabegeraet (Terminal) — Geraete-ID. */
  terminal?: string | null;
  userId?: string | null;
  /** Bedienung (geht fuer BEDIENER_ID vor `userId`). */
  waiterId?: string | null;
  /** Name des Bedieners; fehlt er, wird er beim Signieren nachgeschlagen. */
  operatorName?: string | null;
}

export interface SignInput extends TseActor {
  organizationId: string;
  kind: TseTransactionKind;
  processType: string;
  processData: string;
  training: boolean;
  amountCents?: number | null;
  lines?: Record<string, unknown> | null;
  eventId?: string | null;
  orderId?: string | null;
  paymentId?: string | null;
  refundId?: string | null;
  pfandReturnId?: string | null;
  referencesTseTransactionId?: string | null;
}

const MIN_FINISH_BUDGET_MS = 300;

/**
 * Signiert Kassenvorgaenge ueber die Cloud-TSE der Organisation
 * (tse-swissbit-plan.md §8).
 *
 * Grundregeln:
 * - **Der Verkauf wird nie blockiert.** Jeder Fehler (Swissbit nicht
 *   erreichbar, Zeitlimit, unerwartete Antwort, eigener Fehler) endet als
 *   Vorgang `failed` mit Fehlercode; der Bon traegt „TSE ausgefallen“, der
 *   Ausfall wird protokolliert und die Admins werden benachrichtigt.
 * - **Nach dem Commit, vor dem Bon**: aufgerufen wird erst, wenn die
 *   Zahlung gespeichert ist; der Bon (Druckauftrag) bekommt das Ergebnis.
 * - **Kein Nachsignieren**: nach Ablauf des Zeitbudgets
 *   (`TSE_SIGN_BUDGET_MS`) wird fuer den Vorgang nie mehr
 *   `finishTransaction` mit Verkaufsdaten gesendet; haengende
 *   Transaktionen schliesst der Abgleich mit `AVBelegabbruch`.
 * - **Kein Statusabruf vor der Transaktion** (Empfehlung Swissbit):
 *   start → finish, sonst nichts.
 * - Ein Client je Organisation (`OEOS-<kurz-id>`); das Geraet steht als
 *   `terminal` im eigenen Datensatz.
 */
@Injectable()
export class TseSigningService {
  private readonly logger = new Logger(TseSigningService.name);
  private readonly unitInfo = new Map<string, TseUnitInfo>();

  constructor(
    @InjectRepository(TseTransaction)
    private readonly txRepository: Repository<TseTransaction>,
    @InjectRepository(TseUnit)
    private readonly unitRepository: Repository<TseUnit>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly units: TseUnitCache,
    private readonly swissbit: SwissbitClientProvider,
    private readonly outages: TseOutageService,
    private readonly config: TseConfig,
  ) {}

  /** Signiert die Organisation gerade? (billig, gecacht) */
  async isActive(organizationId: string): Promise<boolean> {
    try {
      return (await this.units.get(organizationId)) !== null;
    } catch (error) {
      this.logger.error(`TSE lookup failed: ${(error as Error).message}`);
      return false;
    }
  }

  // ------------------------------------------------------------ Kern

  /**
   * Fuehrt einen Vorgang auf der TSE aus. `null`, wenn die Organisation
   * keine aktive TSE hat. Wirft nie.
   */
  async sign(input: SignInput): Promise<TseReceiptView | null> {
    let signing: SigningUnit | null;
    try {
      signing = await this.units.get(input.organizationId);
    } catch (error) {
      this.logger.error(
        `TSE lookup for ${input.organizationId} failed: ${(error as Error).message}`,
      );
      return null;
    }
    if (!signing) return null;
    const { unit, credentials } = signing;

    let tx: TseTransaction;
    const operatorName = await this.operatorNameFor(input);
    try {
      tx = await this.txRepository.save(
        this.txRepository.create({
          organizationId: input.organizationId,
          tseUnitId: unit.id,
          eventId: input.eventId ?? null,
          kind: input.kind,
          processType: input.processType,
          processData: input.processData,
          training: input.training,
          status: 'pending',
          clientId: unit.clientId,
          serialNumber: unit.serialNumber,
          amount:
            input.amountCents === null || input.amountCents === undefined
              ? null
              : (input.amountCents / 100).toFixed(2),
          lines: input.lines ?? null,
          terminal: input.terminal ? String(input.terminal).slice(0, 64) : null,
          userId: input.userId ?? null,
          waiterId: input.waiterId ?? null,
          operatorName,
          orderId: input.orderId ?? null,
          paymentId: input.paymentId ?? null,
          refundId: input.refundId ?? null,
          pfandReturnId: input.pfandReturnId ?? null,
          referencesTseTransactionId: input.referencesTseTransactionId ?? null,
        }),
      );
    } catch (error) {
      // Ohne Datensatz kein Protokoll — trotzdem nicht den Verkauf stoppen.
      this.logger.error(
        `Could not record TSE transaction (${input.kind}, org ${input.organizationId}): ${(error as Error).message}`,
      );
      return null;
    }

    const started = Date.now();
    const budget = this.config.settings.timeouts.signBudgetMs;
    const callTimeout = this.config.settings.timeouts.transactionMs;
    const client = this.swissbit.client;
    const request = {
      clientId: unit.clientId,
      processType: input.processType,
      processData: input.processData,
    };

    let start: TransactionResponse | null = null;
    try {
      const startRes = await this.withRetry(
        () =>
          client.startTransaction(
            credentials,
            { ...request, processData: '' },
            Math.min(callTimeout, budget),
          ),
        started,
        budget,
      );
      start = startRes.value;
      tx.startRequestId = startRes.requestId;
      tx.transactionNumber = String(start.transactionNumber);
      tx.startTime = new Date(start.signatureCreationTime * 1000);

      const remaining = budget - (Date.now() - started);
      if (remaining < MIN_FINISH_BUDGET_MS) {
        throw new SwissbitTimeoutError({
          operation: 'finishTransaction',
          status: null,
          errorCode: 'E_TIMEOUT',
          message: `sign budget of ${budget} ms exhausted after start`,
          requestId: '-',
        });
      }
      const finishRes = await client.finishTransaction(
        credentials,
        start.transactionNumber,
        request,
        Math.min(callTimeout, remaining),
      );
      const finish = finishRes.value;
      tx.finishRequestId = finishRes.requestId;
      tx.signatureCounter = String(finish.signatureCounter);
      tx.signatureValue = finish.signatureValue;
      tx.finishTime = new Date(finish.signatureCreationTime * 1000);
      tx.status = input.training ? 'training' : 'signed';
      tx.durationMs = Date.now() - started;
      await this.saveResult(tx);
      void this.outages.recordSuccess(input.organizationId, unit.id);
    } catch (error) {
      tx.status = 'failed';
      tx.errorCode = errorCodeOf(error).slice(0, 60);
      tx.errorMessage = errorMessageOf(error, 500);
      tx.durationMs = Date.now() - started;
      if (error instanceof SwissbitError && error.requestId !== '-') {
        if (start) tx.finishRequestId = error.requestId;
        else tx.startRequestId = error.requestId;
      }
      this.logger.warn(
        `TSE ${input.kind} for org ${input.organizationId} failed: ${tx.errorCode} (${tx.durationMs} ms)`,
      );
      await this.saveResult(tx);
      if (tx.errorCode === 'E_TSE_DISABLED') {
        // Deaktiviert (z. B. auf einer anderen Instanz): Cache neu laden,
        // kein Ausfall.
        this.units.invalidate(input.organizationId);
      } else {
        void this.outages.recordFailure(
          input.organizationId,
          unit.id,
          tx.errorCode,
          tx.errorMessage,
        );
      }
    }
    return tseReceiptView(tx, this.rememberUnit(unit));
  }

  /**
   * Ein zweiter Versuch fuer `startTransaction`, wenn Swissbit sicher
   * nichts verarbeitet hat (429, Wartung, Verbindungsfehler — nicht bei
   * Zeitueberschreitung) und das Budget reicht.
   */
  private async withRetry<T>(
    call: () => Promise<T>,
    started: number,
    budget: number,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (
        error instanceof SwissbitError &&
        error.retryable &&
        !(error instanceof SwissbitTimeoutError) &&
        Date.now() - started < budget / 2
      ) {
        await new Promise((r) => setTimeout(r, 100));
        return call();
      }
      throw error;
    }
  }

  private async saveResult(tx: TseTransaction): Promise<void> {
    try {
      // Beleg-Nr. (BON_ID) vergibt der Datenbank-Trigger beim Einfuegen.
      const rows = rowsOf<{ bon_id: string | null }>(
        await this.txRepository.query(
          'SELECT bon_id FROM tse_transactions WHERE id = $1',
          [tx.id],
        ),
      );
      tx.bonId = rows[0]?.bon_id ?? null;
    } catch {
      tx.bonId = tx.bonId ?? null;
    }
    try {
      await this.txRepository.update(tx.id, {
        status: tx.status,
        transactionNumber: tx.transactionNumber,
        signatureCounter: tx.signatureCounter,
        signatureValue: tx.signatureValue,
        startTime: tx.startTime,
        finishTime: tx.finishTime,
        errorCode: tx.errorCode,
        errorMessage: tx.errorMessage,
        startRequestId: tx.startRequestId,
        finishRequestId: tx.finishRequestId,
        durationMs: tx.durationMs,
      });
    } catch (error) {
      this.logger.error(
        `Could not store TSE result for ${tx.id}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * BEDIENER_NAME als Snapshot (hoechstens 50 Zeichen): mitgegebener Name,
   * sonst der Name der Bedienung bzw. des Mitglieds zum Zeitpunkt des
   * Signierens. Fehler beim Nachschlagen stoppen nie den Verkauf.
   */
  private async operatorNameFor(actor: TseActor): Promise<string | null> {
    const given = actor.operatorName?.trim();
    if (given) return given.slice(0, 50);
    try {
      if (actor.waiterId) {
        const rows: { name: string }[] = await this.txRepository.manager.query(
          `SELECT name FROM waiters WHERE id = $1`,
          [actor.waiterId],
        );
        return rows[0]?.name?.trim().slice(0, 50) || null;
      }
      if (actor.userId) {
        const rows: { name: string | null }[] =
          await this.txRepository.manager.query(
            `SELECT NULLIF(CONCAT_WS(' ', NULLIF(TRIM(first_name), ''), NULLIF(TRIM(last_name), '')), '') AS name
               FROM users WHERE id = $1`,
            [actor.userId],
          );
        return rows[0]?.name?.slice(0, 50) || null;
      }
    } catch (error) {
      this.logger.warn(
        `Operator name lookup failed: ${(error as Error).message}`,
      );
    }
    return null;
  }

  private rememberUnit(unit: TseUnit): TseUnitInfo {
    const info: TseUnitInfo = {
      serialNumber: unit.serialNumber,
      publicKey: unit.publicKey,
      signatureAlgorithm: unit.signatureAlgorithm,
      logTimeFormat: unit.logTimeFormat,
    };
    this.unitInfo.set(unit.id, info);
    return info;
  }

  // ------------------------------------------------- Kassenbelege

  /**
   * Kassenbeleg einer Zahlung (alle Zahlungswege: Einzel, Split, Sammel,
   * Tisch, Verwaltung). Betraege je Steuersatz aus den bezahlten
   * Positionen bzw. anteilig aus der Bestellung, Summe = Zahlbetrag.
   */
  async signPayment(paymentId: string): Promise<TseReceiptView | null> {
    try {
      const payment = await this.paymentRepository.findOne({
        where: { id: paymentId },
        relations: { itemPayments: { orderItem: true } },
      });
      if (!payment) return null;
      const order = await this.orderRepository.findOne({
        where: { id: payment.orderId },
        relations: { items: true },
      });
      if (!order) return null;
      if (!(await this.isActive(order.organizationId))) return null;
      const vatExempt = await this.vatExempt(order.organizationId);

      const amountCents = cents(payment.amount);
      const composition = paymentComposition(order, payment);
      const slots = fitSlots(
        slotsFromComposition(composition, vatExempt),
        amountCents,
      );
      const training = order.isTest === true;
      const amounts: ReceiptAmounts = {
        slots,
        payments: [
          { type: paymentTypeFor(payment.paymentMethod), cents: amountCents },
        ],
      };
      const view = await this.sign({
        organizationId: order.organizationId,
        kind: 'receipt',
        processType: PROCESS_TYPE_RECEIPT,
        processData: kassenbelegProcessData(
          training ? 'AVTraining' : 'Beleg',
          amounts,
        ),
        training,
        amountCents,
        lines: receiptLines(order, payment, composition),
        eventId: order.eventId,
        orderId: order.id,
        paymentId: payment.id,
        terminal: payment.processedByDeviceId,
        userId: payment.processedByUserId,
        waiterId: payment.processedByWaiterId ?? null,
      });
      if (view) view.orderStartTime = await this.orderStartTime(order.id);
      return view;
    } catch (error) {
      this.logger.error(
        `TSE signing of payment ${paymentId} failed before the TSE call: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** Mehrere Zahlungen parallel (Sammelzahlung). */
  async signPayments(
    paymentIds: string[],
  ): Promise<Map<string, TseReceiptView>> {
    const result = new Map<string, TseReceiptView>();
    const views = await Promise.all(
      paymentIds.map((id) => this.signPayment(id)),
    );
    paymentIds.forEach((id, index) => {
      const view = views[index];
      if (view) result.set(id, view);
    });
    return result;
  }

  /**
   * Beleg ueber 0,00 fuer eine Bestellung ohne Zahlung (voll rabattiert).
   */
  async signZeroReceipt(
    orderId: string,
    actor: TseActor,
  ): Promise<TseReceiptView | null> {
    try {
      const order = await this.orderRepository.findOne({
        where: { id: orderId },
        relations: { items: true },
      });
      if (!order || !(await this.isActive(order.organizationId))) return null;
      const training = order.isTest === true;
      return this.sign({
        organizationId: order.organizationId,
        kind: 'receipt',
        processType: PROCESS_TYPE_RECEIPT,
        processData: kassenbelegProcessData(training ? 'AVTraining' : 'Beleg', {
          slots: emptySlots(),
          payments: [],
        }),
        training,
        amountCents: 0,
        lines: {
          orderNumber: order.orderNumber,
          zeroTotal: true,
          items: snapshotItems(order.items),
          discount: Number(order.discountAmount) || 0,
        },
        eventId: order.eventId,
        orderId: order.id,
        ...actor,
      });
    } catch (error) {
      this.logger.error(
        `TSE zero receipt for ${orderId} failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Gegenbeleg einer Erstattung: Kassenbeleg mit negativen Betraegen,
   * Verweis auf den Kassenbeleg der erstatteten Zahlung.
   */
  async signRefund(refund: Refund): Promise<TseReceiptView | null> {
    try {
      if (!(await this.isActive(refund.organizationId))) return null;
      const vatExempt = await this.vatExempt(refund.organizationId);
      const amountCents = cents(refund.amount); // negativ
      const composition = refundComposition(refund);
      const slots = fitSlots(
        slotsFromComposition(composition, vatExempt, -1),
        amountCents,
      );
      const training = refund.isTest === true || refund.status === 'test';
      const original = refund.paymentId
        ? await this.txRepository.findOne({
            where: { paymentId: refund.paymentId, kind: 'receipt' },
            order: { createdAt: 'DESC' },
          })
        : null;
      return this.sign({
        organizationId: refund.organizationId,
        kind: 'refund',
        processType: PROCESS_TYPE_RECEIPT,
        processData: kassenbelegProcessData(training ? 'AVTraining' : 'Beleg', {
          slots,
          payments: [
            { type: paymentTypeFor(refund.paymentMethod), cents: amountCents },
          ],
        }),
        training,
        amountCents,
        lines: {
          refundNumber: refund.refundNumber,
          refundKind: refund.kind,
          storno: true,
          items: (refund.items ?? []).map((item) => ({
            name: item.productName,
            quantity: item.quantity,
            unitPrice: Number(item.unitPrice),
            taxRate: Number(item.taxRate),
            amount: Number(item.amount),
            deposit: Number(item.depositAmount),
            ...(item.depositTaxRate != null
              ? { depositTaxRate: Number(item.depositTaxRate) }
              : {}),
          })),
          pfand: Number(refund.pfandAmount),
          pfandByRate: rateRecord(composition.pfand),
          tip: Number(refund.tipAmount),
          paymentMethod: refund.paymentMethod,
        },
        eventId: refund.eventId,
        orderId: refund.orderId,
        paymentId: refund.paymentId,
        refundId: refund.id,
        referencesTseTransactionId: original?.id ?? null,
        terminal: refund.deviceId,
        userId: refund.userId,
        waiterId: refund.waiterId ?? null,
        operatorName: refund.actorName,
      });
    } catch (error) {
      this.logger.error(
        `TSE refund ${refund.id} failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Pfand-Auszahlung (bar, negativ): je Position im Slot des Satzes ihrer
   * Pfandart — die Rueckgabe mindert das Entgelt (§ 17 UStG). Auszahlungen
   * ohne Satz (Bestand) im 0-%-Slot.
   */
  async signPfandReturn(
    pfandReturn: PfandReturn,
  ): Promise<TseReceiptView | null> {
    try {
      if (!(await this.isActive(pfandReturn.organizationId))) return null;
      const vatExempt = await this.vatExempt(pfandReturn.organizationId);
      const amountCents = -Math.abs(cents(pfandReturn.totalAmount));
      const slots = fitSlots(
        depositReturnSlots(pfandReturn.lines ?? [], vatExempt),
        amountCents,
      );
      const training = pfandReturn.isTest === true;
      return this.sign({
        organizationId: pfandReturn.organizationId,
        kind: 'deposit_return',
        processType: PROCESS_TYPE_RECEIPT,
        processData: kassenbelegProcessData(training ? 'AVTraining' : 'Beleg', {
          slots,
          payments: [{ type: 'Bar', cents: amountCents }],
        }),
        training,
        amountCents,
        lines: {
          pfandLines: pfandReturn.lines ?? [],
          returnNumber: pfandReturn.returnNumber ?? null,
        },
        eventId: pfandReturn.eventId,
        pfandReturnId: pfandReturn.id,
        terminal: pfandReturn.deviceId,
        userId: pfandReturn.createdByUserId,
        waiterId: pfandReturn.waiterId ?? null,
      });
    } catch (error) {
      this.logger.error(
        `TSE pfand return ${pfandReturn.id} failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Kassenbuch-Buchung (Anfangsbestand, Einlage, Entnahme, Differenz beim
   * Kassensturz) als eigener Kassenbeleg: Bargeldbewegung im 0-%-Slot,
   * Zahlung bar (DSFinV-K Anhang I, Beispiele Anfangsbestand/Geldtransit).
   */
  async signCashbook(input: {
    organizationId: string;
    entryId: string;
    cashbookType: string;
    amountCents: number;
    note?: string | null;
    terminal?: string | null;
    userId?: string | null;
    waiterId?: string | null;
  }): Promise<TseReceiptView | null> {
    try {
      if (input.amountCents === 0) return null;
      if (!(await this.isActive(input.organizationId))) return null;
      return this.sign({
        organizationId: input.organizationId,
        kind: 'cashbook',
        processType: PROCESS_TYPE_RECEIPT,
        processData: cashbookProcessData(input.amountCents),
        training: false,
        amountCents: input.amountCents,
        lines: {
          cashbookType: input.cashbookType,
          amountCents: input.amountCents,
          note: input.note ?? null,
          entryId: input.entryId,
        },
        terminal: input.terminal ?? null,
        userId: input.userId ?? null,
        waiterId: input.waiterId ?? null,
      });
    } catch (error) {
      this.logger.error(
        `TSE cashbook entry ${input.entryId} failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  // ----------------------------------------------- Bestellvorgaenge

  /**
   * Bestellung-V1 fuer jede Bestellung, die ohne sofortige Zahlung angelegt
   * wird — Tischbetrieb ebenso wie „Senden“ an der Theke (Kassiermodus
   * `tab`) oder eine Bestellung in der Verwaltung. Die Ware wird vor der
   * Zahlung zubereitet (AEAO zu § 146a Nr. 2.2.3.6.2); der Kuechenbon darf
   * erst nach diesem Vorgang entstehen („keine Kuechenbons ohne TSE-Spur“,
   * Steuerberater 2026-11-10, Frage 19). Bestellungen mit sofortiger
   * Zahlung sind ein Vorgang (nur Kassenbeleg, signiert vor dem Kuechenbon).
   * Der Beginn der ersten Bestellung steht spaeter auf dem Beleg
   * (DSFinV-K Tz. 2.7.3, `orderStartTime`).
   */
  async signOrderCreated(
    orderId: string,
    actor: TseActor,
  ): Promise<TseReceiptView | null> {
    try {
      const order = await this.orderRepository.findOne({
        where: { id: orderId },
        relations: { items: true },
      });
      if (!order || order.paymentStatus === PaymentStatus.PAID) return null;
      if (!(await this.isActive(order.organizationId))) return null;
      const lines = (order.items ?? [])
        .filter((i) => i.status !== OrderItemStatus.CANCELLED)
        .map(orderLine);
      if (lines.length === 0) return null;
      return this.signOrderLines(order, 'order', lines, actor);
    } catch (error) {
      this.logger.error(
        `TSE order ${orderId} failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Aenderung einer abgesicherten Bestellung (Positionen dazu/weg, Storno):
   * Bestellung-V1 mit den Mengenaenderungen (negativ = Storno). Nur wenn
   * die Bestellung schon als Bestellvorgang abgesichert wurde.
   */
  async signOrderChange(
    orderId: string,
    changes: Array<{
      item: Pick<OrderItem, 'productName' | 'unitPrice' | 'optionsPrice'> &
        Partial<Pick<OrderItem, 'taxRate'>>;
      quantity: number;
    }>,
    actor: TseActor,
  ): Promise<TseReceiptView | null> {
    try {
      if (changes.every((c) => c.quantity === 0)) return null;
      const order = await this.orderRepository.findOne({
        where: { id: orderId },
      });
      if (!order || !(await this.isActive(order.organizationId))) return null;
      const signedBefore = await this.txRepository.exists({
        where: { orderId, kind: 'order' },
      });
      if (!signedBefore) return null;
      const lines = changes.map((c) => ({
        ...orderLine({ ...c.item, quantity: 1 }),
        quantity: c.quantity,
      }));
      const cancellation = changes.every((c) => c.quantity < 0);
      return this.signOrderLines(
        order,
        cancellation ? 'order_cancellation' : 'order',
        lines,
        actor,
      );
    } catch (error) {
      this.logger.error(
        `TSE order change ${orderId} failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private signOrderLines(
    order: Order,
    kind: 'order' | 'order_cancellation',
    lines: (OrderLine & { taxRate?: number })[],
    actor: TseActor,
  ): Promise<TseReceiptView | null> {
    const training = order.isTest === true;
    return this.sign({
      organizationId: order.organizationId,
      kind,
      processType: PROCESS_TYPE_ORDER,
      processData: bestellungProcessData(lines),
      training,
      amountCents: lines.reduce((s, l) => s + l.quantity * l.unitCents, 0),
      lines: {
        orderNumber: order.orderNumber,
        tableNumber: order.tableNumber ?? null,
        items: lines.map((l) => ({ ...l })),
      },
      eventId: order.eventId,
      orderId: order.id,
      ...actor,
    });
  }

  // -------------------------------------------------- Abfragen

  async viewsFor(txs: TseTransaction[]): Promise<TseReceiptView[]> {
    const missing = [
      ...new Set(
        txs
          .map((t) => t.tseUnitId)
          .filter((id): id is string => !!id && !this.unitInfo.has(id)),
      ),
    ];
    if (missing.length) {
      const units = await this.unitRepository.find({
        where: { id: In(missing) },
      });
      for (const unit of units) this.rememberUnit(unit);
    }
    return txs.map((t) =>
      tseReceiptView(
        t,
        t.tseUnitId ? (this.unitInfo.get(t.tseUnitId) ?? null) : null,
      ),
    );
  }

  /** Letzter Kassenbeleg einer Zahlung (Nachdruck, digitaler Beleg). */
  async forPayment(paymentId: string): Promise<TseReceiptView | null> {
    const tx = await this.txRepository.findOne({
      where: { paymentId, kind: 'receipt' },
      order: { createdAt: 'DESC' },
    });
    if (!tx) return null;
    const [view] = await this.viewsFor([tx]);
    if (tx.orderId) view.orderStartTime = await this.orderStartTime(tx.orderId);
    return view;
  }

  /**
   * Beginn der ersten abgesicherten Bestellung (Bestellung-V1) einer
   * Bestellung — Startzeit der TSE, ersatzweise (Ausfall) die Systemzeit.
   * Steht auf dem Beleg (DSFinV-K Tz. 2.7.2/2.7.3). null ohne Bestellvorgang.
   */
  async orderStartTime(orderId: string): Promise<string | null> {
    try {
      const rows = rowsOf<{ started: Date | string | null }>(
        await this.txRepository.query(
          `SELECT min(COALESCE(start_time, created_at)) AS started
             FROM tse_transactions
            WHERE order_id = $1 AND kind = 'order'`,
          [orderId],
        ),
      );
      const started = rows[0]?.started;
      return started ? new Date(started).toISOString() : null;
    } catch (error) {
      this.logger.warn(
        `Order start lookup for ${orderId} failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async forRefund(refundId: string): Promise<TseReceiptView | null> {
    const tx = await this.txRepository.findOne({
      where: { refundId },
      order: { createdAt: 'DESC' },
    });
    return tx ? (await this.viewsFor([tx]))[0] : null;
  }

  /** Kassenbeleg einer Pfand-Auszahlung (Beleg drucken, Nachdruck). */
  async forPfandReturn(pfandReturnId: string): Promise<TseReceiptView | null> {
    const tx = await this.txRepository.findOne({
      where: { pfandReturnId },
      order: { createdAt: 'DESC' },
    });
    return tx ? (await this.viewsFor([tx]))[0] : null;
  }

  /** Alle Vorgaenge einer Bestellung (Bestellung, Belege, Gegenbelege). */
  async forOrder(
    orderId: string,
    organizationId: string,
  ): Promise<TseReceiptView[]> {
    const txs = await this.txRepository.find({
      where: { orderId, organizationId },
      order: { createdAt: 'ASC' },
    });
    return this.viewsFor(txs.filter((t) => t.kind !== 'abort'));
  }

  private async vatExempt(organizationId: string): Promise<boolean> {
    const org = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, settings: true },
    });
    return org?.settings?.vatExempt !== false;
  }
}

// ------------------------------------------------------- Hilfen (rein)

export function isTableServiceOrder(
  order: Pick<Order, 'tableId' | 'tableNumber' | 'fulfillmentType'>,
): boolean {
  return (
    !!order.tableId ||
    !!order.tableNumber ||
    order.fulfillmentType === OrderFulfillmentType.TABLE_SERVICE
  );
}

function orderLine(
  item: Pick<
    OrderItem,
    'productName' | 'unitPrice' | 'optionsPrice' | 'quantity'
  > &
    Partial<Pick<OrderItem, 'taxRate'>>,
): OrderLine & { taxRate?: number } {
  return {
    quantity: item.quantity,
    name: item.productName,
    unitCents: cents(unitGross(item)),
    // Nur fuer die DSFinV-K-Kopie (nicht Teil der Prozessdaten).
    ...(item.taxRate !== undefined ? { taxRate: Number(item.taxRate) } : {}),
  };
}

/**
 * Zusammensetzung einer Zahlung:
 * - Split an der Kasse (`metadata.splitItems`): die bezahlten Positionen,
 * - Split in der Verwaltung (`itemPayments`): die zugeordneten Betraege,
 * - sonst die Bestellung anteilig auf den Zahlbetrag skaliert.
 */
export function paymentComposition(
  order: Pick<Order, 'items' | 'discountAmount' | 'tipAmount' | 'total'>,
  payment: Pick<Payment, 'amount' | 'metadata' | 'itemPayments'>,
): Composition {
  const amountCents = cents(payment.amount);
  const items = order.items ?? [];
  const splitItems = (payment.metadata as { splitItems?: unknown } | null)
    ?.splitItems;
  if (Array.isArray(splitItems) && splitItems.length > 0) {
    const goods = new Map<number, number>();
    for (const entry of splitItems as Array<{
      orderItemId?: string;
      quantity?: number;
    }>) {
      const item = items.find((i) => i.id === entry.orderItemId);
      if (!item) continue;
      const rate = Number(item.taxRate) || 0;
      goods.set(
        rate,
        (goods.get(rate) ?? 0) +
          cents(unitGross(item)) * (Number(entry.quantity) || 0),
      );
    }
    return scaleComposition({ goods, pfand: new Map(), tip: 0 }, amountCents);
  }
  if (payment.itemPayments?.length) {
    const goods = new Map<number, number>();
    for (const ip of payment.itemPayments) {
      const rate = Number(ip.orderItem?.taxRate) || 0;
      goods.set(rate, (goods.get(rate) ?? 0) + cents(ip.amount));
    }
    return scaleComposition({ goods, pfand: new Map(), tip: 0 }, amountCents);
  }
  const whole = orderComposition(items, {
    discountAmount: Number(order.discountAmount) || 0,
    tipAmount: Number(order.tipAmount) || 0,
    total: Number(order.total) || 0,
  });
  if (cents(order.total) === amountCents) return whole;
  return scaleComposition(whole, amountCents);
}

/** Zusammensetzung (positiv) einer Erstattung. */
export function refundComposition(
  refund: Pick<
    Refund,
    'metadata' | 'taxLines' | 'amount' | 'pfandAmount' | 'tipAmount' | 'items'
  >,
): Composition {
  const raw = (refund.metadata as { composition?: unknown } | null)
    ?.composition as
    | {
        goods?: Record<string, number>;
        pfand?: number;
        pfandByRate?: Record<string, number>;
        tip?: number;
      }
    | undefined;
  if (raw && typeof raw === 'object') {
    return {
      goods: rateMapFrom(raw.goods, true),
      pfand: pfandFromRecord(raw, true),
      tip: Math.abs(Number(raw.tip) || 0),
    };
  }
  const c = emptyComposition();
  for (const item of refund.items ?? []) {
    const rate = Number(item.taxRate) || 0;
    c.goods.set(rate, (c.goods.get(rate) ?? 0) + Math.abs(cents(item.amount)));
  }
  c.pfand = pfandMap(Math.abs(cents(refund.pfandAmount ?? 0)));
  c.tip = Math.abs(cents(refund.tipAmount ?? 0));
  return c;
}

/**
 * Sorgt dafuer, dass die Summe der Slots exakt dem Zahlbetrag entspricht
 * (Rundung, fehlende Positionen): die Differenz geht an den groessten
 * Slot; sind alle Slots leer, an den 0-%-Slot.
 */
export function fitSlots(slots: VatSlots, totalCents: number): VatSlots {
  const out = [...slots] as VatSlots;
  const diff = totalCents - slotsTotal(out);
  if (diff === 0) return out;
  let target = 4;
  let biggest = 0;
  out.forEach((value, index) => {
    if (Math.abs(value) > biggest) {
      biggest = Math.abs(value);
      target = index;
    }
  });
  out[target] += diff;
  return out;
}

/**
 * Kopie der Positionen fuer die DSFinV-K (Bonpos, Bonpos_Zusatzinfo): je
 * Position Name, Menge, Stueckpreis inkl. Optionen, Satz, Pfand, Artikel,
 * Warengruppe und Optionen (Varianten).
 */
export function snapshotItems(
  items: OrderItem[] | undefined,
): Record<string, unknown>[] {
  return (items ?? [])
    .filter((i) => i.status !== OrderItemStatus.CANCELLED)
    .map((i) => ({
      id: i.id,
      name: i.productName,
      quantity: i.quantity,
      unitPrice: unitGross(i),
      taxRate: Number(i.taxRate),
      deposit: Number(i.depositAmount || 0),
      // Satz des Pfands (fehlt = nicht steuerbar, Bestand von vor 2026-11).
      ...(i.depositTaxRate != null
        ? { depositTaxRate: Number(i.depositTaxRate) }
        : {}),
      productId: i.productId ?? null,
      categoryId: i.categoryId ?? null,
      categoryName: i.categoryName ?? null,
      options: (i.options?.selected ?? []).map((o) => ({
        group: o.group,
        option: o.option,
        priceModifier: Number(o.priceModifier) || 0,
      })),
    }));
}

export function receiptLines(
  order: Pick<
    Order,
    'orderNumber' | 'items' | 'discountAmount' | 'tipAmount' | 'total'
  >,
  payment: Pick<Payment, 'paymentMethod' | 'amount' | 'metadata'>,
  composition: Composition,
): Record<string, unknown> {
  return {
    orderNumber: order.orderNumber,
    paymentMethod: payment.paymentMethod,
    amount: Number(payment.amount),
    orderTotal: Number(order.total) || 0,
    items: snapshotItems(order.items),
    discount: Number(order.discountAmount) || 0,
    tip: Number(order.tipAmount) || 0,
    composition: {
      goods: rateRecord(composition.goods),
      pfand: pfandSum(composition),
      pfandByRate: rateRecord(composition.pfand),
      tip: composition.tip,
    },
    ...(payment.metadata && 'splitItems' in payment.metadata
      ? { splitItems: payment.metadata.splitItems }
      : {}),
  };
}
