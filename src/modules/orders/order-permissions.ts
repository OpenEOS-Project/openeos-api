import { ForbiddenException } from '@nestjs/common';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  OrganizationRole,
  type OrganizationPermissions,
} from '../../database/entities/user-organization.entity';

/** Mitgliedschaft mit Rolle und Modulrechten. */
interface Membership {
  role: OrganizationRole | `${OrganizationRole}`;
  permissions?: OrganizationPermissions | null;
}

/**
 * Bestellungen anlegen und kassieren darf jedes Mitglied (wie an der
 * Kasse). Was darueber hinausgeht, braucht das Recht „Bestellungen“ oder
 * Admin — dieselbe Regel wie fuer Storno und Erstattung:
 *
 * - Bestellungen loeschen,
 * - bezahlte oder teilbezahlte Bestellungen aendern,
 * - Zahlungen in der Verwaltung als bezahlt erfassen,
 * - Bestellungen ohne (vollstaendige) Zahlung abschliessen.
 */
export function mayManageOrders(
  user: { isSuperAdmin?: boolean | null },
  membership: Membership | null | undefined,
): boolean {
  if (user.isSuperAdmin) return true;
  if (!membership) return false;
  return (
    membership.role === OrganizationRole.ADMIN ||
    membership.permissions?.orders === true
  );
}

export function assertMayManageOrders(
  user: { isSuperAdmin?: boolean | null },
  membership: Membership | null | undefined,
): void {
  if (mayManageOrders(user, membership)) return;
  throw new ForbiddenException({
    code: ErrorCodes.FORBIDDEN,
    reason: ErrorReasons.ORDERS_PERMISSION_REQUIRED,
    message: 'Dafür brauchst du das Recht „Bestellungen“ oder Admin.',
  });
}
