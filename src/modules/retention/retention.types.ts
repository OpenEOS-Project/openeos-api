import type { EntityManager } from 'typeorm';
import type { RetentionConfig } from './retention.config';

/**
 * Ein Loeschlauf je Datenart. Die Reihenfolge ist die Ausfuehrungsreihenfolge:
 * erst die kurzen Fristen, dann Organisationen und Konten, zuletzt der
 * Bericht ueber das Steuerarchiv.
 */
export const RETENTION_CATEGORIES = [
  'guest_data',
  'helper_data',
  'waiter_data',
  'auth_records',
  'audit_logs',
  'support_messages',
  'contact_requests',
  'assistant_imports',
  'webhook_deliveries',
  'organization_inactivity',
  'organization_purge',
  'user_accounts',
  'deletion_reminders',
  'fiscal_archive',
] as const;

export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

/**
 * Datenarten im Protokoll der Loeschungen, die kein naechtlicher Lauf sind,
 * sondern Loeschungen durch den Verein selbst (`club`): Organisation
 * geloescht bzw. wiederhergestellt, Mitglied entfernt. Schichtanmeldungen
 * stehen unter `helper_data`, Konten unter `user_accounts`.
 */
export const CLUB_DELETION_CATEGORIES = [
  'organization_closure',
  'memberships',
] as const;

/** Alles, was im Protokoll (`retention_runs.category`) stehen kann. */
export const DELETION_LOG_CATEGORIES = [
  ...RETENTION_CATEGORIES,
  ...CLUB_DELETION_CATEGORIES,
] as const;

export type DeletionLogCategory = (typeof DELETION_LOG_CATEGORIES)[number];

/**
 * scheduled = naechtlicher Lauf, manual = von Hand ausgeloest,
 * instruction = Loeschung auf Weisung (Einzelloeschung, sofortige
 * endgueltige Loeschung einer Organisation), self_service = Benutzer hat
 * sein Konto (bzw. ein Helfer seine Anmeldung) selbst geloescht, club =
 * der Verein hat geloescht (Organisation, Mitglied, Schichtanmeldungen)
 */
export type RetentionTrigger =
  | 'scheduled'
  | 'manual'
  | 'instruction'
  | 'self_service'
  | 'club';

export const RETENTION_TRIGGERS: RetentionTrigger[] = [
  'scheduled',
  'manual',
  'instruction',
  'self_service',
  'club',
];

export type RetentionRunStatus = 'running' | 'succeeded' | 'failed';

export interface RetentionRunContext {
  readonly now: Date;
  readonly dryRun: boolean;
  /** Transaktion des Laufs; im Probelauf wird sie zurueckgerollt. */
  readonly manager: EntityManager;
  readonly config: RetentionConfig;
  /** Geloeschte bzw. anonymisierte Datensaetze (zaehlen in `total`). */
  removed(key: string, count: number): void;
  /** Sonstige Zahlen (Ankuendigungen, uebersprungene Faelle …). */
  note(key: string, count: number): void;
  /**
   * Nebenwirkung ausserhalb der Datenbank (Dateien loeschen), erst nach
   * erfolgreichem Commit und nie im Probelauf.
   */
  afterCommit(task: () => Promise<void>): void;
}

export interface RetentionJob {
  readonly category: RetentionCategory;
  run(ctx: RetentionRunContext): Promise<void>;
}

export const RETENTION_JOBS = Symbol('RETENTION_JOBS');
