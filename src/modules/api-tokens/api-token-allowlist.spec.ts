import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { API_TOKEN_ACCESS_KEY } from '../../common/decorators/api-token-access.decorator';
import {
  ORGANIZATION_TOKEN_SCOPES,
  PLATFORM_TOKEN_SCOPES,
  TokenScope,
} from './api-scopes';

/**
 * Die Positivliste fuer API-Tokens, aus den Controllern gelesen.
 *
 * Ein Token darf nur Verwaltung (ki-plan.md Abschnitt 5): kein Loeschen,
 * keine Kasse, kein Geld, keine Mitglieder, keine Freischaltung. Wer einen
 * Endpunkt mit @ApiTokenAccess versieht, der dagegen verstoesst, sieht es
 * hier — nicht erst, wenn ein Agent ihn benutzt.
 */

interface AllowlistedRoute {
  method: string;
  path: string;
  scope: TokenScope;
  controller: string;
}

function controllerFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

function joinPath(prefix: string, suffix: string): string {
  const parts = [prefix, suffix]
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return '/' + parts.join('/');
}

export function collectAllowlist(): AllowlistedRoute[] {
  const routes: AllowlistedRoute[] = [];
  const modulesDir = path.resolve(__dirname, '..');
  for (const file of controllerFiles(modulesDir)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const exported: Record<string, unknown> = require(file);
    for (const candidate of Object.values(exported)) {
      if (typeof candidate !== 'function') continue;
      const prefix = Reflect.getMetadata(PATH_METADATA, candidate) as
        | string
        | undefined;
      if (prefix === undefined) continue;
      const proto = (candidate as { prototype: object }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = (proto as Record<string, unknown>)[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const scope = Reflect.getMetadata(API_TOKEN_ACCESS_KEY, handler) as
          | TokenScope
          | undefined;
        if (!scope) continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          | RequestMethod
          | undefined;
        const suffix = Reflect.getMetadata(PATH_METADATA, handler) as string;
        routes.push({
          method: RequestMethod[method ?? RequestMethod.GET],
          path: joinPath(prefix, suffix),
          scope,
          controller: candidate.name,
        });
      }
    }
  }
  return routes.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
}

describe('API token allowlist', () => {
  const routes = collectAllowlist();

  it('has entries', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it('never opens a DELETE endpoint', () => {
    expect(routes.filter((r) => r.method === 'DELETE')).toEqual([]);
  });

  it('never opens POS, money, member, admin or auth endpoints', () => {
    const forbidden = [
      /^\/auth\b/,
      /^\/users\b/,
      /^\/admin\b/,
      /^\/device-api\b/,
      /^\/public\b/,
      /^\/devices\/(init|register|link|lookup|status|me|logout)$/,
      /\/members\b/,
      /\/invitations\b/,
      /^\/organizations\/:organizationId\/payments\b/,
      /\/refunds\b/,
      /\/billing\b/,
      /\/checkout\b/,
      /\/order-invoice\b/,
      /\/invoices\b/,
      /\/sumup\b/,
      /\/menu-imports\b/,
      /\/activate$/,
      /\/deactivate$/,
      /\/test$/,
      /\/api-tokens\b/,
      /\/cancel\b/,
      /\/broadcast$/,
      /\/message$/,
      /\/regenerate-token$/,
      /\/verify$/,
      /\/block$/,
      /\/unblock$/,
    ];
    const violations = routes.filter((r) =>
      forbidden.some((pattern) => pattern.test(r.path)),
    );
    expect(violations).toEqual([]);
  });

  it('orders are read only', () => {
    const orders = routes.filter((r) => /\/orders\b/.test(r.path));
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((r) => r.method === 'GET')).toBe(true);
    expect(orders.every((r) => r.scope === TokenScope.READ)).toBe(true);
  });

  it('GET endpoints need read, mutations need a write scope', () => {
    const readOnly = routes.filter(
      (r) =>
        r.method === 'GET' &&
        r.scope !== TokenScope.READ &&
        r.scope !== TokenScope.MONITORING_READ,
    );
    expect(readOnly).toEqual([]);

    // icon-suggestions und print-template preview sind POSTs, die nichts aendern.
    const harmlessPosts = new Set([
      '/organizations/:organizationId/assistant/icon-suggestions',
      '/organizations/:organizationId/print-templates/:templateId/preview',
    ]);
    const writesWithRead = routes.filter(
      (r) =>
        r.method !== 'GET' &&
        r.scope === TokenScope.READ &&
        !harmlessPosts.has(r.path),
    );
    expect(writesWithRead).toEqual([]);
  });

  it('only uses organization scopes, except the monitoring endpoint', () => {
    for (const route of routes) {
      if (route.path === '/monitoring/metrics') {
        expect(PLATFORM_TOKEN_SCOPES).toContain(route.scope);
      } else {
        expect(ORGANIZATION_TOKEN_SCOPES).toContain(route.scope);
      }
    }
  });

  it('every organization route names the organization or the event in its path', () => {
    const unresolved = routes.filter(
      (r) =>
        r.path !== '/monitoring/metrics' &&
        !/:organizationId\b/.test(r.path) &&
        !/^\/organizations\/:id\b/.test(r.path) &&
        !/^\/events\/:eventId\b/.test(r.path),
    );
    expect(unresolved).toEqual([]);
  });

  it('matches the documented matrix (ki-plan.md section 8)', () => {
    // Wer die Liste aendert, aktualisiert diese Tabelle — und damit die Doku.
    const matrix = routes.map((r) => `${r.scope} ${r.method} ${r.path}`);
    expect(matrix).toMatchSnapshot();
  });
});
