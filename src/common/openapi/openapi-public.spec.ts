import * as fs from 'fs';
import * as path from 'path';

import { ORGANIZATION_TOKEN_SCOPES } from '../../modules/api-tokens/api-scopes';
import { PUBLIC_TAGS, PUBLIC_TAG_ALLOWLIST } from './public-spec';

/**
 * Die oeffentliche Referenz (docs/openapi.public.json, gerendert von
 * openeos-docs) muss lesbar bleiben: jede Operation mit sprechender
 * operationId, deutscher Zusammenfassung und Beschreibung, jeder Tag
 * deklariert. Wer einen Endpunkt per @ApiTokenAccess freigibt, ohne ihn zu
 * beschreiben, sieht es hier — nicht erst in der Seitenleiste der Doku.
 *
 * `pnpm docs:generate` schreibt die Datei; `pnpm docs:check` (CI) prueft,
 * dass sie zum Code passt.
 */

type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: string; description?: string }>;
  security?: Array<Record<string, unknown>>;
  'x-api-token-scope'?: string;
};

type Spec = {
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, Operation>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

function loadSpec(file: string): Spec {
  const specPath = path.resolve(__dirname, '..', '..', '..', 'docs', file);
  return JSON.parse(fs.readFileSync(specPath, 'utf8')) as Spec;
}

function operations(spec: Spec) {
  const result: Array<{ method: string; path: string; op: Operation }> = [];
  for (const [route, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op) result.push({ method: method.toUpperCase(), path: route, op });
    }
  }
  return result;
}

function collectRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRefs(entry, into));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string') into.add(entry);
    else collectRefs(entry, into);
  }
}

describe('docs/openapi.public.json', () => {
  const spec = loadSpec('openapi.public.json');
  const ops = operations(spec);
  const label = ({ method, path: route }: { method: string; path: string }) =>
    `${method} ${route}`;

  it('contains operations', () => {
    expect(ops.length).toBeGreaterThan(0);
  });

  it('every operation has a readable operationId (no Controller_method)', () => {
    const bad = ops
      .filter(({ op }) => !op.operationId || /Controller_/.test(op.operationId))
      .map(label);
    expect(bad).toEqual([]);

    const ids = ops.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every operation has a German summary and a non-empty description', () => {
    const bad = ops
      .filter(
        ({ op }) =>
          !op.summary?.trim() ||
          /Controller_/.test(op.summary) ||
          !op.description?.trim(),
      )
      .map(label);
    expect(bad).toEqual([]);
  });

  it('every operation is public by scope or by tag allowlist', () => {
    const bad = ops
      .filter(({ op }) => {
        const scope = op['x-api-token-scope'];
        const byScope =
          typeof scope === 'string' &&
          (ORGANIZATION_TOKEN_SCOPES as readonly string[]).includes(scope);
        const byTag = (op.tags ?? []).some((tag) =>
          PUBLIC_TAG_ALLOWLIST.some(
            (internal) =>
              PUBLIC_TAGS.find((entry) => entry.internal === internal)?.name ===
              tag,
          ),
        );
        return !byScope && !byTag;
      })
      .map(label);
    expect(bad).toEqual([]);
  });

  it('every tag in use is declared, and every declared tag is in use', () => {
    const declared = new Set((spec.tags ?? []).map((tag) => tag.name));
    const used = new Set(ops.flatMap(({ op }) => op.tags ?? []));

    const undeclared = [...used].filter((tag) => !declared.has(tag));
    expect(undeclared).toEqual([]);

    const unused = [...declared].filter((tag) => !used.has(tag));
    expect(unused).toEqual([]);

    const withoutDescription = (spec.tags ?? [])
      .filter((tag) => !tag.description?.trim())
      .map((tag) => tag.name);
    expect(withoutDescription).toEqual([]);
  });

  it('declares tags in the order of PUBLIC_TAGS', () => {
    const names = (spec.tags ?? []).map((tag) => tag.name);
    const expected = PUBLIC_TAGS.map((tag) => tag.name).filter((name) =>
      names.includes(name),
    );
    expect(names).toEqual(expected);
  });

  it('every path and query parameter has a description', () => {
    const bad = ops.flatMap(({ method, path: route, op }) =>
      (op.parameters ?? [])
        .filter((param) => !param.description?.trim())
        .map((param) => `${method} ${route} → ${param.in} ${param.name}`),
    );
    expect(bad).toEqual([]);
  });

  it('every $ref resolves and no unused schema or security scheme remains', () => {
    const refs = new Set<string>();
    collectRefs(spec.paths, refs);
    collectRefs(spec.components?.schemas, refs);
    const schemas = spec.components?.schemas ?? {};
    const unresolved = [...refs].filter(
      (ref) => !schemas[ref.replace('#/components/schemas/', '')],
    );
    expect(unresolved).toEqual([]);

    const referenced = new Set(
      [...refs].map((ref) => ref.replace('#/components/schemas/', '')),
    );
    const unused = Object.keys(schemas).filter((name) => !referenced.has(name));
    expect(unused).toEqual([]);

    const usedSecurity = new Set(
      ops.flatMap(({ op }) =>
        (op.security ?? []).flatMap((requirement) => Object.keys(requirement)),
      ),
    );
    const unusedSecurity = Object.keys(
      spec.components?.securitySchemes ?? {},
    ).filter((name) => !usedSecurity.has(name));
    expect(unusedSecurity).toEqual([]);
  });

  it('mirrors every organization-token operation of the full spec', () => {
    const full = operations(loadSpec('openapi.json'));
    const expected = full
      .filter(({ op }) => {
        const scope = op['x-api-token-scope'];
        return (
          typeof scope === 'string' &&
          (ORGANIZATION_TOKEN_SCOPES as readonly string[]).includes(scope)
        );
      })
      .map(label)
      .sort();
    const present = new Set(ops.map(label));
    const missing = expected.filter((entry) => !present.has(entry));
    expect(missing).toEqual([]);
  });
});
