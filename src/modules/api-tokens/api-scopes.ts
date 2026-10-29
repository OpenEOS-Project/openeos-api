import type { OrganizationPermissions } from '../../database/entities/user-organization.entity';

/**
 * Was ein API-Token dürfen kann.
 *
 * Ein Token wirkt wie sein Besitzer, nur enger: Zu jeder Anfrage muss der
 * Endpunkt für Tokens freigegeben sein (`@ApiTokenAccess`) und der Token
 * den dort verlangten Geltungsbereich tragen. Was der Besitzer selbst
 * nicht darf (Mitgliedsrolle, Modul-Berechtigungen), darf der Token auch
 * nicht — die Scopes schränken nur ein, sie erweitern nie.
 *
 * Bewusst nicht als Scope vorhanden (ki-plan.md, Abschnitt 5): Kasse
 * (bestellen, kassieren, erstatten), Mitglieder, Geld/Abrechnung, Löschen,
 * Freischaltung von Veranstaltungen.
 */
export enum TokenScope {
  /** Stammdaten, Veranstaltungen, Bestellungen (nur lesen), Berichte. */
  READ = 'read',
  /** Kategorien, Produkte, Pfandarten anlegen und ändern. */
  CATALOG_WRITE = 'catalog:write',
  /** Veranstaltungen und Produktionsstationen anlegen und ändern — nicht freischalten. */
  EVENTS_WRITE = 'events:write',
  /** Bereiche, Tische und Tischplan. */
  TABLES_WRITE = 'tables:write',
  /** Schichtpläne, Jobs, Schichten, Helfer-Anmeldungen bearbeiten. */
  STAFF_WRITE = 'staff:write',
  /** Bon-Vorlagen anlegen und ändern. */
  DEVICES_WRITE = 'devices:write',
  /** Organisationseinstellungen ändern. */
  SETTINGS_WRITE = 'settings:write',
  /** Plattform-Kennzahlen (nur Super-Admin-Tokens, keine Organisation). */
  MONITORING_READ = 'monitoring:read',
}

/** Alte Schreibweise — bleibt für den Monitoring-Controller. */
export const API_SCOPES = {
  MONITORING_READ: TokenScope.MONITORING_READ,
} as const;

export type ApiScope = `${TokenScope}`;

/** Scopes, die ein Organisations-Token tragen darf. */
export const ORGANIZATION_TOKEN_SCOPES: readonly TokenScope[] = [
  TokenScope.READ,
  TokenScope.CATALOG_WRITE,
  TokenScope.EVENTS_WRITE,
  TokenScope.TABLES_WRITE,
  TokenScope.STAFF_WRITE,
  TokenScope.DEVICES_WRITE,
  TokenScope.SETTINGS_WRITE,
];

/** Scopes für Tokens ohne Organisation (Super-Admin, `admin/api-tokens`). */
export const PLATFORM_TOKEN_SCOPES: readonly TokenScope[] = [
  TokenScope.MONITORING_READ,
];

export const ALLE_SCOPES: TokenScope[] = Object.values(TokenScope);

/**
 * Welche Modul-Berechtigung der Besitzer für einen Scope mindestens
 * braucht. Die Dienste prüfen das ohnehin je Anfrage; die Tabelle ist
 * für die Oberfläche (Hinweis beim Anlegen) und die Doku.
 *
 * `read` reicht Mitgliedschaft; Berichte verlangen zusätzlich `reports`.
 */
export const SCOPE_PERMISSIONS: Record<
  TokenScope,
  (keyof OrganizationPermissions)[]
> = {
  [TokenScope.READ]: [],
  [TokenScope.CATALOG_WRITE]: ['products', 'pfand'],
  [TokenScope.EVENTS_WRITE]: ['events'],
  [TokenScope.TABLES_WRITE]: ['events'],
  [TokenScope.STAFF_WRITE]: ['shiftPlans'],
  [TokenScope.DEVICES_WRITE]: ['devices'],
  [TokenScope.SETTINGS_WRITE]: [],
  [TokenScope.MONITORING_READ]: [],
};

/** Kurzbeschreibung je Scope, für die Oberfläche und die API-Doku. */
export const SCOPE_DESCRIPTIONS: Record<TokenScope, string> = {
  [TokenScope.READ]:
    'Organisation, Veranstaltungen, Kategorien, Produkte, Pfandarten, Tische, Stationen, Bon-Vorlagen, Drucker, Schichtpläne, Geräte, Berichte und Bestellungen lesen',
  [TokenScope.CATALOG_WRITE]:
    'Kategorien, Produkte und Pfandarten anlegen und ändern',
  [TokenScope.EVENTS_WRITE]:
    'Veranstaltungen und Produktionsstationen anlegen und ändern (keine Freischaltung)',
  [TokenScope.TABLES_WRITE]: 'Bereiche, Tische und Tischplan bearbeiten',
  [TokenScope.STAFF_WRITE]:
    'Schichtpläne, Jobs, Schichten und Helfer-Anmeldungen bearbeiten',
  [TokenScope.DEVICES_WRITE]: 'Bon-Vorlagen anlegen und ändern',
  [TokenScope.SETTINGS_WRITE]: 'Organisationseinstellungen ändern',
  [TokenScope.MONITORING_READ]: 'Plattform-Kennzahlen lesen (Super-Admin)',
};
