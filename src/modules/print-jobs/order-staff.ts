import type { Order } from '../../database/entities/order.entity';
import type { User } from '../../database/entities/user.entity';

/**
 * Wer hat die Bestellung aufgenommen? Fuer die Bon-Elemente „Bedienung“
 * (`waiter_name`, `waiter_short_name`) und „Gerät“ (`device_name`), Idee
 * aus openeos-web#15, erweitert um die Bedienungen (bedienungen-plan.md §9).
 *
 * - `sender`: Bedienung, die die Runde gesendet hat (`order_items.
 *   added_by_waiter_id`, juengste Position der Bestellung).
 * - `waiter`: verantwortliche Bedienung (`orders.waiter_id`, sonst
 *   `created_by_waiter_id`).
 * - `userName`: Mitglied, das die Bestellung angelegt hat
 *   (`created_by_user_id`): an der Kasse per Mitglieds-PIN, sonst in der
 *   Verwaltung. Nur wenn es (noch) Mitglied der Organisation ist.
 * - `deviceName`: Name des Geraets (`created_by_device_id`), nur wenn das
 *   Geraet zur Organisation der Bestellung gehoert.
 *
 * Alle Namen nur aus der Organisation der Bestellung. Online-/QR-
 * Bestellungen haben nichts davon: dann bleiben die Felder leer und die
 * Vorlagen lassen die Zeile samt Beschriftung weg.
 */
export interface StaffName {
  name: string;
  shortName: string | null;
}

export interface OrderStaff {
  userName: string | null;
  deviceName: string | null;
  /** Runden-Sender (Bedienung). */
  sender?: StaffName | null;
  /** Verantwortliche Bedienung. */
  waiter?: StaffName | null;
  /** Organisationseinstellung „Name auf Bons“ (Standard: Kurzname). */
  receiptName?: 'short' | 'full';
}

export const NO_ORDER_STAFF: OrderStaff = { userName: null, deviceName: null };

type StaffOrder = Pick<
  Order,
  'organizationId' | 'createdByUserId' | 'createdByDeviceId'
> &
  Partial<Pick<Order, 'id' | 'waiterId' | 'createdByWaiterId'>>;

/** Minimaler Ausschnitt aus Repository/EntityManager (`query`). */
export interface RawQueryRunner {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function staffName(name: unknown, shortName: unknown): StaffName | null {
  const full = clean(name);
  return full ? { name: full, shortName: clean(shortName) } : null;
}

/** „Vorname Nachname“, leer → null. */
export function personName(
  user?: Pick<User, 'firstName' | 'lastName'> | null,
): string | null {
  if (!user) return null;
  return clean(
    [user.firstName, user.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' '),
  );
}

/**
 * Laedt die Namen einer Bestellung mit genau einer Abfrage (alles auf die
 * Organisation der Bestellung beschraenkt). Ohne Ersteller und Bedienung
 * keine Abfrage. Pro Druckvorgang einmal aufrufen und das
 * Ergebnis fuer alle Bons dieser Bestellung verwenden.
 */
export async function loadOrderStaff(
  db: RawQueryRunner,
  order: StaffOrder | null | undefined,
): Promise<OrderStaff> {
  if (!order?.organizationId) return NO_ORDER_STAFF;
  const userId = order.createdByUserId ?? null;
  const deviceId = order.createdByDeviceId ?? null;
  const waiterId = order.waiterId ?? order.createdByWaiterId ?? null;
  const orderId = order.id ?? null;
  // Online-/QR-Bestellung ohne Ersteller und Bedienung: nichts zu laden.
  if (!userId && !deviceId && !waiterId) return NO_ORDER_STAFF;
  const rows = (await db.query(
    `SELECT
       (SELECT d.name FROM devices d
         WHERE d.id = $2::uuid AND d.organization_id = $1::uuid) AS device_name,
       (SELECT CONCAT_WS(' ', NULLIF(TRIM(u.first_name), ''),
                              NULLIF(TRIM(u.last_name), '')) FROM users u
          JOIN user_organizations m
            ON m.user_id = u.id AND m.organization_id = $1::uuid
         WHERE u.id = $3::uuid) AS user_name,
       (SELECT w.name FROM waiters w
         WHERE w.id = $4::uuid AND w.organization_id = $1::uuid) AS waiter_name,
       (SELECT w.short_name FROM waiters w
         WHERE w.id = $4::uuid AND w.organization_id = $1::uuid) AS waiter_short_name,
       s.name AS sender_name,
       s.short_name AS sender_short_name,
       (SELECT o.settings->'waiters'->>'receiptName' FROM organizations o
         WHERE o.id = $1::uuid) AS receipt_name
     FROM (SELECT 1) AS one
     LEFT JOIN LATERAL (
       SELECT sw.name, sw.short_name
         FROM order_items oi
         JOIN waiters sw
           ON sw.id = oi.added_by_waiter_id AND sw.organization_id = $1::uuid
        WHERE oi.order_id = $5::uuid
        ORDER BY oi.created_at DESC
        LIMIT 1
     ) s ON true`,
    [order.organizationId, deviceId, userId, waiterId, orderId],
  )) as
    | {
        device_name?: unknown;
        user_name?: unknown;
        waiter_name?: unknown;
        waiter_short_name?: unknown;
        sender_name?: unknown;
        sender_short_name?: unknown;
        receipt_name?: unknown;
      }[]
    | undefined;
  const row = rows?.[0];
  const staff: OrderStaff = {
    userName: clean(row?.user_name),
    deviceName: clean(row?.device_name),
  };
  const waiter = staffName(row?.waiter_name, row?.waiter_short_name);
  const sender = staffName(row?.sender_name, row?.sender_short_name);
  if (waiter) staff.waiter = waiter;
  if (sender) staff.sender = sender;
  if (row?.receipt_name === 'full') staff.receiptName = 'full';
  return staff;
}

function firstWord(name: string): string {
  return name.split(/\s+/)[0];
}

/**
 * Druckfelder. `waiter_name`: Runden-Sender ▸ verantwortliche Bedienung ▸
 * Mitglied (an der Kasse per Mitglieds-PIN bzw. in der Verwaltung) ▸
 * Geraet. Bei Bedienungen der Kurzname, wenn gesetzt (Einstellung „Name
 * auf Bons“, Standard kurz). `waiter_short_name` immer kurz (fuer „Es
 * bediente Sie“). `device_name` immer das Geraet.
 */
export function orderStaffPayload(staff: OrderStaff): {
  waiter_name: string | null;
  waiter_short_name: string | null;
  device_name: string | null;
} {
  const person = staff.sender ?? staff.waiter ?? null;
  const fromWaiter = person
    ? staff.receiptName === 'full'
      ? person.name
      : (person.shortName ?? person.name)
    : null;
  const waiterName = fromWaiter ?? staff.userName ?? staff.deviceName ?? null;
  const shortName = person
    ? (person.shortName ?? firstWord(person.name))
    : staff.userName
      ? firstWord(staff.userName)
      : staff.deviceName;
  return {
    waiter_name: waiterName,
    waiter_short_name: shortName ?? null,
    device_name: staff.deviceName ?? null,
  };
}
