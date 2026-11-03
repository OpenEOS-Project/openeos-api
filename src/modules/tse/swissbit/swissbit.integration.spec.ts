import { Logger } from '@nestjs/common';
import {
  mkdtempSync,
  openSync,
  readSync,
  closeSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { TseExport } from '../../../database/entities/tse-export.entity';
import type { TseTransaction } from '../../../database/entities/tse-transaction.entity';
import type { TseUnit } from '../../../database/entities/tse-unit.entity';
import { TseExportService } from '../tse-export.service';
import { TseSigningService } from '../tse-signing.service';
import type { SwissbitClient } from './swissbit.client';
import { SwissbitError } from './swissbit.errors';
import type { TseCredentials } from './swissbit.types';
import {
  devClient,
  ensureDevTse,
  loadDevState,
  saveDevState,
} from './testing/swissbit-dev-state';

/**
 * Gegen die echte Swissbit-Entwicklungsumgebung (https://dev.web-tse.de).
 *
 *   SWISSBIT_INTEGRATION=1 pnpm test -- swissbit.integration
 *
 * Laeuft nie in CI (ohne Variable uebersprungen). Nutzt den Zustand aus
 * ~/.config/openeos/swissbit-dev-state.json (Credit Token + gespeicherte
 * Dev-TSE) und legt hoechstens dann eine TSE an, wenn keine mehr existiert
 * (Limit: 3 insgesamt). Schreibt die Latenzen nach
 * $SWISSBIT_LATENCY_OUT (Standard /tmp/swissbit-latency.json).
 */
const enabled = process.env.SWISSBIT_INTEGRATION === '1';
const describeLive = enabled ? describe : describe.skip;

const CLIENT_ID = 'OEOS-DEVTEST01';
const ORG = '00000000-0000-4000-8000-00000000dev1';

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

function stats(values: number[]) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
    mean: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
  };
}

describeLive('Swissbit Cloud-TSE 2 (dev environment, live)', () => {
  jest.setTimeout(15 * 60_000);

  let client: SwissbitClient;
  let tse: TseCredentials;
  let unit: TseUnit;
  const rows = new Map<string, TseTransaction>();
  let signing: TseSigningService;
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const state = loadDevState();
    client = devClient(state);
    const ensured = await ensureDevTse(client, state);
    tse = ensured.tse;
    try {
      await client.registerClient(tse, CLIENT_ID);
    } catch (error) {
      if (
        !(error instanceof SwissbitError) ||
        error.errorCode !== 'E_CLIENT_ALREADY_REGISTERED'
      ) {
        throw error;
      }
    }
    if (!ensured.entry.clientIds.includes(CLIENT_ID)) {
      ensured.entry.clientIds.push(CLIENT_ID);
      saveDevState(state);
    }
    const info = (await client.info(tse)).value;
    unit = {
      id: 'dev-unit',
      organizationId: ORG,
      state: 'active',
      serialNumber: tse.serialNumber,
      accessTokenEnc: `enc:${tse.accessToken}`,
      clientId: CLIENT_ID,
      publicKey: info.publicKey,
      signatureAlgorithm: info.signatureAlgorithm,
      logTimeFormat: info.logTimeFormat,
      activatedAt: new Date(Date.now() - 3600_000),
      createdAt: new Date(Date.now() - 3600_000),
    } as unknown as TseUnit;
    results.tse = {
      serialPrefix: tse.serialNumber.slice(0, 12),
      productType: info.productType,
      signatureAlgorithm: info.signatureAlgorithm,
      logTimeFormat: info.logTimeFormat,
      maxStartedTransactions: info.maxStartedTransactions,
      maxRegisteredClients: info.maxRegisteredClients,
      certificationId: info.certificationId,
    };

    let seq = 0;
    const txRepository = {
      create: (data: Partial<TseTransaction>) =>
        ({ ...data }) as TseTransaction,
      save: (row: TseTransaction) => {
        const saved = {
          ...row,
          id: `tx-${++seq}`,
          createdAt: new Date(),
        } as TseTransaction;
        rows.set(saved.id, saved);
        return Promise.resolve(saved);
      },
      update: (id: string, patch: Partial<TseTransaction>) => {
        rows.set(id, { ...rows.get(id)!, ...patch });
        return Promise.resolve();
      },
      findOne: () =>
        Promise.resolve(
          [...rows.values()].find((r) => r.kind === 'receipt') ?? null,
        ),
      exists: () => Promise.resolve(true),
      find: () => Promise.resolve([]),
    };
    const order = {
      id: 'order-dev',
      organizationId: ORG,
      eventId: null,
      orderNumber: 'DEV-1',
      isTest: false,
      tableNumber: '7',
      fulfillmentType: 'table_service',
      discountAmount: 0,
      tipAmount: 0.5,
      total: 12.4,
      items: [
        {
          id: 'a',
          productName: 'Weizen 0,5l',
          quantity: 2,
          unitPrice: 4.5,
          optionsPrice: 0,
          totalPrice: 9,
          taxRate: 19,
          status: 'pending',
          depositAmount: 0,
        },
        {
          id: 'b',
          productName: 'Brezel',
          quantity: 1,
          unitPrice: 2.9,
          optionsPrice: 0,
          totalPrice: 2.9,
          taxRate: 7,
          status: 'pending',
          depositAmount: 0,
        },
      ],
    };
    const payment = {
      id: 'pay-dev',
      orderId: 'order-dev',
      amount: 12.4,
      paymentMethod: 'cash',
      metadata: {},
      itemPayments: [],
      processedByDeviceId: 'device-dev',
      processedByUserId: null,
    };
    signing = new TseSigningService(
      txRepository as never,
      { find: () => Promise.resolve([unit]) } as never,
      { findOne: () => Promise.resolve(payment) } as never,
      { findOne: () => Promise.resolve(order) } as never,
      {
        findOne: () =>
          Promise.resolve({ id: ORG, settings: { vatExempt: false } }),
      } as never,
      {
        get: () => Promise.resolve({ unit, credentials: tse }),
        invalidate: () => undefined,
      } as never,
      { client } as never,
      {
        recordFailure: () => Promise.resolve(),
        recordSuccess: () => Promise.resolve(),
      } as never,
      {
        settings: {
          timeouts: { transactionMs: 5000, signBudgetMs: 8000, adminMs: 15000 },
        },
      } as never,
    );
  });

  afterAll(() => {
    const out =
      process.env.SWISSBIT_LATENCY_OUT ?? '/tmp/swissbit-latency.json';
    writeFileSync(out, JSON.stringify(results, null, 2));

    console.log(JSON.stringify(results, null, 2));
    client?.destroy();
  });

  it('is registered as the single client', async () => {
    const clients = (await client.listClients(tse)).value;
    expect(clients).toContain(CLIENT_ID);
  });

  it('signs a Kassenbeleg (cash, 19 % + 7 % + tip) with a valid QR payload', async () => {
    const view = await signing.signPayment('pay-dev');
    expect(view).toMatchObject({
      status: 'signed',
      training: false,
      clientId: CLIENT_ID,
    });
    expect(view!.processData).toBe('Beleg^9.00_2.90_0.00_0.00_0.50^12.40:Bar');
    expect(view!.signatureValue).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(view!.signatureValue!, 'base64')).toHaveLength(64);
    expect(view!.qrCode!.split(';')).toHaveLength(12);
    expect(
      view!.qrCode!.startsWith(`V0;${CLIENT_ID};Kassenbeleg-V1;Beleg^`),
    ).toBe(true);
    results.receipt = {
      transactionNumber: view!.transactionNumber,
      signatureCounter: view!.signatureCounter,
      startTime: view!.startTime,
      finishTime: view!.finishTime,
    };
  });

  it('signs a training booking (AVTraining)', async () => {
    const view = await signing.sign({
      organizationId: ORG,
      kind: 'receipt',
      processType: 'Kassenbeleg-V1',
      processData: 'AVTraining^1.19_0.00_0.00_0.00_0.00^1.19:Bar',
      training: true,
      amountCents: 119,
    });
    expect(view).toMatchObject({
      status: 'training',
      training: true,
      notice: 'TRAININGSBUCHUNG – KEIN VERKAUF',
    });
  });

  it('signs a refund as negative Kassenbeleg', async () => {
    const view = await signing.signRefund({
      id: 'refund-dev',
      organizationId: ORG,
      orderId: 'order-dev',
      paymentId: 'pay-dev',
      eventId: null,
      refundNumber: 'DEV-1-E1',
      kind: 'refund',
      amount: -4.5,
      pfandAmount: 0,
      tipAmount: 0,
      paymentMethod: 'cash',
      status: 'completed',
      isTest: false,
      deviceId: 'device-dev',
      userId: null,
      items: [],
      taxLines: [],
      metadata: { composition: { goods: { '19': 450 }, pfand: 0, tip: 0 } },
    } as never);
    expect(view).toMatchObject({ status: 'signed', kind: 'refund' });
    expect(view!.processData).toBe('Beleg^-4.50_0.00_0.00_0.00_0.00^-4.50:Bar');
  });

  it('signs a table order (Bestellung-V1)', async () => {
    const view = await signing.signOrderCreated('order-dev', {
      terminal: 'device-dev',
    });
    expect(view).toMatchObject({
      status: 'signed',
      kind: 'order',
      processType: 'Bestellung-V1',
    });
  });

  it('lists no dangling transactions and returns the last response for the client', async () => {
    const started = (await client.listStartedTransactions(tse)).value;
    expect(started).toEqual([]);
    const last = (await client.getLastTransactionResponse(tse, CLIENT_ID))
      .value;
    expect(last.transactionNumber).toBeGreaterThan(0);
  });

  it('latency: 50 sequential + 20 parallel Kassenbelege on ONE client', async () => {
    const one = async () => {
      const t0 = Date.now();
      const view = await signing.sign({
        organizationId: ORG,
        kind: 'receipt',
        processType: 'Kassenbeleg-V1',
        processData: 'Beleg^3.50_0.00_0.00_0.00_0.00^3.50:Bar',
        training: false,
        amountCents: 350,
      });
      if (view?.status !== 'signed')
        throw new Error(`not signed: ${view?.errorCode}`);
      return Date.now() - t0;
    };
    const sequential: number[] = [];
    for (let i = 0; i < 50; i++) sequential.push(await one());
    const parallelStart = Date.now();
    const parallel = await Promise.all(Array.from({ length: 20 }, () => one()));
    const parallelWall = Date.now() - parallelStart;

    const callDurations = [...rows.values()]
      .filter((r) => r.durationMs)
      .map((r) => r.durationMs!);
    results.latency = {
      unit: 'ms per Kassenbeleg (startTransaction + finishTransaction, keep-alive)',
      sequential: stats(sequential),
      parallel20: { ...stats(parallel), wallClockMs: parallelWall },
      allSigned: callDurations.length,
    };
    expect(sequential).toHaveLength(50);
    expect(parallel).toHaveLength(20);
  });

  it('exports, downloads (TAR + SHA-256) and deletes the export only after storing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tse-dev-export-'));
    const exportRows = new Map<string, TseExport>();
    let seq = 0;
    const repo = {
      findOne: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          [...exportRows.values()].find((row) =>
            Object.entries(where).every(([k, v]) =>
              typeof v === 'object' && v !== null
                ? true
                : (row as never)[k] === v,
            ),
          ) ?? null,
        ),
      create: (data: Partial<TseExport>) => ({ ...data }),
      save: (data: TseExport) => {
        const row = {
          ...data,
          id: `e${++seq}`,
          createdAt: new Date(),
        } as TseExport;
        exportRows.set(row.id, row);
        return Promise.resolve(row);
      },
      update: (id: string, patch: Partial<TseExport>) => {
        exportRows.set(id, { ...exportRows.get(id)!, ...patch });
        return Promise.resolve();
      },
    };
    const exportsService = new TseExportService(
      repo as never,
      {} as never,
      { enabled: true, settings: { exportDir: dir } } as never,
      { client } as never,
      { decrypt: (s: string) => s.replace(/^enc:/, '') } as never,
      {} as never,
      { notifyAdmins: () => Promise.resolve() } as never,
      {} as never,
    );
    try {
      const t0 = Date.now();
      // Erst offene (auch automatische) Exporte abholen, dann einen neuen.
      await exportsService.collect(unit, {
        startNew: false,
        trigger: 'scheduled',
      });
      await exportsService.collect(unit, {
        startNew: true,
        trigger: 'manual',
        waitMs: 10 * 60_000,
      });
      const downloaded = [...exportRows.values()].filter(
        (r) => r.status === 'downloaded',
      );
      expect(downloaded.length).toBeGreaterThan(0);
      for (const row of downloaded) {
        expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(row.remoteDeletedAt).toBeInstanceOf(Date);
        const fd = openSync(join(dir, row.filePath!), 'r');
        const buffer = Buffer.alloc(5);
        readSync(fd, buffer, 0, 5, 257);
        closeSync(fd);
        expect(buffer.toString('ascii')).toBe('ustar');
      }
      const remaining = (await client.listExports(tse)).value;
      expect(remaining.filter((e) => e.status === 'success')).toEqual([]);
      results.export = {
        downloaded: downloaded.map((r) => ({
          sizeBytes: Number(r.sizeBytes),
          filename: r.filename,
          trigger: r.trigger,
        })),
        totalMs: Date.now() - t0,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports storage and monthly signatures in the TSE status', async () => {
    const info = (await client.info(tse)).value;
    expect(info.storageUsed).not.toBeNull();
    expect(info.productTypeUsage?.signaturesCurrentMonth).toBeGreaterThan(0);
    results.statusAfter = {
      storageUsed: info.storageUsed,
      storageCapacity: info.storageCapacity,
      signaturesThisMonth: info.productTypeUsage?.signaturesCurrentMonth,
      numStartedTransactions: info.numStartedTransactions,
    };
  });
});
