import { EntityManager } from 'typeorm';
import type { User } from '../../../database/entities/user.entity';
import { OrganizationCashPolicyChange } from '../../../database/entities/organization-cash-policy-change.entity';

/**
 * Schreibwege fuer das Land, ohne Abhaengigkeit von Services — damit
 * OrganizationsService und AuthService sie beim Anlegen einer Organisation
 * nutzen koennen, ohne Kreisimport ueber CountryService.
 */

export interface ClientInfo {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function actorName(user: User): string | null {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return (name ? `${name} (${user.email})` : user.email)?.slice(0, 255) ?? null;
}

/**
 * Schreibt das Land (Spalte) und die Kopie in `settings.address.country`
 * in einem Schritt. Die Kopie gezielt per jsonb, damit alle anderen
 * Einstellungen (und maskierte Zugangsdaten) unberuehrt bleiben.
 */
export async function writeCountry(
  manager: EntityManager,
  organizationId: string,
  country: string,
): Promise<void> {
  await manager.query(
    `UPDATE organizations
        SET country = $2::text,
            settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{address}',
              CASE WHEN jsonb_typeof(settings->'address') = 'object'
                   THEN settings->'address'
                   ELSE '{}'::jsonb
              END || jsonb_build_object('country', $2::text),
              true
            ),
            updated_at = now()
      WHERE id = $1`,
    [organizationId, country],
  );
}

/** Verlaufseintrag (nur anhaengen). */
export async function recordCountryChange(
  manager: EntityManager,
  entry: {
    organizationId: string;
    fromValue: string | null;
    toValue: string;
    reason?: string | null;
    bySupport?: boolean;
    user?: User | null;
    client?: ClientInfo;
    at?: Date;
  },
): Promise<void> {
  await manager.insert(OrganizationCashPolicyChange, {
    organizationId: entry.organizationId,
    kind: 'country',
    fromValue: entry.fromValue,
    toValue: entry.toValue,
    reason: entry.reason ?? null,
    bySupport: entry.bySupport ?? false,
    changedByUserId: entry.user?.id ?? null,
    changedByName: entry.user ? actorName(entry.user) : null,
    ipAddress: entry.client?.ipAddress?.slice(0, 45) ?? null,
    userAgent: entry.client?.userAgent?.slice(0, 500) ?? null,
    createdAt: entry.at ?? new Date(),
  });
}

/**
 * Land einer neu angelegten Organisation (Registrierung, „Neue
 * Organisation“): Kopie in den Einstellungen und erster Verlaufseintrag.
 * Laeuft in der Transaktion des Anlegens.
 */
export async function recordInitialCountry(
  manager: EntityManager,
  organizationId: string,
  country: string,
  user: User | null,
): Promise<void> {
  await writeCountry(manager, organizationId, country);
  await recordCountryChange(manager, {
    organizationId,
    fromValue: null,
    toValue: country,
    reason: 'Beim Anlegen der Organisation',
    user,
  });
}
