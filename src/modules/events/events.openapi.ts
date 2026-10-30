import { paginatedResponse } from '../../common/openapi/responses';

/** Beispiel einer Veranstaltung, wie `GET …/events` sie liefert. */
export const EVENT_EXAMPLE = {
  id: '2f6c1a9e-5b1d-4c7e-9a3f-0d8e7b6a5c41',
  organizationId: '8c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
  copiedFromEventId: null,
  name: 'Sommerfest 2026',
  description: 'Festwochenende am Sportplatz',
  startDate: '2026-07-10T16:00:00.000Z',
  endDate: '2026-07-12T22:00:00.000Z',
  status: 'active',
  settings: {
    orderNumberPrefix: 'SF',
    orderingMode: 'immediate',
    enableOnlineOrdering: false,
    enableTableService: true,
    enableTakeaway: true,
  },
  billingStatus: 'paid',
  paidAt: '2026-06-01T09:12:44.000Z',
  priceCharged: 29,
  billedDays: 3,
  invoiceStatus: null,
  invoiceDueAt: null,
  invoicePaidAt: null,
  invoiceHostedUrl: null,
  invoicePdfUrl: null,
  unlockedStartDate: '2026-07-10T00:00:00.000Z',
  createdAt: '2026-05-20T18:30:12.000Z',
  updatedAt: '2026-07-10T15:58:03.000Z',
};

export const EVENTS_LIST_RESPONSE = paginatedResponse(
  'Veranstaltungen der Organisation, neueste zuerst',
  [
    EVENT_EXAMPLE,
    {
      ...EVENT_EXAMPLE,
      id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      name: 'Weihnachtsmarkt 2025',
      description: null,
      startDate: '2025-12-06T14:00:00.000Z',
      endDate: '2025-12-07T20:00:00.000Z',
      status: 'inactive',
      settings: { orderNumberPrefix: 'WM', orderingMode: 'immediate' },
      paidAt: '2025-11-02T10:05:00.000Z',
      billedDays: 2,
      unlockedStartDate: '2025-12-06T00:00:00.000Z',
      createdAt: '2025-10-28T19:02:40.000Z',
      updatedAt: '2025-12-07T21:10:00.000Z',
    },
  ],
);
