import { countsOnly, ReportsService } from './reports.service';

/*
 * Betriebsart „Nur Bons“ (orders_only): OpenEOS kassiert nicht und zeigt
 * keine Preise. Der Export enthaelt deshalb nur Mengen.
 */
describe('reports in operating mode orders_only', () => {
  it('drops every money column, keeps counts and labels', () => {
    expect(
      countsOnly([
        {
          channel: 'pos',
          orders: 4,
          revenue: 38.5,
          avgReceipt: 9.63,
        },
      ]),
    ).toEqual([{ channel: 'pos', orders: 4 }]);
    expect(
      countsOnly({
        totalRevenue: 100,
        totalOrders: 10,
        totalItemsSold: 30,
        averageOrderValue: 10,
        pfandCollected: 4,
        pfandReturned: 2,
        pfandBalance: 2,
        tips: 1,
        cancelledOrders: 1,
        cancellationRate: 9.09,
      }),
    ).toEqual({
      totalOrders: 10,
      totalItemsSold: 30,
      cancelledOrders: 1,
      cancellationRate: 9.09,
    });
    expect(
      countsOnly([
        {
          productName: 'Bier',
          quantitySold: 20,
          revenue: 90,
          averagePrice: 4.5,
        },
      ]),
    ).toEqual([{ productName: 'Bier', quantitySold: 20 }]);
  });

  it('reads the operating mode from the organization columns', async () => {
    const organizations = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce({ operatingMode: 'orders_only' })
        .mockResolvedValueOnce({ operatingMode: 'cashless' })
        .mockResolvedValueOnce({})
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
    await expect(service.getOperatingMode('org-1')).resolves.toBe(
      'orders_only',
    );
    await expect(service.getOperatingMode('org-1')).resolves.toBe('cashless');
    await expect(service.getOperatingMode('org-1')).resolves.toBe('full');
    await expect(service.getOperatingMode('org-1')).resolves.toBe('full');
    const [query] = organizations.findOne.mock.calls[0] as [
      { select: Record<string, boolean> },
    ];
    expect(query.select.operatingMode).toBe(true);
  });
});
