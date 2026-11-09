import type { Order } from '../../database/entities/order.entity';
import type { User } from '../../database/entities/user.entity';

/**
 * Wer hat die Bestellung aufgenommen? Fuer die Bon-Elemente „Bedienung“
 * (`waiter_name`) und „Gerät“ (`device_name`), Idee aus
 * openeos-web#15.
 *
 * - `userName`: Name des Mitglieds, das die Bestellung angelegt hat
 *   (`created_by_user_id`, z. B. in der Verwaltung). Nur wenn die Person
 *   (noch) Mitglied der Organisation der Bestellung ist.
 * - `deviceName`: Name des bestellenden Geraets (`created_by_device_id`),
 *   nur wenn das Geraet zur Organisation der Bestellung gehoert.
 *
 * Online-/QR-Bestellungen haben weder noch: dann bleiben beide leer und
 * die Vorlagen lassen die Zeile samt Beschriftung weg.
 */
export interface OrderStaff {
  userName: string | null;
  deviceName: string | null;
}

export const NO_ORDER_STAFF: OrderStaff = { userName: null, deviceName: null };

type StaffOrder = Pick<
  Order,
  'organizationId' | 'createdByUserId' | 'createdByDeviceId'
>;

/** Minimaler Ausschnitt aus Repository/EntityManager (`query`). */
export interface RawQueryRunner {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
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
 * Laedt Personen- und Geraetenamen einer Bestellung mit genau einer
 * Abfrage (beide auf die Organisation der Bestellung beschraenkt). Ohne
 * Ersteller keine Abfrage. Pro Druckvorgang einmal aufrufen und das
 * Ergebnis fuer alle Bons dieser Bestellung verwenden.
 */
export async function loadOrderStaff(
  db: RawQueryRunner,
  order: StaffOrder | null | undefined,
): Promise<OrderStaff> {
  if (!order?.organizationId) return NO_ORDER_STAFF;
  const userId = order.createdByUserId ?? null;
  const deviceId = order.createdByDeviceId ?? null;
  if (!userId && !deviceId) return NO_ORDER_STAFF;
  const rows = (await db.query(
    `SELECT
       (SELECT d.name FROM devices d
         WHERE d.id = $2::uuid AND d.organization_id = $1::uuid) AS device_name,
       (SELECT CONCAT_WS(' ', NULLIF(TRIM(u.first_name), ''),
                              NULLIF(TRIM(u.last_name), '')) FROM users u
          JOIN user_organizations m
            ON m.user_id = u.id AND m.organization_id = $1::uuid
         WHERE u.id = $3::uuid) AS user_name`,
    [order.organizationId, deviceId, userId],
  )) as { device_name?: unknown; user_name?: unknown }[] | undefined;
  const row = rows?.[0];
  return {
    userName: clean(row?.user_name),
    deviceName: clean(row?.device_name),
  };
}

/**
 * Druckfelder: `waiter_name` ist die Person, sonst das Geraet (bei
 * „ein Geraet je Bedienung“ steht der Name im Geraetenamen);
 * `device_name` immer das bestellende Geraet.
 */
export function orderStaffPayload(staff: OrderStaff): {
  waiter_name: string | null;
  device_name: string | null;
} {
  return {
    waiter_name: staff.userName ?? staff.deviceName ?? null,
    device_name: staff.deviceName ?? null,
  };
}
