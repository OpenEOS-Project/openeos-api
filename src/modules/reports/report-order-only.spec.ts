import { orderOnlyExportRow, ReportsService } from './reports.service';

/*
 * „Nur Bestellen“: OpenEOS kassiert nicht, die Betraege der Berichte sind
 * Bestellwerte (nicht kassiert). Der Export benennt sie deshalb um.
 */
describe('reports in order-only mode', () => {
  it('renames revenue columns to orderValue and keeps counts', () => {
    expect(
      orderOnlyExportRow({
        channel: 'pos',
        orders: 4,
        revenue: 38.5,
        avgReceipt: 9.63,
      }),
    ).toEqual({
      channel: 'pos',
      orders: 4,
      orderValue: 38.5,
      averageOrderValue: 9.63,
    });
    expect(orderOnlyExportRow({ totalRevenue: 100, totalOrders: 10 })).toEqual({
      orderValue: 100,
      totalOrders: 10,
    });
  });

  it('reads the operating mode from the organization settings', async () => {
    const organizations = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce({ settings: { operatingMode: 'order_only' } })
        .mockResolvedValueOnce({ settings: {} })
        .mockResolvedValueOnce(null),
    };
    const none = undefined as never;
    const service = new ReportsService(
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      organizations as never,
    );
    await expect(service.getOperatingMode('org-1')).resolves.toBe('order_only');
    await expect(service.getOperatingMode('org-1')).resolves.toBe('pos');
    await expect(service.getOperatingMode('org-1')).resolves.toBe('pos');
  });
});
