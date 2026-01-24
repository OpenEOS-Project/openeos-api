export enum Role {
  SUPERADMIN = 'superadmin',
  ADMIN = 'admin',
  MANAGER = 'manager',
  CASHIER = 'cashier',
  KITCHEN = 'kitchen',
  DELIVERY = 'delivery',
}

// Alias for organization context
export const OrganizationRole = Role;

export const ROLE_HIERARCHY: Record<Role, number> = {
  [Role.SUPERADMIN]: 100,
  [Role.ADMIN]: 80,
  [Role.MANAGER]: 60,
  [Role.CASHIER]: 40,
  [Role.KITCHEN]: 20,
  [Role.DELIVERY]: 20,
};

export function hasRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}
