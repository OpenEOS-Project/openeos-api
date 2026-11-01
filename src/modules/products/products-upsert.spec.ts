import { ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { Category, Product } from '../../database/entities';
import type { User } from '../../database/entities';
import type { GatewayService } from '../gateway/gateway.service';
import { ProductsService, type ProductUpsertBatch } from './products.service';

/**
 * `upsertMany` (fuer das Agenten-Werkzeug `upsert_products`): erst alles
 * pruefen, dann in einer Transaktion schreiben. Die Transaktion ist hier
 * nachgebaut — geschriebene Zeilen landen erst beim Commit im Bestand,
 * ein Fehler verwirft alles wie Postgres beim Rollback.
 */

const ORG = 'org-1';
const EVENT = 'event-1';
const CAT = 'cat-1';
const PROD = 'prod-1';
const user = { id: 'user-1' } as User;

type Row = Record<string, unknown>;

function setup(
  options: {
    settings?: Record<string, unknown>;
    membership?: Row | null;
  } = {},
) {
  const committed = { categories: [] as Row[], products: [] as Row[] };
  const existing: Row[] = [
    { id: PROD, eventId: EVENT, name: 'Bier', price: 4.5, categoryId: CAT },
  ];
  let ids = 0;

  const transaction = jest.fn(
    async (work: (manager: unknown) => Promise<unknown>) => {
      const staged = { categories: [] as Row[], products: [] as Row[] };
      const manager = {
        getRepository: (entity: unknown) => {
          if (entity === Category) {
            return {
              find: () => Promise.resolve([{ id: CAT, eventId: EVENT }]),
              create: (row: Row) => ({ ...row }),
              save: (row: Row) => {
                row.id ??= `cat-new-${++ids}`;
                staged.categories.push(row);
                return Promise.resolve(row);
              },
            };
          }
          if (entity === Product) {
            return {
              findOne: ({
                where,
              }: {
                where: { id: string; eventId: string };
              }) =>
                Promise.resolve(
                  existing
                    .filter(
                      (p) => p.id === where.id && p.eventId === where.eventId,
                    )
                    .map((p) => ({ ...p }))[0] ?? null,
                ),
              create: (row: Row) => ({ ...row }),
              save: (row: Row) => {
                row.id ??= `prod-new-${++ids}`;
                staged.products.push(row);
                return Promise.resolve(row);
              },
            };
          }
          throw new Error('unexpected repository');
        },
      };
      const result = await work(manager);
      committed.categories.push(...staged.categories);
      committed.products.push(...staged.products);
      return result;
    },
  );

  const gateway = { notifyMenuRefresh: jest.fn() };
  const service = new ProductsService(
    { manager: { transaction } } as unknown as Repository<Product>,
    {
      findOne: () =>
        Promise.resolve(
          options.membership === undefined
            ? { role: 'admin', permissions: {} }
            : options.membership,
        ),
    } as never,
    {
      findOne: () =>
        Promise.resolve({
          id: ORG,
          settings: options.settings ?? {
            vatExempt: false,
            address: { country: 'DE' },
          },
        }),
    } as never,
    {} as never,
    {
      findOne: () => Promise.resolve({ id: EVENT, organizationId: ORG }),
    } as never,
    {} as never,
    {} as never,
    gateway as unknown as GatewayService,
  );
  return { service, committed, transaction, gateway };
}

const batch = (overrides: Partial<ProductUpsertBatch> = {}) =>
  ({
    newCategories: ['Essen'],
    create: [
      {
        dto: { name: 'Radler', price: 4.5, taxRate: 19, categoryId: CAT },
        categoryName: 'Getränke',
      },
      {
        dto: { name: 'Bratwurst', price: 3.5, taxRate: 7 },
        categoryName: 'Essen',
      },
    ],
    update: [{ id: PROD, dto: { price: 4.8 } }],
    ...overrides,
  }) as ProductUpsertBatch;

describe('ProductsService.upsertMany', () => {
  it('writes categories, creates and updates in one transaction', async () => {
    const { service, committed, transaction, gateway } = setup();
    const result = await service.upsertMany(EVENT, batch(), user);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result.categories.map((c) => c.name)).toEqual(['Essen']);
    expect(result.created.map((p) => [p.name, p.categoryId])).toEqual([
      ['Radler', CAT],
      ['Bratwurst', result.categories[0].id],
    ]);
    expect(result.updated).toEqual([
      expect.objectContaining({ id: PROD, name: 'Bier', price: 4.8 }),
    ]);
    expect(committed.categories).toHaveLength(1);
    expect(committed.products).toHaveLength(3);
    expect(gateway.notifyMenuRefresh).toHaveBeenCalledTimes(1);
    expect(gateway.notifyMenuRefresh).toHaveBeenCalledWith(
      ORG,
      EVENT,
      'product-upsert',
    );
  });

  it('refuses tax rates a VAT-exempt organization may not use before writing anything', async () => {
    const { service, committed, transaction, gateway } = setup({
      settings: { vatExempt: true, address: { country: 'DE' } },
    });
    await expect(
      service.upsertMany(
        EVENT,
        batch({
          newCategories: [],
          create: [
            { dto: { name: 'A', price: 1, taxRate: 0, categoryId: CAT } },
            { dto: { name: 'B', price: 1, taxRate: 19, categoryId: CAT } },
          ],
          update: [],
        }),
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: 'TAX_RATE_NOT_ALLOWED', params: { rate: 19 } },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(committed.products).toHaveLength(0);
    expect(gateway.notifyMenuRefresh).not.toHaveBeenCalled();
  });

  it('rolls back everything when a later row fails', async () => {
    const { service, committed, gateway } = setup();
    await expect(
      service.upsertMany(
        EVENT,
        batch({ update: [{ id: 'gone', dto: { price: 1 } }] }),
        user,
      ),
    ).rejects.toMatchObject({ response: { reason: 'PRODUCT_NOT_FOUND' } });
    /* Kategorie und zwei neue Produkte waren schon geschrieben — verworfen. */
    expect(committed.categories).toHaveLength(0);
    expect(committed.products).toHaveLength(0);
    expect(gateway.notifyMenuRefresh).not.toHaveBeenCalled();
  });

  it('refuses categories of another event', async () => {
    const { service, committed } = setup();
    await expect(
      service.upsertMany(
        EVENT,
        batch({
          newCategories: [],
          create: [{ dto: { name: 'X', price: 1, categoryId: 'foreign' } }],
          update: [],
        }),
        user,
      ),
    ).rejects.toMatchObject({ response: { reason: 'CATEGORY_NOT_FOUND' } });
    expect(committed.products).toHaveLength(0);
  });

  it('checks the products permission first', async () => {
    const { service, transaction } = setup({
      membership: { role: 'member', permissions: {} },
    });
    await expect(
      service.upsertMany(EVENT, batch(), user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reports the allowed tax rates for the preview', async () => {
    expect(await setup().service.allowedTaxRates(ORG)).toEqual([19, 7, 0]);
    expect(
      await setup({ settings: { vatExempt: true } }).service.allowedTaxRates(
        ORG,
      ),
    ).toEqual([0]);
    expect(await setup({ settings: {} }).service.allowedTaxRates(ORG)).toEqual([
      0,
    ]);
  });
});
