import { tableKey } from './tables.constants';

/**
 * Tischstatus (Spezifikation §2.4), serverseitig aus den Bestellungen des
 * Events abgeleitet:
 *
 * - `wait` (Vorrang): (a) Gastbestellung (`online`/`qr_order`) mit
 *   `status=open`, noch nicht quittiert, oder (b) eine Position `ready` in
 *   einer `table_service`-Bestellung (muss an den Tisch).
 * - `busy`: mindestens eine Bestellung unbezahlt/teilbezahlt und weder
 *   storniert noch abgeschlossen.
 * - `free`: sonst — taucht in der Liste nicht auf.
 *
 * Eine SQL-Abfrage liefert je relevanter Bestellung eine Zeile (inkl.
 * Positionssummen und passendem Tisch), `aggregateTableStatus` gruppiert
 * sie nach Tischschluessel `upper(trim(table_number))`.
 */
export type TableStatusValue = 'busy' | 'wait';

/**
 * Grund fuer `wait`: `guest` = unquittierte Gastbestellung (a), `ready` =
 * fertige Position muss an den Tisch (b). Gilt beides, hat `guest` Vorrang
 * (das Oeffnen des Tisches quittiert sie, danach bleibt ggf. `ready`).
 */
export type TableWaitReason = 'guest' | 'ready';

export interface TableStatusEntry {
  key: string;
  tableId: string | null;
  label: string;
  areaId: string | null;
  status: TableStatusValue;
  waitReason: TableWaitReason | null;
  openAmount: number;
  itemCount: number;
  orderIds: string[];
  waitingSince: string | null;
  lastActivityAt: string;
}

/** Zeile aus TABLE_STATUS_SQL (pg liefert numeric/bigint als string). */
export interface TableStatusOrderRow {
  id: string;
  tableNumber: string;
  status: string;
  paymentStatus: string;
  source: string;
  fulfillmentType: string;
  acknowledgedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  total: string | number;
  paidAmount: string | number;
  itemCount: string | number | null;
  readySince: Date | string | null;
  lastItemAt: Date | string | null;
  matchedTableId: string | null;
  matchedLabel: string | null;
  matchedAreaId: string | null;
}

const OPEN_PAYMENT = ['unpaid', 'partly_paid'];
const CLOSED_ORDER = ['cancelled', 'completed'];
const GUEST_SOURCES = ['online', 'qr_order'];

/**
 * Eine Abfrage: alle nicht stornierten Bestellungen des Events mit
 * Tischnummer, die offen sind oder auf Bedienung warten. $1 = Organisation,
 * $2 = Event. Der Tisch wird ueber `table_id`, sonst ueber die Bezeichnung
 * zugeordnet (Altdaten, freie Nummern).
 */
export const TABLE_STATUS_SQL = `
  SELECT o.id,
         o.table_number      AS "tableNumber",
         o.status::text      AS "status",
         o.payment_status::text AS "paymentStatus",
         o.source::text      AS "source",
         o.fulfillment_type::text AS "fulfillmentType",
         o.acknowledged_at   AS "acknowledgedAt",
         o.created_at        AS "createdAt",
         o.updated_at        AS "updatedAt",
         o.total             AS "total",
         o.paid_amount       AS "paidAmount",
         i.item_count        AS "itemCount",
         i.ready_since       AS "readySince",
         i.last_item_at      AS "lastItemAt",
         COALESCE(t.id, k.id)             AS "matchedTableId",
         COALESCE(t.label, k.label)       AS "matchedLabel",
         COALESCE(t.area_id, k.area_id)   AS "matchedAreaId"
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT SUM(oi.quantity) FILTER (WHERE oi.status <> 'cancelled') AS item_count,
             MIN(COALESCE(oi.ready_at, oi.updated_at)) FILTER (WHERE oi.status = 'ready') AS ready_since,
             MAX(oi.updated_at) AS last_item_at
        FROM order_items oi
       WHERE oi.order_id = o.id
    ) i ON true
    LEFT JOIN dining_tables t
      ON t.id = o.table_id AND t.deleted_at IS NULL
    LEFT JOIN dining_tables k
      ON t.id IS NULL
     AND k.organization_id = o.organization_id
     AND upper(k.label) = upper(btrim(o.table_number))
     AND k.deleted_at IS NULL
   WHERE o.organization_id = $1
     AND o.event_id = $2
     AND o.table_number IS NOT NULL
     AND btrim(o.table_number) <> ''
     AND o.status <> 'cancelled'
     AND (
           (o.payment_status IN ('unpaid', 'partly_paid') AND o.status <> 'completed')
        OR (o.source IN ('online', 'qr_order') AND o.status = 'open' AND o.acknowledged_at IS NULL)
        OR (o.fulfillment_type = 'table_service' AND i.ready_since IS NOT NULL)
         )
   ORDER BY o.created_at ASC
`;

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

export function isOpenOrder(row: {
  status: string;
  paymentStatus: string;
}): boolean {
  return (
    OPEN_PAYMENT.includes(row.paymentStatus) &&
    !CLOSED_ORDER.includes(row.status)
  );
}

export function isGuestWaiting(row: {
  status: string;
  source: string;
  acknowledgedAt: Date | string | null;
}): boolean {
  return (
    GUEST_SOURCES.includes(row.source) &&
    row.status === 'open' &&
    !row.acknowledgedAt
  );
}

export function hasReadyItems(row: {
  status: string;
  fulfillmentType: string;
  readySince: Date | string | null;
}): boolean {
  return (
    row.status !== 'cancelled' &&
    row.fulfillmentType === 'table_service' &&
    !!row.readySince
  );
}

interface Group {
  key: string;
  tableId: string | null;
  matchedLabel: string | null;
  areaId: string | null;
  latestLabel: string;
  latestAt: Date | null;
  wait: boolean;
  guestWaiting: boolean;
  readyWaiting: boolean;
  busy: boolean;
  openAmount: number;
  itemCount: number;
  orderIds: string[];
  waitingSince: Date | null;
  lastActivityAt: Date | null;
}

/**
 * Gruppiert die Bestellzeilen nach Tischschluessel und leitet je Tisch den
 * Status ab. Tische ohne `wait`/`busy` fehlen in der Antwort. Sortierung:
 * `wait` zuerst (laengste Wartezeit zuerst), dann juengste Aktivitaet.
 */
export function aggregateTableStatus(
  rows: TableStatusOrderRow[],
): TableStatusEntry[] {
  const groups = new Map<string, Group>();

  for (const row of rows) {
    if (row.status === 'cancelled' || !row.tableNumber?.trim()) continue;

    const open = isOpenOrder(row);
    const guest = isGuestWaiting(row);
    const ready = hasReadyItems(row);
    if (!open && !guest && !ready) continue;

    const key = tableKey(row.tableNumber);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        tableId: null,
        matchedLabel: null,
        areaId: null,
        latestLabel: row.tableNumber.trim(),
        latestAt: null,
        wait: false,
        guestWaiting: false,
        readyWaiting: false,
        busy: false,
        openAmount: 0,
        itemCount: 0,
        orderIds: [],
        waitingSince: null,
        lastActivityAt: null,
      };
      groups.set(key, group);
    }

    const createdAt = toDate(row.createdAt);
    if (!group.latestAt || (createdAt && createdAt >= group.latestAt)) {
      group.latestAt = createdAt;
      group.latestLabel = row.tableNumber.trim();
      if (row.matchedTableId) {
        group.tableId = row.matchedTableId;
        group.matchedLabel = row.matchedLabel;
        group.areaId = row.matchedAreaId;
      }
    }
    if (!group.tableId && row.matchedTableId) {
      group.tableId = row.matchedTableId;
      group.matchedLabel = row.matchedLabel;
      group.areaId = row.matchedAreaId;
    }

    group.orderIds.push(row.id);
    group.itemCount += Number(row.itemCount ?? 0) || 0;

    if (open) {
      group.busy = true;
      group.openAmount += Number(row.total) - Number(row.paidAmount);
    }
    if (guest) {
      group.wait = true;
      group.guestWaiting = true;
      group.waitingSince = minDate(group.waitingSince, createdAt);
    }
    if (ready) {
      group.wait = true;
      group.readyWaiting = true;
      group.waitingSince = minDate(group.waitingSince, toDate(row.readySince));
    }

    group.lastActivityAt = maxDate(
      group.lastActivityAt,
      maxDate(toDate(row.updatedAt), toDate(row.lastItemAt)),
    );
  }

  const entries: TableStatusEntry[] = [];
  for (const group of groups.values()) {
    if (!group.wait && !group.busy) continue;
    const lastActivityAt =
      group.lastActivityAt ?? group.latestAt ?? new Date(0);
    entries.push({
      key: group.key,
      tableId: group.tableId,
      label: group.matchedLabel ?? group.latestLabel,
      areaId: group.areaId,
      status: group.wait ? 'wait' : 'busy',
      waitReason: group.guestWaiting
        ? 'guest'
        : group.readyWaiting
          ? 'ready'
          : null,
      openAmount: Math.round(Math.max(group.openAmount, 0) * 100) / 100,
      itemCount: group.itemCount,
      orderIds: group.orderIds,
      waitingSince: group.wait
        ? (group.waitingSince ?? lastActivityAt).toISOString()
        : null,
      lastActivityAt: lastActivityAt.toISOString(),
    });
  }

  return entries.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'wait' ? -1 : 1;
    if (a.status === 'wait' && a.waitingSince && b.waitingSince) {
      const byWait = a.waitingSince.localeCompare(b.waitingSince);
      if (byWait !== 0) return byWait;
    }
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}
