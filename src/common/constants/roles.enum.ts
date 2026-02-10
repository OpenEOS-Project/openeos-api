export enum Role {
  SUPERADMIN = 'superadmin',
  ADMIN = 'admin',
  MEMBER = 'member',
}

// Alias for organization context
export const OrganizationRole = Role;

export const ROLE_HIERARCHY: Record<Role, number> = {
  [Role.SUPERADMIN]: 100,
  [Role.ADMIN]: 80,
  [Role.MEMBER]: 20,
};

export function hasRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}
