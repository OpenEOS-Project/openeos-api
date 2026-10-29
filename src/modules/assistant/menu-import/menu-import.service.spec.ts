import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource, Repository } from 'typeorm';
import {
  Category,
  Event,
  MenuImport,
  PfandType,
  Product,
  User,
  UserOrganization,
} from '../../../database/entities';
import { GatewayService } from '../../gateway/gateway.service';
import { AiProvider } from '../../ai/ai-provider.interface';
import { AiQuotaService } from '../../ai/ai-quota.service';
import { AssistantService } from '../assistant.service';
import { importDir, storeFiles } from './menu-import-files';
import { MenuImportService, toOptions } from './menu-import.service';
import { MenuImportWorkerService } from './menu-import-worker.service';

const FIXTURES = join(__dirname, '../../../../test/fixtures/menu');
const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const EVENT = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const IMPORT = '3f0e8b6a-5c2d-4e1f-9a8b-7c6d5e4f3a2b';
const EXISTING_CATEGORY = '11111111-1111-4111-8111-111111111111';
const EXISTING_PRODUCT = '22222222-2222-4222-8222-222222222222';
const PFAND = '33333333-3333-4333-8333-333333333333';
const user = { id: 'user-1' } as User;

function setup(
  options: {
    supportsPdf?: boolean;
    vatExempt?: boolean;
    importStatus?: MenuImport['status'];
  } = {},
) {
  const uploadDir = mkdtempSync(join(tmpdir(), 'menu-service-'));
  const saved: Partial<MenuImport>[] = [];
  const importUpdates: [unknown, Partial<MenuImport>][] = [];
  const importRepository = {
    create: jest.fn((entry: Partial<MenuImport>) => entry),
    save: jest.fn((entry: Partial<MenuImport>) => {
      const stored = { ...entry, id: IMPORT };
      saved.push(stored);
      return Promise.resolve(stored);
    }),
    update: jest.fn((where: unknown, values: Partial<MenuImport>) => {
      importUpdates.push([where, values]);
      return Promise.resolve();
    }),
    delete: jest.fn(() => Promise.resolve()),
    findOne: jest.fn(() =>
      Promise.resolve({
        id: IMPORT,
        organizationId: ORG,
        eventId: EVENT,
        status: options.importStatus ?? 'done',
        source: 'text',
        files: [],
        createdAt: new Date(),
        suggestion: { categories: [], products: [], warnings: [] },
      } as unknown as MenuImport),
    ),
    find: jest.fn(() => Promise.resolve([])),
  } as unknown as Repository<MenuImport>;
  const eventRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({ id: EVENT, organizationId: ORG } as Event),
    ),
  } as unknown as Repository<Event>;
  const membershipRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({
        role: 'member',
        permissions: { products: true },
      } as unknown as UserOrganization),
    ),
  } as unknown as Repository<UserOrganization>;

  // Transaktions-Manager: merkt sich, was angelegt und geaendert wird.
  const created: { entity: unknown; values: Record<string, unknown> }[] = [];
  const updated: {
    entity: unknown;
    where: unknown;
    values: Record<string, unknown>;
  }[] = [];
  const manager = {
    find: jest.fn((entity: unknown) => {
      if (entity === Category)
        return Promise.resolve([{ id: EXISTING_CATEGORY }]);
      if (entity === PfandType) return Promise.resolve([{ id: PFAND }]);
      return Promise.resolve([]);
    }),
    findOne: jest.fn((entity: unknown, { where }: { where: { id: string } }) =>
      Promise.resolve(
        entity === Product && where.id === EXISTING_PRODUCT
          ? { id: EXISTING_PRODUCT, icon: 'pos-icon:pils' }
          : null,
      ),
    ),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(() => Promise.resolve({ max: 4 })),
    })),
    create: jest.fn((entity: unknown, values: Record<string, unknown>) => ({
      __entity: entity,
      ...values,
    })),
    save: jest.fn((row: { __entity: unknown } & Record<string, unknown>) => {
      const { __entity, ...values } = row;
      created.push({ entity: __entity, values });
      return Promise.resolve({ ...values, id: `new-${created.length}` });
    }),
    update: jest.fn(
      (entity: unknown, where: unknown, values: Record<string, unknown>) => {
        updated.push({ entity, where, values });
        return Promise.resolve();
      },
    ),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb(manager)),
  } as unknown as DataSource;
  const recordAudit = jest.fn(() => Promise.resolve());
  const assistantService = {
    assertUsable: jest.fn(() =>
      Promise.resolve({
        id: ORG,
        settings: {
          vatExempt: options.vatExempt ?? false,
          address: { country: 'DE' },
        },
      }),
    ),
    recordAudit,
  } as unknown as AssistantService;
  const reserve = jest.fn(() => Promise.resolve({ id: 'usage-1' }));
  const settle = jest.fn(() => Promise.resolve());
  const quota = { reserve, settle } as unknown as AiQuotaService;
  const provider = {
    supportsPdf: () => options.supportsPdf ?? true,
  } as unknown as AiProvider;
  const kick = jest.fn();
  const notifyMenuImportUpdated = jest.fn();
  const notifyMenuRefresh = jest.fn();
  const gateway = {
    notifyMenuImportUpdated,
    notifyMenuRefresh,
  } as unknown as GatewayService;
  const configService = {
    get: (key: string) =>
      key === 'UPLOAD_DIR'
        ? uploadDir
        : { maxUploadMb: 1, menuPagesPerImport: 2 },
  } as unknown as ConfigService;
  const service = new MenuImportService(
    importRepository,
    eventRepository,
    membershipRepository,
    {} as Repository<Category>,
    {} as Repository<PfandType>,
    dataSource,
    assistantService,
    quota,
    provider,
    { kick } as unknown as MenuImportWorkerService,
    gateway,
    configService,
  );
  return {
    service,
    uploadDir,
    saved,
    importUpdates,
    reserve,
    settle,
    kick,
    created,
    updated,
    recordAudit,
    gateway,
    notifyMenuImportUpdated,
    notifyMenuRefresh,
    importRepository,
  };
}

describe('MenuImportService.create', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it('accepts pasted text, reserves the quota and kicks the worker', async () => {
    const ctx = setup();
    dirs.push(ctx.uploadDir);
    const result = await ctx.service.create(ORG, EVENT, user, {
      files: [],
      text: '  Bier 3 €  ',
    });
    expect(result).toEqual({ id: IMPORT, status: 'queued' });
    expect(ctx.reserve).toHaveBeenCalledWith(ORG, 'user-1', 'menu_import');
    expect(ctx.saved[0]).toMatchObject({
      source: 'text',
      inputText: 'Bier 3 €',
      usageId: 'usage-1',
      files: [],
    });
    expect(ctx.kick).toHaveBeenCalledWith(IMPORT);
    expect(ctx.notifyMenuImportUpdated).toHaveBeenCalledWith(ORG, {
      id: IMPORT,
      eventId: EVENT,
      status: 'queued',
    });
  });

  it('stores images under menu-imports/<id>/ in order', async () => {
    const ctx = setup();
    dirs.push(ctx.uploadDir);
    const png = readFileSync(join(FIXTURES, 'getraenke.png'));
    await ctx.service.create(ORG, EVENT, user, {
      files: [{ buffer: png }, { buffer: png }],
    });
    expect(ctx.saved[0]).toMatchObject({ source: 'images' });
    expect(ctx.importUpdates[0]).toEqual([
      { id: IMPORT },
      {
        files: [
          'menu-imports/' + IMPORT + '/page-01.png',
          'menu-imports/' + IMPORT + '/page-02.png',
        ],
      },
    ]);
    expect(
      existsSync(join(importDir(ctx.uploadDir, IMPORT), 'page-02.png')),
    ).toBe(true);
  });

  it('rejects bad input before touching the quota', async () => {
    const ctx = setup({ supportsPdf: false });
    dirs.push(ctx.uploadDir);
    const png = readFileSync(join(FIXTURES, 'getraenke.png'));
    const pdf = Buffer.from('%PDF-1.4 fake');
    await expect(
      ctx.service.create(ORG, EVENT, user, { files: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.create(ORG, EVENT, user, {
        files: [{ buffer: Buffer.from('<html>no image</html>') }],
      }),
    ).rejects.toMatchObject({
      response: { code: 'MENU_IMPORT_INVALID_FILES' },
    });
    await expect(
      ctx.service.create(ORG, EVENT, user, {
        files: [{ buffer: png }, { buffer: png }, { buffer: png }],
      }),
    ).rejects.toMatchObject({
      response: { params: { max: 2 } },
    });
    await expect(
      ctx.service.create(ORG, EVENT, user, {
        files: [{ buffer: pdf }, { buffer: png }],
      }),
    ).rejects.toThrow(/nur allein/);
    await expect(
      ctx.service.create(ORG, EVENT, user, { files: [{ buffer: pdf }] }),
    ).rejects.toThrow(/PDF wird vom eingerichteten Anbieter nicht unterstützt/);
    await expect(
      ctx.service.create(ORG, EVENT, user, {
        files: [{ buffer: Buffer.alloc(2 * 1024 * 1024, 1) }],
      }),
    ).rejects.toThrow(/zu groß/);
    expect(ctx.reserve).not.toHaveBeenCalled();
  });

  it('accepts a single PDF when the provider can read it', async () => {
    const ctx = setup({ supportsPdf: true });
    dirs.push(ctx.uploadDir);
    await ctx.service.create(ORG, EVENT, user, {
      files: [{ buffer: Buffer.from('%PDF-1.4 fake pdf') }],
    });
    expect(ctx.saved[0]).toMatchObject({ source: 'pdf' });
  });
});

describe('MenuImportService.apply', () => {
  const dto = {
    categories: [
      { key: 'c1', name: 'Vom Grill' },
      { key: 'c2', name: 'Getränke', existingCategoryId: EXISTING_CATEGORY },
    ],
    products: [
      {
        key: 'p1',
        categoryKey: 'c2',
        name: 'Pils',
        price: 2.5,
        taxRate: 19 as const,
        variants: [
          { name: '0,3 l', priceModifier: 0 },
          { name: '0,5 l', priceModifier: 1 },
        ],
        action: 'create' as const,
      },
      {
        key: 'p2',
        categoryKey: 'c2',
        name: 'Radler',
        price: 3.5,
        taxRate: 19 as const,
        action: 'update' as const,
        existingProductId: EXISTING_PRODUCT,
      },
      {
        key: 'p3',
        categoryKey: 'c1',
        name: 'Steak',
        price: 5,
        taxRate: 19 as const,
        action: 'skip' as const,
      },
      {
        key: 'p4',
        categoryKey: 'c1',
        name: 'Cola (Flasche)',
        price: 2.5,
        taxRate: 19 as const,
        icon: 'pos-icon:cola-flasche',
        pfandTypeId: PFAND,
        action: 'create' as const,
      },
    ],
  };
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it('creates categories and products, maps variants to options and audits', async () => {
    const ctx = setup();
    dirs.push(ctx.uploadDir);
    await storeFiles(ctx.uploadDir, IMPORT, [
      {
        buffer: readFileSync(join(FIXTURES, 'getraenke.png')),
        mediaType: 'image/png',
      },
    ]);

    const result = await ctx.service.apply(ORG, EVENT, IMPORT, dto, user, {
      ipAddress: '10.0.0.1',
    });
    expect(result).toEqual({
      createdCategories: 1,
      createdProducts: 2,
      updatedProducts: 1,
    });

    expect(ctx.created[0]).toEqual({
      entity: Category,
      values: { eventId: EVENT, name: 'Vom Grill', sortOrder: 5 },
    });
    expect(ctx.created[1]).toEqual({
      entity: Product,
      values: {
        eventId: EVENT,
        categoryId: EXISTING_CATEGORY,
        name: 'Pils',
        description: null,
        price: 2.5,
        taxRate: 19,
        icon: null,
        pfandTypeId: null,
        sortOrder: 5,
        options: {
          groups: [
            {
              name: 'Größe',
              type: 'single',
              required: true,
              options: [
                { name: '0,3 l', priceModifier: 0, default: true },
                { name: '0,5 l', priceModifier: 1 },
              ],
            },
          ],
        },
      },
    });
    expect(ctx.created[2].values).toMatchObject({
      categoryId: 'new-1',
      name: 'Cola (Flasche)',
      icon: 'pos-icon:cola-flasche',
      pfandTypeId: PFAND,
      sortOrder: 6,
    });
    expect(ctx.updated).toContainEqual({
      entity: Product,
      where: { id: EXISTING_PRODUCT },
      values: expect.objectContaining({
        name: 'Radler',
        price: 3.5,
        icon: 'pos-icon:pils',
        options: { groups: [] },
      }) as unknown,
    });
    expect(ctx.updated).toContainEqual({
      entity: MenuImport,
      where: { id: IMPORT },
      values: { status: 'applied', appliedAt: expect.any(Date) as unknown },
    });
    expect(existsSync(importDir(ctx.uploadDir, IMPORT))).toBe(false);
    expect(ctx.recordAudit).toHaveBeenCalledWith(
      'menu_import_applied',
      ORG,
      user,
      { ipAddress: '10.0.0.1' },
      {
        eventId: EVENT,
        importId: IMPORT,
        createdCategories: 1,
        createdProducts: 2,
        updatedProducts: 1,
      },
      { type: 'menu_import', id: IMPORT },
    );
    expect(ctx.notifyMenuRefresh).toHaveBeenCalledWith(
      ORG,
      EVENT,
      'menu_import',
    );
  });

  it('refuses imports that are not done, unknown category keys and disallowed tax rates', async () => {
    const notReady = setup({ importStatus: 'processing' });
    dirs.push(notReady.uploadDir);
    await expect(
      notReady.service.apply(ORG, EVENT, IMPORT, dto, user),
    ).rejects.toBeInstanceOf(ConflictException);

    const badKey = setup();
    dirs.push(badKey.uploadDir);
    await expect(
      badKey.service.apply(
        ORG,
        EVENT,
        IMPORT,
        { categories: [], products: [dto.products[0]] },
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: 'MENU_IMPORT_CATEGORY_KEY_UNKNOWN' },
    });

    const exempt = setup({ vatExempt: true });
    dirs.push(exempt.uploadDir);
    await expect(
      exempt.service.apply(ORG, EVENT, IMPORT, dto, user),
    ).rejects.toMatchObject({
      response: { reason: 'TAX_RATE_NOT_ALLOWED', params: { rate: 19 } },
    });
  });
});

describe('toOptions', () => {
  it('returns empty groups without variants', () => {
    expect(toOptions({})).toEqual({ groups: [] });
    expect(toOptions({ variants: [] })).toEqual({ groups: [] });
  });
});
