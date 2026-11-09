import type { DeviceSettings } from '../../database/entities/device.entity';
import {
  OrganizationRole,
  type UserOrganization,
} from '../../database/entities/user-organization.entity';
import type {
  OrganizationWaiterSettings,
  Organization,
} from '../../database/entities/organization.entity';
import {
  WAITER_PERMISSION_KEYS,
  type Waiter,
  type WaiterPermissionKey,
  type WaiterPermissions,
  type WaiterRole,
} from '../../database/entities/waiter.entity';

/** Gerätemodus: ohne Bedienung, gemeinsame Kasse (PIN), feste Bedienung. */
export const WAITER_MODES = ['off', 'shared', 'personal'] as const;
export type WaiterMode = (typeof WAITER_MODES)[number];

/** Rechte je Rolle; `permissions` der Bedienung weicht davon ab. */
export const ROLE_PERMISSIONS: Record<
  WaiterRole,
  Record<WaiterPermissionKey, boolean>
> = {
  // Bedienung: kassieren und Rabatt-Bons einloesen; Storno/Erstattung,
  // Kassenlade von Hand und Kassenbuch nur mit Freigabe.
  service: {
    refund: false,
    cashDrawer: false,
    discount: true,
    cashbook: false,
  },
  // Schichtleitung: alles.
  lead: { refund: true, cashDrawer: true, discount: true, cashbook: true },
};

export const WAITER_SETTINGS_DEFAULTS: Required<OrganizationWaiterSettings> = {
  pinLength: 4,
  wallet: false,
  foreignTables: 'warn',
  selfSettlement: false,
  receiptName: 'short',
};

export function waiterSettings(
  organization: Pick<Organization, 'settings'> | null | undefined,
): Required<OrganizationWaiterSettings> {
  const own = organization?.settings?.waiters ?? {};
  return {
    pinLength: own.pinLength === 6 ? 6 : 4,
    // Kellnerbrieftasche erst nach Antwort des Steuerberaters (SB1): bis
    // dahin immer aus, auch wenn jemand den Schalter schon setzt.
    wallet: false,
    foreignTables: own.foreignTables === 'allow' ? 'allow' : 'warn',
    selfSettlement: own.selfSettlement === true,
    receiptName: own.receiptName === 'full' ? 'full' : 'short',
  };
}

/** Wirksame Rechte einer Bedienung (Rolle + Abweichungen). */
export function effectiveWaiterPermissions(
  role: WaiterRole,
  overrides: WaiterPermissions | null | undefined,
): Record<WaiterPermissionKey, boolean> {
  const base = ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.service;
  const result = { ...base };
  for (const key of WAITER_PERMISSION_KEYS) {
    const value = overrides?.[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

/**
 * Gerätemodus aus den Einstellungen. Ohne `waiterMode` gilt der frühere
 * Schalter `requirePin` als gemeinsame Kasse (Entscheidung 15; die
 * Migration setzt den Wert auch in der Datenbank).
 */
export function waiterModeOf(
  settings: DeviceSettings | null | undefined,
): WaiterMode {
  const mode = settings?.waiterMode as unknown;
  if (mode === 'shared' || mode === 'personal' || mode === 'off') return mode;
  return settings?.requirePin === true ? 'shared' : 'off';
}

/**
 * Wer an der Kasse bucht (aus der Bedienungs-Sitzung bzw. der festen
 * Bedienung des Geräts). Rechte kommen nur von hier, nie aus dem Body.
 */
export interface Operator {
  kind: 'waiter' | 'member';
  waiterId: string | null;
  userId: string | null;
  name: string;
  shortName: string | null;
  color: string | null;
  role: WaiterRole | 'admin' | 'member';
  permissions: Record<WaiterPermissionKey, boolean>;
  sessionId: string | null;
}

/** Zuordnung einer Buchung (Bedienung oder Mitglied). */
export interface Attribution {
  waiterId: string | null;
  userId: string | null;
  /** Anzeigename (Snapshot fuer Protokoll und Bon). */
  name: string | null;
}

export const NO_ATTRIBUTION: Attribution = {
  waiterId: null,
  userId: null,
  name: null,
};

export function attributionOf(
  operator: Operator | null | undefined,
): Attribution {
  if (!operator) return NO_ATTRIBUTION;
  return {
    waiterId: operator.waiterId,
    userId: operator.userId,
    name: operator.name,
  };
}

export function waiterOperator(
  waiter: Pick<
    Waiter,
    'id' | 'name' | 'shortName' | 'color' | 'role' | 'permissions'
  >,
  sessionId: string | null,
): Operator {
  return {
    kind: 'waiter',
    waiterId: waiter.id,
    userId: null,
    name: waiter.name,
    shortName: waiter.shortName,
    color: waiter.color,
    role: waiter.role,
    permissions: effectiveWaiterPermissions(waiter.role, waiter.permissions),
    sessionId,
  };
}

/** Mitglied mit Mitglieds-PIN an der Kasse (gilt als Bedienung). */
export function memberOperator(
  member: Pick<UserOrganization, 'userId' | 'role' | 'permissions'>,
  user: { firstName?: string | null; lastName?: string | null },
  sessionId: string | null,
): Operator {
  const admin = member.role === OrganizationRole.ADMIN;
  const name =
    [user.firstName, user.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ') || '—';
  return {
    kind: 'member',
    waiterId: null,
    userId: member.userId,
    name,
    shortName: user.firstName?.trim().slice(0, 12) || null,
    color: null,
    role: admin ? 'admin' : 'member',
    // Mitglieder buchen an der Kasse wie bisher; Storno/Erstattung nur mit
    // Recht „Bestellungen“ oder als Admin.
    permissions: {
      refund: admin || member.permissions?.orders === true,
      cashDrawer: true,
      discount: true,
      cashbook: true,
    },
    sessionId,
  };
}

/** Kurzdarstellung fuer Antworten an das Geraet. */
export function operatorView(operator: Operator) {
  return {
    kind: operator.kind,
    id: operator.waiterId ?? operator.userId,
    waiterId: operator.waiterId,
    userId: operator.userId,
    name: operator.name,
    shortName: operator.shortName,
    color: operator.color,
    role: operator.role,
    permissions: operator.permissions,
  };
}
