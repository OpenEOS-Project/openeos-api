import { NotFoundException } from '@nestjs/common';

import type { User } from '../../../database/entities';
import { ORGANIZATION_TOKEN_SCOPES } from '../../api-tokens/api-scopes';
import type { AgentTool, AgentToolContext } from '../agent-tool.types';
import { CatalogTools } from './catalog.tools';
import { DeviceTools } from './devices.tools';
import { EventTools } from './events.tools';
import { IconTools } from './icons.tools';
import { OrganizationTools } from './organization.tools';
import { ReportTools } from './reports.tools';
import { StaffTools } from './staff.tools';
import { TableTools } from './tables.tools';

/**
 * Jedes Werkzeug einmal mit gemockten Diensten: Lesen liefert die knappe
 * Form, Schreiben ohne `confirm` aendert nichts, mit `confirm` ruft es den
 * Dienst. Die Eingabe laeuft durch das Schema (Defaults, strict).
 */

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const EVENT = '9c9c9c9c-4f43-4a3e-9f8e-0f2b8f3f1a33';
const EVENT2 = '9c9c9c9c-4f43-4a3e-9f8e-0f2b8f3f1a34';
const CAT = '3a3a3a3a-4f43-4a3e-9f8e-0f2b8f3f1a55';
const PROD = '4b4b4b4b-4f43-4a3e-9f8e-0f2b8f3f1a66';
const PFAND = '5c5c5c5c-4f43-4a3e-9f8e-0f2b8f3f1a77';
const STATION = '6d6d6d6d-4f43-4a3e-9f8e-0f2b8f3f1a88';
const AREA = '7e7e7e7e-4f43-4a3e-9f8e-0f2b8f3f1a99';
const TABLE = '8f8f8f8f-4f43-4a3e-9f8e-0f2b8f3f1aaa';
const PLAN = '9a9a9a9a-4f43-4a3e-9f8e-0f2b8f3f1abb';
const JOB = 'abababab-4f43-4a3e-9f8e-0f2b8f3f1acc';
const TEMPLATE = 'bcbcbcbc-4f43-4a3e-9f8e-0f2b8f3f1add';
const ORDER = 'cdcdcdcd-4f43-4a3e-9f8e-0f2b8f3f1aee';
const PRINTER = 'dededede-4f43-4a3e-9f8e-0f2b8f3f1aff';
const UNKNOWN = '00000000-4f43-4a3e-9f8e-0f2b8f3f1a00';

const ctx: AgentToolContext = {
  user: { id: 'user-1' } as User,
  organizationId: ORG,
  apiToken: { id: 'token-1', name: 'Agent', scopes: [...ORGANIZATION_TOKEN_SCOPES], organizationId: ORG },
};

const paged = <T>(data: T[]) => ({
  data,
  meta: { page: 1, limit: 50, total: data.length, totalPages: 1, hasNext: false, hasPrev: false },
});
const notFound = () => Promise.reject(new NotFoundException({ code: 'NOT_FOUND' }));

const event = {
  id: EVENT,
  name: 'Sommerfest',
  status: 'inactive',
  startDate: new Date('2026-07-10'),
  endDate: new Date('2026-07-11'),
  billingStatus: 'none',
  settings: { orderingMode: 'immediate', tables: { mode: 'free' } },
  description: null,
  createdAt: new Date('2026-01-01'),
  priceCharged: 99,
  stripeCheckoutSessionId: 'cs_secret',
};
const category = { id: CAT, name: 'Getränke', parentId: null, sortOrder: 0, isActive: true, products: [{}], description: null };
const product = {
  id: PROD, name: 'Bier', categoryId: CAT, category: { name: 'Getränke' }, price: '4.50', taxRate: 19,
  pfandTypeId: PFAND, icon: null, description: null, isActive: true, isAvailable: true, isFavorite: false,
  trackInventory: false, stockQuantity: 0, stockUnit: 'Stück', productionStationId: null, sortOrder: 0, options: { groups: [] },
};
const pfand = { id: PFAND, name: 'Becher', amount: '2.00', isActive: true, sortOrder: 0 };
const station = { id: STATION, name: 'Küche', color: null, sortOrder: 0, isActive: true, printerId: null, handoffStationId: null, printer: null, description: null };
const org = {
  id: ORG, name: 'TSV', slug: 'tsv', logoUrl: null,
  settings: { currency: 'EUR', timezone: 'Europe/Berlin', receipt: { headerText: 'Hallo', showTaxDetails: true }, sumup: { apiKey: 'sup_secret' } },
  supportPin: '123456',
};
const table = { id: TABLE, label: 'A01', areaId: AREA, seats: 8, shape: 'rect', isActive: true };
const area = { id: AREA, name: 'Zelt A', sortOrder: 0, width: 1200, height: 800, tables: [table] };
const shift = { id: 'shift-1', date: new Date('2026-07-10'), startTime: '18:00:00', endTime: '22:00:00', requiredWorkers: 2, notes: null, registrations: [{ status: 'confirmed', email: 'x@y.z', verificationToken: 'tok' }, { status: 'pending_approval' }] };
const job = { id: JOB, name: 'Theke', description: null, color: null, requiredWorkers: 2, sortOrder: 0, shifts: [shift] };
const plan = { id: PLAN, name: 'Helfer', status: 'draft', eventId: EVENT, event: { name: 'Sommerfest' }, publicSlug: 'helfer', jobs: [job], description: null, settings: { requireApproval: true }, createdAt: new Date('2026-01-01') };
const device = { id: 'dev-1', name: 'Kasse 1', type: 'pos', status: 'verified', isActive: true, lastSeenAt: new Date(), deviceToken: 'dt_secret', verificationCode: '111111', isOnline: () => true };
const printer = { id: PRINTER, name: 'Küche', type: 'kitchen', connectionType: 'network', paperWidth: 80, hasCashDrawer: false, isActive: true, isOnline: true, lastSeenAt: null, deviceId: 'dev-2', connectionConfig: { ipAddress: '10.0.0.5' } };
const template = { id: TEMPLATE, name: 'Kassenbon', type: 'receipt', isDefault: true, template: { sections: [] } };
const order = {
  id: ORDER, orderNumber: 'A-1', dailyNumber: 1, createdAt: new Date(), completedAt: null, status: 'completed', paymentStatus: 'paid',
  displayStatus: 'completed', source: 'pos', fulfillmentType: 'counter_pickup', isTest: false, eventId: EVENT, tableNumber: '12',
  subtotal: 9, pfandTotal: 2, tipAmount: 0, discountAmount: 0, refundedAmount: 0, total: 11, paymentMethods: ['cash'],
  customerName: 'Max Gast', customerPhone: '0170', notes: 'ohne Zwiebeln', createdByUser: { passwordHash: 'pw' },
  items: [{ productName: 'Bier', categoryName: 'Getränke', quantity: 2, unitPrice: '4.50', totalPrice: '9.00', taxRate: '19.00', depositAmount: '2.00', status: 'delivered', options: { selected: [{ option: 'groß' }] }, kitchenNotes: 'eilig' }],
};

const events = {
  findAll: jest.fn(() => Promise.resolve(paged([event, { ...event, id: EVENT2, name: 'Alt', status: 'active' }]))),
  findOne: jest.fn((_o: string, id: string) => ([EVENT, EVENT2].includes(id) ? Promise.resolve({ ...event, id }) : notFound())),
  create: jest.fn((_o: string, dto: Record<string, unknown>) => Promise.resolve({ ...event, ...dto, id: EVENT, status: 'inactive' })),
  update: jest.fn((_o: string, _id: string, dto: Record<string, unknown>) => Promise.resolve({ ...event, ...dto })),
  copyFromEvent: jest.fn(() => Promise.resolve({ categoriesCopied: 1, productsCopied: 1 })),
};
const categories = {
  findAll: jest.fn(() => Promise.resolve([category])),
  create: jest.fn((_e: string, dto: Record<string, unknown>) => Promise.resolve({ ...category, ...dto, id: 'cat-new' })),
  update: jest.fn((_e: string, _id: string, dto: Record<string, unknown>) => Promise.resolve({ ...category, ...dto })),
};
const products = {
  findAll: jest.fn(() => Promise.resolve(paged([product]))),
  findOne: jest.fn((_e: string, id: string) => (id === PROD ? Promise.resolve(product) : notFound())),
  create: jest.fn((_e: string, dto: Record<string, unknown>) => Promise.resolve({ ...product, ...dto, id: 'prod-new' })),
  update: jest.fn((_e: string, id: string, dto: Record<string, unknown>) => Promise.resolve({ ...product, ...dto, id })),
  updateAvailability: jest.fn((_e: string, _id: string, isAvailable: boolean) => Promise.resolve({ ...product, isAvailable })),
};
const pfandTypes = {
  findAll: jest.fn(() => Promise.resolve([pfand])),
  create: jest.fn((_o: string, dto: Record<string, unknown>) => Promise.resolve({ ...pfand, ...dto, id: 'pfand-new' })),
};
const stations = {
  findAll: jest.fn(() => Promise.resolve([station])),
  findOne: jest.fn((_e: string, id: string) => (id === STATION ? Promise.resolve(station) : notFound())),
  create: jest.fn((_e: string, dto: Record<string, unknown>) => Promise.resolve({ ...station, ...dto, id: 'st-new' })),
  update: jest.fn((_e: string, _id: string, dto: Record<string, unknown>) => Promise.resolve({ ...station, ...dto })),
};
const organizations = {
  findOne: jest.fn(() => Promise.resolve(org)),
  update: jest.fn((_id: string, dto: { name?: string; settings?: Record<string, unknown> }) =>
    Promise.resolve({ ...org, name: dto.name ?? org.name, settings: { ...org.settings, ...dto.settings } })),
  checkMembership: jest.fn(() => Promise.resolve({ role: 'admin' })),
  checkRole: jest.fn(() => Promise.resolve({ role: 'admin' })),
  checkPermission: jest.fn(() => Promise.resolve({ role: 'admin' })),
};
const gateway = { notifyOrganizationSettingsUpdated: jest.fn() };
const tables = {
  listAreas: jest.fn(() => Promise.resolve([area])),
  createArea: jest.fn((_o: string, dto: Record<string, unknown>) => Promise.resolve({ ...area, ...dto, id: 'area-new', tables: [] })),
  bulkCreate: jest.fn((_o: string, dto: { count: number }) =>
    Promise.resolve(Array.from({ length: dto.count }, (_, i) => ({ ...table, id: `t-${i}`, label: `B${i + 1}` })))),
  updateTable: jest.fn((_o: string, _id: string, dto: Record<string, unknown>) => Promise.resolve({ ...table, ...dto })),
};
const shifts = {
  findAllPlans: jest.fn(() => Promise.resolve([plan])),
  findOnePlan: jest.fn((_o: string, id: string) => (id === PLAN ? Promise.resolve(plan) : notFound())),
  findAllShifts: jest.fn((_o: string, id: string) => (id === JOB ? Promise.resolve([shift]) : notFound())),
  createPlan: jest.fn((_o: string, dto: Record<string, unknown>) => Promise.resolve({ ...plan, ...dto, id: 'plan-new', jobs: [] })),
  createJob: jest.fn((_o: string, _p: string, dto: Record<string, unknown>) => Promise.resolve({ ...job, ...dto, id: 'job-new', shifts: [] })),
  createShiftsBulk: jest.fn((_o: string, _j: string, dtos: Record<string, unknown>[]) =>
    Promise.resolve(dtos.map((d, i) => ({ ...shift, ...d, id: `s-${i}`, registrations: [] })))),
  publishPlan: jest.fn(() => Promise.resolve({ ...plan, status: 'published' })),
};
const devices = { findAll: jest.fn(() => Promise.resolve(paged([device]))) };
const printers = { findAll: jest.fn(() => Promise.resolve(paged([printer]))) };
const templates = {
  findAll: jest.fn(() => Promise.resolve(paged([template]))),
  findOne: jest.fn((_o: string, id: string) => (id === TEMPLATE ? Promise.resolve(template) : notFound())),
  create: jest.fn((_o: string, dto: Record<string, unknown>) => Promise.resolve({ ...template, ...dto, id: 'tpl-new' })),
  update: jest.fn((_o: string, _id: string, dto: Record<string, unknown>) => Promise.resolve({ ...template, ...dto })),
};
const reports = {
  getSalesReport: jest.fn(() => Promise.resolve({ totalRevenue: 1234.567, totalOrders: 10, averageOrderValue: 123.4567, totalItemsSold: 30, pfandCollected: 20, pfandReturned: 10, pfandBalance: 10, cancelledOrders: 1, cancellationRate: 9.09 })),
  getNetSalesSummary: jest.fn(() => Promise.resolve({ itemsRevenue: 1200, unassignedRefunds: -5, tips: 3, netRevenue: 1198 })),
  getProductsReport: jest.fn(() => Promise.resolve([{ productId: PROD, productName: 'Bier', categoryName: 'Getränke', quantitySold: 20, revenue: 90, averagePrice: 4.5 }])),
  getCategoriesReport: jest.fn(() => Promise.resolve([{ categoryId: CAT, name: 'Getränke', quantity: 20, revenue: 90 }])),
  getHourlyReport: jest.fn(() => Promise.resolve([{ date: '2026-07-10', hour: 17, orders: 0, revenue: 0 }, { date: '2026-07-10', hour: 18, orders: 5, revenue: 50 }])),
  getPaymentsReport: jest.fn(() => Promise.resolve([{ method: 'cash', count: 8, total: 80, percentage: 80 }])),
  getChannelsReport: jest.fn(() => Promise.resolve([{ channel: 'pos', orders: 10, revenue: 100, avgReceipt: 10 }])),
};
const orders = {
  findAll: jest.fn(() => Promise.resolve(paged([order]))),
  findOne: jest.fn((_o: string, id: string) => (id === ORDER ? Promise.resolve(order) : notFound())),
};
const assistant = { getStatus: jest.fn(() => Promise.resolve({ enabled: true })), assertUsable: jest.fn(() => Promise.resolve(org)) };
const icons = { suggest: jest.fn(() => Promise.resolve([{ name: 'Bier', suggestions: [{ icon: 'pos-icon:beer', score: 0.987 }] }])) };

const groups = [
  new OrganizationTools(organizations as never, gateway as never),
  new EventTools(events as never, categories as never, products as never, stations as never, organizations as never),
  new CatalogTools(events as never, categories as never, products as never, pfandTypes as never, stations as never, organizations as never),
  new TableTools(tables as never, organizations as never),
  new StaffTools(shifts as never, organizations as never),
  new DeviceTools(devices as never, printers as never, templates as never, organizations as never),
  new ReportTools(reports as never, orders as never),
  new IconTools(assistant as never, icons as never),
];
const tools = new Map<string, AgentTool>(groups.flatMap((g) => g.tools()).map((t) => [t.name, t]));

function run(name: string, input: unknown = {}): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.handler(ctx, tool.inputSchema.parse(input));
}
const r = (name: string, input?: unknown) => run(name, input) as Promise<Record<string, any>>;

beforeEach(() => jest.clearAllMocks());

describe('tool catalogue', () => {
  it('has every tool from the plan, mutating ones with confirm', () => {
    expect([...tools.keys()].sort()).toEqual(
      [
        'get_organization', 'list_events', 'get_event', 'list_categories', 'list_products', 'list_pfand_types',
        'list_table_areas', 'list_production_stations', 'list_printers', 'list_print_templates', 'list_shift_plans',
        'get_shift_plan', 'get_sales_report', 'list_orders', 'get_order', 'list_devices', 'suggest_icons',
        'create_category', 'update_category', 'upsert_products', 'update_product_availability', 'create_pfand_type',
        'create_event', 'update_event', 'copy_event', 'create_production_station', 'update_production_station',
        'create_table_area', 'create_tables', 'update_table',
        'create_shift_plan', 'create_shift_job', 'create_shifts', 'publish_shift_plan',
        'create_print_template', 'update_print_template', 'update_organization',
      ].sort(),
    );
    for (const tool of tools.values()) {
      const shape = (tool.inputSchema as { shape: Record<string, unknown> }).shape;
      expect(tool.mutating).toBe('confirm' in shape);
      expect(tool.mutating ? tool.scope !== 'read' : tool.scope === 'read').toBe(true);
    }
  });

  it('rejects unknown fields everywhere', () => {
    for (const tool of tools.values()) {
      expect(tool.inputSchema.safeParse({ hacker: true }).success).toBe(false);
    }
  });
});

describe('organization', () => {
  it('get_organization hides secrets', async () => {
    const result = await r('get_organization');
    expect(result).toMatchObject({ id: ORG, name: 'TSV', currency: 'EUR', assistantEnabled: false });
    expect(JSON.stringify(result)).not.toMatch(/sup_secret|123456/);
  });
  it('update_organization previews, merges sub-objects and notifies', async () => {
    const input = { name: 'TSV 1900', settings: { receipt: { footerText: 'Danke' } } };
    const p = await r('update_organization', input);
    expect(p.preview).toBe(true);
    expect(Object.keys(p.changes)).toEqual(['name', 'receipt']);
    expect(organizations.update).not.toHaveBeenCalled();
    const d = await r('update_organization', { ...input, confirm: true });
    expect(d.ok).toBe(true);
    expect(organizations.update).toHaveBeenCalledWith(ORG, { name: 'TSV 1900', settings: { receipt: { headerText: 'Hallo', showTaxDetails: true, footerText: 'Danke' } } }, ctx.user);
    expect(gateway.notifyOrganizationSettingsUpdated).toHaveBeenCalledWith(ORG);
  });
  it('update_organization refuses forbidden settings', () => {
    expect(tools.get('update_organization')!.inputSchema.safeParse({ settings: { sumup: {} } }).success).toBe(false);
    expect(tools.get('update_organization')!.inputSchema.safeParse({ settings: { legal: {} } }).success).toBe(false);
  });
});

describe('events', () => {
  it('list_events filters and compacts; no billing internals', async () => {
    const all = await r('list_events');
    expect(all.total).toBe(2);
    expect(all.items[0]).toEqual({ id: EVENT, name: 'Sommerfest', status: 'inactive', startDate: '2026-07-10', endDate: '2026-07-11', billingStatus: 'none', orderingMode: 'immediate', tablesMode: 'free', shopEnabled: false, copiedFromEventId: null });
    expect(JSON.stringify(all)).not.toContain('cs_secret');
    expect((await r('list_events', { status: 'active' })).items.map((e: { id: string }) => e.id)).toEqual([EVENT2]);
  });
  it('get_event checks the organization', async () => {
    expect((await r('get_event', { eventId: EVENT })).settings.orderingMode).toBe('immediate');
    await expect(r('get_event', { eventId: UNKNOWN })).rejects.toBeInstanceOf(NotFoundException);
  });
  it('create_event previews then creates inactive, never activates', async () => {
    const p = await r('create_event', { name: 'Herbstfest', startDate: '2026-10-03' });
    expect(p).toMatchObject({ preview: true, wouldCreate: { name: 'Herbstfest' } });
    expect(p.summary).toMatch(/inactive/);
    expect(events.create).not.toHaveBeenCalled();
    const d = await r('create_event', { name: 'Herbstfest', startDate: '2026-10-03', settings: { orderingMode: 'tab' }, confirm: true });
    expect(events.create).toHaveBeenCalledWith(ORG, { name: 'Herbstfest', startDate: '2026-10-03', settings: { orderingMode: 'tab' } }, ctx.user);
    expect(d.event.status).toBe('inactive');
  });
  it('update_event shows changes', async () => {
    const p = await r('update_event', { eventId: EVENT, name: 'Sommerfest 2026', settings: { tables: { mode: 'predefined', areaIds: [AREA] } } });
    expect(p.changes.name).toEqual({ from: 'Sommerfest', to: 'Sommerfest 2026' });
    expect(p.changes['settings.tables'].to.mode).toBe('predefined');
    await r('update_event', { eventId: EVENT, name: 'Sommerfest 2026', confirm: true });
    expect(events.update).toHaveBeenCalledWith(ORG, EVENT, { name: 'Sommerfest 2026' }, ctx.user);
    expect((await r('update_event', { eventId: EVENT, name: 'Sommerfest', confirm: true })).summary).toMatch(/Keine Änderung/);
    expect(events.update).toHaveBeenCalledTimes(1);
  });
  it('copy_event counts then copies', async () => {
    const p = await r('copy_event', { targetEventId: EVENT, sourceEventId: EVENT2 });
    expect(p).toMatchObject({ preview: true, categoryCount: 1, productCount: 1 });
    await r('copy_event', { targetEventId: EVENT, sourceEventId: EVENT2, confirm: true });
    expect(events.copyFromEvent).toHaveBeenCalledWith(ORG, EVENT, EVENT2, { categoryIds: undefined, productIds: undefined, copyStock: false }, ctx.user);
  });
  it('production stations', async () => {
    expect((await r('list_production_stations', { eventId: EVENT })).items[0]).toMatchObject({ id: STATION, name: 'Küche', printerName: null });
    const p = await r('create_production_station', { eventId: EVENT, name: 'Grill', printerId: PRINTER });
    expect(p.preview).toBe(true);
    expect(stations.create).not.toHaveBeenCalled();
    await r('create_production_station', { eventId: EVENT, name: 'Grill', printerId: PRINTER, confirm: true });
    expect(stations.create).toHaveBeenCalledWith(EVENT, { name: 'Grill', printerId: PRINTER }, ctx.user);
    const u = await r('update_production_station', { eventId: EVENT, stationId: STATION, isActive: false, confirm: true });
    expect(u.changes.isActive).toEqual({ from: true, to: false });
    expect(stations.update).toHaveBeenCalledWith(EVENT, STATION, { isActive: false }, ctx.user);
  });
});

describe('catalog', () => {
  it('lists categories, products and pfand types with EUR numbers', async () => {
    expect((await r('list_categories', { eventId: EVENT })).items[0]).toMatchObject({ id: CAT, productCount: 1 });
    const products = await r('list_products', { eventId: EVENT, search: 'bie' });
    expect(products.items[0]).toMatchObject({ id: PROD, price: 4.5, taxRate: 19, category: 'Getränke', stockQuantity: null });
    expect(products.items[0].optionGroups).toBeUndefined();
    expect((await r('list_products', { eventId: EVENT, search: 'wein' })).total).toBe(0);
    expect((await r('list_pfand_types')).items[0]).toEqual({ id: PFAND, name: 'Becher', amount: 2, isActive: true, sortOrder: 0 });
  });
  it('create_category warns about duplicates and checks refs', async () => {
    const p = await r('create_category', { eventId: EVENT, name: 'Getränke' });
    expect(p.summary).toMatch(/schon/);
    await expect(r('create_category', { eventId: EVENT, name: 'Essen', parentId: UNKNOWN })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await r('create_category', { eventId: EVENT, name: 'Essen', productionStationId: STATION, confirm: true });
    expect(categories.create).toHaveBeenCalledWith(EVENT, { name: 'Essen', productionStationId: STATION }, ctx.user);
  });
  it('update_category', async () => {
    const p = await r('update_category', { eventId: EVENT, categoryId: CAT, name: 'Drinks', isActive: true });
    expect(Object.keys(p.changes)).toEqual(['name']);
    await r('update_category', { eventId: EVENT, categoryId: CAT, name: 'Drinks', confirm: true });
    expect(categories.update).toHaveBeenCalledWith(EVENT, CAT, { name: 'Drinks' }, ctx.user);
    await expect(r('update_category', { eventId: EVENT, categoryId: UNKNOWN, name: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('upsert_products plans creates, updates, unchanged and errors', async () => {
    const rows = [
      { name: 'bier', price: 4.8 },
      { name: 'Radler', price: 4.5, category: 'Getränke', icon: 'pos-icon:radler', optionGroups: [{ name: 'Größe', options: [{ name: '0,5 l', priceModifier: 0 }] }] },
      { name: 'Bratwurst', price: 3.5, category: 'Essen' },
      { name: 'Ohne Preis', category: 'Getränke' },
      { id: UNKNOWN, name: 'Geist' },
    ];
    const p = await r('upsert_products', { eventId: EVENT, products: rows });
    expect(p.preview).toBe(true);
    expect(p.wouldUpdate).toEqual([{ id: PROD, name: 'Bier', changes: { price: { from: 4.5, to: 4.8 } } }]);
    expect(p.wouldCreate).toEqual([{ name: 'Radler', category: 'Getränke', price: 4.5, taxRate: null }]);
    expect(p.errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 5]);
    await expect(r('upsert_products', { eventId: EVENT, products: rows, confirm: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(products.create).not.toHaveBeenCalled();

    const ok = rows.slice(0, 3);
    const p2 = await r('upsert_products', { eventId: EVENT, products: ok, createMissingCategories: true });
    expect(p2.newCategories).toEqual(['Essen']);
    expect(p2.errors).toEqual([]);
    const d = await r('upsert_products', { eventId: EVENT, products: ok, createMissingCategories: true, confirm: true });
    expect(categories.create).toHaveBeenCalledWith(EVENT, { name: 'Essen' }, ctx.user);
    expect(products.update).toHaveBeenCalledWith(EVENT, PROD, { name: 'bier', price: 4.8 }, ctx.user);
    expect(products.create).toHaveBeenCalledTimes(2);
    expect(products.create).toHaveBeenLastCalledWith(EVENT, { name: 'Bratwurst', price: 3.5, categoryId: 'cat-new' }, ctx.user);
    expect(products.create.mock.calls[0][1]).toMatchObject({ categoryId: CAT, icon: 'pos-icon:radler', options: { groups: [{ name: 'Größe', type: 'single', required: false }] } });
    expect(d.summary).toMatch(/2 Produkte angelegt, 1 geändert, 1 Kategorien/);
  });
  it('upsert_products refuses unchanged noise and bad refs', async () => {
    const p = await r('upsert_products', { eventId: EVENT, products: [{ name: 'Bier', price: 4.5, pfandTypeId: PFAND }, { name: 'Cola', price: 3, categoryId: CAT, pfandTypeId: UNKNOWN }] });
    expect(p.unchanged).toEqual(['Bier']);
    expect(p.errors[0].error).toMatch(/pfandTypeId/);
  });
  it('update_product_availability', async () => {
    expect((await r('update_product_availability', { eventId: EVENT, productId: PROD, isAvailable: true })).summary).toMatch(/bereits/);
    const p = await r('update_product_availability', { eventId: EVENT, productId: PROD, isAvailable: false });
    expect(p.preview).toBe(true);
    expect(products.updateAvailability).not.toHaveBeenCalled();
    await r('update_product_availability', { eventId: EVENT, productId: PROD, isAvailable: false, confirm: true });
    expect(products.updateAvailability).toHaveBeenCalledWith(EVENT, PROD, false, ctx.user);
  });
  it('create_pfand_type', async () => {
    expect((await r('create_pfand_type', { name: 'Becher', amount: 2 })).summary).toMatch(/schon/);
    expect(tools.get('create_pfand_type')!.inputSchema.safeParse({ name: 'X', amount: 1.005 }).success).toBe(false);
    await r('create_pfand_type', { name: 'Krug', amount: 5, confirm: true });
    expect(pfandTypes.create).toHaveBeenCalledWith(ORG, { name: 'Krug', amount: 5 }, ctx.user);
    expect(organizations.checkPermission).toHaveBeenCalledWith(ORG, ctx.user, 'pfand');
  });
});

describe('tables', () => {
  it('list_table_areas with tables', async () => {
    expect((await r('list_table_areas')).items[0]).toEqual({ id: AREA, name: 'Zelt A', sortOrder: 0, width: 1200, height: 800, tableCount: 1, tables: [table] });
  });
  it('create_table_area refuses duplicates', async () => {
    await expect(r('create_table_area', { name: 'zelt a' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await r('create_table_area', { name: 'Saal' })).preview).toBe(true);
    await r('create_table_area', { name: 'Saal', width: 800, confirm: true });
    expect(tables.createArea).toHaveBeenCalledWith(ORG, { name: 'Saal', width: 800 }, ctx.user);
  });
  it('create_tables previews labels and collisions', async () => {
    const p = await r('create_tables', { areaId: AREA, prefix: 'A', start: 1, count: 3, padding: 2 });
    expect(p).toMatchObject({ preview: true, labels: ['A01', 'A02', 'A03'], collisions: ['A01'] });
    await expect(r('create_tables', { areaId: AREA, prefix: 'A', start: 1, count: 3, padding: 2, confirm: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    const d = await r('create_tables', { areaId: AREA, prefix: 'B', count: 2, seats: 8, confirm: true });
    expect(tables.bulkCreate).toHaveBeenCalledWith(ORG, { areaId: AREA, prefix: 'B', start: 1, count: 2, padding: 0, seats: 8 }, ctx.user);
    expect(d.tables).toHaveLength(2);
    await expect(r('create_tables', { areaId: UNKNOWN, count: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('update_table', async () => {
    const p = await r('update_table', { tableId: TABLE, label: 'A1', seats: 8 });
    expect(Object.keys(p.changes)).toEqual(['label']);
    await r('update_table', { tableId: TABLE, isActive: false, confirm: true });
    expect(tables.updateTable).toHaveBeenCalledWith(ORG, TABLE, { isActive: false }, ctx.user);
  });
});

describe('staff', () => {
  it('reads plans without helper data and enforces shiftPlans permission on writes', async () => {
    expect((await r('list_shift_plans')).items[0]).toMatchObject({ id: PLAN, status: 'draft', eventName: 'Sommerfest', jobCount: 1 });
    expect(organizations.checkMembership).toHaveBeenCalledWith(ORG, ctx.user);
    const plan = await r('get_shift_plan', { planId: PLAN });
    expect(plan.registrations).toEqual({ confirmed: 1, pendingApproval: 1, pendingEmail: 0, rejected: 0, cancelled: 0 });
    expect(plan.jobs[0].shifts[0]).toMatchObject({ date: '2026-07-10', startTime: '18:00', endTime: '22:00', confirmed: 1, pending: 1 });
    expect(JSON.stringify(plan)).not.toMatch(/x@y\.z|verificationToken/);
    await r('create_shift_plan', { name: 'Helfer 2026', eventId: EVENT });
    expect(organizations.checkPermission).toHaveBeenCalledWith(ORG, ctx.user, 'shiftPlans');
  });
  it('create_shift_plan / create_shift_job', async () => {
    expect(shifts.createPlan).not.toHaveBeenCalled();
    await r('create_shift_plan', { name: 'Helfer 2026', eventId: EVENT, requireApproval: false, confirm: true });
    expect(shifts.createPlan).toHaveBeenCalledWith(ORG, { name: 'Helfer 2026', eventId: EVENT, requireApproval: false });
    await r('create_shift_job', { planId: PLAN, name: 'Grill', requiredWorkers: 3, confirm: true });
    expect(shifts.createJob).toHaveBeenCalledWith(ORG, PLAN, { name: 'Grill', requiredWorkers: 3 });
    await expect(r('create_shift_job', { planId: UNKNOWN, name: 'Grill' })).rejects.toBeInstanceOf(NotFoundException);
  });
  it('create_shifts skips duplicates', async () => {
    const input = { jobId: JOB, shifts: [{ date: '2026-07-10', startTime: '18:00', endTime: '22:00' }, { date: '2026-07-11', startTime: '18:00', endTime: '22:00' }] };
    const p = await r('create_shifts', input);
    expect(p).toMatchObject({ preview: true, skipped: ['2026-07-10|18:00|22:00'] });
    expect(p.wouldCreate).toHaveLength(1);
    const d = await r('create_shifts', { ...input, confirm: true });
    expect(shifts.createShiftsBulk).toHaveBeenCalledWith(ORG, JOB, [{ date: '2026-07-11', startTime: '18:00', endTime: '22:00' }]);
    expect(d.shifts).toHaveLength(1);
    expect(tools.get('create_shifts')!.inputSchema.safeParse({ jobId: JOB, shifts: [{ date: '2026-07-10', startTime: '25:00', endTime: '22:00' }] }).success).toBe(false);
  });
  it('publish_shift_plan', async () => {
    const p = await r('publish_shift_plan', { planId: PLAN });
    expect(p).toMatchObject({ preview: true, shiftCount: 1, warning: null });
    expect(shifts.publishPlan).not.toHaveBeenCalled();
    const d = await r('publish_shift_plan', { planId: PLAN, confirm: true });
    expect(d.plan.status).toBe('published');
    expect(d.publicPath).toBe('/s/helfer');
    shifts.findOnePlan.mockResolvedValueOnce({ ...plan, status: 'published' } as never);
    await expect(r('publish_shift_plan', { planId: PLAN })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('devices', () => {
  it('lists devices and printers without credentials', async () => {
    const d = await r('list_devices');
    expect(d.items[0]).toEqual({ id: 'dev-1', name: 'Kasse 1', type: 'pos', status: 'verified', isActive: true, lastSeenAt: expect.any(String), online: true });
    expect(JSON.stringify(d)).not.toMatch(/dt_secret|111111/);
    expect((await r('list_devices', { type: 'display' })).total).toBe(0);
    const p = await r('list_printers');
    expect(p.items[0]).toMatchObject({ id: PRINTER, type: 'kitchen', isOnline: true });
    expect(JSON.stringify(p)).not.toContain('10.0.0.5');
    expect(printers.findAll).toHaveBeenCalledWith(ORG, ctx.user, { page: 1, limit: 50 });
  });
  it('print templates', async () => {
    expect((await r('list_print_templates')).items[0]).toEqual({ id: TEMPLATE, name: 'Kassenbon', type: 'receipt', isDefault: true });
    expect((await r('list_print_templates', { includeDefinition: true })).items[0].template).toEqual({ sections: [] });
    expect((await r('list_print_templates', { type: 'kitchen_ticket' })).total).toBe(0);
    expect((await r('create_print_template', { name: 'Küche', type: 'kitchen_ticket' })).preview).toBe(true);
    expect(organizations.checkRole).toHaveBeenCalledWith(ORG, ctx.user, 'admin');
    await r('create_print_template', { name: 'Küche', type: 'kitchen_ticket', template: { width: 42 }, confirm: true });
    expect(templates.create).toHaveBeenCalledWith(ORG, { name: 'Küche', type: 'kitchen_ticket', template: { width: 42 } }, ctx.user);
    const u = await r('update_print_template', { templateId: TEMPLATE, template: { sections: [{ type: 'header' }] } });
    expect(u.changes.template).toEqual({ from: '(definition)', to: '(new definition)' });
    await r('update_print_template', { templateId: TEMPLATE, name: 'Bon', confirm: true });
    expect(templates.update).toHaveBeenCalledWith(ORG, TEMPLATE, { name: 'Bon' }, ctx.user);
  });
});

describe('reports and orders', () => {
  it('get_sales_report picks sections and rounds', async () => {
    const report = await r('get_sales_report', { eventId: EVENT, sections: ['summary', 'hourly', 'net', 'channels'] });
    expect(report.summary).toMatchObject({ revenue: 1234.57, orders: 10, averageReceipt: 123.46 });
    expect(report.hourly).toEqual([{ date: '2026-07-10', hour: 18, orders: 5, revenue: 50 }]);
    expect(report.net.netRevenue).toBe(1198);
    expect(report.channels[0]).toEqual({ channel: 'pos', orders: 10, revenue: 100, averageReceipt: 10 });
    expect(report.products).toBeUndefined();
    expect(reports.getProductsReport).not.toHaveBeenCalled();
    expect(reports.getSalesReport).toHaveBeenCalledWith(ORG, { eventId: EVENT, startDate: undefined, endDate: undefined }, ctx.user);
    const defaults = await r('get_sales_report', { startDate: '2026-07-10', endDate: '2026-07-10' });
    expect(Object.keys(defaults)).toEqual(['filter', 'summary', 'products', 'categories', 'payments']);
  });
  it('list_orders and get_order are anonymous', async () => {
    const list = await r('list_orders', { eventId: EVENT, status: 'completed', limit: 20 });
    expect(orders.findAll).toHaveBeenCalledWith(ORG, ctx.user, { page: 1, limit: 20, eventId: EVENT, status: 'completed', includeItems: false });
    expect(list.items[0]).toMatchObject({ id: ORDER, orderNumber: 'A-1', total: 11, paymentMethods: ['cash'], itemCount: 1 });
    expect(list.items[0].items).toBeUndefined();
    const one = await r('get_order', { orderId: ORDER });
    expect(one.items[0]).toEqual({ productName: 'Bier', categoryName: 'Getränke', quantity: 2, unitPrice: 4.5, totalPrice: 9, taxRate: 19, deposit: 2, status: 'delivered', options: ['groß'] });
    expect(JSON.stringify([list, one])).not.toMatch(/Max Gast|0170|Zwiebeln|eilig|passwordHash|createdByUser/);
    await expect(r('list_orders', { offset: 30, limit: 100 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('icons', () => {
  it('suggest_icons needs the assistant and rounds scores', async () => {
    const result = await r('suggest_icons', { names: ['Bier'] });
    expect(assistant.assertUsable).toHaveBeenCalledWith(ORG);
    expect(result.items).toEqual([{ name: 'Bier', suggestions: [{ icon: 'pos-icon:beer', score: 0.99 }] }]);
  });
});
