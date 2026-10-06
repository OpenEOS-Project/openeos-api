import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  EventSettings,
  EventTableMode,
} from '../../database/entities/event.entity';
import { OrderFulfillmentType } from '../../database/entities/order.entity';
import { findTableIdByLabel } from '../tables/table-lookup';
import { LABEL_MAX } from '../tables/tables.constants';

/**
 * Tischbetrieb einer Kassenbestellung (Spezifikation §2.3):
 *
 * | Gerät     | Event-Modus  | Ergebnis                                            |
 * |-----------|--------------|-----------------------------------------------------|
 * | counter   | beliebig     | counter_pickup, kein Tisch                          |
 * | table     | none         | counter_pickup, kein Tisch                          |
 * | table     | free         | table_service, freie Nummer, table_id best effort   |
 * | table     | predefined   | table_service, table_id Pflicht, Nummer = Label     |
 * | table + Override counter_pickup (Theke/To-go) | free/predefined | counter_pickup |
 */

export interface DeviceOrderTableInput {
  /** `device.settings.serviceMode`; fehlt → `table` (wie die Kasse). */
  serviceMode?: string | null;
  /** `event.settings.tables`; fehlt → `free`. */
  eventTables?: EventSettings['tables'] | null;
  fulfillmentType?: OrderFulfillmentType | null;
  tableId?: string | null;
  tableNumber?: string | null;
}

export interface ResolvedOrderTable {
  fulfillmentType: OrderFulfillmentType;
  tableNumber: string | null;
  tableId: string | null;
}

export interface TableCandidate {
  id: string;
  label: string;
  areaId: string;
  isActive: boolean;
}

/** Zugriff auf die Tische der Organisation (nicht geloescht, Bereich nicht geloescht). */
export interface DeviceTableLookup {
  byId(tableId: string): Promise<TableCandidate | null>;
  byLabel(label: string): Promise<TableCandidate | null>;
  /** Best effort fuer freie Nummern (Modus `free`), nur aktive Tische. */
  idByLabel(label: string): Promise<string | null>;
}

export function effectiveTableMode(
  eventTables: EventSettings['tables'] | null | undefined,
): EventTableMode {
  const mode = eventTables?.mode;
  return mode === 'none' || mode === 'predefined' ? mode : 'free';
}

function tableRequired(): BadRequestException {
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.TABLE_REQUIRED,
    message:
      'Für diese Veranstaltung brauchst du einen Tisch. Wähl einen Tisch oder kassiere ohne Tisch.',
  });
}

function tableNotFound(params: Record<string, string>): NotFoundException {
  return new NotFoundException({
    code: ErrorCodes.NOT_FOUND,
    reason: ErrorReasons.TABLE_NOT_FOUND,
    message:
      'Diesen Tisch gibt es für diese Veranstaltung nicht (mehr). Wähl bitte einen anderen Tisch.',
    params,
  });
}

export async function resolveDeviceOrderTable(
  input: DeviceOrderTableInput,
  lookup: DeviceTableLookup,
): Promise<ResolvedOrderTable> {
  const counter: ResolvedOrderTable = {
    fulfillmentType: OrderFulfillmentType.COUNTER_PICKUP,
    tableNumber: null,
    tableId: null,
  };

  const serviceMode = input.serviceMode || 'table';
  if (serviceMode !== 'table') return counter;

  const mode = effectiveTableMode(input.eventTables);
  if (mode === 'none') return counter;

  // „Ohne Tisch“ (Theke/To-go) an einem Tisch-Geraet. `table_service` im
  // Body bleibt wirkungslos — der ergibt sich aus Geraet und Event.
  if (input.fulfillmentType === OrderFulfillmentType.COUNTER_PICKUP) {
    return counter;
  }

  const tableNumber = input.tableNumber?.trim() || null;
  const tableId = input.tableId || null;

  if (mode === 'free') {
    // Freie Nummer ist massgeblich; ein Tisch wird nur zugeordnet, wenn er
    // eindeutig passt. Abgelehnt wird hier nie.
    let candidate: TableCandidate | null = null;
    if (tableId) {
      candidate = await lookup.byId(tableId);
      if (candidate && !candidate.isActive) candidate = null;
    }
    const number = tableNumber ?? candidate?.label ?? null;
    if (candidate && (!tableNumber || sameKey(candidate.label, tableNumber))) {
      return {
        fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
        tableNumber: number,
        tableId: candidate.id,
      };
    }
    return {
      fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
      tableNumber: number,
      tableId:
        number && number.length <= LABEL_MAX
          ? await lookup.idByLabel(number)
          : null,
    };
  }

  // predefined: ein gueltiger Tisch ist Pflicht. Ohne `tableId` (Kassen vor
  // der Tischauswahl) wird die Nummer als Bezeichnung gesucht.
  let candidate: TableCandidate | null;
  if (tableId) {
    candidate = await lookup.byId(tableId);
  } else if (tableNumber) {
    candidate = await lookup.byLabel(tableNumber);
  } else {
    throw tableRequired();
  }

  const areaIds = input.eventTables?.areaIds;
  if (
    !candidate ||
    !candidate.isActive ||
    (Array.isArray(areaIds) && !areaIds.includes(candidate.areaId))
  ) {
    throw tableNotFound(
      tableId ? { tableId } : { tableNumber: tableNumber ?? '' },
    );
  }

  return {
    fulfillmentType: OrderFulfillmentType.TABLE_SERVICE,
    tableNumber: candidate.label,
    tableId: candidate.id,
  };
}

function sameKey(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

const TABLE_CANDIDATE_SQL = `
  SELECT t.id, t.label, t.area_id AS "areaId", t.is_active AS "isActive"
    FROM dining_tables t
    JOIN table_areas a ON a.id = t.area_id AND a.deleted_at IS NULL
   WHERE t.organization_id = $1
     AND t.deleted_at IS NULL
`;

/** Lookup gegen die Datenbank (innerhalb der Transaktion der Bestellung). */
export function createDeviceTableLookup(
  manager: EntityManager,
  organizationId: string,
): DeviceTableLookup {
  const first = async (
    sql: string,
    params: unknown[],
  ): Promise<TableCandidate | null> => {
    const rows: TableCandidate[] = await manager.query(sql, params);
    return rows[0] ?? null;
  };
  return {
    byId: (tableId) =>
      first(`${TABLE_CANDIDATE_SQL} AND t.id = $2 LIMIT 1`, [
        organizationId,
        tableId,
      ]),
    byLabel: (label) =>
      label.trim().length > LABEL_MAX
        ? Promise.resolve(null)
        : first(
            `${TABLE_CANDIDATE_SQL} AND upper(t.label) = upper($2) LIMIT 1`,
            [organizationId, label.trim()],
          ),
    idByLabel: (label) => findTableIdByLabel(manager, organizationId, label),
  };
}

/** Eindeutiger Index aus Migration 1814 (Organisation + clientRequestId). */
export const CLIENT_REQUEST_INDEX = 'UQ_orders_org_client_request';

/** Insert scheiterte, weil dieselbe clientRequestId schon angelegt wurde. */
export function isClientRequestConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as
    | { code?: string; constraint?: string }
    | undefined;
  return (
    driverError?.code === '23505' &&
    driverError.constraint === CLIENT_REQUEST_INDEX
  );
}
