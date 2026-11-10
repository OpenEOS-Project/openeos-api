import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CronLockService } from '../../common/redis/cron-lock.service';
import { TseTransaction } from '../../database/entities/tse-transaction.entity';
import { TseUnit } from '../../database/entities/tse-unit.entity';
import { errorCodeOf, errorMessageOf } from './swissbit/swissbit.errors';
import { SwissbitClientProvider } from './swissbit/swissbit-client.provider';
import type { TseCredentials } from './swissbit/swissbit.types';
import { TseConfig } from './tse.config';
import { TseCryptoService } from './tse-crypto.service';
import { PROCESS_TYPE_RECEIPT, abortProcessData } from './tse-process-data';
import { rowsOf } from './tse-sql.util';

/** Ein Vorgang gilt als abgebrochen, wenn er so lange `pending` ist. */
const PENDING_STALE_MS = 2 * 60_000;

interface StartedSnapshot {
  numbers: number[];
  at: string;
}

/**
 * Abgleich und Lebenszyklus im Hintergrund:
 *
 * 1. `pending`-Vorgaenge aelter als 2 Minuten (Prozess abgebrochen) →
 *    `failed` (`E_INTERRUPTED`); der Bon trug ohnehin keine Signatur.
 * 2. Haengende Transaktionen auf der TSE (gestartet, nie beendet — z. B.
 *    `finishTransaction` lief in ein Zeitlimit): wer in zwei Laeufen
 *    hintereinander in `listTransactions` steht, wird mit
 *    `AVBelegabbruch` geschlossen (eigener Vorgang `abort`). **Kein
 *    Nachsignieren** der Verkaufsdaten.
 * 3. Verlorene Antworten: ist ein `failed`-Vorgang mit bekannter
 *    Transaktionsnummer nicht mehr offen, fragt der Abgleich
 *    `getLastTransactionResponse` (teuer, hoechstens einmal je TSE und
 *    Lauf) und speichert die Signatur, wenn die Nummer passt
 *    (`recovered_at`). Der Vorgang **bleibt `failed`**: der Bon wurde ohne
 *    Signatur ausgegeben und bleibt ein Ausfallbeleg (AEAO zu § 146a Nr.
 *    2.2.3.3, 2.5.2). DSFinV-K: Signatur in `TSE_Transaktionen` mit
 *    `TSE_TA_FEHLER` „Signatur nach Belegausgabe“ (Steuerberater 2026-11-10,
 *    Frage 16).
 * 4. Offene Ausfaelle schliessen, wenn die TSE danach wieder signiert hat
 *    (Ausfaelle, die eine andere Instanz geoeffnet hat).
 *
 * Der Lebenszyklus `monthly` (Abmeldung zum Monatsende) steht in
 * TseMonthlyCycleService.
 */
@Injectable()
export class TseReconcileService {
  private readonly logger = new Logger(TseReconcileService.name);

  constructor(
    @InjectRepository(TseTransaction)
    private readonly txRepository: Repository<TseTransaction>,
    @InjectRepository(TseUnit)
    private readonly unitRepository: Repository<TseUnit>,
    private readonly config: TseConfig,
    private readonly swissbit: SwissbitClientProvider,
    private readonly crypto: TseCryptoService,
    private readonly cronLock: CronLockService,
  ) {}

  @Cron('0 */5 * * * *', { name: 'tse-reconcile' })
  async reconcileJob(): Promise<void> {
    if (!this.config.enabled) return;
    await this.cronLock.runExclusive('tse-reconcile', () => this.reconcile());
  }

  async reconcile(now = new Date()): Promise<void> {
    await this.markInterrupted(now);
    const units = await this.unitRepository
      .createQueryBuilder('unit')
      .addSelect('unit.accessTokenEnc')
      .where(`unit.state = 'active'`)
      .andWhere(
        `EXISTS (SELECT 1 FROM tse_transactions t
                  WHERE t.tse_unit_id = unit.id
                    AND t.created_at > now() - interval '2 days')`,
      )
      .getMany();
    for (const unit of units) {
      try {
        await this.reconcileUnit(unit, now);
      } catch (error) {
        this.logger.warn(
          `Reconcile of TSE unit ${unit.id} failed: ${errorCodeOf(error)} ${errorMessageOf(error, 200)}`,
        );
      }
    }
    await this.closeRecoveredOutages();
  }

  private async markInterrupted(now: Date): Promise<void> {
    const rows = rowsOf<{ id: string }>(
      await this.txRepository.query(
        `UPDATE tse_transactions
            SET status = 'failed', error_code = 'E_INTERRUPTED',
                error_message = 'signing was interrupted (process restart)',
                updated_at = now()
          WHERE status = 'pending' AND created_at < $1
          RETURNING id`,
        [new Date(now.getTime() - PENDING_STALE_MS)],
      ),
    );
    if (rows.length)
      this.logger.warn(
        `${rows.length} interrupted TSE transactions marked failed`,
      );
  }

  async reconcileUnit(unit: TseUnit, now = new Date()): Promise<void> {
    if (!unit.serialNumber || !unit.accessTokenEnc) return;
    const credentials: TseCredentials = {
      serialNumber: unit.serialNumber,
      accessToken: this.crypto.decrypt(unit.accessTokenEnc),
    };
    const client = this.swissbit.client;
    const started = (await client.listStartedTransactions(credentials)).value;

    // In-flight: Vorgaenge, die gerade signiert werden, nie anfassen.
    const inFlight = new Set(
      rowsOf<{ transaction_number: string }>(
        await this.txRepository.query(
          `SELECT transaction_number FROM tse_transactions
            WHERE tse_unit_id = $1 AND status = 'pending'
              AND transaction_number IS NOT NULL`,
          [unit.id],
        ),
      ).map((r) => Number(r.transaction_number)),
    );

    const previous = (unit.metadata?.startedSnapshot ??
      null) as StartedSnapshot | null;
    const seenBefore = new Set(previous?.numbers ?? []);
    const dangling = started.filter(
      (n) => seenBefore.has(n) && !inFlight.has(n),
    );

    for (const number of dangling) {
      await this.abortDangling(unit, credentials, number);
    }

    const snapshot: StartedSnapshot = {
      numbers: started.filter((n) => !dangling.includes(n)),
      at: now.toISOString(),
    };
    await this.unitRepository.query(
      `UPDATE tse_units
          SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{startedSnapshot}', $2::jsonb, true)
        WHERE id = $1`,
      [unit.id, JSON.stringify(snapshot)],
    );

    await this.recoverLostResponses(unit, credentials, new Set(started));
  }

  private async abortDangling(
    unit: TseUnit,
    credentials: TseCredentials,
    transactionNumber: number,
  ): Promise<void> {
    const processData = abortProcessData();
    const original = await this.txRepository.findOne({
      where: {
        tseUnitId: unit.id,
        transactionNumber: String(transactionNumber),
      },
      order: { createdAt: 'DESC' },
    });
    try {
      const res = await this.swissbit.client.finishTransaction(
        credentials,
        transactionNumber,
        {
          clientId: unit.clientId,
          processType: PROCESS_TYPE_RECEIPT,
          processData,
        },
      );
      await this.txRepository.save(
        this.txRepository.create({
          organizationId: unit.organizationId,
          tseUnitId: unit.id,
          eventId: original?.eventId ?? null,
          kind: 'abort',
          processType: PROCESS_TYPE_RECEIPT,
          processData,
          training: false,
          status: 'signed',
          clientId: unit.clientId,
          serialNumber: unit.serialNumber,
          transactionNumber: String(res.value.transactionNumber),
          signatureCounter: String(res.value.signatureCounter),
          signatureValue: res.value.signatureValue,
          finishTime: new Date(res.value.signatureCreationTime * 1000),
          amount: '0.00',
          finishRequestId: res.requestId,
          orderId: original?.orderId ?? null,
          paymentId: original?.paymentId ?? null,
          refundId: original?.refundId ?? null,
          pfandReturnId: original?.pfandReturnId ?? null,
          referencesTseTransactionId: original?.id ?? null,
          lines: { reason: 'dangling transaction closed (AVBelegabbruch)' },
        }),
      );
      if (original) {
        await this.txRepository.update(original.id, { abortedAt: new Date() });
      }
      this.logger.warn(
        `Dangling TSE transaction ${transactionNumber} of unit ${unit.id} closed with AVBelegabbruch`,
      );
    } catch (error) {
      this.logger.warn(
        `Closing dangling TSE transaction ${transactionNumber} failed: ${errorCodeOf(error)}`,
      );
    }
  }

  private async recoverLostResponses(
    unit: TseUnit,
    credentials: TseCredentials,
    stillStarted: Set<number>,
  ): Promise<void> {
    const candidates = await this.txRepository
      .createQueryBuilder('tx')
      .where('tx.tseUnitId = :unitId', { unitId: unit.id })
      .andWhere(`tx.status = 'failed'`)
      .andWhere('tx.transactionNumber IS NOT NULL')
      .andWhere('tx.recoveredAt IS NULL')
      .andWhere('tx.abortedAt IS NULL')
      .andWhere(`tx.errorCode IN ('E_TIMEOUT', 'E_NETWORK')`)
      .andWhere(`tx.createdAt > now() - interval '1 day'`)
      .orderBy('tx.createdAt', 'DESC')
      .getMany();
    const open = candidates.filter(
      (t) => !stillStarted.has(Number(t.transactionNumber)),
    );
    if (open.length === 0) return;
    try {
      const last = (
        await this.swissbit.client.getLastTransactionResponse(
          credentials,
          unit.clientId,
        )
      ).value;
      const match = open.find(
        (t) => Number(t.transactionNumber) === last.transactionNumber,
      );
      if (!match) return;
      // Status bleibt `failed` (Ausfallbeleg) — nur die Signatur wird
      // nachgetragen, gekennzeichnet als „Signatur nach Belegausgabe“.
      await this.txRepository.update(match.id, {
        signatureCounter: String(last.signatureCounter),
        signatureValue: last.signatureValue,
        finishTime: new Date(last.signatureCreationTime * 1000),
        recoveredAt: new Date(),
      });
      this.logger.log(
        `Late TSE signature stored for transaction ${match.id} (receipt stays an outage receipt)`,
      );
    } catch (error) {
      this.logger.debug(`getLastTransactionResponse: ${errorCodeOf(error)}`);
    }
  }

  /** Ausfaelle schliessen, wenn danach wieder erfolgreich signiert wurde. */
  private async closeRecoveredOutages(): Promise<void> {
    await this.txRepository.query(
      `UPDATE tse_outages o
          SET ended_at = s.first_ok, updated_at = now()
         FROM (
           SELECT o2.id, min(t.created_at) AS first_ok
             FROM tse_outages o2
             JOIN tse_transactions t
               ON t.tse_unit_id = o2.tse_unit_id
              AND t.status IN ('signed', 'training')
              AND t.created_at > o2.updated_at
            WHERE o2.ended_at IS NULL
            GROUP BY o2.id
         ) s
        WHERE o.id = s.id`,
    );
  }
}
