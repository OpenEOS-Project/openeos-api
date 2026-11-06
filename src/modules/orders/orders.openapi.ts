import { paginatedResponse } from '../../common/openapi/responses';

/**
 * Beispiel einer Bestellung, wie `GET …/orders` sie liefert: Spalten der
 * Bestellung, dazu `displayStatus` und `paymentMethods` wie in der Kasse;
 * `items` nur mit `includeItems=true`.
 */
export const ORDER_EXAMPLE = {
  id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  organizationId: '8c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
  eventId: '2f6c1a9e-5b1d-4c7e-9a3f-0d8e7b6a5c41',
  orderNumber: 'SF-0042',
  dailyNumber: 42,
  tableNumber: 'A03',
  tableId: '1234abcd-5678-4ef0-9abc-def012345678',
  acknowledgedAt: '2026-07-11T18:05:30.000Z',
  clientRequestId: null,
  isTest: false,
  customerName: null,
  customerPhone: null,
  status: 'completed',
  paymentStatus: 'paid',
  source: 'pos',
  subtotal: 12.5,
  taxTotal: 1.49,
  total: 14.5,
  paidAmount: 14.5,
  tipAmount: 0,
  discountAmount: 0,
  discountReason: null,
  refundedAmount: 0,
  pfandTotal: 2,
  notes: null,
  priority: 'normal',
  fulfillmentType: 'table_service',
  estimatedReadyAt: null,
  readyAt: '2026-07-11T18:12:03.000Z',
  completedAt: '2026-07-11T18:15:47.000Z',
  cancelledAt: null,
  cancellationReason: null,
  createdByUserId: null,
  createdByDeviceId: '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2910',
  onlineSessionId: null,
  createdByUser: null,
  createdByDevice: {
    id: '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2910',
    name: 'Kasse Festzelt 1',
  },
  displayStatus: 'completed',
  paymentMethods: ['cash'],
  createdAt: '2026-07-11T18:04:58.000Z',
  updatedAt: '2026-07-11T18:15:47.000Z',
};

export const ORDERS_LIST_RESPONSE = paginatedResponse(
  'Bestellungen der Organisation, neueste zuerst',
  [
    ORDER_EXAMPLE,
    {
      ...ORDER_EXAMPLE,
      id: '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e',
      orderNumber: 'SF-0041',
      dailyNumber: 41,
      tableNumber: null,
      tableId: null,
      status: 'open',
      paymentStatus: 'unpaid',
      source: 'qr_order',
      subtotal: 8,
      taxTotal: 1.28,
      total: 8,
      paidAmount: 0,
      pfandTotal: 0,
      fulfillmentType: 'counter_pickup',
      readyAt: null,
      completedAt: null,
      createdByDeviceId: null,
      createdByDevice: null,
      displayStatus: 'unpaid',
      paymentMethods: [],
      createdAt: '2026-07-11T18:03:10.000Z',
      updatedAt: '2026-07-11T18:03:10.000Z',
    },
  ],
  50,
);

/** CSV-Download von `GET …/orders/export` (Beispiel: `variant=orders`, ohne das BOM am Anfang). */
export const ORDERS_EXPORT_RESPONSE = {
  status: 200,
  description:
    'CSV-Datei als Download (`Content-Disposition: attachment; filename="bestellungen_JJJJ-MM-TT.csv"`)',
  content: {
    'text/csv': {
      schema: { type: 'string' as const },
      example:
        'Bestellnummer;Tagesnummer;Datum;Uhrzeit;Veranstaltung;Status;Kanal;Ausgabe;Tisch;Gerät;Artikel;Zahlart;Zwischensumme;Rabatt;Pfand;Trinkgeld;Gesamt;Bezahlt;Erstattet;Enthaltene MwSt;Testbestellung;Gastname;Anmerkung\r\n' +
        'SF-0042;42;11.07.2026;20:04:58;Sommerfest;Abgeschlossen;Kasse;Am Tisch;A03;Kasse Festzelt 1;3;Bar;12,50;0,00;2,00;0,00;14,50;14,50;0,00;1,49;Nein;;\r\n',
    },
  },
};
