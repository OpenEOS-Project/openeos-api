import { DeepPartial, EntityManager, Repository } from 'typeorm';
import { Order } from '../../database/entities/order.entity';
import { Organization } from '../../database/entities/organization.entity';
import { dayBoundsInZone } from '../../common/utils/event-schedule.util';

/**
 * Vergabe von Bestellnummer (`YYYYMMDD-NNNN`, Shop: `S-YYYYMMDD-NNNN`) und
 * Abholnummer (`dailyNumber`).
 *
 * Frueher stammte das Datum der Nummer aus UTC, der Tageszaehler aber aus
 * der lokalen Mitternacht des Containers (TZ=Europe/Berlin). Zwischen 0 und
 * 2 Uhr Ortszeit begann der Zaehler neu, das Datum aber noch nicht — so
 * entstand z. B. `20260924-0001` ein zweites Mal. Jetzt gilt:
 *
 * - Datum und Zaehler beziehen sich auf denselben Kalendertag, und zwar in
 *   der Zeitzone der Organisation (Standard Europe/Berlin), unabhaengig von
 *   der Zeitzone des Servers.
 * - Der Zaehler ist das hoechste bereits vergebene NNNN mit genau diesem
 *   Praefix plus eins — nicht die Anzahl der Bestellungen. Geloeschte
 *   Bestellungen oder Altbestaende mit anderer Tagesgrenze fuehren so nicht
 *   zu einer doppelten Nummer.
 * - Vergabe und Insert laufen in einer Transaktion unter einer Advisory-Lock
 *   je Organisation, damit zwei gleichzeitige Bestellungen nicht denselben
 *   Hoechstwert lesen.
 */

export const DEFAULT_ORDER_TIME_ZONE = 'Europe/Berlin';

/** Namensraum der Advisory-Lock (erster Schluessel von pg_advisory_xact_lock). */
export const ORDER_NUMBER_LOCK_NAMESPACE = 41_201;

/** Praefixe, die die Vergabe kennt — fest, damit LIKE nichts zu escapen hat. */
export type OrderNumberPrefix = '' | 'S-';

// Altbestaende bekamen ihr Datum aus UTC; eine Nummer mit diesem Datum kann
// deshalb (und nach einem Wechsel der Zeitzone) etwas ausserhalb des
// Ortstages angelegt worden sein. Zwei Tage Spielraum decken jeden
// Zeitzonenversatz ab und halten die Abfrage auf dem Index
// (organization_id, created_at).
const PREFIX_SEARCH_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

export function resolveOrderTimeZone(timeZone: unknown): string {
  if (typeof timeZone === 'string' && timeZone.trim() !== '') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() });
      return timeZone.trim();
    } catch {
      // Unbekannte Zone in den Einstellungen — Standard verwenden.
    }
  }
  return DEFAULT_ORDER_TIME_ZONE;
}

export interface OrderDay {
  /** Kalendertag als `YYYYMMDD`. */
  key: string;
  /** Mitternacht dieses Tages in der Zeitzone (inklusiv). */
  start: Date;
  /** Mitternacht des Folgetages (exklusiv). */
  end: Date;
}

export function orderDay(now: Date, timeZone: string): OrderDay {
  const bounds = dayBoundsInZone(now, timeZone);
  return { ...bounds, key: bounds.key.replace(/-/g, '') };
}

export function formatOrderNumber(
  prefix: OrderNumberPrefix,
  dayKey: string,
  sequence: number,
): string {
  return `${prefix}${dayKey}-${String(sequence).padStart(4, '0')}`;
}

export interface AllocateOrderNumbersParams {
  organizationId: string;
  eventId: string | null;
  prefix?: OrderNumberPrefix;
  now?: Date;
}

export interface AllocatedOrderNumbers {
  orderNumber: string;
  dailyNumber: number;
}

type MaxRow = { max: number | string | null };

function toInt(rows: unknown): number {
  const value = (rows as MaxRow[] | undefined)?.[0]?.max;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Naechste Bestell- und Abholnummer. Muss innerhalb der Transaktion laufen,
 * die die Bestellung anlegt und vorher die Advisory-Lock haelt — siehe
 * saveOrderWithNumbers.
 */
export async function allocateOrderNumbers(
  manager: EntityManager,
  params: AllocateOrderNumbersParams,
): Promise<AllocatedOrderNumbers> {
  const prefix = params.prefix ?? '';
  const organization = await manager.findOne(Organization, {
    where: { id: params.organizationId },
    select: { id: true, settings: true },
  });
  const timeZone = resolveOrderTimeZone(organization?.settings?.timezone);
  const day = orderDay(params.now ?? new Date(), timeZone);

  const base = `${prefix}${day.key}-`;
  // Position der laufenden Nummer im String (SQL zaehlt ab 1).
  const sequenceFrom = base.length + 1;
  const maxSequence = toInt(
    await manager.query(
      `SELECT MAX(
         CASE WHEN SUBSTRING(o.order_number FROM $3::int) ~ '^[0-9]{1,9}$'
              THEN CAST(SUBSTRING(o.order_number FROM $3::int) AS integer)
         END
       ) AS max
       FROM orders o
       WHERE o.organization_id = $1
         AND o.order_number LIKE $2
         AND o.created_at >= $4
         AND o.created_at < $5`,
      [
        params.organizationId,
        `${base}%`,
        sequenceFrom,
        new Date(day.start.getTime() - PREFIX_SEARCH_MARGIN_MS),
        new Date(day.end.getTime() + PREFIX_SEARCH_MARGIN_MS),
      ],
    ),
  );

  // Abholnummer: je Veranstaltung (ohne Veranstaltung je Organisation) und
  // Tag fortlaufend, mit derselben Tagesgrenze wie die Bestellnummer.
  const maxDaily = toInt(
    await manager.query(
      `SELECT MAX(o.daily_number) AS max
       FROM orders o
       WHERE o.organization_id = $1
         AND ($2::uuid IS NULL OR o.event_id = $2::uuid)
         AND o.created_at >= $3
         AND o.created_at < $4`,
      [params.organizationId, params.eventId, day.start, day.end],
    ),
  );

  return {
    orderNumber: formatOrderNumber(prefix, day.key, maxSequence + 1),
    dailyNumber: maxDaily + 1,
  };
}

export type NewOrderData = Omit<
  DeepPartial<Order>,
  'orderNumber' | 'dailyNumber' | 'organizationId' | 'eventId'
>;

/**
 * Bestellung mit frisch vergebener Bestell- und Abholnummer anlegen.
 * Vergabe und Insert liegen in einer Transaktion unter einer Advisory-Lock
 * je Organisation; die Lock endet mit der Transaktion.
 */
export async function saveOrderWithNumbers(
  orderRepository: Repository<Order>,
  params: AllocateOrderNumbersParams,
  data: NewOrderData,
): Promise<Order> {
  return orderRepository.manager.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      ORDER_NUMBER_LOCK_NAMESPACE,
      params.organizationId,
    ]);
    const numbers = await allocateOrderNumbers(manager, params);
    const order = manager.create(Order, {
      ...data,
      organizationId: params.organizationId,
      eventId: params.eventId,
      ...numbers,
    } as DeepPartial<Order>);
    return manager.save(order);
  });
}
