import { BadRequestException } from '@nestjs/common';

import {
  ErrorCodes,
  ErrorReasons,
  type ErrorReason,
} from '../constants/error-codes';

/**
 * Verweise in Anfragen (z. B. `categoryId`, `pfandTypeId`, `eventId`)
 * zeigen nur auf Datensaetze derselben Organisation — und bei Daten einer
 * Veranstaltung (Kategorien, Produkte, Stationen) auf dieselbe
 * Veranstaltung. Eine Stelle fuer diese Pruefung, damit nicht jeder Dienst
 * seine eigene Abfrage schreibt und keiner sie vergisst.
 *
 * Unbekannte, fremde und geloeschte Datensaetze fuehren zur selben Antwort
 * (400 mit dem Grund der Art, z. B. CATEGORY_NOT_FOUND): wer die ID nicht
 * kennt, erfaehrt nicht, ob es sie anderswo gibt.
 */
export type ReferenceKind =
  | 'event'
  | 'category'
  | 'product'
  | 'productionStation'
  | 'pfandType'
  | 'printer'
  | 'printTemplate'
  | 'order'
  | 'orderItem'
  | 'tokenType'
  | 'waiter'
  | 'device'
  | 'tableArea';

interface ReferenceSpec {
  table: string;
  /**
   * `organization`: Tabelle hat `organization_id`.
   * `event`: Tabelle hat `event_id`, die Organisation kommt ueber `events`.
   * `order`: Tabelle hat `order_id`, die Organisation kommt ueber `orders`.
   */
  scope: 'organization' | 'event' | 'order';
  /** Tabelle kennt `deleted_at` (weich geloescht = nicht vorhanden). */
  softDelete?: boolean;
  reason: ErrorReason;
  message: string;
}

const REFERENCES: Record<ReferenceKind, ReferenceSpec> = {
  event: {
    table: 'events',
    scope: 'organization',
    softDelete: true,
    reason: ErrorReasons.EVENT_NOT_FOUND,
    message: 'Veranstaltung nicht gefunden',
  },
  category: {
    table: 'categories',
    scope: 'event',
    reason: ErrorReasons.CATEGORY_NOT_FOUND,
    message: 'Kategorie nicht gefunden',
  },
  product: {
    table: 'products',
    scope: 'event',
    softDelete: true,
    reason: ErrorReasons.PRODUCT_NOT_FOUND,
    message: 'Produkt nicht gefunden',
  },
  productionStation: {
    table: 'production_stations',
    scope: 'event',
    reason: ErrorReasons.PRODUCTION_STATION_NOT_FOUND,
    message: 'Produktionsstandort nicht gefunden',
  },
  pfandType: {
    table: 'pfand_types',
    scope: 'organization',
    reason: ErrorReasons.DEPOSIT_TYPE_NOT_FOUND,
    message: 'Pfand-Typ nicht gefunden',
  },
  printer: {
    table: 'printers',
    scope: 'organization',
    reason: ErrorReasons.PRINTER_NOT_FOUND,
    message: 'Drucker nicht gefunden',
  },
  printTemplate: {
    table: 'print_templates',
    scope: 'organization',
    reason: ErrorReasons.PRINT_TEMPLATE_NOT_FOUND,
    message: 'Druckvorlage nicht gefunden',
  },
  order: {
    table: 'orders',
    scope: 'organization',
    reason: ErrorReasons.ORDER_NOT_FOUND,
    message: 'Bestellung nicht gefunden',
  },
  orderItem: {
    table: 'order_items',
    scope: 'order',
    reason: ErrorReasons.ORDER_ITEM_NOT_FOUND,
    message: 'Bestellposition nicht gefunden',
  },
  tokenType: {
    table: 'token_types',
    scope: 'organization',
    reason: ErrorReasons.TOKEN_TYPE_NOT_FOUND,
    message: 'Markentyp nicht gefunden',
  },
  waiter: {
    table: 'waiters',
    scope: 'organization',
    reason: ErrorReasons.WAITER_NOT_FOUND,
    message: 'Bedienung nicht gefunden',
  },
  device: {
    table: 'devices',
    scope: 'organization',
    reason: ErrorReasons.DEVICE_NOT_FOUND,
    message: 'Gerät nicht gefunden',
  },
  tableArea: {
    table: 'table_areas',
    scope: 'organization',
    reason: ErrorReasons.TABLE_AREA_NOT_FOUND,
    message: 'Bereich nicht gefunden',
  },
};

export interface ReferenceCheck {
  kind: ReferenceKind;
  /** Eine ID, mehrere oder nichts (leer = nichts zu pruefen). */
  ids: string | readonly string[] | null | undefined;
  /** Feldname fuer die Fehlermeldung (`params.field`). */
  field?: string;
}

export interface ReferenceScope {
  organizationId: string;
  /**
   * Bei Daten einer Veranstaltung: genau diese Veranstaltung. Ohne Angabe
   * reicht irgendeine Veranstaltung der Organisation.
   */
  eventId?: string | null;
  /** Bei Bestellpositionen: genau diese Bestellung. */
  orderId?: string | null;
}

/** Alles, was eine rohe Abfrage ausfuehren kann (DataSource, EntityManager). */
export interface ReferenceQueryRunner {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idsOf(ids: ReferenceCheck['ids']): string[] {
  if (ids === null || ids === undefined) return [];
  const list = typeof ids === 'string' ? [ids] : [...ids];
  return [...new Set(list.filter((id) => id !== null && id !== ''))];
}

export function referenceNotFound(
  kind: ReferenceKind,
  field?: string,
): BadRequestException {
  const spec = REFERENCES[kind];
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: spec.reason,
    message: spec.message,
    ...(field ? { params: { field } } : {}),
  });
}

/** SQL fuer eine Art; die Tabellennamen stammen nur aus REFERENCES. */
export function referenceSql(kind: ReferenceKind, withParent: boolean): string {
  const spec = REFERENCES[kind];
  const alive = spec.softDelete ? ' AND t.deleted_at IS NULL' : '';
  const base = `SELECT t.id FROM ${spec.table} t`;
  switch (spec.scope) {
    case 'organization':
      return `${base} WHERE t.id = ANY($1::uuid[]) AND t.organization_id = $2${alive}`;
    case 'event':
      return `${base} JOIN events p ON p.id = t.event_id WHERE t.id = ANY($1::uuid[]) AND p.organization_id = $2${
        withParent ? ' AND t.event_id = $3' : ''
      }${alive}`;
    case 'order':
      return `${base} JOIN orders p ON p.id = t.order_id WHERE t.id = ANY($1::uuid[]) AND p.organization_id = $2${
        withParent ? ' AND t.order_id = $3' : ''
      }${alive}`;
  }
}

/**
 * Prueft alle Verweise; wirft beim ersten, der nicht zur Organisation (bzw.
 * Veranstaltung) gehoert. Eine Abfrage je Art.
 */
export async function assertReferencesInOrganization(
  db: ReferenceQueryRunner,
  scope: ReferenceScope,
  checks: readonly ReferenceCheck[],
): Promise<void> {
  for (const check of checks) {
    const ids = idsOf(check.ids);
    if (ids.length === 0) continue;
    if (ids.some((id) => !UUID.test(id))) {
      throw referenceNotFound(check.kind, check.field);
    }
    const spec = REFERENCES[check.kind];
    const parent =
      spec.scope === 'event'
        ? scope.eventId
        : spec.scope === 'order'
          ? scope.orderId
          : null;
    const params: unknown[] = [ids, scope.organizationId];
    if (parent) params.push(parent);
    const rows = (await db.query(
      referenceSql(check.kind, !!parent),
      params,
    )) as { id: string }[] | undefined;
    const found = new Set(
      (rows ?? []).map((row) => String(row.id).toLowerCase()),
    );
    if (ids.some((id) => !found.has(id.toLowerCase()))) {
      throw referenceNotFound(check.kind, check.field);
    }
  }
}

/**
 * Fuer Antworten: eine geladene Veranstaltung, die nicht zur Organisation
 * des Datensatzes gehoert, wird weggelassen (`eventId` und `event` leer).
 * Gibt eine Kopie zurueck; das Entity selbst bleibt unveraendert.
 */
export function withoutForeignEvent<
  T extends {
    organizationId: string;
    eventId?: string | null;
    event?: { organizationId: string } | null;
  },
>(row: T): T {
  if (!row.event || row.event.organizationId === row.organizationId) {
    return row;
  }
  return { ...row, eventId: null, event: null };
}
