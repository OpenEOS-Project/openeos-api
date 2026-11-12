import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';

import type {
  Category,
  Event,
  Organization,
  PfandType,
  Product,
  StockMovement,
  User,
  UserOrganization,
} from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorReasons } from '../../common/constants/error-codes';
import { fakeReferenceDb } from '../../common/utils/organization-references.fake-spec';
import type { GatewayService } from '../gateway/gateway.service';
import { CategoriesService } from '../categories/categories.service';
import { EventsService } from '../events/events.service';
import { ProductsService } from './products.service';

/**
 * Kategorien und Produkte verweisen nur auf Datensaetze derselben
 * Organisation bzw. Veranstaltung (Kategorie, Pfand-Typ, Station).
 */

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const EVENT = '10000000-0000-4000-8000-000000000001';
const OTHER_EVENT = '10000000-0000-4000-8000-000000000002';
const CAT = '20000000-0000-4000-8000-000000000001';
const CHILD_CAT = '20000000-0000-4000-8000-000000000004';
const FOREIGN_CAT = '20000000-0000-4000-8000-000000000002';
const PFAND = '30000000-0000-4000-8000-000000000001';
const FOREIGN_PFAND = '30000000-0000-4000-8000-000000000002';
const STATION = '70000000-0000-4000-8000-000000000001';
const FOREIGN_STATION = '70000000-0000-4000-8000-000000000002';
const PRODUCT = '60000000-0000-4000-8000-000000000001';

const user = { id: 'user-1' } as User;

const tables = () =>
  fakeReferenceDb({
    events: [
      { id: EVENT, organization_id: ORG },
      { id: OTHER_EVENT, organization_id: OTHER_ORG },
    ],
    categories: [
      { id: CAT, event_id: EVENT },
      { id: CHILD_CAT, event_id: EVENT },
      { id: FOREIGN_CAT, event_id: OTHER_EVENT },
    ],
    pfand_types: [
      { id: PFAND, organization_id: ORG },
      { id: FOREIGN_PFAND, organization_id: OTHER_ORG },
    ],
    production_stations: [
      { id: STATION, event_id: EVENT },
      { id: FOREIGN_STATION, event_id: OTHER_EVENT },
    ],
  });

const admin = {
  findOne: jest.fn(() =>
    Promise.resolve({ role: OrganizationRole.ADMIN, permissions: {} }),
  ),
} as unknown as Repository<UserOrganization>;
const events = {
  findOne: jest.fn(() => Promise.resolve({ id: EVENT, organizationId: ORG })),
} as unknown as Repository<Event>;
const gateway = {
  notifyCategoryUpdated: jest.fn(),
  notifyProductUpdated: jest.fn(),
  notifyMenuRefresh: jest.fn(),
} as unknown as GatewayService;

function categories(options: { cycle?: boolean } = {}) {
  const fake = tables();
  const query = jest.fn((sql: string, params?: unknown[]) =>
    sql.includes('WITH RECURSIVE')
      ? Promise.resolve(options.cycle ? [{ '?column?': 1 }] : [])
      : fake.query(sql, params),
  );
  const save = jest.fn((row: unknown) => Promise.resolve(row));
  const repository = {
    create: (row: object) => ({ id: 'new-cat', ...row }),
    save,
    findOne: jest.fn(() =>
      Promise.resolve({ id: CAT, eventId: EVENT, name: 'Getränke' }),
    ),
  } as unknown as Repository<Category>;
  const service = new CategoriesService(
    repository,
    admin,
    events,
    {} as Repository<Product>,
    gateway,
    { query } as unknown as DataSource,
  );
  return { service, save };
}

function products() {
  const fake = tables();
  const save = jest.fn((row: unknown) => Promise.resolve(row));
  const transaction = jest.fn();
  const repository = {
    create: (row: object) => ({ id: PRODUCT, ...row }),
    save,
    findOne: jest.fn(() =>
      Promise.resolve({ id: PRODUCT, eventId: EVENT, categoryId: CAT }),
    ),
    manager: { query: fake.query, transaction },
  } as unknown as Repository<Product>;
  const service = new ProductsService(
    repository,
    admin,
    {} as Repository<Organization>,
    {} as Repository<StockMovement>,
    events,
    {} as Repository<Category>,
    {} as Repository<PfandType>,
    gateway,
  );
  return { service, save, transaction };
}

describe('category references', () => {
  it('creates a subcategory under a category of the same event', async () => {
    const { service, save } = categories();
    await service.create(EVENT, { name: 'Bier', parentId: CAT }, user);
    expect(save).toHaveBeenCalled();
  });

  it('rejects a parent category from another organization', async () => {
    const { service, save } = categories();
    await expect(
      service.create(EVENT, { name: 'Bier', parentId: FOREIGN_CAT }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a production station from another organization', async () => {
    const { service } = categories();
    await expect(
      service.update(
        EVENT,
        CAT,
        { productionStationId: FOREIGN_STATION },
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: ErrorReasons.PRODUCTION_STATION_NOT_FOUND },
    });
  });

  it('rejects moving a category below one of its subcategories', async () => {
    const { service, save } = categories({ cycle: true });
    await expect(
      service.update(EVENT, CAT, { parentId: CHILD_CAT }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('product references', () => {
  const base = { name: 'Pils', price: 3.5, taxRate: undefined };

  it('creates a product with category, deposit type and station of its own organization', async () => {
    const { service, save } = products();
    await service.create(
      EVENT,
      {
        ...base,
        categoryId: CAT,
        pfandTypeId: PFAND,
        productionStationId: STATION,
      } as never,
      user,
    );
    expect(save).toHaveBeenCalled();
  });

  it('rejects a deposit type from another organization', async () => {
    const { service, save } = products();
    await expect(
      service.create(
        EVENT,
        { ...base, categoryId: CAT, pfandTypeId: FOREIGN_PFAND } as never,
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: ErrorReasons.DEPOSIT_TYPE_NOT_FOUND },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects moving a product into a category of another organization', async () => {
    const { service, save } = products();
    await expect(
      service.update(EVENT, PRODUCT, { categoryId: FOREIGN_CAT }, user),
    ).rejects.toMatchObject({
      response: { reason: ErrorReasons.CATEGORY_NOT_FOUND },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('checks deposit types and stations of a batch before writing', async () => {
    const { service, transaction } = products();
    await expect(
      service.upsertMany(
        EVENT,
        {
          newCategories: [],
          create: [
            {
              dto: {
                ...base,
                categoryId: CAT,
                productionStationId: FOREIGN_STATION,
              } as never,
            },
          ],
          update: [],
        },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('catalog copy', () => {
  it('only copies from events of the same organization', async () => {
    const findOne = jest.fn(({ where }: { where: Record<string, string> }) =>
      Promise.resolve(
        where.id === OTHER_EVENT && where.organizationId === ORG
          ? null
          : { id: where.id, organizationId: OTHER_ORG },
      ),
    );
    const service = new EventsService(
      { findOne } as never,
      {} as never,
      admin,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      gateway,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
    );
    jest
      .spyOn(service, 'findOne')
      .mockResolvedValue({ id: EVENT, organizationId: ORG } as never);
    await expect(
      service.copyFromEvent(ORG, EVENT, OTHER_EVENT, {}, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findOne).toHaveBeenCalledWith({
      where: { id: OTHER_EVENT, organizationId: ORG },
    });
  });
});
