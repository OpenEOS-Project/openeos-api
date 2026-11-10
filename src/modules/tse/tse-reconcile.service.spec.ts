import type { Repository } from 'typeorm';

import type { CronLockService } from '../../common/redis/cron-lock.service';
import type { TseTransaction } from '../../database/entities/tse-transaction.entity';
import type { TseUnit } from '../../database/entities/tse-unit.entity';
import type { SwissbitClientProvider } from './swissbit/swissbit-client.provider';
import type { TseConfig } from './tse.config';
import type { TseCryptoService } from './tse-crypto.service';
import { TseReconcileService } from './tse-reconcile.service';
import { tsePrintBlock, tseReceiptView } from './tse-view';

/**
 * Signatur nach Belegausgabe (Steuerberater 2026-11-10, Frage 16): eine
 * Signatur, die der Abgleich erst nach dem Druck findet, wird gespeichert,
 * der Vorgang bleibt aber `failed` — der Bon war ein Ausfallbeleg.
 */
describe('TseReconcileService — late signatures', () => {
  const unit = {
    id: 'unit-1',
    organizationId: 'org-1',
    clientId: 'OEOS-ABC',
    serialNumber: 'ff00',
    accessTokenEnc: 'enc',
    metadata: {},
    publicKey: 'PK',
    signatureAlgorithm: 'ecdsa-plain-SHA256',
    logTimeFormat: 'unixTime',
  } as unknown as TseUnit;

  function setup(lastTransactionNumber: number) {
    const lost = {
      id: 'tx-lost',
      tseUnitId: 'unit-1',
      kind: 'receipt',
      status: 'failed',
      training: false,
      transactionNumber: '41',
      errorCode: 'E_TIMEOUT',
      recoveredAt: null,
      abortedAt: null,
    } as unknown as TseTransaction;
    const update = jest.fn().mockResolvedValue(undefined);
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([lost]),
    };
    const txRepository = {
      query: jest.fn().mockResolvedValue([]),
      update,
      createQueryBuilder: jest.fn(() => qb),
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((v: unknown) => v),
    } as unknown as Repository<TseTransaction>;
    const unitRepository = {
      query: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<TseUnit>;
    const client = {
      listStartedTransactions: jest.fn().mockResolvedValue({ value: [] }),
      getLastTransactionResponse: jest.fn().mockResolvedValue({
        value: {
          transactionNumber: lastTransactionNumber,
          signatureCounter: 99,
          signatureValue: 'SIG==',
          signatureCreationTime: 1_793_000_000,
        },
      }),
      finishTransaction: jest.fn(),
    };
    const service = new TseReconcileService(
      txRepository,
      unitRepository,
      { enabled: true } as unknown as TseConfig,
      { client } as unknown as SwissbitClientProvider,
      { decrypt: () => 'token' } as unknown as TseCryptoService,
      {} as CronLockService,
    );
    return { service, update, lost, client };
  }

  it('stores a late signature but keeps the transaction failed (outage receipt)', async () => {
    const { service, update } = setup(41);
    await service.reconcileUnit(unit);
    expect(update).toHaveBeenCalledTimes(1);
    const [id, changes] = update.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe('tx-lost');
    expect(changes).not.toHaveProperty('status');
    expect(changes).toMatchObject({
      signatureCounter: '99',
      signatureValue: 'SIG==',
      recoveredAt: expect.any(Date) as unknown,
    });
  });

  it('ignores a last response that belongs to another transaction', async () => {
    const { service, update } = setup(42);
    await service.reconcileUnit(unit);
    expect(update).not.toHaveBeenCalled();
  });

  it('view: still an outage receipt; the late signature is only marked, never as QR', () => {
    const tx = {
      id: 'tx-lost',
      kind: 'receipt',
      status: 'failed',
      training: false,
      processType: 'Kassenbeleg-V1',
      processData: 'Beleg^4.00_0.00_0.00_0.00_0.00^4.00:Bar',
      clientId: 'OEOS-ABC',
      serialNumber: 'ff00',
      transactionNumber: '41',
      signatureCounter: '99',
      startTime: new Date('2026-11-10T18:00:00.000Z'),
      finishTime: new Date('2026-11-10T18:00:09.000Z'),
      signatureValue: 'SIG==',
      errorCode: 'E_TIMEOUT',
      recoveredAt: new Date('2026-11-10T18:05:00.000Z'),
      bonId: '17',
      createdAt: new Date('2026-11-10T18:00:00.000Z'),
    } as unknown as TseTransaction;
    const view = tseReceiptView(tx, unit);
    expect(view).toMatchObject({
      status: 'failed',
      notice: 'TSE nicht erreichbar – Beleg ohne Signatur',
      signatureValue: null,
      signatureCounter: null,
      finishTime: null,
      qrCode: null,
      lateSignature: {
        note: 'Signatur nach Belegausgabe',
        transactionNumber: 41,
        signatureCounter: 99,
        finishTime: '2026-11-10T18:00:09.000Z',
      },
    });
    // Erster Druck (Antwort an die Kasse): nichts von der spaeten Signatur.
    expect(tsePrintBlock(view)?.late_signature).toBeNull();
    // Nachdruck: Ausfallbeleg + gekennzeichneter Hinweis, ohne QR-Code.
    const reprint = tsePrintBlock(view, { reprint: true });
    expect(reprint).toMatchObject({
      failed: true,
      qr_code: null,
      signature: null,
      late_signature: {
        note: 'Signatur nach Belegausgabe',
        transaction_number: 41,
        signature_counter: 99,
      },
    });
  });
});
