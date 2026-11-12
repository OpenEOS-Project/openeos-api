import { ForbiddenException } from '@nestjs/common';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import { hasRole, Role } from '../constants/roles.enum';

/** Was von `request.user` fuer die Pruefung gebraucht wird. */
export interface OrganizationActor {
  isSuperAdmin?: boolean;
  organizations?: { id: string; role: string }[];
}

/**
 * Hat der Benutzer in genau dieser Organisation mindestens `role`?
 *
 * Zusaetzlich zu OrganizationGuard/RolesGuard direkt dort, wo mit der
 * Organisation aus dem Pfad gearbeitet wird — die Pruefung haengt so
 * nicht davon ab, welche Angabe ein Guard ausgewertet hat.
 */
export function assertOrganizationRole(
  user: OrganizationActor | undefined,
  organizationId: string,
  role: Role,
): void {
  if (user?.isSuperAdmin) return;
  const membership = user?.organizations?.find((o) => o.id === organizationId);
  if (!membership) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      reason: ErrorReasons.NOT_ORGANIZATION_MEMBER,
      message: 'Kein Mitglied dieser Organisation',
    });
  }
  if (!hasRole(membership.role as Role, role)) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
      message: 'Keine ausreichende Berechtigung',
    });
  }
}
