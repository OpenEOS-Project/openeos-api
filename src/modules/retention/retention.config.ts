import {
  RETENTION_CATEGORIES,
  type RetentionCategory,
} from './retention.types';

/**
 * Aufbewahrungs- und Loeschfristen (README „Aufbewahrung und Löschung“).
 *
 * Die Standardwerte sind die Fristen aus den Vertragsunterlagen des
 * gehosteten Betriebs. Jede Frist laesst sich per Umgebungsvariable
 * aendern; Fristen, nach denen Kundendaten verschwinden, haben eine
 * Untergrenze von 30 Tagen: kein Loeschlauf darf Daten entfernen, die
 * nicht mindestens 30 Tage lang exportiert werden konnten.
 */
export interface RetentionConfig {
  /** Laufen die naechtlichen Loeschlaeufe ueberhaupt? */
  enabled: boolean;
  /** Nur zaehlen und protokollieren, nichts aendern, keine Mails. */
  dryRun: boolean;
  /** Nur diese Kategorien (leer = alle). */
  categories: RetentionCategory[];
  /** Gaesteangaben in Bestellungen: Tage nach dem Ende der Veranstaltung. */
  guestDataDays: number;
  /** Schichtanmeldungen: Tage nach der letzten Schicht des Plans. */
  helperDataDays: number;
  /** Admin-Protokoll und IP-Angaben in Aenderungsprotokollen. */
  auditLogDays: number;
  /** Erledigte, abgelaufene Einladungen und widerrufene API-Tokens. */
  staleCredentialDays: number;
  /** Support-Chat: Monate nach dem Ende der Nutzung. */
  supportMonths: number;
  /** Website-Anfragen: Monate nach Abschluss der Bearbeitung. */
  contactMonths: number;
  /** Organisationen ohne Buchung: Monate bis zur Ankuendigung. */
  inactiveOrganizationMonths: number;
  /** Benutzerkonten ohne Organisation und ohne Anmeldung. */
  inactiveUserMonths: number;
  /** Vorlauf zwischen Ankuendigung und Schliessung bzw. Loeschung. */
  noticeDays: number;
  /** Exportfrist nach dem Loeschen bzw. Schliessen einer Organisation. */
  exportPeriodDays: number;
  /** Steuerarchiv (nur Bericht, keine Loeschung). */
  fiscalArchiveYears: number;
  /** Eigenes Protokoll der Loeschlaeufe. */
  runLogYears: number;
}

/** Kein Loeschlauf darf Daten entfernen, die kuerzer exportierbar waren. */
export const MIN_EXPORT_OFFER_DAYS = 30;

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number, min = 1): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function categories(env: Env): RetentionCategory[] {
  const raw = env.RETENTION_CATEGORIES?.trim();
  if (!raw) return [];
  const known = new Set<string>(RETENTION_CATEGORIES);
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is RetentionCategory => known.has(part));
}

/**
 * Liest die Konfiguration aus der Umgebung.
 *
 * - `RETENTION_ENABLED`: Standard an im gehosteten Betrieb, aus bei
 *   `DEPLOYMENT_MODE=selfhosted` (dort entscheidet der Betreiber).
 * - `RETENTION_DRY_RUN`: Standard aus nur bei `NODE_ENV=production`,
 *   sonst an — Staging und Entwicklung zaehlen erst einmal nur.
 */
export function loadRetentionConfig(env: Env = process.env): RetentionConfig {
  const selfHosted = env.DEPLOYMENT_MODE === 'selfhosted';
  const production = env.NODE_ENV === 'production';
  return {
    enabled: bool(env, 'RETENTION_ENABLED', !selfHosted),
    dryRun: bool(env, 'RETENTION_DRY_RUN', !production),
    categories: categories(env),
    guestDataDays: int(
      env,
      'RETENTION_GUEST_DATA_DAYS',
      30,
      MIN_EXPORT_OFFER_DAYS,
    ),
    helperDataDays: int(
      env,
      'RETENTION_HELPER_DATA_DAYS',
      30,
      MIN_EXPORT_OFFER_DAYS,
    ),
    auditLogDays: int(env, 'RETENTION_AUDIT_LOG_DAYS', 90),
    staleCredentialDays: int(env, 'RETENTION_STALE_CREDENTIAL_DAYS', 90),
    supportMonths: int(env, 'RETENTION_SUPPORT_MONTHS', 12),
    contactMonths: int(env, 'RETENTION_CONTACT_MONTHS', 6),
    inactiveOrganizationMonths: int(env, 'RETENTION_INACTIVE_ORG_MONTHS', 24),
    inactiveUserMonths: int(env, 'RETENTION_INACTIVE_USER_MONTHS', 24),
    noticeDays: int(
      env,
      'RETENTION_NOTICE_DAYS',
      MIN_EXPORT_OFFER_DAYS,
      MIN_EXPORT_OFFER_DAYS,
    ),
    exportPeriodDays: int(
      env,
      'RETENTION_EXPORT_PERIOD_DAYS',
      30,
      MIN_EXPORT_OFFER_DAYS,
    ),
    fiscalArchiveYears: int(env, 'RETENTION_FISCAL_ARCHIVE_YEARS', 10, 10),
    runLogYears: int(env, 'RETENTION_RUN_LOG_YEARS', 3),
  };
}

export const RETENTION_CONFIG = Symbol('RETENTION_CONFIG');

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export function daysAfter(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** Kalendermonate zurueck (UTC), z. B. 24 Monate vor dem 31.03. = 31.03. */
export function monthsBefore(now: Date, months: number): Date {
  const result = new Date(now.getTime());
  result.setUTCMonth(result.getUTCMonth() - months);
  return result;
}

/**
 * Die Regel, an der jede endgueltige Loeschung haengt: Die Ankuendigung
 * mit dem Exportangebot muss mindestens `MIN_EXPORT_OFFER_DAYS` (bzw. die
 * eingestellte Vorlaufzeit, wenn laenger) zurueckliegen.
 */
export function exportOfferHonoured(
  noticeSentAt: Date | null | undefined,
  now: Date,
  noticeDays: number,
): boolean {
  if (!noticeSentAt) return false;
  const required = Math.max(noticeDays, MIN_EXPORT_OFFER_DAYS);
  return noticeSentAt.getTime() <= daysBefore(now, required).getTime();
}
