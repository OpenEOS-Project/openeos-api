import type { UserOrganization } from '../../database/entities/user-organization.entity';
import type {
  OrganizationPermissions,
  OrganizationRole,
} from '../../database/entities/user-organization.entity';
import { withoutHiddenOrganizationFields } from './organization-hidden-fields';

/** Konto eines Mitglieds, so weit die Mitgliederseite es zeigt. */
export interface MemberUserView {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
}

/**
 * Mitgliedschaft, wie sie die Mitglieder-Endpunkte ausliefern. Bewusst eine
 * eigene Form statt des Entities: weder die alte PIN noch Kontofelder wie
 * Passwort, 2FA oder Sperrstatus gehoeren in die Antwort — egal, was am
 * Entity gerade geladen ist.
 */
export interface MemberView {
  id: string;
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  permissions: OrganizationPermissions;
  hasPin: boolean;
  createdAt: Date;
  updatedAt: Date;
  user?: MemberUserView;
}

export function memberUserView(
  user: UserOrganization['user'] | null | undefined,
): MemberUserView | undefined {
  if (!user) return undefined;
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}

export function memberView(
  member: UserOrganization,
  hasPin: boolean = !!member.pin,
): MemberView {
  const view: MemberView = {
    id: member.id,
    userId: member.userId,
    organizationId: member.organizationId,
    role: member.role,
    permissions: member.permissions ?? {},
    hasPin,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
  const user = memberUserView(member.user);
  if (user) view.user = user;
  return view;
}

/**
 * Eigene Mitgliedschaft nach dem Annehmen einer Einladung: Rolle und Rechte
 * plus die Organisation ohne ihre verborgenen Felder.
 */
export function ownMembershipView(member: UserOrganization) {
  const { pin: _pin, user: _user, organization, ...rest } = member;
  void _pin;
  void _user;
  if (!organization) return rest;
  return {
    ...rest,
    organization: withoutHiddenOrganizationFields(organization),
  };
}
