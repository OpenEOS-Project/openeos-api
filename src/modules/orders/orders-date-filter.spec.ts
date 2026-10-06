import { OrdersService } from './orders.service';
import { QueryOrdersDto } from './dto/query-orders.dto';

/**
 * Das Dashboard fragt die Bestellungen von "heute" mit
 * dateFrom = dateTo = 'YYYY-MM-DD' ab. Der rohe String landete als
 * Untergrenze in der Abfrage und wurde dort als Mitternacht UTC gelesen —
 * in Berlin 02:00 Uhr. Bestellungen zwischen Mitternacht und 2 Uhr
 * fehlten.
 */
describe('OrdersService date filter', () => {
  const previousTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Europe/Berlin';
  });
  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  function capture(query: Partial<QueryOrdersDto>) {
    const params: Record<string, unknown> = {};
    const qb = {
      andWhere: (_sql: string, p?: Record<string, unknown>) => {
        Object.assign(params, p);
        return qb;
      },
    };
    const service = Object.create(OrdersService.prototype) as {
      applyOrderFilters: (qb: unknown, alias: string, q: unknown) => void;
    };
    service.applyOrderFilters(qb, 'ord', query);
    return params;
  }

  it('turns a plain day into local start and end of day', () => {
    const params = capture({ dateFrom: '2026-09-12', dateTo: '2026-09-12' });
    expect((params.dateFrom as Date).toISOString()).toBe(
      '2026-09-11T22:00:00.000Z',
    );
    expect((params.dateTo as Date).toISOString()).toBe(
      '2026-09-12T21:59:59.999Z',
    );
  });

  it('includes an order placed at 00:30 local time', () => {
    const params = capture({ dateFrom: '2026-09-12', dateTo: '2026-09-12' });
    const placedAt = new Date('2026-09-11T22:30:00.000Z'); // 00:30 in Berlin
    expect(placedAt >= (params.dateFrom as Date)).toBe(true);
    expect(placedAt <= (params.dateTo as Date)).toBe(true);
  });
});
