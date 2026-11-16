import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../../database/entities';
import { OrganizationApiTokensController } from '../api-tokens/organization-api-tokens.controller';
import type { ApiTokensService } from '../api-tokens/api-tokens.service';
import { WebhooksController } from './webhooks.controller';
import type { WebhooksService } from './webhooks.service';

/*
 * Webhooks und API-Zugaenge pruefen die Rolle zusaetzlich zu den Guards
 * direkt gegen die Organisation aus dem Pfad: hier ohne Guards aufgerufen,
 * als Administrator von A mit Pfad B.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

const adminOfA = {
  id: 'user-1',
  isSuperAdmin: false,
  organizations: [{ id: A, role: 'admin' }],
} as unknown as User;
const memberOfB = {
  id: 'user-2',
  isSuperAdmin: false,
  organizations: [{ id: B, role: 'member' }],
} as unknown as User;
const req = { ip: '127.0.0.1', headers: {} } as unknown as Request;

function serviceMock<T>(): { mock: T; calls: () => number } {
  const fns: jest.Mock[] = [];
  const mock = new Proxy(
    {},
    {
      get: () => {
        const fn = jest.fn(() => Promise.resolve({}));
        fns.push(fn);
        return fn;
      },
    },
  ) as T;
  return { mock, calls: () => fns.filter((f) => f.mock.calls.length).length };
}

describe('webhooks and API tokens: organization from the path', () => {
  const webhookCalls = (c: WebhooksController, user: User, org: string) => [
    () => c.list(org, user),
    () => c.create(org, user, {} as never, req),
    () => c.get(org, ID, user),
    () => c.update(org, ID, user, {} as never, req),
    () => c.remove(org, ID, user, req),
    () => c.rotate(org, ID, user, req),
    () => c.test(org, ID, user),
    () => c.deliveries(org, ID, user, {} as never),
    () => c.delivery(org, ID, ID, user),
    () => c.redeliver(org, ID, ID, user),
  ];
  const tokenCalls = (
    c: OrganizationApiTokensController,
    user: User,
    org: string,
  ) => [
    () => c.list(org, user),
    () => c.create(org, user, { name: 'x', scopes: [] } as never, req),
    () => c.revoke(org, ID, user, req),
  ];

  it.each([
    ['administrator of another organization', adminOfA],
    ['member without admin role', memberOfB],
  ])('refuses the %s before calling the service', async (_label, user) => {
    const hooks = serviceMock<WebhooksService>();
    const tokens = serviceMock<ApiTokensService>();
    const calls = [
      ...webhookCalls(new WebhooksController(hooks.mock), user, B),
      ...tokenCalls(new OrganizationApiTokensController(tokens.mock), user, B),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(hooks.calls()).toBe(0);
    expect(tokens.calls()).toBe(0);
  });

  it('serves administrators of the path organization', async () => {
    const hooks = serviceMock<WebhooksService>();
    const tokens = serviceMock<ApiTokensService>();
    const calls = [
      ...webhookCalls(new WebhooksController(hooks.mock), adminOfA, A),
      ...tokenCalls(
        new OrganizationApiTokensController(tokens.mock),
        adminOfA,
        A,
      ),
    ];
    for (const call of calls) {
      await expect(call()).resolves.toBeDefined();
    }
  });
});
