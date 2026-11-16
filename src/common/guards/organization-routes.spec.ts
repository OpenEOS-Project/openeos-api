import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  Logger,
  RequestMethod,
  Type,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { Server } from 'http';
import { ApiTokenThrottlerGuard } from './api-token-throttler.guard';
import { OrganizationGuard } from './organization.guard';
import { OrganizationScopeGuard } from './organization-scope.guard';
import { SuperAdminGuard } from './super-admin.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AppRequest } from '../types/request.types';

/*
 * Matrix ueber alle Routen, die eine Organisation im Pfad nennen
 * (`organizations/:organizationId/...`, `organizations/:id/...`), erzeugt
 * aus den Controller-Metadaten — neue Controller sind automatisch dabei.
 *
 * Benutzer: Administrator von Organisation A, kein Mitglied von B.
 *  1. Pfad B + Header A            -> 403, kein Dienst wird aufgerufen.
 *  2. Pfad B ohne Header (Guards)  -> 403 bei OrganizationGuard-Controllern.
 *  3. Pfad A + Header A            -> keine Organisations-403.
 *  4. Statisch: Handler ohne OrganizationGuard lesen die Organisation aus
 *     dem Pfad (@Param) und geben den Aufrufer an den Dienst weiter;
 *     @CurrentOrganization nur hinter OrganizationGuard.
 */

jest.setTimeout(60_000);

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_ID = randomUUID();

const MODULES = path.resolve(__dirname, '../../modules');

function controllerFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

type Controller = Type<unknown>;

function loadControllers(): Controller[] {
  const found = new Set<Controller>();
  for (const file of controllerFiles(MODULES)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (
        typeof value === 'function' &&
        Reflect.getMetadata(PATH_METADATA, value) !== undefined &&
        Reflect.hasMetadata('__controller__', value)
      ) {
        found.add(value as Controller);
      }
    }
  }
  return [...found];
}

interface Route {
  controller: Controller;
  handler: string;
  method: RequestMethod;
  path: string;
  orgParam: 'organizationId' | 'id';
}

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';

const METHODS: Partial<Record<RequestMethod, Verb>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

function join(...parts: string[]): string {
  return (
    '/' +
    parts
      .flatMap((p) => p.split('/'))
      .filter(Boolean)
      .join('/')
  );
}

function orgParamOf(routePath: string): Route['orgParam'] | null {
  if (/(^|\/):organizationId(\/|$)/.test(routePath)) return 'organizationId';
  if (/^\/organizations\/:id(\/|$)/.test(routePath)) return 'id';
  return null;
}

function routesOf(controllers: Controller[]): Route[] {
  const routes: Route[] = [];
  for (const controller of controllers) {
    const prefixes = [Reflect.getMetadata(PATH_METADATA, controller)].flat();
    const proto = controller.prototype as Record<string, unknown>;
    for (const handler of Object.getOwnPropertyNames(proto)) {
      if (handler === 'constructor') continue;
      const fn = proto[handler];
      if (typeof fn !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as
        | RequestMethod
        | undefined;
      if (method === undefined) continue;
      const subPaths = [Reflect.getMetadata(PATH_METADATA, fn)].flat();
      for (const prefix of prefixes as string[]) {
        for (const sub of subPaths as string[]) {
          const routePath = join(prefix ?? '', sub ?? '');
          const orgParam = orgParamOf(routePath);
          if (orgParam) {
            routes.push({
              controller,
              handler,
              method,
              path: routePath,
              orgParam,
            });
          }
        }
      }
    }
  }
  return routes;
}

function urlFor(route: Route, org: string): string {
  return route.path
    .split('/')
    .map((segment) => {
      if (segment === `:${route.orgParam}`) return org;
      if (segment.startsWith(':')) return randomUUID();
      return segment;
    })
    .join('/');
}

function guardsOf(route: Route): unknown[] {
  const proto = route.controller.prototype as Record<string, unknown>;
  return [
    ...((Reflect.getMetadata(GUARDS_METADATA, route.controller) as
      | unknown[]
      | undefined) ?? []),
    ...((Reflect.getMetadata(
      GUARDS_METADATA,
      proto[route.handler] as object,
    ) as unknown[] | undefined) ?? []),
  ];
}

interface RouteArg {
  index: number;
  data?: unknown;
  factory?: (data: unknown, ctx: ExecutionContext) => unknown;
}

function argsOf(route: Route): { key: string; arg: RouteArg }[] {
  const meta =
    (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      route.controller,
      route.handler,
    ) as Record<string, RouteArg> | undefined) ?? {};
  return Object.entries(meta).map(([key, arg]) => ({ key, arg }));
}

/** Probiert einen eigenen Parameter-Decorator an einer Kunst-Anfrage aus. */
function customArgKind(arg: RouteArg): 'user' | 'organization' | 'other' {
  if (!arg.factory) return 'other';
  const user = { id: 'sentinel-user' };
  const req = {
    user,
    device: { id: 'sentinel-device' },
    params: { organizationId: 'sentinel-org' },
    headers: {},
    query: {},
    body: {},
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  try {
    const value = arg.factory(arg.data, ctx);
    if (value === user || value === 'sentinel-user') return 'user';
    if (value === req.device || value === 'sentinel-device') return 'user';
    if (value === 'sentinel-org') return 'organization';
  } catch {
    return 'other';
  }
  return 'other';
}

/** Jeder Dienst ist eine Attrappe; jeder Aufruf wird mitgeschrieben. */
const serviceCalls: string[] = [];
function mockFor(token: unknown): unknown {
  // Optionen der eingebauten Pipes (ParseUUIDPipe u. a.): Standardwerte
  if (token === Object) return {};
  const name =
    typeof token === 'function'
      ? (token as { name: string }).name
      : String(token);
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (typeof prop === 'symbol') return undefined;
        return (...args: unknown[]) => {
          serviceCalls.push(`${name}.${prop}`);
          void args;
          return undefined;
        };
      },
    },
  );
}

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    req.user = {
      id: USER_ID,
      email: 'admin-a@example.org',
      isSuperAdmin: false,
      organizations: [{ id: ORG_A, role: 'admin' }],
    };
    return true;
  }
}

/** Mitgliedschaften fuer OrganizationPermissionGuard: nur Admin in A. */
const dataSource = {
  getRepository: () => ({
    findOne: ({
      where,
    }: {
      where: { userId: string; organizationId: string };
    }) =>
      Promise.resolve(
        where.userId === USER_ID && where.organizationId === ORG_A
          ? { role: 'admin', permissions: {} }
          : null,
      ),
  }),
};

describe('organization-scoped routes', () => {
  const controllers = loadControllers();
  const routes = routesOf(controllers);
  let app: INestApplication;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers,
      providers: [
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: OrganizationScopeGuard },
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    })
      .useMocker(mockFor)
      // Zaehler-Guard liest beim Start seine Konfiguration (hier Attrappe)
      .overrideGuard(ApiTokenThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    serviceCalls.length = 0;
  });

  it('finds the organization-scoped routes', () => {
    expect(routes.length).toBeGreaterThan(200);
    // Stichproben aus beiden Schreibweisen des Parameters
    const paths = routes.map((r) => r.path);
    expect(paths).toContain('/organizations/:organizationId/webhooks');
    expect(paths).toContain('/organizations/:organizationId/api-tokens');
    expect(paths).toContain('/organizations/:organizationId/shift-plans');
    expect(paths).toContain('/organizations/:id/members');
    expect(paths).toContain('/organizations/:id/waiters');
  });

  it('rejects a header naming another organization than the path, before any service runs', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      const verb = METHODS[route.method];
      if (!verb) continue;
      serviceCalls.length = 0;
      const res = await request(app.getHttpServer() as Server)
        [verb](urlFor(route, ORG_B))
        .set('X-Organization-Id', ORG_A)
        .send({});
      const reason = (res.body as { reason?: string })?.reason;
      if (res.status !== 403 || reason !== 'ORGANIZATION_MISMATCH') {
        failures.push(
          `${verb.toUpperCase()} ${route.path}: ${res.status} ${reason}`,
        );
      }
      if (serviceCalls.length > 0) {
        failures.push(
          `${verb.toUpperCase()} ${route.path}: called ${serviceCalls.join(', ')}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('rejects a body or query organization that differs from the path', async () => {
    const route = routes.find(
      (r) =>
        r.path === '/organizations/:organizationId/webhooks' &&
        r.method === RequestMethod.POST,
    )!;
    const body = await request(app.getHttpServer() as Server)
      .post(urlFor(route, ORG_A))
      .send({ organizationId: ORG_B });
    expect(body.status).toBe(403);
    const query = await request(app.getHttpServer() as Server).get(
      `${urlFor(route, ORG_A)}?organizationId=${ORG_B}`,
    );
    expect(query.status).toBe(403);
    expect(serviceCalls).toEqual([]);
  });

  it('rejects guarded routes of another organization without a header', async () => {
    const guarded = routes.filter((r) =>
      guardsOf(r).includes(OrganizationGuard),
    );
    expect(guarded.length).toBeGreaterThan(50);
    const failures: string[] = [];
    for (const route of guarded) {
      const verb = METHODS[route.method];
      if (!verb) continue;
      serviceCalls.length = 0;
      const res = await request(app.getHttpServer() as Server)
        [verb](urlFor(route, ORG_B))
        .send({});
      if (res.status !== 403 || serviceCalls.length > 0) {
        failures.push(
          `${verb.toUpperCase()} ${route.path}: ${res.status} ${serviceCalls.join(', ')}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('lets the same organization in path and header through the organization checks', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      const verb = METHODS[route.method];
      if (!verb) continue;
      const res = await request(app.getHttpServer() as Server)
        [verb](urlFor(route, ORG_A))
        .set('X-Organization-Id', ORG_A)
        .send({});
      const reason = (res.body as { reason?: string })?.reason;
      if (
        reason === 'ORGANIZATION_MISMATCH' ||
        reason === 'NOT_ORGANIZATION_MEMBER'
      ) {
        failures.push(`${verb.toUpperCase()} ${route.path}: ${reason}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('reads the organization from the path and passes the caller on (routes without OrganizationGuard)', () => {
    const failures: string[] = [];
    for (const route of routes) {
      const args = argsOf(route);
      const guarded = guardsOf(route).includes(OrganizationGuard);
      const usesCurrentOrganization = args.some(
        ({ arg }) => customArgKind(arg) === 'organization',
      );
      if (usesCurrentOrganization && !guarded) {
        failures.push(
          `${route.path} ${route.handler}: @CurrentOrganization without OrganizationGuard`,
        );
      }
      if (guarded) continue;
      const readsPath = args.some(
        ({ key, arg }) =>
          key.startsWith(`${RouteParamtypes.PARAM}:`) &&
          arg.data === route.orgParam,
      );
      const passesCaller = args.some(
        ({ arg }) => customArgKind(arg) === 'user',
      );
      if (!readsPath) {
        failures.push(
          `${route.path} ${route.handler}: organization not read from the path`,
        );
      }
      if (!passesCaller && !isPublic(route) && !superAdminOnly(route)) {
        failures.push(
          `${route.path} ${route.handler}: caller not passed to the service`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});

function isPublic(route: Route): boolean {
  const proto = route.controller.prototype as Record<string, unknown>;
  return (
    Reflect.getMetadata(IS_PUBLIC_KEY, route.controller) === true ||
    Reflect.getMetadata(IS_PUBLIC_KEY, proto[route.handler] as object) === true
  );
}

/** Plattform-Verwaltung: SuperAdminGuard statt Mitgliedschaft. */
function superAdminOnly(route: Route): boolean {
  return guardsOf(route).includes(SuperAdminGuard);
}
