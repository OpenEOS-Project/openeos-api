import { OrdersService } from './orders.service';
import { QueryOrdersDto } from './dto/query-orders.dto';

/**
 * Das Dashboard fragt die Bestellungen von "heute" mit
 * dateFrom = dateTo = 'YYYY-MM-DD' ab. Der rohe String landete als
 * Untergrenze in der Abfrage und wurde dort als Mitternacht UTC gelesen —
 * in Berlin 02:00 Uhr. Bestellungen zwischen Mitternacht und 2 Uhr
 * fehlten. Jetzt ist die Untergrenze der lokale Tagesbeginn.
 */
describe('OrdersService date filter', () => {
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
    expect(params.dateFrom).toEqual(new Date(2026, 8, 12, 0, 0, 0, 0));
    expect(params.dateTo).toEqual(new Date(2026, 8, 12, 23, 59, 59, 999));
  });

  it('includes an order placed at 00:30 local time', () => {
    const params = capture({ dateFrom: '2026-09-12', dateTo: '2026-09-12' });
    const placedAt = new Date(2026, 8, 12, 0, 30);
    expect(placedAt >= (params.dateFrom as Date)).toBe(true);
    expect(placedAt <= (params.dateTo as Date)).toBe(true);
  });
});
