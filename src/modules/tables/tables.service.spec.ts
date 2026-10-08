import {
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, FindOperator } from 'typeorm';
import { DiningTable } from '../../database/entities/dining-table.entity';
import { TableArea } from '../../database/entities/table-area.entity';
import {
  Order,
  OrderStatus,
  PaymentStatus,
} from '../../database/entities/order.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { User } from '../../database/entities/user.entity';
import { GatewayService } from '../gateway/gateway.service';
import { TablesService, bulkLabels } from './tables.service';

const ORG = '6c0f5c55-3c55-4a43-9d7c-0b2f2f6c1001';
const OTHER_ORG = '6c0f5c55-3c55-4a43-9d7c-0b2f2f6c1002';
const USER = { id: 'u1' } as User;

type Row = Record<string, unknown> & { id: string };

/** Kleiner In-Memory-Ersatz fuer die Repository-Methoden des Service. */
function matches(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    switch (condition.type) {
      case 'in':
        return (condition.value as unknown as unknown[]).includes(value);
      case 'not':
        return !matches(value, condition.child ?? condition.value);
      default:
        throw new Error(`operator ${condition.type} not faked`);
    }
  }
  return value === condition;
}

class FakeRepo {
  rows: Row[] = [];
  readonly manager: unknown;

  constructor(
    private readonly softDelete_: boolean,
    manager: () => unknown,
  ) {
    Object.defineProperty(this, 'manager', { get: manager });
  }

  private visible(withDeleted = false) {
    return this.rows.filter(
      (r) => withDeleted || !this.softDelete_ || !r.deletedAt,
    );
  }

  private filter(where: Record<string, unknown> = {}) {
    return this.visible().filter((row) =>
      Object.entries(where).every(([k, v]) => matches(row[k], v)),
    );
  }

  create(data: Record<string, unknown>) {
    return { ...data };
  }

  find(options: { where?: Record<string, unknown> } = {}) {
    return Promise.resolve(this.filter(options.where));
  }

  findOne(options: { where: Record<string, unknown> }) {
    return Promise.resolve(this.filter(options.where)[0] ?? null);
  }

  count(options: { where?: Record<string, unknown> } = {}) {
    return Promise.resolve(this.filter(options.where).length);
  }

  save<T extends Record<string, unknown>>(entity: T | T[]) {
    const list = Array.isArray(entity) ? entity : [entity];
    for (const item of list) {
      if (!item.id) Object.assign(item, { id: randomUUID() });
      const index = this.rows.findIndex((r) => r.id === item.id);
      if (index >= 0) this.rows[index] = item as unknown as Row;
      else this.rows.push(item as unknown as Row);
    }
    return Promise.resolve(entity);
  }

  update(where: Record<string, unknown>, patch: Record<string, unknown>) {
    const hit = this.filter(where);
    hit.forEach((row) => Object.assign(row, patch));
    return Promise.resolve({ affected: hit.length });
  }

  softDelete(where: Record<string, unknown>) {
    const hit = this.filter(where);
    hit.forEach((row) => (row.deletedAt = new Date()));
    return Promise.resolve({ affected: hit.length });
  }
}

function setup(
  options: {
    role?: OrganizationRole;
    permissions?: Record<string, boolean>;
  } = {},
) {
  const repos = new Map<unknown, FakeRepo>([
    [TableArea, new FakeRepo(true, () => manager)],
    [DiningTable, new FakeRepo(true, () => manager)],
    [Order, new FakeRepo(false, () => manager)],
    [UserOrganization, new FakeRepo(false, () => manager)],
  ]);
  const getRepository = (entity: unknown) => {
    const repo = repos.get(entity);
    if (!repo) throw new Error('unexpected repository');
    return repo;
  };
  const manager = { getRepository };

  repos.get(UserOrganization)!.rows.push({
    id: 'm1',
    organizationId: ORG,
    userId: USER.id,
    role: options.role ?? OrganizationRole.ADMIN,
    permissions: options.permissions ?? {},
  });

  const dataSource = {
    getRepository,
    manager,
    // Rollback nachspielen: bei Fehler Stand vor der Transaktion zurueck.
    transaction: async (work: (m: unknown) => Promise<unknown>) => {
      const snapshot = [...repos.values()].map((r) =>
        r.rows.map((row) => ({ ...row })),
      );
      try {
        return await work(manager);
      } catch (error) {
        [...repos.values()].forEach((r, i) => (r.rows = snapshot[i]));
        throw error;
      }
    },
    query: jest.fn(),
  } as unknown as DataSource;

  const gateway = {
    notifyTablesUpdated: jest.fn(),
  } as unknown as GatewayService & {
    notifyTablesUpdated: jest.Mock;
  };

  const service = new TablesService(dataSource, gateway);
  return {
    service,
    gateway,
    areas: repos.get(TableArea)!,
    tables: repos.get(DiningTable)!,
    orders: repos.get(Order)!,
  };
}

async function withArea(ctx: ReturnType<typeof setup>, name = 'Zelt A') {
  return ctx.service.createArea(ORG, { name }, USER);
}

async function expectError(
  promise: Promise<unknown>,
  type: new (...args: never[]) => Error,
  reason: string,
) {
  const error = await promise.then(
    () => {
      throw new Error('expected an error');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  expect(
    (error as { getResponse(): { reason: string } }).getResponse(),
  ).toEqual(expect.objectContaining({ reason }));
  return error as { getResponse(): Record<string, unknown> };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('bulkLabels', () => {
  it('builds A01…A12 from prefix A, start 1, count 12, padding 2', () => {
    expect(bulkLabels('A', 1, 12, 2)).toEqual([
      'A01',
      'A02',
      'A03',
      'A04',
      'A05',
      'A06',
      'A07',
      'A08',
      'A09',
      'A10',
      'A11',
      'A12',
    ]);
  });

  it('pads nothing with padding 0 and allows an empty prefix', () => {
    expect(bulkLabels('', 9, 3, 0)).toEqual(['9', '10', '11']);
  });
});

describe('TablesService', () => {
  describe('labels', () => {
    it('rejects a label that exists in another case', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'A1' },
        USER,
      );

      await expectError(
        ctx.service.createTable(ORG, { areaId: area.id, label: 'a1' }, USER),
        ConflictException,
        'TABLE_LABEL_TAKEN',
      );
    });

    it('is unique across areas of the organization', async () => {
      const ctx = setup();
      const a = await withArea(ctx, 'Zelt A');
      const b = await withArea(ctx, 'Biergarten');
      await ctx.service.createTable(ORG, { areaId: a.id, label: '1' }, USER);

      await expectError(
        ctx.service.createTable(ORG, { areaId: b.id, label: '1' }, USER),
        ConflictException,
        'TABLE_LABEL_TAKEN',
      );
    });

    it('does not count deleted tables or other organizations', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const first = await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'A1' },
        USER,
      );
      await ctx.service.removeTable(ORG, first.id, USER);
      ctx.tables.rows.push({
        id: randomUUID(),
        organizationId: OTHER_ORG,
        areaId: randomUUID(),
        label: 'A2',
      });

      await expect(
        ctx.service.createTable(ORG, { areaId: area.id, label: 'A1' }, USER),
      ).resolves.toMatchObject({ label: 'A1' });
      await expect(
        ctx.service.createTable(ORG, { areaId: area.id, label: 'A2' }, USER),
      ).resolves.toMatchObject({ label: 'A2' });
    });

    it('rejects area names case-insensitively', async () => {
      const ctx = setup();
      await withArea(ctx, 'Zelt A');
      await expectError(
        withArea(ctx, 'zelt a'),
        ConflictException,
        'TABLE_AREA_NAME_TAKEN',
      );
    });
  });

  describe('bulk create', () => {
    it('creates A01…A12 in a grid and notifies the organization', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const created = await ctx.service.bulkCreate(
        ORG,
        {
          areaId: area.id,
          prefix: 'A',
          start: 1,
          count: 12,
          padding: 2,
          seats: 6,
          layout: { cols: 6, gap: 40 },
        },
        USER,
      );

      expect(created.map((t) => t.label)).toEqual(bulkLabels('A', 1, 12, 2));
      expect(created[0]).toMatchObject({ x: 40, y: 40, seats: 6 });
      expect(created[6]).toMatchObject({ x: 40, y: 160 });
      expect(created.map((t) => t.sortOrder)).toEqual(
        Array.from({ length: 12 }, (_, i) => i),
      );
      expect(ctx.gateway.notifyTablesUpdated).toHaveBeenLastCalledWith(ORG, [
        area.id,
      ]);
    });

    it('creates nothing when one label collides and lists all conflicts', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'a03' },
        USER,
      );
      await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'A07' },
        USER,
      );

      const error = await expectError(
        ctx.service.bulkCreate(
          ORG,
          { areaId: area.id, prefix: 'A', start: 1, count: 12, padding: 2 },
          USER,
        ),
        ConflictException,
        'TABLE_LABEL_TAKEN',
      );
      expect(error.getResponse().params).toMatchObject({
        conflicts: 'A03, A07',
        count: 2,
      });
      expect(ctx.tables.rows.filter((t) => !t.deletedAt)).toHaveLength(2);
    });

    it('rejects labels longer than 20 characters', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      await expectError(
        ctx.service.bulkCreate(
          ORG,
          {
            areaId: area.id,
            prefix: 'X'.repeat(19),
            start: 9,
            count: 2,
            padding: 0,
          },
          USER,
        ),
        BadRequestException,
        'TABLE_LABEL_INVALID',
      );
      expect(ctx.tables.rows).toHaveLength(0);
    });
  });

  describe('layout', () => {
    it('saves positions and decor of the area', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const table = await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'A1' },
        USER,
      );

      const result = await ctx.service.putLayout(
        ORG,
        area.id,
        {
          tables: [
            {
              id: table.id,
              x: 100,
              y: 200,
              width: 120,
              height: 60,
              rotation: 90,
            },
          ],
          decor: [
            {
              id: 'd1',
              type: 'bar',
              x: 0,
              y: 0,
              width: 300,
              height: 40,
              rotation: 0,
            },
          ],
        },
        USER,
      );

      expect(result.tables[0]).toMatchObject({
        x: 100,
        y: 200,
        width: 120,
        height: 60,
        rotation: 90,
      });
      expect(ctx.areas.rows[0].decor).toEqual([
        {
          id: 'd1',
          type: 'bar',
          x: 0,
          y: 0,
          width: 300,
          height: 40,
          rotation: 0,
        },
      ]);
    });

    it('rejects tables of another area and changes nothing', async () => {
      const ctx = setup();
      const a = await withArea(ctx, 'Zelt A');
      const b = await withArea(ctx, 'Biergarten');
      const own = await ctx.service.createTable(
        ORG,
        { areaId: a.id, label: 'A1' },
        USER,
      );
      const foreign = await ctx.service.createTable(
        ORG,
        { areaId: b.id, label: 'G1' },
        USER,
      );

      await expectError(
        ctx.service.putLayout(
          ORG,
          a.id,
          {
            tables: [
              {
                id: own.id,
                x: 100,
                y: 100,
                width: 80,
                height: 80,
                rotation: 0,
              },
              {
                id: foreign.id,
                x: 0,
                y: 0,
                width: 80,
                height: 80,
                rotation: 0,
              },
            ],
          },
          USER,
        ),
        NotFoundException,
        'TABLE_NOT_FOUND',
      );
      expect(ctx.tables.rows.find((t) => t.id === own.id)).toMatchObject({
        x: 0,
        y: 0,
      });
    });

    it('rejects positions outside the area', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const table = await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'A1' },
        USER,
      );

      await expectError(
        ctx.service.putLayout(
          ORG,
          area.id,
          {
            tables: [
              {
                id: table.id,
                x: 1201,
                y: 0,
                width: 80,
                height: 80,
                rotation: 0,
              },
            ],
          },
          USER,
        ),
        BadRequestException,
        'TABLE_OUT_OF_AREA',
      );
    });
  });

  describe('walls, zones and outline', () => {
    const wall = {
      id: 'w1',
      type: 'wall' as const,
      points: [
        { x: 0, y: 0 },
        { x: 1200, y: 0 },
        { x: 1200, y: 640 },
      ],
      thickness: 12,
    };
    const zone = {
      id: 'z1',
      type: 'zone' as const,
      zoneType: 'kitchen' as const,
      label: 'Küche',
      points: [
        { x: 0, y: 600 },
        { x: 300, y: 600 },
        { x: 300, y: 800 },
        { x: 0, y: 800 },
      ],
    };
    const bar = {
      id: 'd1',
      type: 'bar' as const,
      x: 0,
      y: 0,
      width: 300,
      height: 40,
      rotation: 0,
    };
    const outline = [
      { x: 0, y: 0 },
      { x: 1200, y: 0 },
      { x: 1200, y: 640 },
      { x: 1040, y: 800 },
      { x: 0, y: 800 },
    ];

    it('stores polyline walls, zones and rectangles side by side', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      await ctx.service.putLayout(
        ORG,
        area.id,
        { tables: [], decor: [bar, wall, zone], outline },
        USER,
      );
      expect(ctx.areas.rows[0].decor).toEqual([bar, wall, zone]);
      expect(ctx.areas.rows[0].outline).toEqual(outline);
      expect(ctx.gateway.notifyTablesUpdated).toHaveBeenLastCalledWith(ORG, [
        area.id,
      ]);
    });

    it('keeps a rectangular wall (no points) as before', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const rectWall = { ...bar, id: 'd2', type: 'wall' as const };
      await ctx.service.putLayout(
        ORG,
        area.id,
        { tables: [], decor: [rectWall] },
        USER,
      );
      expect(ctx.areas.rows[0].decor).toEqual([rectWall]);
    });

    it('resets the outline with null and leaves it alone when omitted', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      await ctx.service.updateArea(ORG, area.id, { outline }, USER);
      await ctx.service.updateArea(ORG, area.id, { name: 'Zelt B' }, USER);
      expect(ctx.areas.rows[0].outline).toEqual(outline);
      await ctx.service.updateArea(ORG, area.id, { outline: null }, USER);
      expect(ctx.areas.rows[0].outline).toBeNull();
    });

    it('rejects points outside the area', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      await expectError(
        ctx.service.putLayout(
          ORG,
          area.id,
          {
            tables: [],
            decor: [
              {
                ...wall,
                points: [
                  { x: 0, y: 0 },
                  { x: 1201, y: 0 },
                ],
              },
            ],
          },
          USER,
        ),
        BadRequestException,
        'TABLE_OUT_OF_AREA',
      );
      await expectError(
        ctx.service.updateArea(
          ORG,
          area.id,
          { outline: [...outline.slice(0, 4), { x: 0, y: 801 }] },
          USER,
        ),
        BadRequestException,
        'TABLE_OUT_OF_AREA',
      );
      expect(ctx.areas.rows[0].decor).toEqual([]);
    });

    it('requires 3 points per zone and outline, 2 per wall', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const two = zone.points.slice(0, 2);
      const error = await expectError(
        ctx.service.putLayout(
          ORG,
          area.id,
          { tables: [], decor: [{ ...zone, points: two }] },
          USER,
        ),
        BadRequestException,
        'TABLE_AREA_SHAPE_INVALID',
      );
      expect(error.getResponse()).toEqual(
        expect.objectContaining({
          params: { kind: 'zone', problem: 'tooFewPoints', min: 3 },
        }),
      );
      await expectError(
        ctx.service.updateArea(ORG, area.id, { outline: two }, USER),
        BadRequestException,
        'TABLE_AREA_SHAPE_INVALID',
      );
      await expectError(
        ctx.service.putLayout(
          ORG,
          area.id,
          { tables: [], decor: [{ ...wall, points: two.slice(0, 1) }] },
          USER,
        ),
        BadRequestException,
        'TABLE_AREA_SHAPE_INVALID',
      );
    });

    it('rejects more than 100 points', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const many = Array.from({ length: 101 }, (_, i) => ({ x: i, y: i }));
      await expectError(
        ctx.service.putLayout(
          ORG,
          area.id,
          { tables: [], decor: [{ ...wall, points: many }] },
          USER,
        ),
        BadRequestException,
        'TABLE_AREA_SHAPE_INVALID',
      );
    });

    it('pulls outline and shape points in when the area shrinks', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      await ctx.service.putLayout(
        ORG,
        area.id,
        { tables: [], decor: [bar, wall], outline },
        USER,
      );
      await ctx.service.updateArea(
        ORG,
        area.id,
        { width: 1000, height: 700 },
        USER,
      );
      const row = ctx.areas.rows[0] as unknown as TableArea;
      expect(row.outline).toEqual([
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 640 },
        { x: 1000, y: 700 },
        { x: 0, y: 700 },
      ]);
      expect(row.decor[1]).toEqual({
        ...wall,
        points: [
          { x: 0, y: 0 },
          { x: 1000, y: 0 },
          { x: 1000, y: 640 },
        ],
      });
      expect(row.decor[0]).toEqual(bar);
    });
  });

  describe('rename', () => {
    it('updates the table number of open orders only', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const table = await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'A1' },
        USER,
      );
      const order = (
        id: string,
        paymentStatus: PaymentStatus,
        status: OrderStatus,
      ) => ({
        id,
        tableId: table.id,
        tableNumber: 'A1',
        paymentStatus,
        status,
      });
      ctx.orders.rows.push(
        order('open', PaymentStatus.UNPAID, OrderStatus.OPEN),
        order('partly', PaymentStatus.PARTLY_PAID, OrderStatus.IN_PROGRESS),
        order('served', PaymentStatus.UNPAID, OrderStatus.READY),
        order('paid', PaymentStatus.PAID, OrderStatus.COMPLETED),
        order('cancelled', PaymentStatus.UNPAID, OrderStatus.CANCELLED),
        {
          ...order('other', PaymentStatus.UNPAID, OrderStatus.OPEN),
          tableId: null,
        },
      );

      await ctx.service.updateTable(ORG, table.id, { label: 'B1' }, USER);

      const numbers = Object.fromEntries(
        ctx.orders.rows.map((o) => [o.id, o.tableNumber]),
      );
      expect(numbers).toEqual({
        open: 'B1',
        partly: 'B1',
        served: 'B1',
        paid: 'A1',
        cancelled: 'A1',
        other: 'A1',
      });
    });

    it('rejects a rename onto an existing label', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'A1' },
        USER,
      );
      const t2 = await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'A2' },
        USER,
      );

      await expectError(
        ctx.service.updateTable(ORG, t2.id, { label: 'a1' }, USER),
        ConflictException,
        'TABLE_LABEL_TAKEN',
      );
    });

    it('allows changing only the case of the own label', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const table = await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'a1' },
        USER,
      );
      await expect(
        ctx.service.updateTable(ORG, table.id, { label: 'A1' }, USER),
      ).resolves.toMatchObject({ label: 'A1' });
    });
  });

  describe('delete', () => {
    it('refuses to delete a table with open orders (409)', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const table = await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'A1' },
        USER,
      );
      ctx.orders.rows.push({
        id: 'o1',
        tableId: table.id,
        paymentStatus: PaymentStatus.PARTLY_PAID,
        status: OrderStatus.OPEN,
      });

      await expectError(
        ctx.service.removeTable(ORG, table.id, USER),
        ConflictException,
        'TABLE_HAS_OPEN_ORDERS',
      );
      expect(ctx.tables.rows[0].deletedAt).toBeUndefined();
    });

    it('soft-deletes a table whose orders are paid', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const table = await ctx.service.createTable(
        ORG,
        { areaId: area.id, label: 'A1' },
        USER,
      );
      ctx.orders.rows.push({
        id: 'o1',
        tableId: table.id,
        paymentStatus: PaymentStatus.PAID,
        status: OrderStatus.COMPLETED,
      });

      await ctx.service.removeTable(ORG, table.id, USER);
      expect(ctx.tables.rows[0].deletedAt).toBeInstanceOf(Date);
    });

    it('refuses to delete an area while one of its tables has open orders', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      const [, second] = await ctx.service.bulkCreate(
        ORG,
        { areaId: area.id, prefix: 'A', start: 1, count: 2, padding: 0 },
        USER,
      );
      ctx.orders.rows.push({
        id: 'o1',
        tableId: second.id,
        paymentStatus: PaymentStatus.UNPAID,
        status: OrderStatus.IN_PROGRESS,
      });

      await expectError(
        ctx.service.removeArea(ORG, area.id, USER),
        ConflictException,
        'TABLE_HAS_OPEN_ORDERS',
      );
      expect(ctx.areas.rows[0].deletedAt).toBeUndefined();
    });

    it('soft-deletes an area together with its tables', async () => {
      const ctx = setup();
      const area = await withArea(ctx);
      await ctx.service.bulkCreate(
        ORG,
        { areaId: area.id, prefix: 'A', start: 1, count: 3, padding: 0 },
        USER,
      );

      await ctx.service.removeArea(ORG, area.id, USER);
      expect(ctx.areas.rows[0].deletedAt).toBeInstanceOf(Date);
      expect(ctx.tables.rows.every((t) => t.deletedAt)).toBe(true);
      await expect(ctx.service.listAreas(ORG, USER)).resolves.toEqual([]);
    });
  });

  describe('permissions', () => {
    it('lets members read but not write without the events permission', async () => {
      const ctx = setup({ role: OrganizationRole.MEMBER });
      await expect(ctx.service.listAreas(ORG, USER)).resolves.toEqual([]);
      await expectError(
        withArea(ctx),
        ForbiddenException,
        'INSUFFICIENT_PERMISSIONS',
      );
    });

    it('lets members with the events permission write', async () => {
      const ctx = setup({
        role: OrganizationRole.MEMBER,
        permissions: { events: true },
      });
      await expect(withArea(ctx)).resolves.toMatchObject({ name: 'Zelt A' });
    });

    it('denies non-members', async () => {
      const ctx = setup();
      await expectError(
        ctx.service.listAreas(OTHER_ORG, USER),
        ForbiddenException,
        'ORGANIZATION_ACCESS_DENIED',
      );
    });
  });

  it('lists areas with tables sorted naturally', async () => {
    const ctx = setup();
    const b = await withArea(ctx, 'Biergarten');
    const a = await withArea(ctx, 'Zelt A');
    await ctx.service.reorderAreas(ORG, { ids: [a.id, b.id] }, USER);
    for (const label of ['A10', 'A2', 'A1']) {
      await ctx.service.createTable(ORG, { areaId: a.id, label }, USER);
    }
    // gleiche sortOrder → natuerliche Reihenfolge der Bezeichnung
    ctx.tables.rows.forEach((t) => (t.sortOrder = 0));

    const list = await ctx.service.listAreas(ORG, USER);
    expect(list.map((x) => x.name)).toEqual(['Zelt A', 'Biergarten']);
    expect(list[0].tables.map((t) => t.label)).toEqual(['A1', 'A2', 'A10']);
  });
});
