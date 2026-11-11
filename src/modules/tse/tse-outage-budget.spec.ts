import { Logger } from '@nestjs/common';

import { OrderItemStatus } from '../../database/entities/order-item.entity';
import type { TseTransaction } from '../../database/entities/tse-transaction.entity';
import { kitchenTseMarks } from '../print-jobs/order-print.service';
import { SwissbitTimeoutError } from './swissbit/swissbit.errors';
import { TseOutageService } from './tse-outage.service';
import { TseSigningService } from './tse-signing.service';

/*
 * Waehrend eines offenen TSE-Ausfalls wartete jeder Kuechenbon das volle
 * Signaturbudget (8 s), bevor er mit Ausfallvermerk kam. Jetzt bekommt das
 * Absichern einer Bestellung vor dem Kuechenbon bei offenem Ausfall nur das
 * kurze Budget (Standard 1,5 s); Kassenbelege behalten das volle Budget —
 * ihre erste erfolgreiche Signatur schliesst den Ausfall, danach gilt fuer
 * Bestellungen wieder das volle Budget.
 */

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a99';
const UNIT = {
  id: 'unit-1',
  organizationId: ORG,
  state: 'active',
  serialNumber:
    'd7201aa6d1ba08c78bbc7d10f9eba5bb0199698092045b10ff72ca3d5dafe6c7',
  clientId: 'OEOS-7D0C7A524F43',
  publicKey: 'BHhWOeis=',
  signatureAlgorithm: 'ecdsa-plain-SHA256',
  logTimeFormat: 'unixTime',
};

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

const theOrder = {
  id: 'order-1',
  organizationId: ORG,
  eventId: 'event-1',
  orderNumber: 'A-1',
  isTest: false,
  tableNumber: '4',
  paymentStatus: 'unpaid',
  discountAmount: 0,
  tipAmount: 0,
  total: 9,
  items: [
    {
      id: 'i1',
      productName: 'Bier',
      quantity: 2,
      unitPrice: 4.5,
      optionsPrice: 0,
      totalPrice: 9,
      taxRate: 19,
      status: OrderItemStatus.PENDING,
      depositAmount: 0,
    },
  ],
};

/** Ausfallprotokoll wie in Postgres: hoechstens ein offener Ausfall je TSE. */
function outageRepository() {
  let open = false;
  return {
    get open() {
      return open;
    },
    query: jest.fn((sql: string) => {
      if (sql.includes('INSERT INTO tse_outages')) {
        const opened = !open;
        open = true;
        return Promise.resolve([
          { id: 'outage-1', opened, notified_at: new Date() },
        ]);
      }
      if (sql.includes('UPDATE tse_outages SET ended_at')) {
        const closed = open ? [{ id: 'outage-1' }] : [];
        open = false;
        return Promise.resolve(closed);
      }
      return Promise.resolve([]);
    }),
    exists: jest.fn(() => Promise.resolve(open)),
  };
}

function setup(options: { swissbitDown: () => boolean }) {
  const repo = outageRepository();
  const outages = new TseOutageService(
    repo as never,
    {
      statusChanged: jest.fn(),
      notifyAdmins: jest.fn(),
    } as never,
  );
  let n = 0;
  const txRepository = {
    create: jest.fn((d: Partial<TseTransaction>) => ({ ...d })),
    save: jest.fn((row: TseTransaction) =>
      Promise.resolve({ ...row, id: row.id ?? `tx-${++n}` }),
    ),
    query: jest.fn(() => Promise.resolve([])),
    exists: jest.fn(() => Promise.resolve(false)),
    find: jest.fn(() => Promise.resolve([])),
    manager: { query: jest.fn(() => Promise.resolve([])) },
  };
  /** Zeitlimit, mit dem start/finish aufgerufen wurden. */
  const timeouts: number[] = [];
  const response = () => ({
    value: {
      transactionNumber: 17,
      signatureCreationTime: 1793716174,
      signatureCounter: 40,
      signatureValue: 'sig',
    },
    requestId: 'req',
    durationMs: 5,
  });
  const call = (_c: unknown, _r: unknown, timeoutMs: number) => {
    timeouts.push(timeoutMs);
    if (options.swissbitDown()) {
      // Wie ein Swissbit, der nicht antwortet: Zeitlimit des Aufrufs.
      return Promise.reject(
        new SwissbitTimeoutError({
          operation: 'startTransaction',
          status: null,
          errorCode: 'E_TIMEOUT',
          message: `timeout after ${timeoutMs} ms`,
          requestId: 'req-x',
        }),
      );
    }
    return Promise.resolve(response());
  };
  const client = {
    startTransaction: jest.fn(call),
    finishTransaction: jest.fn(
      (_c: unknown, _n: number, _r: unknown, t: number) => call(_c, _r, t),
    ),
  };
  const payment = {
    id: 'pay-1',
    orderId: 'order-1',
    amount: 9,
    paymentMethod: 'card',
    metadata: {},
    itemPayments: [],
  };
  const service = new TseSigningService(
    txRepository as never,
    { find: jest.fn(() => Promise.resolve([UNIT])) } as never,
    { findOne: jest.fn(() => Promise.resolve(payment)) } as never,
    { findOne: jest.fn(() => Promise.resolve(theOrder)) } as never,
    {
      findOne: jest.fn(() =>
        Promise.resolve({ id: ORG, settings: { vatExempt: false } }),
      ),
    } as never,
    {
      get: jest.fn(() =>
        Promise.resolve({
          unit: UNIT,
          credentials: { serialNumber: UNIT.serialNumber, accessToken: 't' },
        }),
      ),
      invalidate: jest.fn(),
    } as never,
    { client } as never,
    outages,
    {
      settings: {
        timeouts: {
          transactionMs: 5000,
          signBudgetMs: 8000,
          adminMs: 15000,
          outageOrderBudgetMs: 1500,
        },
      },
    } as never,
  );
  return { service, outages, repo, timeouts };
}

/** recordFailure/recordSuccess laufen im Hintergrund (void). */
const settle = () => new Promise((r) => setImmediate(r));

describe('TSE outage: short budget for securing orders before kitchen tickets', () => {
  it('no outage: orders get the full budget', async () => {
    const { service, timeouts } = setup({ swissbitDown: () => false });

    const view = await service.signOrderCreated('order-1', {});

    expect(view?.status).toBe('signed');
    // start: min(Aufruf-Zeitlimit 5000, Budget 8000).
    expect(timeouts[0]).toBe(5000);
  });

  it('open outage: the order is secured with the short budget, kitchen ticket gets the outage mark', async () => {
    let down = true;
    const { service, outages, timeouts } = setup({ swissbitDown: () => down });

    // Erster Fehlschlag (z. B. ein Kassenbeleg) oeffnet den Ausfall.
    await service.signPayment('pay-1');
    await settle();
    expect(await outages.isOpen('unit-1')).toBe(true);

    timeouts.length = 0;
    const view = await service.signOrderCreated('order-1', {});

    expect(timeouts[0]).toBe(1500);
    expect(view?.status).toBe('failed');
    expect(kitchenTseMarks(view)).toEqual({ tse_outage: true });
    down = false;
  });

  it('payments keep the full budget during an outage, and their success brings orders back to normal', async () => {
    let down = true;
    const { service, outages, timeouts, repo } = setup({
      swissbitDown: () => down,
    });
    await service.signOrderCreated('order-1', {});
    await settle();
    expect(repo.open).toBe(true);

    // Kassenbeleg waehrend des Ausfalls: volles Budget (5000 je Aufruf).
    timeouts.length = 0;
    await service.signPayment('pay-1');
    expect(timeouts[0]).toBe(5000);

    // Die TSE ist zurueck: die erste erfolgreiche Signatur schliesst den
    // Ausfall …
    down = false;
    timeouts.length = 0;
    const receipt = await service.signPayment('pay-1');
    await settle();
    expect(receipt?.status).toBe('signed');
    expect(repo.open).toBe(false);
    expect(await outages.isOpen('unit-1')).toBe(false);

    // … und Bestellungen haben wieder das volle Budget.
    timeouts.length = 0;
    const order = await service.signOrderCreated('order-1', {});
    expect(order?.status).toBe('signed');
    expect(timeouts[0]).toBe(5000);
    expect(kitchenTseMarks(order)).toEqual({});
  });

  it('outage opened by another instance is seen within a few seconds (cached lookup)', async () => {
    const { outages, repo } = setup({ swissbitDown: () => false });
    expect(await outages.isOpen('unit-1')).toBe(false);
    // Eine andere Instanz oeffnet den Ausfall in der Datenbank.
    await repo.query('INSERT INTO tse_outages ...');
    // Innerhalb der Cache-Zeit noch der alte Stand, danach der neue.
    expect(await outages.isOpen('unit-1')).toBe(false);
    const later = Date.now() + 10_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(later);
    expect(await outages.isOpen('unit-1')).toBe(true);
    clock.mockRestore();
  });

  it('kitchen marks: only for an unsigned order, nothing without TSE', () => {
    expect(kitchenTseMarks(null)).toEqual({});
    expect(kitchenTseMarks({ status: 'signed' } as never)).toEqual({});
    expect(kitchenTseMarks({ status: 'training' } as never)).toEqual({});
    expect(kitchenTseMarks({ status: 'failed' } as never)).toEqual({
      tse_outage: true,
    });
  });
});
