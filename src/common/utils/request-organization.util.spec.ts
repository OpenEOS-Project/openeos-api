import { ForbiddenException } from '@nestjs/common';
import type { AppRequest } from '../types/request.types';
import {
  resolveRequestOrganizationId,
  routeOrganizationId,
} from './request-organization.util';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function req(parts: {
  route?: string;
  params?: Record<string, string>;
  header?: string | string[];
  body?: unknown;
  query?: Record<string, unknown>;
}): AppRequest {
  return {
    route: parts.route ? { path: parts.route } : undefined,
    params: parts.params ?? {},
    headers:
      parts.header !== undefined ? { 'x-organization-id': parts.header } : {},
    body: parts.body,
    query: parts.query ?? {},
  } as unknown as AppRequest;
}

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return ((error as ForbiddenException).getResponse() as { reason: string })
      .reason;
  }
  return undefined;
}

describe('resolveRequestOrganizationId', () => {
  it('uses the path parameter', () => {
    expect(
      resolveRequestOrganizationId(
        req({
          route: '/api/organizations/:organizationId/webhooks',
          params: { organizationId: B },
        }),
      ),
    ).toBe(B);
  });

  it('treats :id of the organization routes as the organization', () => {
    const request = req({
      route: '/api/organizations/:id/waiters',
      params: { id: B },
    });
    expect(routeOrganizationId(request)).toBe(B);
    expect(resolveRequestOrganizationId(request)).toBe(B);
  });

  it('does not treat :id of other routes as an organization', () => {
    const request = req({
      route: '/api/organizations/:organizationId/invoices/:id',
      params: { organizationId: A, id: B },
    });
    expect(resolveRequestOrganizationId(request)).toBe(A);
    expect(
      routeOrganizationId(req({ route: '/api/events/:id', params: { id: B } })),
    ).toBeUndefined();
  });

  it('refuses a header that names another organization than the path', () => {
    expect(
      reasonOf(() =>
        resolveRequestOrganizationId(
          req({
            route: '/api/organizations/:organizationId/webhooks',
            params: { organizationId: B },
            header: A,
          }),
        ),
      ),
    ).toBe('ORGANIZATION_MISMATCH');
  });

  it('refuses repeated headers with differing values', () => {
    expect(
      reasonOf(() =>
        resolveRequestOrganizationId(
          req({
            route: '/api/organizations/:organizationId/webhooks',
            params: { organizationId: B },
            header: [B, A],
          }),
        ),
      ),
    ).toBe('ORGANIZATION_MISMATCH');
  });

  it('refuses body or query naming another organization than the path', () => {
    const route = '/api/organizations/:organizationId/reports/sales';
    expect(
      reasonOf(() =>
        resolveRequestOrganizationId(
          req({
            route,
            params: { organizationId: B },
            body: { organizationId: A },
          }),
        ),
      ),
    ).toBe('ORGANIZATION_MISMATCH');
    expect(
      reasonOf(() =>
        resolveRequestOrganizationId(
          req({
            route,
            params: { organizationId: B },
            query: { organizationId: A },
          }),
        ),
      ),
    ).toBe('ORGANIZATION_MISMATCH');
  });

  it('accepts a header equal to the path', () => {
    expect(
      resolveRequestOrganizationId(
        req({
          route: '/api/organizations/:organizationId/webhooks',
          params: { organizationId: A },
          header: A,
        }),
      ),
    ).toBe(A);
  });

  it('falls back to header, body, query without an organization in the path', () => {
    expect(resolveRequestOrganizationId(req({ header: A }))).toBe(A);
    expect(
      resolveRequestOrganizationId(req({ body: { organizationId: A } })),
    ).toBe(A);
    expect(
      resolveRequestOrganizationId(req({ query: { organizationId: A } })),
    ).toBe(A);
    expect(resolveRequestOrganizationId(req({}))).toBeUndefined();
    expect(
      reasonOf(() =>
        resolveRequestOrganizationId(
          req({ header: A, query: { organizationId: B } }),
        ),
      ),
    ).toBe('ORGANIZATION_MISMATCH');
  });

  it('ignores empty and non-string values', () => {
    expect(
      resolveRequestOrganizationId(
        req({
          route: '/api/organizations/:organizationId/webhooks',
          params: { organizationId: A },
          header: '',
          body: { organizationId: 42 },
        }),
      ),
    ).toBe(A);
  });
});
