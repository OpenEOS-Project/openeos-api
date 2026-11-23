import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { EntityManager, FindOperator } from 'typeorm';
import {
  Category,
  Event,
  Organization,
  Product,
  ProductionStation,
  Shift,
  ShiftJob,
  ShiftPlan,
  TableArea,
  TokenType,
  UserOrganization,
  Waiter,
} from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { EventStatus } from '../../database/entities/event.entity';
import { ShiftPlanStatus } from '../../database/entities/shift-plan.entity';
import { DeploymentService } from '../../common/services/deployment.service';
import { GatewayService } from '../gateway/gateway.service';
import { PinCredentialsService } from '../waiters/pin-credentials.service';
import { WaiterSessionsService } from '../waiters/waiter-sessions.service';
import { WaitersService } from '../waiters/waiters.service';
import {
  EventCopyService,
  dayKeyDiff,
  duplicateEventSettings,
  nameKey,
  shiftDayKey,
} from './event-copy.service';
import { EventsService } from './events.service';
import { TestOrderCleanupService } from './test-order-cleanup.service';

/* ------------------------------------------------------------------ *
 * Kleiner In-Memory-Ersatz fuer EntityManager/Repository: genug fuer die
 * Abfragen der Uebernahme (Gleichheit, In, IsNull, MoreThan) und eine
 * Transaktion, die bei einem Fehler den Stand davor wiederherstellt.
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown> & { id: string };
type Store = Map<unknown, Row[]>;

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected instanceof FindOperator) {
      const op = expected as FindOperator<unknown>;
      switch (op.type) {
        case 'in':
          return (op.value as unknown[]).includes(actual);
        case 'isNull':
          return actual === null || actual === undefined;
        case 'moreThan':
          return (
            actual instanceof Date &&
            actual.getTime() > (op.value as Date).getTime()
          );
        default:
          throw new Error(`operator ${op.type} not supported`);
      }
    }
    if (expected instanceof Date && actual instanceof Date) {
      return expected.getTime() === actual.getTime();
    }
    return actual === expected;
  });
}

class FakeRepo {
  /** Wirft beim n-ten save (fuer „alles oder nichts“). */
  failOnSave: ((row: Row) => boolean) | null = null;

  constructor(
    private readonly store: Store,
    private readonly entity: unknown,
  ) {}

  private get rows(): Row[] {
    if (!this.store.has(this.entity)) this.store.set(this.entity, []);
    return this.store.get(this.entity)!;
  }

  create(data: Record<string, unknown>) {
    return { ...data };
  }

  find(options: { where?: Record<string, unknown> } = {}) {
    return Promise.resolve(
      this.rows
        .filter((r) => !r.deletedAt && matches(r, options.where))
        .map((r) => ({ ...r })),
    );
  }

  async findOne(options: { where?: Record<string, unknown> } = {}) {
    return (await this.find(options))[0] ?? null;
  }

  async count(options: { where?: Record<string, unknown> } = {}) {
    return (await this.find(options)).length;
  }

  save<T extends Record<string, unknown>>(input: T | T[]): Promise<T | T[]> {
    const list = Array.isArray(input) ? input : [input];
    for (const item of list) {
      if (this.failOnSave?.(item as unknown as Row)) {
        return Promise.reject(new Error('save failed'));
      }
      const row = item as unknown as Row;
      if (!row.id) row.id = randomUUID();
      if (!row.createdAt) row.createdAt = new Date();
      const index = this.rows.findIndex((r) => r.id === row.id);
      if (index >= 0) this.rows[index] = { ...this.rows[index], ...row };
      else this.rows.push({ ...row });
    }
    return Promise.resolve(input);
  }

  update(where: Record<string, unknown>, patch: Record<string, unknown>) {
    for (const row of this.rows)
      if (matches(row, where)) Object.assign(row, patch);
    return Promise.resolve();
  }
}

class FakeDb {
  store: Store = new Map();
  repos = new Map<unknown, FakeRepo>();
  queries: string[] = [];

  repo(entity: unknown): FakeRepo {
    if (!this.repos.has(entity))
      this.repos.set(entity, new FakeRepo(this.store, entity));
    return this.repos.get(entity)!;
  }

  rows<T = Row>(entity: unknown): T[] {
    return (this.store.get(entity) ?? []) as unknown as T[];
  }

  insert(entity: unknown, row: Record<string, unknown>): Row {
    const full = { id: randomUUID(), createdAt: new Date(0), ...row } as Row;
    if (!this.store.has(entity)) this.store.set(entity, []);
    this.store.get(entity)!.push(full);
    return full;
  }

  get manager(): EntityManager {
    return {
      getRepository: (entity: unknown) => this.repo(entity),
      query: (sql: string) => {
        this.queries.push(sql);
        return Promise.resolve([]);
      },
      transaction: async <T>(cb: (m: EntityManager) => Promise<T>) => {
        const snapshot = new Map(
          [...this.store.entries()].map(([k, rows]) => [
            k,
            rows.map((r) => ({ ...r })),
          ]),
        );
        try {
          return await cb(this.manager);
        } catch (error) {
          this.store.clear();
          for (const [k, rows] of snapshot) this.store.set(k, rows);
          throw error;
        }
      },
    } as unknown as EntityManager;
  }
}

const ORG = randomUUID();
const PRINTER = randomUUID();
const PFAND = randomUUID();

function seedSource(db: FakeDb, opts: { vatExempt?: boolean } = {}) {
  db.insert(Organization, {
    id: ORG,
    settings: { vatExempt: opts.vatExempt ?? false, timezone: 'Europe/Berlin' },
  });
  const source = db.insert(Event, {
    organizationId: ORG,
    name: 'Sportlergala 2026',
    startDate: new Date('2026-03-14T00:00:00+01:00'),
    endDate: new Date('2026-03-15T00:00:00+01:00'),
    status: EventStatus.INACTIVE,
    settings: {},
  });
  const target = db.insert(Event, {
    organizationId: ORG,
    name: 'Sommerfest',
    startDate: new Date('2026-07-10T00:00:00+02:00'),
    endDate: new Date('2026-07-10T00:00:00+02:00'),
    status: EventStatus.INACTIVE,
    settings: {},
  });
  // Kette Grill -> Kueche -> Ausgabe; die Bar steht allein.
  const ausgabe = db.insert(ProductionStation, {
    eventId: source.id,
    name: 'Ausgabe',
    sortOrder: 3,
    isActive: true,
    printerId: PRINTER,
    handoffStationId: null,
  });
  const kueche = db.insert(ProductionStation, {
    eventId: source.id,
    name: 'Küche',
    sortOrder: 1,
    isActive: true,
    printerId: PRINTER,
    handoffStationId: ausgabe.id,
  });
  const grill = db.insert(ProductionStation, {
    eventId: source.id,
    name: 'Grill',
    sortOrder: 2,
    isActive: true,
    printerId: null,
    handoffStationId: kueche.id,
  });
  const bar = db.insert(ProductionStation, {
    eventId: source.id,
    name: 'Bar',
    sortOrder: 0,
    isActive: true,
    printerId: PRINTER,
    handoffStationId: null,
  });
  const getraenke = db.insert(Category, {
    eventId: source.id,
    parentId: null,
    name: 'Getränke',
    sortOrder: 0,
    isActive: true,
    icon: 'cup',
    color: '#123456',
    printSettings: { copies: 2 },
    productionStationId: bar.id,
  });
  const bier = db.insert(Category, {
    eventId: source.id,
    parentId: getraenke.id,
    name: 'Bier',
    sortOrder: 1,
    isActive: true,
    productionStationId: bar.id,
  });
  const essen = db.insert(Category, {
    eventId: source.id,
    parentId: null,
    name: 'Essen',
    sortOrder: 1,
    isActive: true,
    productionStationId: null,
  });
  const product = (row: Record<string, unknown>) =>
    db.insert(Product, {
      eventId: source.id,
      description: null,
      taxRate: 19,
      imageUrl: null,
      icon: null,
      isFavorite: false,
      isActive: true,
      isAvailable: true,
      trackInventory: false,
      stockQuantity: 0,
      stockUnit: 'Stück',
      options: { groups: [] },
      printSettings: null,
      sortOrder: 0,
      productionStationId: null,
      pfandTypeId: null,
      deletedAt: null,
      ...row,
    });
  const cola = product({
    categoryId: getraenke.id,
    name: 'Cola',
    price: 3.5,
    pfandTypeId: PFAND,
    imageUrl: '/uploads/org/products/cola.webp',
    icon: 'oe:bottle',
    isFavorite: true,
    trackInventory: true,
    stockQuantity: 48,
    options: {
      groups: [{ name: 'Eis', type: 'single', required: true, options: [] }],
    },
    printSettings: { printerId: PRINTER },
    sortOrder: 4,
  });
  const pils = product({
    categoryId: bier.id,
    name: 'Pils',
    price: 4,
    pfandTypeId: PFAND,
  });
  const wurst = product({
    categoryId: essen.id,
    name: 'Bratwurst',
    price: 4.5,
    taxRate: 7,
    productionStationId: grill.id,
  });
  product({
    categoryId: essen.id,
    name: 'Gelöscht',
    price: 1,
    deletedAt: new Date(),
  });
  return {
    source,
    target,
    stations: { ausgabe, kueche, grill, bar },
    getraenke,
    bier,
    essen,
    cola,
    pils,
    wurst,
  };
}

describe('event copy helpers', () => {
  it('compares names trimmed and case-insensitive', () => {
    expect(nameKey('  GETRÄNKE ')).toBe(nameKey('getränke'));
  });

  it('shifts day keys across month and year ends', () => {
    expect(shiftDayKey('2026-12-30', 3)).toBe('2027-01-02');
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(dayKeyDiff('2026-03-14', '2027-03-13')).toBe(364);
    expect(shiftDayKey('kaputt', 3)).toBe('kaputt');
  });

  it('duplicates only event settings and shifts shop days', () => {
    const area = randomUUID();
    const gone = randomUUID();
    const settings = duplicateEventSettings(
      {
        orderingMode: 'tab',
        tables: { mode: 'predefined', areaIds: [area, gone] },
        sales: { earlyStartHours: 4, presale: true },
        shop: {
          enabled: true,
          hoursMode: 'event',
          serviceFee: 0.5,
          days: [
            { date: '2026-03-14', start: '18:00', end: '02:00' },
            { date: '2026-03-15', start: '10:00', end: '16:00' },
          ],
        },
        // nie mitnehmen:
        tse: { clientId: 'x' },
        billing: { paid: true },
      } as never,
      7,
      ['2026-03-21'],
      new Set([area]),
    );
    expect(settings).toEqual({
      orderingMode: 'tab',
      tables: { mode: 'predefined', areaIds: [area] },
      sales: { earlyStartHours: 4, presale: true },
      shop: {
        enabled: true,
        hoursMode: 'event',
        serviceFee: 0.5,
        days: [{ date: '2026-03-21', start: '18:00', end: '02:00' }],
      },
    });
  });

  it('falls back to all areas when every selected area is gone', () => {
    const settings = duplicateEventSettings(
      { tables: { mode: 'predefined', areaIds: [randomUUID()] } },
      0,
      null,
      new Set(),
    );
    expect(settings.tables).toEqual({ mode: 'predefined', areaIds: null });
  });
});

describe('EventCopyService.copyCatalog', () => {
  it('copies stations, categories and products with all references', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    const result = await new EventCopyService().copyCatalog(db.manager, {
      organizationId: ORG,
      sourceEventId: s.source.id,
      targetEventId: s.target.id,
      allStations: true,
    });

    expect(result).toMatchObject({
      stationsCopied: 4,
      categoriesCopied: 3,
      productsCopied: 3,
      productsSkipped: 0,
    });
    const stations = db
      .rows<ProductionStation>(ProductionStation)
      .filter((x) => x.eventId === s.target.id);
    const byName = new Map(stations.map((x) => [x.name, x]));
    // Kette in zwei Durchgaengen: Grill -> Kueche -> Ausgabe.
    expect(byName.get('Grill')!.handoffStationId).toBe(byName.get('Küche')!.id);
    expect(byName.get('Küche')!.handoffStationId).toBe(
      byName.get('Ausgabe')!.id,
    );
    expect(byName.get('Ausgabe')!.handoffStationId).toBeNull();
    expect(byName.get('Küche')!.printerId).toBe(PRINTER);

    const categories = db
      .rows<Category>(Category)
      .filter((c) => c.eventId === s.target.id);
    const getraenke = categories.find((c) => c.name === 'Getränke')!;
    const bier = categories.find((c) => c.name === 'Bier')!;
    expect(bier.parentId).toBe(getraenke.id);
    expect(getraenke).toMatchObject({
      icon: 'cup',
      color: '#123456',
      printSettings: { copies: 2 },
      productionStationId: byName.get('Bar')!.id,
    });

    const products = db
      .rows<Product>(Product)
      .filter((p) => p.eventId === s.target.id);
    expect(products.map((p) => p.name).sort()).toEqual([
      'Bratwurst',
      'Cola',
      'Pils',
    ]);
    const cola = products.find((p) => p.name === 'Cola')!;
    expect(cola).toMatchObject({
      categoryId: getraenke.id,
      taxRate: 19,
      pfandTypeId: PFAND,
      imageUrl: '/uploads/org/products/cola.webp',
      icon: 'oe:bottle',
      isFavorite: true,
      sortOrder: 4,
      stockQuantity: 0,
      trackInventory: true,
      printSettings: { printerId: PRINTER },
      options: s.cola.options,
    });
    const wurst = products.find((p) => p.name === 'Bratwurst')!;
    expect(wurst.taxRate).toBe(7);
    expect(wurst.productionStationId).toBe(byName.get('Grill')!.id);
    expect(result.maps.products.get(s.cola.id)).toBe(cola.id);
  });

  it('keeps stock only on request', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    await new EventCopyService().copyCatalog(db.manager, {
      organizationId: ORG,
      sourceEventId: s.source.id,
      targetEventId: s.target.id,
      productIds: [s.cola.id],
      copyStock: true,
    });
    const cola = db
      .rows<Product>(Product)
      .find((p) => p.eventId === s.target.id && p.name === 'Cola')!;
    expect(cola.stockQuantity).toBe(48);
  });

  it('sets the tax rate to 0 for a VAT-exempt organization', async () => {
    const db = new FakeDb();
    const s = seedSource(db, { vatExempt: true });
    await new EventCopyService().copyCatalog(db.manager, {
      organizationId: ORG,
      sourceEventId: s.source.id,
      targetEventId: s.target.id,
    });
    const rates = db
      .rows<Product>(Product)
      .filter((p) => p.eventId === s.target.id)
      .map((p) => p.taxRate);
    expect(rates).toEqual([0, 0, 0]);
  });

  it('merges categories and stations by name and skips existing products', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    const bar = db.insert(ProductionStation, {
      eventId: s.target.id,
      name: 'BAR ',
      handoffStationId: null,
    });
    const getraenke = db.insert(Category, {
      eventId: s.target.id,
      parentId: null,
      name: 'getränke',
      sortOrder: 9,
    });
    db.insert(Product, {
      eventId: s.target.id,
      categoryId: getraenke.id,
      name: 'cola',
      price: 3,
      deletedAt: null,
    });
    // Gleicher Name auf anderer Ebene ist eine andere Kategorie.
    db.insert(Category, {
      eventId: s.target.id,
      parentId: null,
      name: 'Bier',
      sortOrder: 3,
    });

    const result = await new EventCopyService().copyCatalog(db.manager, {
      organizationId: ORG,
      sourceEventId: s.source.id,
      targetEventId: s.target.id,
      productIds: [s.cola.id, s.pils.id],
    });

    expect(result).toMatchObject({
      categoriesCopied: 1, // Bier unter Getränke
      categoriesMerged: 1, // Getränke
      productsCopied: 1, // Pils
      productsSkipped: 1, // Cola
      skippedProducts: [{ name: 'Cola', category: 'getränke' }],
      stationsCopied: 0,
      stationsMerged: 1,
    });
    const categories = db
      .rows<Category>(Category)
      .filter((c) => c.eventId === s.target.id);
    expect(categories).toHaveLength(3);
    const newBier = categories.find(
      (c) => c.name === 'Bier' && c.parentId === getraenke.id,
    )!;
    expect(newBier.productionStationId).toBe(bar.id);
    const pils = db
      .rows<Product>(Product)
      .find((p) => p.eventId === s.target.id && p.name === 'Pils')!;
    expect(pils.categoryId).toBe(newBier.id);
  });

  it('copies duplicates when asked to', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    const getraenke = db.insert(Category, {
      eventId: s.target.id,
      parentId: null,
      name: 'Getränke',
    });
    db.insert(Product, {
      eventId: s.target.id,
      categoryId: getraenke.id,
      name: 'Cola',
      price: 3,
      deletedAt: null,
    });
    const result = await new EventCopyService().copyCatalog(db.manager, {
      organizationId: ORG,
      sourceEventId: s.source.id,
      targetEventId: s.target.id,
      productIds: [s.cola.id],
      includeDuplicates: true,
    });
    expect(result.productsCopied).toBe(1);
    expect(
      db
        .rows<Product>(Product)
        .filter((p) => p.eventId === s.target.id && p.name === 'Cola'),
    ).toHaveLength(2);
  });

  it('is idempotent: a second identical copy only skips', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    const service = new EventCopyService();
    const options = {
      organizationId: ORG,
      sourceEventId: s.source.id,
      targetEventId: s.target.id,
    };
    await service.copyCatalog(db.manager, options);
    const second = await service.copyCatalog(db.manager, options);
    expect(second).toMatchObject({
      productsCopied: 0,
      productsSkipped: 3,
      categoriesCopied: 0,
      categoriesMerged: 3,
    });
    expect(
      db.rows<Product>(Product).filter((p) => p.eventId === s.target.id),
    ).toHaveLength(3);
  });

  it('brings only referenced stations and their follow-up chain', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    const result = await new EventCopyService().copyCatalog(db.manager, {
      organizationId: ORG,
      sourceEventId: s.source.id,
      targetEventId: s.target.id,
      productIds: [s.wurst.id],
    });
    const names = db
      .rows<ProductionStation>(ProductionStation)
      .filter((x) => x.eventId === s.target.id)
      .map((x) => x.name)
      .sort();
    expect(names).toEqual(['Ausgabe', 'Grill', 'Küche']);
    expect(result.stationsCopied).toBe(3);
    // Nur Essen kam mit (Kategorie des Produkts).
    expect(
      db
        .rows<Category>(Category)
        .filter((c) => c.eventId === s.target.id)
        .map((c) => c.name),
    ).toEqual(['Essen']);
  });

  it('selecting a subcategory brings its parent along', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    await new EventCopyService().copyCatalog(db.manager, {
      organizationId: ORG,
      sourceEventId: s.source.id,
      targetEventId: s.target.id,
      categoryIds: [s.bier.id],
    });
    const categories = db
      .rows<Category>(Category)
      .filter((c) => c.eventId === s.target.id);
    expect(categories.map((c) => c.name).sort()).toEqual(['Bier', 'Getränke']);
    const products = db
      .rows<Product>(Product)
      .filter((p) => p.eventId === s.target.id);
    expect(products.map((p) => p.name)).toEqual(['Pils']);
  });
});

describe('EventCopyService – token types and shift plans', () => {
  it('remaps allowed categories and products of event-only token types', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    db.insert(TokenType, {
      organizationId: ORG,
      eventId: s.source.id,
      name: 'Getränkemarke',
      value: 2,
      kind: 'single_purpose',
      vatRate: 19,
      allowedCategoryIds: [s.getraenke.id],
      allowedProductIds: [s.wurst.id, randomUUID()],
      sortOrder: 0,
      isActive: true,
      buybackAllowed: false,
    });
    db.insert(TokenType, {
      organizationId: ORG,
      eventId: null,
      name: 'Org-weit',
      value: 1,
    });
    const service = new EventCopyService();
    const { maps } = await service.copyCatalog(db.manager, {
      organizationId: ORG,
      sourceEventId: s.source.id,
      targetEventId: s.target.id,
      productIds: [s.cola.id],
    });
    const count = await service.copyEventTokenTypes(
      db.manager,
      ORG,
      s.source.id,
      s.target.id,
      maps,
    );
    expect(count).toBe(1);
    const copy = db
      .rows<TokenType>(TokenType)
      .find((t) => t.eventId === s.target.id)!;
    expect(copy).toMatchObject({
      name: 'Getränkemarke',
      kind: 'single_purpose',
      vatRate: 19,
      allowedCategoryIds: [maps.categories.get(s.getraenke.id)],
      // Bratwurst kam nicht mit, die unbekannte ID auch nicht.
      allowedProductIds: [],
    });
  });

  it('copies shift plans as drafts with shifted dates and no registrations', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    const plan = db.insert(ShiftPlan, {
      organizationId: ORG,
      eventId: s.source.id,
      name: 'Helfer Sportlergala 2026',
      publicSlug: 'helfer-alt',
      status: ShiftPlanStatus.PUBLISHED,
      settings: {
        requireApproval: false,
        allowMultipleShifts: true,
        reminderDaysBefore: 2,
      },
    });
    const job = db.insert(ShiftJob, {
      shiftPlanId: plan.id,
      name: 'Theke',
      sortOrder: 0,
      requiredWorkers: 3,
    });
    db.insert(Shift, {
      shiftJobId: job.id,
      date: '2026-03-14',
      startTime: '18:00:00',
      endTime: '22:00:00',
      requiredWorkers: 2,
      notes: 'Kasse',
    });
    db.insert(Shift, {
      shiftJobId: job.id,
      date: '2026-03-15',
      startTime: '10:00:00',
      endTime: '14:00:00',
      requiredWorkers: 1,
      notes: null,
    });

    const result = await new EventCopyService().copyEventShiftPlans(
      db.manager,
      ORG,
      { id: s.source.id, name: 'Sportlergala 2026' },
      { id: s.target.id, name: 'Sportlergala 2027' },
      364,
    );
    expect(result).toEqual({ plans: 1, shifts: 2 });
    const copy = db
      .rows<ShiftPlan>(ShiftPlan)
      .find((p) => p.eventId === s.target.id)!;
    expect(copy).toMatchObject({
      name: 'Helfer Sportlergala 2027',
      status: ShiftPlanStatus.DRAFT,
      settings: { requireApproval: false, reminderDaysBefore: 2 },
    });
    expect(copy.publicSlug).toMatch(/^helfer-sportlergala-2027-/);
    const jobCopy = db
      .rows<ShiftJob>(ShiftJob)
      .find((j) => j.shiftPlanId === copy.id)!;
    expect(jobCopy).toMatchObject({ name: 'Theke', requiredWorkers: 3 });
    const shifts = db
      .rows<Shift>(Shift)
      .filter((x) => x.shiftJobId === jobCopy.id);
    expect(shifts.map((x) => [x.date, x.startTime, x.notes])).toEqual([
      ['2027-03-13', '18:00:00', 'Kasse'],
      ['2027-03-14', '10:00:00', null],
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * EventsService: Anlegen mit Vorlage und Duplizieren (alles oder nichts,
 * Doppelklick, Bedienungen mit neuen PINs, Rechte).
 * ------------------------------------------------------------------ */

function buildEventsService(db: FakeDb, membership: Partial<UserOrganization>) {
  db.insert(UserOrganization, {
    organizationId: ORG,
    userId: 'user-1',
    ...membership,
  });
  const dataSource = {
    getRepository: (entity: unknown) => db.repo(entity),
    query: () => Promise.resolve([]),
  };
  const generatePins = jest.fn((_org: string, owners: { ownerId: string }[]) =>
    Promise.resolve(
      new Map(owners.map((o, i) => [o.ownerId, String(4711 + i)])),
    ),
  );
  const pins = { generate: generatePins } as unknown as PinCredentialsService;
  const config = { get: () => undefined } as unknown as ConfigService;
  const waiters = new WaitersService(
    dataSource as never,
    pins,
    {} as WaiterSessionsService,
    config,
  );
  const eventRepo = Object.assign(db.repo(Event), { manager: db.manager });
  const notifyMenuRefresh = jest.fn();
  const gateway = { notifyMenuRefresh } as unknown as GatewayService;
  const service = new EventsService(
    eventRepo as never,
    db.repo(Organization) as never,
    db.repo(UserOrganization) as never,
    db.repo(Category) as never,
    db.repo(Product) as never,
    {} as never,
    {} as never,
    db.repo(TableArea) as never,
    gateway,
    { billingEnabled: false } as unknown as DeploymentService,
    {} as TestOrderCleanupService,
    config,
    undefined,
    new EventCopyService(undefined, waiters),
  );
  return { service, generatePins, notifyMenuRefresh };
}

const USER = { id: 'user-1', email: 'u@example.org' } as never;

describe('EventsService – create with template', () => {
  it('creates the event and copies the catalog in one go', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    const { service } = buildEventsService(db, {
      role: OrganizationRole.ADMIN,
    });
    const event = await service.create(
      ORG,
      {
        name: 'Sportlergala 2027',
        startDate: '2027-03-13T00:00:00+01:00',
        copyFromEventId: s.source.id,
      },
      USER,
    );
    expect(event.copiedFromEventId).toBe(s.source.id);
    expect(event.copySummary).toMatchObject({
      productsCopied: 3,
      categoriesCopied: 3,
      stationsCopied: 4,
    });
    expect(
      db.rows<Product>(Product).filter((p) => p.eventId === event.id),
    ).toHaveLength(3);
  });

  it('without a template behaves as before', async () => {
    const db = new FakeDb();
    seedSource(db);
    const { service } = buildEventsService(db, {
      role: OrganizationRole.ADMIN,
    });
    const event = await service.create(
      ORG,
      {
        name: 'Leer',
        startDate: '2027-03-13T00:00:00+01:00',
        copyFromEventId: null,
      },
      USER,
    );
    expect(event.copySummary).toBeUndefined();
    expect(
      db.rows<Product>(Product).filter((p) => p.eventId === event.id),
    ).toHaveLength(0);
  });

  it('is all or nothing: a failing copy leaves no event behind', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    const { service } = buildEventsService(db, {
      role: OrganizationRole.ADMIN,
    });
    const before = db.rows(Event).length;
    db.repo(Product).failOnSave = (row) => row.name === 'Pils';
    await expect(
      service.create(
        ORG,
        {
          name: 'Kaputt',
          startDate: '2027-03-13T00:00:00+01:00',
          copyFromEventId: s.source.id,
        },
        USER,
      ),
    ).rejects.toThrow('save failed');
    expect(db.rows(Event)).toHaveLength(before);
    expect(
      db.rows<Product>(Product).filter((p) => p.eventId !== s.source.id),
    ).toHaveLength(0);
    expect(
      db
        .rows<ProductionStation>(ProductionStation)
        .filter((x) => x.eventId !== s.source.id),
    ).toHaveLength(0);
  });

  it('rejects a template from another organization', async () => {
    const db = new FakeDb();
    seedSource(db);
    const foreign = db.insert(Event, {
      organizationId: randomUUID(),
      name: 'Fremd',
    });
    const { service } = buildEventsService(db, {
      role: OrganizationRole.ADMIN,
    });
    await expect(
      service.create(
        ORG,
        {
          name: 'X',
          startDate: '2027-03-13T00:00:00+01:00',
          copyFromEventId: foreign.id,
        },
        USER,
      ),
    ).rejects.toMatchObject({ response: { reason: 'SOURCE_EVENT_NOT_FOUND' } });
  });

  it('refuses the same copy twice within seconds (double click)', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    const { service } = buildEventsService(db, {
      role: OrganizationRole.ADMIN,
    });
    const dto = {
      name: 'Doppelt',
      startDate: '2027-03-13T00:00:00+01:00',
      copyFromEventId: s.source.id,
    };
    await service.create(ORG, dto, USER);
    await expect(service.create(ORG, dto, USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(
      db.rows<Event>(Event).filter((e) => e.name === 'Doppelt'),
    ).toHaveLength(1);
  });
});

describe('EventsService – duplicate', () => {
  function seedFull(db: FakeDb) {
    const s = seedSource(db);
    const area = db.insert(TableArea, { organizationId: ORG, name: 'Halle' });
    Object.assign(db.rows<Event>(Event).find((e) => e.id === s.source.id)!, {
      description: 'Gala mit Ehrungen',
      settings: {
        orderingMode: 'tab',
        tables: { mode: 'predefined', areaIds: [area.id] },
        sales: { earlyStartHours: 3, presale: true },
        shop: {
          enabled: true,
          hoursMode: 'event',
          days: [
            { date: '2026-03-14', start: '18:00', end: '02:00' },
            { date: '2026-03-15', start: '11:00', end: '15:00' },
          ],
        },
        tse: { secret: true },
      },
      billingStatus: 'paid',
    });
    db.insert(Waiter, {
      organizationId: ORG,
      eventId: s.source.id,
      name: 'Anna Beispiel',
      shortName: 'Anna',
      color: '#dc2626',
      role: 'lead',
      permissions: { refund: true },
      isEmployee: false,
      isActive: true,
      anonymizedAt: null,
    });
    db.insert(Waiter, {
      organizationId: ORG,
      eventId: s.source.id,
      name: 'Weg',
      isActive: false,
      anonymizedAt: null,
    });
    db.insert(Waiter, {
      organizationId: ORG,
      eventId: null,
      name: 'Org-weit',
      isActive: true,
      anonymizedAt: null,
    });
    const plan = db.insert(ShiftPlan, {
      organizationId: ORG,
      eventId: s.source.id,
      name: 'Helfer',
      publicSlug: 'helfer',
      status: ShiftPlanStatus.PUBLISHED,
      settings: {},
    });
    const job = db.insert(ShiftJob, {
      shiftPlanId: plan.id,
      name: 'Grill',
      sortOrder: 0,
      requiredWorkers: 2,
    });
    db.insert(Shift, {
      shiftJobId: job.id,
      date: '2026-03-14',
      startTime: '17:00:00',
      endTime: '20:00:00',
      requiredWorkers: 2,
      notes: null,
    });
    return { ...s, area };
  }

  it('copies catalog, settings, shift plans and waiters with new PINs', async () => {
    const db = new FakeDb();
    const s = seedFull(db);
    const { service, generatePins } = buildEventsService(db, {
      role: OrganizationRole.ADMIN,
    });
    const result = await service.duplicate(
      ORG,
      s.source.id,
      {
        name: 'Sportlergala 2027',
        startDate: '2027-03-13T00:00:00+01:00',
        endDate: '2027-03-14T00:00:00+01:00',
      },
      USER,
    );

    expect(result.event).toMatchObject({
      name: 'Sportlergala 2027',
      description: 'Gala mit Ehrungen',
      status: EventStatus.INACTIVE,
      copiedFromEventId: s.source.id,
    });
    expect(
      (result.event as unknown as Record<string, unknown>).billingStatus,
    ).toBeUndefined();
    expect(result.event.settings).toEqual({
      orderingMode: 'tab',
      tables: { mode: 'predefined', areaIds: [s.area.id] },
      sales: { earlyStartHours: 3, presale: true },
      shop: {
        enabled: true,
        hoursMode: 'event',
        days: [
          { date: '2027-03-13', start: '18:00', end: '02:00' },
          { date: '2027-03-14', start: '11:00', end: '15:00' },
        ],
      },
    });
    expect(result.copied).toMatchObject({
      productsCopied: 3,
      stationsCopied: 4,
      shiftPlans: 1,
      shifts: 1,
      waiters: 1,
    });
    expect(result.skipped).toEqual({ shiftPlans: false, waiters: false });

    expect(result.waiters).toEqual([
      expect.objectContaining({
        name: 'Anna Beispiel',
        shortName: 'Anna',
        color: '#dc2626',
        role: 'lead',
        eventId: result.event.id,
        pin: '4711',
      }),
    ]);
    expect(generatePins).toHaveBeenCalledTimes(1);
    const waiter = db
      .rows<Waiter>(Waiter)
      .find((w) => w.eventId === result.event.id)!;
    expect(waiter.permissions).toEqual({ refund: true });

    const shift = db
      .rows<Shift>(Shift)
      .find((x) => x.shiftJobId !== undefined && x.date === '2027-03-13');
    expect(shift).toBeDefined();
  });

  it('skips shift plans and waiters without the matching permission', async () => {
    const db = new FakeDb();
    const s = seedFull(db);
    const { service, generatePins } = buildEventsService(db, {
      role: OrganizationRole.MEMBER,
      permissions: { events: true } as never,
    });
    const result = await service.duplicate(
      ORG,
      s.source.id,
      { name: 'Ohne Rechte', startDate: '2027-03-13T00:00:00+01:00' },
      USER,
    );
    expect(result.skipped).toEqual({ shiftPlans: true, waiters: true });
    expect(result.waiters).toEqual([]);
    expect(generatePins).not.toHaveBeenCalled();
    expect(
      db
        .rows<ShiftPlan>(ShiftPlan)
        .filter((p) => p.eventId === result.event.id),
    ).toHaveLength(0);
    expect(result.copied.productsCopied).toBe(3);
  });

  it('rolls everything back when the waiter limit is reached', async () => {
    const db = new FakeDb();
    const s = seedFull(db);
    Object.assign(db.rows<Organization>(Organization)[0], { waiterLimit: 3 });
    const { service } = buildEventsService(db, {
      role: OrganizationRole.ADMIN,
    });
    const events = db.rows(Event).length;
    const plans = db.rows(ShiftPlan).length;
    await expect(
      service.duplicate(
        ORG,
        s.source.id,
        { name: 'Zu viele', startDate: '2027-03-13T00:00:00+01:00' },
        USER,
      ),
    ).rejects.toMatchObject({ response: { reason: 'WAITER_LIMIT_REACHED' } });
    expect(db.rows(Event)).toHaveLength(events);
    expect(db.rows(ShiftPlan)).toHaveLength(plans);
    expect(
      db.rows<Product>(Product).filter((p) => p.eventId !== s.source.id),
    ).toHaveLength(0);
  });
});

describe('EventsService.copyFromEvent', () => {
  it('locks the target, merges and notifies the tills', async () => {
    const db = new FakeDb();
    const s = seedSource(db);
    const { service, notifyMenuRefresh } = buildEventsService(db, {
      role: OrganizationRole.ADMIN,
    });
    const first = await service.copyFromEvent(
      ORG,
      s.target.id,
      s.source.id,
      { productIds: [s.cola.id] },
      USER,
    );
    const second = await service.copyFromEvent(
      ORG,
      s.target.id,
      s.source.id,
      { productIds: [s.cola.id] },
      USER,
    );
    expect(first).toMatchObject({ productsCopied: 1, categoriesCopied: 1 });
    expect(second).toMatchObject({
      productsCopied: 0,
      productsSkipped: 1,
      categoriesMerged: 1,
    });
    expect(
      db.queries.some((q) =>
        q.includes('FROM events WHERE id = $1 FOR UPDATE'),
      ),
    ).toBe(true);
    expect(notifyMenuRefresh).toHaveBeenCalledTimes(1);
    expect(
      db.rows<Event>(Event).find((e) => e.id === s.target.id)!
        .copiedFromEventId,
    ).toBe(s.source.id);
  });
});
