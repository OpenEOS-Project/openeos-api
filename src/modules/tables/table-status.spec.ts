import { DataSource } from 'typeorm';
import { GatewayService } from '../gateway/gateway.service';
import {
  TABLE_STATUS_SQL,
  TableStatusOrderRow,
  aggregateTableStatus,
} from './table-status';
import { TablesService } from './tables.service';

let seq = 0;
function row(
  overrides: Partial<TableStatusOrderRow> = {},
): TableStatusOrderRow {
  seq += 1;
  return {
    id: `o${seq}`,
    tableNumber: '12',
    status: 'open',
    paymentStatus: 'unpaid',
    source: 'pos',
    fulfillmentType: 'table_service',
    acknowledgedAt: null,
    createdAt: '2026-10-06T18:00:00.000Z',
    updatedAt: '2026-10-06T18:00:00.000Z',
    total: '10.00',
    paidAmount: '0.00',
    itemCount: '2',
    readySince: null,
    lastItemAt: null,
    matchedTableId: null,
    matchedLabel: null,
    matchedAreaId: null,
    ...overrides,
  };
}

describe('aggregateTableStatus', () => {
  it('marks a table with unpaid orders as busy and sums the open amount', () => {
    const [entry, ...rest] = aggregateTableStatus([
      row({ id: 'a', total: '12.50', paidAmount: '0' }),
      row({
        id: 'b',
        paymentStatus: 'partly_paid',
        status: 'in_progress',
        total: '20.00',
        paidAmount: '7.50',
        itemCount: '3',
        updatedAt: '2026-10-06T18:30:00.000Z',
      }),
    ]);

    expect(rest).toHaveLength(0);
    expect(entry).toEqual({
      key: '12',
      tableId: null,
      label: '12',
      areaId: null,
      status: 'busy',
      openAmount: 25,
      itemCount: 5,
      orderIds: ['a', 'b'],
      waitingSince: null,
      lastActivityAt: '2026-10-06T18:30:00.000Z',
    });
  });

  it('counts unpaid orders whose items were all served (status ready) as busy', () => {
    const [entry] = aggregateTableStatus([row({ status: 'ready' })]);
    expect(entry.status).toBe('busy');
  });

  it('leaves out tables whose orders are paid, completed or cancelled (free)', () => {
    expect(
      aggregateTableStatus([
        row({ paymentStatus: 'paid', status: 'completed' }),
        row({ paymentStatus: 'paid', status: 'open', source: 'pos' }),
        row({ status: 'cancelled' }),
        row({ paymentStatus: 'unpaid', status: 'completed' }),
      ]),
    ).toEqual([]);
  });

  it('marks an unacknowledged guest order as waiting, even when paid', () => {
    const [entry] = aggregateTableStatus([
      row({
        source: 'online',
        paymentStatus: 'paid',
        paidAmount: '10.00',
        createdAt: '2026-10-06T18:05:00.000Z',
      }),
    ]);
    expect(entry).toMatchObject({
      status: 'wait',
      openAmount: 0,
      waitingSince: '2026-10-06T18:05:00.000Z',
    });
  });

  it('stops waiting once the guest order is acknowledged', () => {
    expect(
      aggregateTableStatus([
        row({
          source: 'qr_order',
          paymentStatus: 'paid',
          acknowledgedAt: '2026-10-06T18:06:00.000Z',
        }),
      ]),
    ).toEqual([]);
  });

  it('marks a table with a ready item in a table-service order as waiting', () => {
    const [entry] = aggregateTableStatus([
      row({
        paymentStatus: 'paid',
        status: 'in_progress',
        readySince: '2026-10-06T18:20:00.000Z',
      }),
    ]);
    expect(entry).toMatchObject({
      status: 'wait',
      waitingSince: '2026-10-06T18:20:00.000Z',
    });
  });

  it('ignores ready items of counter pickup orders', () => {
    expect(
      aggregateTableStatus([
        row({
          paymentStatus: 'paid',
          fulfillmentType: 'counter_pickup',
          readySince: '2026-10-06T18:20:00.000Z',
        }),
      ]),
    ).toEqual([]);
  });

  it('gives wait priority over busy and takes the earliest waiting time', () => {
    const [entry] = aggregateTableStatus([
      row({ id: 'busy' }),
      row({
        id: 'ready',
        paymentStatus: 'paid',
        readySince: '2026-10-06T18:40:00.000Z',
      }),
      row({
        id: 'guest',
        source: 'online',
        paymentStatus: 'paid',
        createdAt: '2026-10-06T18:10:00.000Z',
      }),
    ]);
    expect(entry).toMatchObject({
      status: 'wait',
      openAmount: 10,
      orderIds: ['busy', 'ready', 'guest'],
      waitingSince: '2026-10-06T18:10:00.000Z',
    });
  });

  it('groups by upper(trim(table number)) and uses the matched table', () => {
    const entries = aggregateTableStatus([
      row({ id: 'legacy', tableNumber: ' a03 ' }),
      row({
        id: 'linked',
        tableNumber: 'A03',
        matchedTableId: 't3',
        matchedLabel: 'A03',
        matchedAreaId: 'area',
      }),
      row({ id: 'other', tableNumber: '7' }),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.key === 'A03')).toMatchObject({
      tableId: 't3',
      label: 'A03',
      areaId: 'area',
      orderIds: ['legacy', 'linked'],
    });
  });

  it('sorts waiting tables first (oldest first), then by last activity', () => {
    const entries = aggregateTableStatus([
      row({ tableNumber: '1', updatedAt: '2026-10-06T18:01:00.000Z' }),
      row({ tableNumber: '2', updatedAt: '2026-10-06T18:09:00.000Z' }),
      row({
        tableNumber: '3',
        source: 'online',
        createdAt: '2026-10-06T18:30:00.000Z',
      }),
      row({
        tableNumber: '4',
        source: 'online',
        createdAt: '2026-10-06T18:20:00.000Z',
      }),
    ]);
    expect(entries.map((e) => e.key)).toEqual(['4', '3', '2', '1']);
  });
});

describe('TablesService.getStatus', () => {
  it('runs one query for organization and event and aggregates it', async () => {
    const query = jest.fn().mockResolvedValue([row({ id: 'x' })]);
    const service = new TablesService(
      { query } as unknown as DataSource,
      {} as GatewayService,
    );

    const result = await service.getStatus('org', 'event');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(TABLE_STATUS_SQL, ['org', 'event']);
    expect(result).toEqual([
      expect.objectContaining({ key: '12', status: 'busy' }),
    ]);
  });
});
