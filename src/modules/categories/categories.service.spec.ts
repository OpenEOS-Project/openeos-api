import { ConflictException } from '@nestjs/common';
import { DataSource, IsNull, QueryFailedError, Repository } from 'typeorm';
import {
  Category,
  Event,
  Product,
  User,
  UserOrganization,
} from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { GatewayService } from '../gateway/gateway.service';
import { CategoriesService } from './categories.service';

const EVENT = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const CATEGORY = '11111111-1111-4111-8111-111111111111';
const user = { id: 'user-1' } as User;

function setup(options: { activeProducts?: number; deleteError?: Error }) {
  const managerDelete = jest.fn((entity: unknown, criteria: unknown) => {
    if (options.deleteError && entity === Category) {
      return Promise.reject(options.deleteError);
    }
    void criteria;
    return Promise.resolve({ affected: 1 });
  });
  const dataSource = {
    transaction: jest.fn((run: (manager: unknown) => Promise<unknown>) =>
      run({ delete: managerDelete }),
    ),
  } as unknown as DataSource;
  const removeCategory = jest.fn();
  const categoryRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({ id: CATEGORY, eventId: EVENT, name: 'Vom Grill' }),
    ),
    remove: removeCategory,
  } as unknown as Repository<Category>;
  const countProducts = jest.fn(() =>
    Promise.resolve(options.activeProducts ?? 0),
  );
  const productRepository = {
    count: countProducts,
  } as unknown as Repository<Product>;
  const notifyCategoryDeleted = jest.fn();
  const service = new CategoriesService(
    categoryRepository,
    {
      findOne: jest.fn(() =>
        Promise.resolve({ role: OrganizationRole.ADMIN, permissions: {} }),
      ),
    } as unknown as Repository<UserOrganization>,
    {
      findOne: jest.fn(() =>
        Promise.resolve({ id: EVENT, organizationId: 'org-1' }),
      ),
    } as unknown as Repository<Event>,
    productRepository,
    { notifyCategoryDeleted } as unknown as GatewayService,
    dataSource,
  );
  return {
    service,
    managerDelete,
    countProducts,
    removeCategory,
    notifyCategoryDeleted,
  };
}

describe('CategoriesService.remove (issue #88)', () => {
  it('hard-deletes soft-deleted products first, then the category', async () => {
    const ctx = setup({});
    await ctx.service.remove(EVENT, CATEGORY, user);
    expect(ctx.countProducts).toHaveBeenCalledWith({
      where: { categoryId: CATEGORY, deletedAt: IsNull() },
    });
    expect(ctx.managerDelete).toHaveBeenNthCalledWith(
      1,
      Product,
      expect.objectContaining({ categoryId: CATEGORY }),
    );
    expect(ctx.managerDelete).toHaveBeenNthCalledWith(2, Category, {
      id: CATEGORY,
      eventId: EVENT,
    });
    expect(ctx.removeCategory).not.toHaveBeenCalled();
    expect(ctx.notifyCategoryDeleted).toHaveBeenCalledWith(
      'org-1',
      EVENT,
      CATEGORY,
    );
  });

  it('refuses with 409 CATEGORY_HAS_PRODUCTS while visible products remain', async () => {
    const ctx = setup({ activeProducts: 2 });
    const promise = ctx.service.remove(EVENT, CATEGORY, user);
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({
      response: {
        code: 'CONFLICT',
        reason: 'CATEGORY_HAS_PRODUCTS',
        params: { count: 2 },
      },
    });
    expect(ctx.managerDelete).not.toHaveBeenCalled();
    expect(ctx.notifyCategoryDeleted).not.toHaveBeenCalled();
  });

  it('turns a foreign-key / not-null violation into 409 CATEGORY_IN_USE', async () => {
    const driverError = Object.assign(new Error('null value in column'), {
      code: '23502',
    });
    const ctx = setup({
      deleteError: new QueryFailedError('DELETE', [], driverError),
    });
    const promise = ctx.service.remove(EVENT, CATEGORY, user);
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({
      response: { reason: 'CATEGORY_IN_USE' },
    });
    expect(ctx.notifyCategoryDeleted).not.toHaveBeenCalled();
  });

  it('lets unrelated errors through unchanged', async () => {
    const ctx = setup({ deleteError: new Error('boom') });
    await expect(ctx.service.remove(EVENT, CATEGORY, user)).rejects.toThrow(
      'boom',
    );
  });
});
