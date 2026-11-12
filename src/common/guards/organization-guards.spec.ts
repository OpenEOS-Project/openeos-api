import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Role } from '../constants/roles.enum';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { ORGANIZATION_PERMISSION_KEY } from '../decorators/requires-organization-permission.decorator';
import { ShiftsController } from '../../modules/shifts/shifts.controller';
import { OrganizationGuard } from './organization.guard';
import { OrganizationPermissionGuard } from './organization-permission.guard';
import { OrganizationScopeGuard } from './organization-scope.guard';
import { RolesGuard } from './roles.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const adminOfA = {
  id: USER,
  email: 'a@example.org',
  isSuperAdmin: false,
  organizations: [{ id: A, role: 'admin' }],
};

function context(
  request: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): { ctx: ExecutionContext; reflector: Reflector } {
  const handler = () => undefined;
  const ctx = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
  return { ctx, reflector };
}

function orgRequest(pathOrg: string, header?: string) {
  return {
    user: adminOfA,
    route: { path: '/api/organizations/:organizationId/webhooks' },
    params: { organizationId: pathOrg },
    headers: header ? { 'x-organization-id': header } : {},
    query: {},
    body: {},
  };
}

async function reasonOf(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return ((error as ForbiddenException).getResponse() as { reason: string })
      .reason;
  }
  return undefined;
}

describe('OrganizationGuard / RolesGuard', () => {
  it('checks the organization from the path, not the header', async () => {
    const { ctx, reflector } = context(orgRequest(B, A), {
      [ROLES_KEY]: [Role.ADMIN],
    });
    expect(await reasonOf(() => new OrganizationGuard().canActivate(ctx))).toBe(
      'ORGANIZATION_MISMATCH',
    );
    expect(
      await reasonOf(() => new RolesGuard(reflector).canActivate(ctx)),
    ).toBe('ORGANIZATION_MISMATCH');
  });

  it('refuses a path organization the user is not a member of', async () => {
    const { ctx, reflector } = context(orgRequest(B), {
      [ROLES_KEY]: [Role.ADMIN],
    });
    expect(await reasonOf(() => new OrganizationGuard().canActivate(ctx))).toBe(
      'NOT_ORGANIZATION_MEMBER',
    );
    expect(
      await reasonOf(() => new RolesGuard(reflector).canActivate(ctx)),
    ).toBe('NOT_ORGANIZATION_MEMBER');
  });

  it('accepts the own organization and records it on the request', () => {
    const request = orgRequest(A, A);
    const { ctx, reflector } = context(request, { [ROLES_KEY]: [Role.ADMIN] });
    expect(new OrganizationGuard().canActivate(ctx)).toBe(true);
    expect(new RolesGuard(reflector).canActivate(ctx)).toBe(true);
    expect((request as { organizationId?: string }).organizationId).toBe(A);
  });

  it('requires the role in the path organization', async () => {
    const request = {
      ...orgRequest(B),
      user: {
        ...adminOfA,
        organizations: [
          { id: A, role: 'admin' },
          { id: B, role: 'member' },
        ],
      },
    };
    const { ctx, reflector } = context(request, { [ROLES_KEY]: [Role.ADMIN] });
    expect(
      await reasonOf(() => new RolesGuard(reflector).canActivate(ctx)),
    ).toBe('INSUFFICIENT_PERMISSIONS');
  });
});

describe('OrganizationScopeGuard', () => {
  it('refuses a differing header on any route with an organization in the path', async () => {
    const { ctx } = context(orgRequest(B, A));
    expect(
      await reasonOf(() => new OrganizationScopeGuard().canActivate(ctx)),
    ).toBe('ORGANIZATION_MISMATCH');
  });

  it('leaves routes without an organization in the path alone', () => {
    const { ctx } = context({
      route: { path: '/api/devices/register' },
      params: {},
      headers: { 'x-organization-id': A },
      body: { organizationId: B },
      query: {},
    });
    expect(new OrganizationScopeGuard().canActivate(ctx)).toBe(true);
  });
});

describe('OrganizationPermissionGuard', () => {
  function guard(
    membership: { role: string; permissions: Record<string, boolean> } | null,
    request: Record<string, unknown>,
  ) {
    const findOne = jest.fn(() => Promise.resolve(membership));
    const dataSource = {
      getRepository: () => ({ findOne }),
    } as unknown as DataSource;
    const { ctx, reflector } = context(request, {
      [ORGANIZATION_PERMISSION_KEY]: 'shiftPlans',
    });
    return {
      run: () =>
        new OrganizationPermissionGuard(reflector, dataSource).canActivate(ctx),
      findOne,
    };
  }

  it('lets administrators of the path organization through', async () => {
    const { run, findOne } = guard(
      { role: 'admin', permissions: {} },
      orgRequest(A),
    );
    await expect(run()).resolves.toBe(true);
    expect(findOne).toHaveBeenCalledWith({
      where: { userId: USER, organizationId: A },
    });
  });

  it('lets members with the module permission through', async () => {
    const { run } = guard(
      { role: 'member', permissions: { shiftPlans: true } },
      orgRequest(A),
    );
    await expect(run()).resolves.toBe(true);
  });

  it('refuses members without the module permission', async () => {
    const { run } = guard(
      { role: 'member', permissions: { shiftPlans: false, events: true } },
      orgRequest(A),
    );
    expect(await reasonOf(run)).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('refuses non-members of the path organization', async () => {
    const { run } = guard(null, orgRequest(B));
    expect(await reasonOf(run)).toBe('NOT_ORGANIZATION_MEMBER');
  });

  it('refuses a header naming another organization', async () => {
    const { run, findOne } = guard(
      { role: 'admin', permissions: {} },
      orgRequest(B, A),
    );
    expect(await reasonOf(run)).toBe('ORGANIZATION_MISMATCH');
    expect(findOne).not.toHaveBeenCalled();
  });

  it('protects every shift plan route with the shiftPlans permission', () => {
    expect(
      Reflect.getMetadata(ORGANIZATION_PERMISSION_KEY, ShiftsController),
    ).toBe('shiftPlans');
    expect(Reflect.getMetadata(GUARDS_METADATA, ShiftsController)).toEqual(
      expect.arrayContaining([OrganizationGuard, OrganizationPermissionGuard]),
    );
    const proto = ShiftsController.prototype as unknown as Record<
      string,
      object
    >;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      // keine Methode setzt die Berechtigung zurueck
      expect(
        Reflect.getMetadata(ORGANIZATION_PERMISSION_KEY, proto[name]),
      ).toBeUndefined();
    }
  });
});
