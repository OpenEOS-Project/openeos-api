import type { OpenAPIObject } from '@nestjs/swagger';
import type {
  OperationObject,
  PathItemObject,
  TagObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import { ORGANIZATION_TOKEN_SCOPES } from '../../modules/api-tokens/api-scopes';

/**
 * Die oeffentliche API-Referenz (docs.openeos.de/api) zeigt nur, was fuer
 * Nutzer und Integrationen zaehlt: alles, was ein Organisations-Token
 * erreicht (`x-api-token-scope`), plus die Verwaltung dieser Tokens.
 * Geraete-API, Kasse, Admin, Abrechnung, Anmeldung bleiben in der
 * vollstaendigen Beschreibung (docs/openapi.json, Swagger UI).
 *
 * Die Tags der Controller bleiben englisch (Swagger UI, Code); nach aussen
 * tragen sie deutsche Namen in dieser Reihenfolge. Wer einen Endpunkt fuer
 * Tokens freigibt, dessen Tag hier fehlt, sieht das sofort: der Generator
 * bricht ab.
 */
export const PUBLIC_TAGS: ReadonlyArray<{
  internal: string;
  name: string;
  description: string;
}> = [
  {
    internal: 'Organizations',
    name: 'Organisation',
    description: 'Stammdaten und Einstellungen deiner Organisation',
  },
  {
    internal: 'Events',
    name: 'Veranstaltungen',
    description:
      'Veranstaltungen anlegen, ändern und lesen. Freischalten und aktivieren geht nur in der App.',
  },
  {
    internal: 'Categories',
    name: 'Kategorien',
    description: 'Kategorien je Veranstaltung',
  },
  {
    internal: 'Products',
    name: 'Produkte',
    description:
      'Produkte je Veranstaltung: Preis, Steuersatz, Optionen, Pfand, Bestand und Verfügbarkeit',
  },
  {
    internal: 'Pfand Types',
    name: 'Pfand',
    description: 'Pfandarten der Organisation (z. B. Glas, Becher)',
  },
  {
    internal: 'Tables',
    name: 'Tische & Bereiche',
    description: 'Bereiche, Tische und der Tischplan der Organisation',
  },
  {
    internal: 'Production Stations',
    name: 'Stationen',
    description:
      'Produktionsstationen (Küche, Ausgabe, Bar) je Veranstaltung, an die Bestellpositionen gehen',
  },
  {
    internal: 'Printers',
    name: 'Drucker',
    description:
      'Drucker der Organisation lesen. Anlegen, ändern und Testdruck gehen nur in der App.',
  },
  {
    internal: 'Print Templates',
    name: 'Bon-Vorlagen',
    description: 'Vorlagen für Bons und Bestellzettel',
  },
  {
    internal: 'Shift Plans',
    name: 'Schichtpläne',
    description:
      'Schichtpläne mit Jobs, Schichten und Helfer-Anmeldungen. E-Mail-Versand und Löschen bleiben der App vorbehalten.',
  },
  {
    internal: 'Reports',
    name: 'Berichte',
    description:
      'Auswertungen über Umsatz, Produkte, Zahlarten, Geräte und Bestand. Der Token-Besitzer braucht das Modulrecht „Auswertung“.',
  },
  {
    internal: 'Orders',
    name: 'Bestellungen (nur lesen)',
    description:
      'Bestellungen lesen und auswerten. Anlegen, Kassieren, Stornieren und Erstatten sind der Kasse und der App vorbehalten.',
  },
  {
    internal: 'Devices',
    name: 'Geräte (nur lesen)',
    description:
      'Kassen und Displays der Organisation lesen. Koppeln, sperren und löschen geht nur in der App.',
  },
  {
    internal: 'Assistant',
    name: 'Assistent',
    description:
      'KI-gestützte Hilfen. Nur verfügbar, wenn der Assistent für die Organisation aktiviert ist.',
  },
  {
    internal: 'API Tokens',
    name: 'API-Zugänge',
    description:
      'API-Tokens der Organisation ausstellen und widerrufen — nur mit Anmeldung (JWT) als Administrator, nicht per Token.',
  },
];

/** Tags, deren Operationen auch ohne `x-api-token-scope` oeffentlich sind. */
export const PUBLIC_TAG_ALLOWLIST: readonly string[] = ['API Tokens'];

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

const ORGANIZATION_SCOPES = new Set<string>(ORGANIZATION_TOKEN_SCOPES);

function isPublicOperation(operation: OperationObject): boolean {
  const scope = (operation as unknown as Record<string, unknown>)[
    'x-api-token-scope'
  ];
  if (typeof scope === 'string' && ORGANIZATION_SCOPES.has(scope)) {
    return true;
  }
  return (operation.tags ?? []).some((tag) =>
    PUBLIC_TAG_ALLOWLIST.includes(tag),
  );
}

/** Alle `$ref`-Ziele unter components/schemas, die ein Objekt erreicht. */
function collectSchemaRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectSchemaRefs(entry, into);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string') {
      const match = /^#\/components\/schemas\/(.+)$/.exec(entry);
      if (match) into.add(match[1]);
      continue;
    }
    collectSchemaRefs(entry, into);
  }
}

/**
 * Leitet aus der vollstaendigen Beschreibung die oeffentliche ab: nur
 * freigegebene Operationen, deutsche Tags in fester Reihenfolge, nur die
 * Schemas und Sicherheitsschemata, die davon noch gebraucht werden.
 */
export function buildPublicSpec(
  full: OpenAPIObject,
  options: { description?: string } = {},
): OpenAPIObject {
  const tagByInternal = new Map(PUBLIC_TAGS.map((tag) => [tag.internal, tag]));
  const usedTags = new Set<string>();
  const usedSecurity = new Set<string>();
  const paths: Record<string, PathItemObject> = {};

  for (const [path, item] of Object.entries(full.paths)) {
    const kept: PathItemObject = {};
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation || !isPublicOperation(operation)) continue;

      const tags = (operation.tags ?? []).map((tag) => {
        const mapped = tagByInternal.get(tag);
        if (!mapped) {
          throw new Error(
            `Public OpenAPI: ${method.toUpperCase()} ${path} carries tag "${tag}", ` +
              'which has no entry in PUBLIC_TAGS (src/common/openapi/public-spec.ts).',
          );
        }
        usedTags.add(mapped.name);
        return mapped.name;
      });
      for (const requirement of operation.security ?? []) {
        for (const name of Object.keys(requirement)) usedSecurity.add(name);
      }
      kept[method] = { ...operation, tags };
    }
    if (Object.keys(kept).length) {
      // Pfad-weite Angaben (parameters, summary) uebernehmen, falls vorhanden.
      const { parameters, summary, description } = item;
      paths[path] = {
        ...(summary ? { summary } : {}),
        ...(description ? { description } : {}),
        ...(parameters ? { parameters } : {}),
        ...kept,
      };
    }
  }

  // Schemas transitiv einsammeln: was eine Operation referenziert, und was
  // diese Schemas wiederum referenzieren.
  const allSchemas = full.components?.schemas ?? {};
  const schemaNames = new Set<string>();
  collectSchemaRefs(paths, schemaNames);
  let pending = [...schemaNames];
  while (pending.length) {
    const next = new Set<string>();
    for (const name of pending) {
      collectSchemaRefs(allSchemas[name], next);
    }
    pending = [...next].filter((name) => !schemaNames.has(name));
    for (const name of pending) schemaNames.add(name);
  }
  const schemas = Object.fromEntries(
    Object.entries(allSchemas).filter(([name]) => schemaNames.has(name)),
  );

  const securitySchemes = Object.fromEntries(
    Object.entries(full.components?.securitySchemes ?? {}).filter(([name]) =>
      usedSecurity.has(name),
    ),
  );

  const tags: TagObject[] = PUBLIC_TAGS.filter((tag) =>
    usedTags.has(tag.name),
  ).map(({ name, description }) => ({ name, description }));

  const components: NonNullable<OpenAPIObject['components']> = {
    ...full.components,
    ...(Object.keys(schemas).length ? { schemas } : {}),
    ...(Object.keys(securitySchemes).length ? { securitySchemes } : {}),
  };
  if (!Object.keys(schemas).length) delete components.schemas;
  if (!Object.keys(securitySchemes).length) delete components.securitySchemes;

  return {
    ...full,
    info: {
      ...full.info,
      description: options.description ?? full.info.description,
    },
    tags,
    paths,
    components,
  };
}
