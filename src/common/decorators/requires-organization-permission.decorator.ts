import { SetMetadata } from '@nestjs/common';
import type { OrganizationPermissions } from '../../database/entities/user-organization.entity';

export const ORGANIZATION_PERMISSION_KEY = 'organizationPermission';

/**
 * Modul-Berechtigung, die ein Mitglied in der Organisation aus dem Pfad
 * braucht (Administratoren immer). Ausgewertet von
 * OrganizationPermissionGuard.
 */
export const RequiresOrganizationPermission = (
  permission: keyof OrganizationPermissions,
) => SetMetadata(ORGANIZATION_PERMISSION_KEY, permission);
