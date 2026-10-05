import { ForbiddenException } from '@nestjs/common';

import {
  OrganizationPermissions,
  OrganizationRole,
} from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';

/** Mitgliedschaft oder Einladung — beides traegt Rolle und Modulrechte. */
interface Holder {
  role: OrganizationRole;
  permissions?: OrganizationPermissions | null;
}

function lacks(actor: Holder, key: string): boolean {
  return !actor.permissions?.[key as keyof OrganizationPermissions];
}

/**
 * Verhindert, dass ein Mitglied mit Mitgliederrecht mehr vergibt, als es
 * selbst hat: keine Admin-Rolle und nur Modulrechte, die es selbst besitzt.
 * Rechte, die es selbst nicht hat, kann es auch nicht entziehen — Rechte,
 * die das bearbeitete Mitglied bereits hat, bleiben dann unveraendert.
 * Admins (und Super-Admins) duerfen alles vergeben.
 */
export function assertCanGrant(
  actor: Holder,
  role: OrganizationRole,
  permissions: OrganizationPermissions | undefined,
  alreadyHeld: OrganizationPermissions | null = {},
): void {
  if (actor.role === OrganizationRole.ADMIN) return;

  if (role === OrganizationRole.ADMIN) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      message: 'Nur Admins können die Admin-Rolle vergeben',
    });
  }

  if (permissions === undefined) return;

  const requested = permissions as Record<string, unknown>;
  const held = (alreadyHeld ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(requested), ...Object.keys(held)]);
  const changesForeign = [...keys].some(
    (key) =>
      lacks(actor, key) && Boolean(requested[key]) !== Boolean(held[key]),
  );
  if (changesForeign) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      message:
        'Es können nur eigene Berechtigungen vergeben oder entzogen werden',
    });
  }
}

/**
 * Prueft, ob ein Mitglied mit Mitgliederrecht ein anderes Mitglied (oder
 * eine Einladung) als Ganzes verwalten darf — entfernen, widerrufen, PIN
 * setzen. Das geht nur bei Nicht-Admins, deren Rechte es selbst alle hat.
 * Admins (und Super-Admins) duerfen alles.
 */
export function assertCanManage(actor: Holder, target: Holder): void {
  if (actor.role === OrganizationRole.ADMIN) return;

  if (target.role === OrganizationRole.ADMIN) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      message: 'Nur Admins können Admins bearbeiten',
    });
  }

  const exceeding = Object.entries(target.permissions ?? {}).some(
    ([key, held]) => Boolean(held) && lacks(actor, key),
  );
  if (exceeding) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      message:
        'Mitglieder mit Berechtigungen, die Sie selbst nicht haben, können nur Admins verwalten',
    });
  }
}
