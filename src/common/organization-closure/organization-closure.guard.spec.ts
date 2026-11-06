import { Controller, Delete, Get, Post } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  ClosedOrganizationAccess,
  OrganizationClosureGuard,
} from './organization-closure.guard';
import type {
  OrganizationClosure,
  OrganizationClosureService,
} from './organization-closure.service';

const CLOSED = '11111111-1111-4111-8111-111111111111';
const OPEN = '22222222-2222-4222-8222-222222222222';
const EVENT_OF_CLOSED = '33333333-3333-4333-8333-333333333333';

@Controller('organizations/:organizationId/orders')
class OrdersController {
  @Get()
  list() {}
  @Post(':id/cancel')
  cancel() {}
}

@Controller('organizations/:id/tse')
class TseController {
  @Post('exports')
  @ClosedOrganizationAccess()
  requestExport() {}
  @Post('deactivate')
  deactivate() {}
}

@Controller('organizations')
class OrganizationsController {
  @Delete(':id')
  remove() {}
}

@Controller('events/:eventId/products')
class ProductsController {
  @Post()
  create() {}
}

@Controller('public/shop')
class ShopController {
  @Get(':eventId')
  shop() {}
}

@Controller('admin/retention')
class AdminController {
  @Post('organizations/:organizationId/purge')
  purge() {}
}

@Controller('devices')
class DevicesController {
  @Post('link')
  link() {}
}

function closure(purged = false): OrganizationClosure {
  return {
    closedAt: new Date('2026-11-01T00:00:00Z'),
    finalDeletionAt: new Date('2026-12-01T00:00:00Z'),
    purged,
    readOnly: true,
  };
}

function setup(purged = false) {
  const service = {
    closures: jest.fn((ids: string[]) =>
      Promise.resolve(
        new Map(
          ids.filter((id) => id === CLOSED).map((id) => [id, closure(purged)]),
        ),
      ),
    ),
    organizationOfEvent: jest.fn((id: string) =>
      Promise.resolve(id === EVENT_OF_CLOSED ? CLOSED : null),
    ),
  };
  const guard = new OrganizationClosureGuard(
    new Reflector(),
    service as unknown as OrganizationClosureService,
  );
  return { guard, service };
}

function ctx(
  controller: new () => object,
  handler: string,
  request: {
    method: string;
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
    user?: {
      id: string;
      isSuperAdmin?: boolean;
      organizations: { id: string; role: string }[];
    };
  },
): ExecutionContext {
  const proto = controller.prototype as Record<string, () => void>;
  return {
    getType: () => 'http',
    getClass: () => controller,
    getHandler: () => proto[handler],
    switchToHttp: () => ({
      getRequest: () => ({ params: {}, query: {}, body: {}, ...request }),
    }),
  } as unknown as ExecutionContext;
}

const admin = {
  id: 'u1',
  isSuperAdmin: false,
  organizations: [
    { id: CLOSED, role: 'admin' },
    { id: OPEN, role: 'admin' },
  ],
};
const member = {
  id: 'u2',
  isSuperAdmin: false,
  organizations: [{ id: CLOSED, role: 'member' }],
};

describe('OrganizationClosureGuard (read-only export period, AGB 10.4)', () => {
  it('lets admins read a closed organization', async () => {
    const { guard } = setup();
    await expect(
      guard.canActivate(
        ctx(OrdersController, 'list', {
          method: 'GET',
          params: { organizationId: CLOSED },
          user: admin,
        }),
      ),
    ).resolves.toBe(true);
  });

  it('blocks writes of admins with ORGANIZATION_READ_ONLY', async () => {
    const { guard } = setup();
    await expect(
      guard.canActivate(
        ctx(OrdersController, 'cancel', {
          method: 'POST',
          params: { organizationId: CLOSED, id: 'x' },
          user: admin,
        }),
      ),
    ).rejects.toMatchObject({
      response: { reason: 'ORGANIZATION_READ_ONLY' },
    });
  });

  it('blocks writes of super admins on organization routes too', async () => {
    const { guard } = setup();
    await expect(
      guard.canActivate(
        ctx(OrganizationsController, 'remove', {
          method: 'DELETE',
          params: { id: CLOSED },
          user: { id: 'sa', isSuperAdmin: true, organizations: [] },
        }),
      ),
    ).rejects.toMatchObject({
      response: { reason: 'ORGANIZATION_READ_ONLY' },
    });
  });

  it('allows export endpoints marked @ClosedOrganizationAccess', async () => {
    const { guard } = setup();
    await expect(
      guard.canActivate(
        ctx(TseController, 'requestExport', {
          method: 'POST',
          params: { id: CLOSED },
          user: admin,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(
        ctx(TseController, 'deactivate', {
          method: 'POST',
          params: { id: CLOSED },
          user: admin,
        }),
      ),
    ).rejects.toMatchObject({
      response: { reason: 'ORGANIZATION_READ_ONLY' },
    });
  });

  it('shuts out non-admin members completely', async () => {
    const { guard } = setup();
    await expect(
      guard.canActivate(
        ctx(OrdersController, 'list', {
          method: 'GET',
          params: { organizationId: CLOSED },
          user: member,
        }),
      ),
    ).rejects.toMatchObject({ response: { reason: 'ORGANIZATION_CLOSED' } });
  });

  it('shuts out admins after the final deletion', async () => {
    const { guard } = setup(true);
    await expect(
      guard.canActivate(
        ctx(OrdersController, 'list', {
          method: 'GET',
          params: { organizationId: CLOSED },
          user: admin,
        }),
      ),
    ).rejects.toMatchObject({ response: { reason: 'ORGANIZATION_CLOSED' } });
  });

  it('resolves the organization of events/:eventId routes', async () => {
    const { guard } = setup();
    await expect(
      guard.canActivate(
        ctx(ProductsController, 'create', {
          method: 'POST',
          params: { eventId: EVENT_OF_CLOSED },
          user: admin,
        }),
      ),
    ).rejects.toMatchObject({
      response: { reason: 'ORGANIZATION_READ_ONLY' },
    });
  });

  it('checks organizationId in the body (e.g. linking a device)', async () => {
    const { guard } = setup();
    await expect(
      guard.canActivate(
        ctx(DevicesController, 'link', {
          method: 'POST',
          body: { organizationId: CLOSED, code: '123' },
          user: admin,
        }),
      ),
    ).rejects.toMatchObject({
      response: { reason: 'ORGANIZATION_READ_ONLY' },
    });
  });

  it('answers 404 on public pages of a closed organization', async () => {
    const { guard } = setup();
    await expect(
      guard.canActivate(
        ctx(ShopController, 'shop', {
          method: 'GET',
          params: { eventId: EVENT_OF_CLOSED },
        }),
      ),
    ).rejects.toMatchObject({
      status: 404,
      response: { reason: 'ORGANIZATION_CLOSED' },
    });
  });

  it('leaves open organizations and admin routes alone', async () => {
    const { guard, service } = setup();
    await expect(
      guard.canActivate(
        ctx(OrdersController, 'cancel', {
          method: 'POST',
          params: { organizationId: OPEN, id: 'x' },
          user: admin,
        }),
      ),
    ).resolves.toBe(true);
    service.closures.mockClear();
    await expect(
      guard.canActivate(
        ctx(AdminController, 'purge', {
          method: 'POST',
          params: { organizationId: CLOSED },
          user: { id: 'sa', isSuperAdmin: true, organizations: [] },
        }),
      ),
    ).resolves.toBe(true);
    expect(service.closures).not.toHaveBeenCalled();
  });
});
