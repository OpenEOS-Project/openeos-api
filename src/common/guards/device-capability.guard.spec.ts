import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DeviceAuthGuard } from './device-auth.guard';
import { DeviceCapabilityGuard } from './device-capability.guard';
import { DEVICE_CAPABILITY_KEY } from '../decorators/device-capability.decorator';
import {
  DeviceCapabilityName,
  deviceCapabilities,
} from '../constants/device-capabilities';

type DeviceShape = { type: string; settings?: { displayMode?: string } };

const DEVICES: Record<string, DeviceShape> = {
  pos: { type: 'pos' },
  admin: { type: 'admin' },
  customerDisplay: { type: 'display', settings: { displayMode: 'customer' } },
  displayWithoutMode: { type: 'display', settings: {} },
  stationDisplay: { type: 'display', settings: { displayMode: 'station' } },
  printerAgent: { type: 'printer_agent' },
  unknown: { type: 'something-else' },
};

interface Route {
  route: string;
  controller: string;
  handler: string;
  guards: unknown[];
  capability: DeviceCapabilityName | undefined;
}

function joinPath(base: string, sub: string): string {
  return [base, sub]
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/** Alle Controller-Dateien unter src, die Geraete-Endpunkte enthalten. */
function deviceRoutes(): Route[] {
  const root = path.join(__dirname, '../..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name.endsWith('.controller.ts') &&
        /device-api|DeviceAuthGuard/.test(fs.readFileSync(full, 'utf8'))
      ) {
        files.push(full);
      }
    }
  };
  walk(root);
  const routes: Route[] = [];
  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function') continue;
      const controller = value as new (...args: unknown[]) => unknown;
      const base = Reflect.getMetadata(PATH_METADATA, controller) as
        | string
        | undefined;
      if (base === undefined) continue;
      const classGuards =
        (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? [];
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler) as
          | string
          | undefined;
        if (sub === undefined) continue;
        const method = Reflect.getMetadata(
          METHOD_METADATA,
          handler,
        ) as RequestMethod;
        const guards = [
          ...classGuards,
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ??
            []),
        ];
        const capability = (Reflect.getMetadata(
          DEVICE_CAPABILITY_KEY,
          handler,
        ) ?? Reflect.getMetadata(DEVICE_CAPABILITY_KEY, controller)) as
          | DeviceCapabilityName
          | undefined;
        routes.push({
          route: `${RequestMethod[method]} /${joinPath(base, sub)}`,
          controller: controller.name,
          handler: name,
          guards,
          capability,
        });
      }
    }
  }
  return routes;
}

function contextFor(
  device: DeviceShape | undefined,
  capability: DeviceCapabilityName | undefined,
): ExecutionContext {
  const handler = () => undefined;
  if (capability)
    Reflect.defineMetadata(DEVICE_CAPABILITY_KEY, capability, handler);
  class Host {}
  return {
    switchToHttp: () => ({ getRequest: () => ({ device }) }),
    getHandler: () => handler,
    getClass: () => Host,
  } as unknown as ExecutionContext;
}

describe('Device capabilities', () => {
  const routes = deviceRoutes();
  const deviceAuthed = routes.filter((r) => r.guards.includes(DeviceAuthGuard));

  it('finds the device endpoints', () => {
    expect(deviceAuthed.length).toBeGreaterThan(60);
  });

  it('every device-api route is authenticated by device token', () => {
    const unguarded = routes
      .filter((r) => r.route.split(' ')[1].startsWith('/device-api'))
      .filter((r) => !r.guards.includes(DeviceAuthGuard))
      .map((r) => r.route);
    expect(unguarded).toEqual([]);
  });

  it('every device route checks the device type after authentication', () => {
    const missing = deviceAuthed
      .filter(
        (r) =>
          r.guards.indexOf(DeviceCapabilityGuard) <
          r.guards.indexOf(DeviceAuthGuard),
      )
      .map((r) => r.route);
    expect(missing).toEqual([]);
  });

  it('every device route declares a capability', () => {
    const undeclared = deviceAuthed
      .filter((r) => !r.capability)
      .map((r) => `${r.route} (${r.controller}.${r.handler})`);
    expect(undeclared).toEqual([]);
  });

  function allowedRoutes(device: DeviceShape): string[] {
    const capabilities = deviceCapabilities(device as never);
    return deviceAuthed
      .filter((r) => r.capability && capabilities.has(r.capability))
      .map((r) => r.route)
      .sort();
  }

  it('a printer agent reaches only its printers and templates', () => {
    expect(allowedRoutes(DEVICES.printerAgent)).toEqual([
      'GET /device-api/printers',
      'GET /device-api/templates',
      'POST /device-api/printers/discovered',
      'POST /device-api/printers/sync',
    ]);
  });

  it('a customer display reaches only the organization', () => {
    expect(allowedRoutes(DEVICES.customerDisplay)).toEqual([
      'GET /device-api/organization',
    ]);
    expect(allowedRoutes(DEVICES.displayWithoutMode)).toEqual([
      'GET /device-api/organization',
    ]);
  });

  it('a station display reaches the organization and its station items', () => {
    expect(allowedRoutes(DEVICES.stationDisplay)).toEqual([
      'GET /device-api/organization',
      'GET /device-api/station/items',
      'POST /device-api/station/items/:itemId/ready',
    ]);
  });

  it('a till takes orders, payments and refunds but not printer or station endpoints', () => {
    for (const till of [DEVICES.pos, DEVICES.admin]) {
      const allowed = allowedRoutes(till);
      expect(allowed).toEqual(
        expect.arrayContaining([
          'POST /device-api/orders',
          'POST /device-api/payments',
          'POST /device-api/payments/split',
          'POST /device-api/payments/batch',
          'POST /device-api/orders/:orderId/refunds',
          'POST /device-api/orders/:orderId/cancel',
          'POST /device-api/waiter-session',
          'POST /device-api/cashbook',
          'POST /device-api/tokens/sales',
          'GET /device-api/events/:eventId/products',
        ]),
      );
      expect(allowed).not.toContain('GET /device-api/printers');
      expect(allowed).not.toContain('GET /device-api/templates');
      expect(allowed).not.toContain('GET /device-api/station/items');
    }
  });

  it('displays and printer agents cannot take orders, payments or refunds', () => {
    const sales = deviceAuthed
      .filter((r) => r.capability === DeviceCapabilityName.SALES)
      .map((r) => r.route);
    expect(sales).toEqual(
      expect.arrayContaining([
        'POST /device-api/orders',
        'POST /device-api/payments/split',
        'POST /device-api/orders/:orderId/refunds',
      ]),
    );
    for (const device of [
      DEVICES.customerDisplay,
      DEVICES.stationDisplay,
      DEVICES.printerAgent,
      DEVICES.unknown,
    ]) {
      const allowed = allowedRoutes(device);
      expect(allowed.filter((route) => sales.includes(route))).toEqual([]);
    }
  });

  describe('guard', () => {
    const guard = new DeviceCapabilityGuard(new Reflector());

    it('lets a device through when its type has the capability', () => {
      expect(
        guard.canActivate(contextFor(DEVICES.pos, DeviceCapabilityName.SALES)),
      ).toBe(true);
      expect(
        guard.canActivate(
          contextFor(DEVICES.stationDisplay, DeviceCapabilityName.STATION),
        ),
      ).toBe(true);
    });

    it('answers 403 DEVICE_TYPE_NOT_ALLOWED otherwise', () => {
      for (const [device, capability] of [
        [DEVICES.customerDisplay, DeviceCapabilityName.SALES],
        [DEVICES.printerAgent, DeviceCapabilityName.SALES],
        [DEVICES.customerDisplay, DeviceCapabilityName.STATION],
        [DEVICES.pos, DeviceCapabilityName.PRINTING],
        [DEVICES.unknown, DeviceCapabilityName.ORGANIZATION],
      ] as const) {
        try {
          guard.canActivate(contextFor(device, capability));
          throw new Error('expected a rejection');
        } catch (error) {
          expect(error).toBeInstanceOf(ForbiddenException);
          expect((error as ForbiddenException).getResponse()).toMatchObject({
            reason: 'DEVICE_TYPE_NOT_ALLOWED',
          });
        }
      }
    });

    it('rejects endpoints without a declared capability', () => {
      expect(() =>
        guard.canActivate(contextFor(DEVICES.pos, undefined)),
      ).toThrow(ForbiddenException);
    });
  });
});
