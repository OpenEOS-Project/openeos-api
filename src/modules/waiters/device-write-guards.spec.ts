import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DeviceApiController } from '../devices/device-api.controller';
import { DeviceTablesController } from '../devices/device-tables.controller';
import { DeviceCashbookController } from '../dsfinvk/device-cashbook.controller';
import { WaiterSessionGuard } from './waiter-session.guard';

type Ctor = { prototype: object; name: string };

function routes(controller: Ctor) {
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter(
      (name) => name !== 'constructor' && typeof proto[name] === 'function',
    )
    .map((name) => {
      const handler = proto[name] as object;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        | string
        | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        | RequestMethod
        | undefined;
      if (path === undefined || method === undefined) return null;
      const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ??
        []) as unknown[];
      return {
        route: `${RequestMethod[method]} /${base}/${path}`
          .replace(/\/+/g, '/')
          .replace(/\/$/, ''),
        guarded: guards.includes(WaiterSessionGuard),
      };
    })
    .filter((r): r is { route: string; guarded: boolean } => r !== null);
}

/**
 * bedienungen-plan.md §5 „Pflicht der Sitzung“: alle schreibenden
 * Geraete-Endpunkte laufen durch den WaiterSessionGuard (bei
 * `waiterMode != off` ohne gueltige Sitzung 403).
 */
const REQUIRED = [
  'POST /device-api/orders',
  'POST /device-api/payments',
  'POST /device-api/payments/split',
  'POST /device-api/payments/batch',
  'POST /device-api/pfand-returns',
  'POST /device-api/cash-drawer/open',
  'POST /device-api/sumup/checkout',
  'POST /device-api/orders/:orderId/cancel',
  'POST /device-api/orders/:orderId/cancel-items',
  'POST /device-api/orders/:orderId/refunds',
  'POST /device-api/tables/acknowledge',
  'POST /device-api/order-items/deliver',
  'POST /device-api/orders/complete',
  'POST /device-api/cashbook',
];

/** Schreibend, aber bewusst ohne Sitzung (Druck, Agent, Station, Anmeldung). */
const EXEMPT = [
  'POST /device-api/pfand-returns/:pfandReturnId/print',
  'POST /device-api/printers/discovered',
  'POST /device-api/printers/sync',
  'POST /device-api/verify-pin',
  'POST /device-api/sumup/terminate',
  'POST /device-api/orders/:orderId/refunds/:refundId/reprint',
  'POST /device-api/orders/:orderId/reprint',
  'POST /device-api/station/items/:itemId/ready',
];

describe('waiter session guard on device write endpoints', () => {
  const all = [
    DeviceApiController,
    DeviceTablesController,
    DeviceCashbookController,
  ].flatMap((c) => routes(c as unknown as Ctor));

  it.each(REQUIRED)('%s requires the waiter session', (route) => {
    const found = all.find((r) => r.route === route);
    expect(found).toBeDefined();
    expect(found?.guarded).toBe(true);
  });

  it('every other write endpoint is listed as an exception on purpose', () => {
    const writes = all.filter((r) => !r.route.startsWith('GET '));
    const unlisted = writes
      .filter((r) => !REQUIRED.includes(r.route) && !EXEMPT.includes(r.route))
      .map((r) => r.route);
    expect(unlisted).toEqual([]);
    for (const r of writes.filter((w) => EXEMPT.includes(w.route))) {
      expect(r.guarded).toBe(false);
    }
  });

  it('read endpoints stay without the guard', () => {
    expect(all.filter((r) => r.route.startsWith('GET ') && r.guarded)).toEqual(
      [],
    );
  });
});
