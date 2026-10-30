import { paginatedResponse } from '../../common/openapi/responses';

/** Beispiel eines Produkts, wie `GET …/products` es liefert (mit Kategorie). */
export const PRODUCT_EXAMPLE = {
  id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
  eventId: '2f6c1a9e-5b1d-4c7e-9a3f-0d8e7b6a5c41',
  categoryId: '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b',
  name: 'Bratwurst im Brötchen',
  description: 'Vom Grill, mit Senf oder Ketchup',
  price: 4.5,
  taxRate: 7,
  imageUrl: null,
  icon: 'pos-icon:sausage-bun',
  isFavorite: true,
  isActive: true,
  isAvailable: true,
  trackInventory: true,
  stockQuantity: 120,
  stockUnit: 'Stück',
  lowStockThreshold: 20,
  options: {
    groups: [
      {
        name: 'Soße',
        type: 'single',
        required: false,
        options: [
          { name: 'Senf', priceModifier: 0, default: true },
          { name: 'Ketchup', priceModifier: 0 },
        ],
      },
    ],
  },
  printSettings: null,
  sortOrder: 1,
  productionStationId: 'c0ffee00-1111-4222-8333-444455556666',
  pfandTypeId: null,
  category: {
    id: '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b',
    eventId: '2f6c1a9e-5b1d-4c7e-9a3f-0d8e7b6a5c41',
    name: 'Grill',
    sortOrder: 1,
    isActive: true,
  },
  createdAt: '2026-05-21T08:14:02.000Z',
  updatedAt: '2026-07-10T17:40:11.000Z',
};

export const PRODUCTS_LIST_RESPONSE = paginatedResponse(
  'Produkte der Veranstaltung mit Kategorie, nach Reihenfolge und Name sortiert',
  [
    PRODUCT_EXAMPLE,
    {
      ...PRODUCT_EXAMPLE,
      id: '6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b',
      name: 'Pils 0,5 l',
      description: null,
      price: 4,
      taxRate: 19,
      icon: 'pos-icon:beer-glass',
      isFavorite: false,
      trackInventory: false,
      stockQuantity: 0,
      lowStockThreshold: null,
      options: { groups: [] },
      sortOrder: 2,
      productionStationId: null,
      pfandTypeId: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a',
      categoryId: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b',
      category: {
        id: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b',
        eventId: '2f6c1a9e-5b1d-4c7e-9a3f-0d8e7b6a5c41',
        name: 'Getränke',
        sortOrder: 2,
        isActive: true,
      },
    },
  ],
  50,
);
