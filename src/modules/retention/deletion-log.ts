import type { EntityManager } from 'typeorm';

import type { DeletionLogCategory } from './retention.types';

/**
 * Eintrag im Protokoll der Loeschungen (`retention_runs`) fuer Loeschungen,
 * die kein Loeschlauf sind: der Verein loescht selbst (Organisation,
 * Mitglied, Schichtanmeldungen; Ausloeser `club`) oder ein Helfer meldet
 * sich selbst ab (`self_service`). Loeschkonzept 1.5/5.3.
 *
 * Festgehalten werden wer (`executedByUserId`), wann, welche Datenart und
 * wie viele Datensaetze, dazu Kennungen (`details`) — nie Inhalte wie
 * Namen, E-Mail-Adressen oder Notizen.
 */
export interface DeletionLogEntry {
  category: DeletionLogCategory;
  trigger: 'club' | 'self_service';
  organizationId: string | null;
  executedByUserId: string | null;
  /** Geloeschte bzw. geschlossene Datensaetze (zaehlen in `total`). */
  removed: Record<string, number>;
  /** Sonstige Zahlen, z. B. `organizationsRestored`. */
  notes?: Record<string, number>;
  details?: Record<string, unknown> | null;
  reason?: string | null;
  at?: Date;
}

/**
 * Schreibt den Eintrag. In der Transaktion der Loeschung aufrufen
 * (`manager`), damit Loeschung und Protokoll nur gemeinsam gelingen.
 */
export async function recordDeletion(
  manager: EntityManager,
  entry: DeletionLogEntry,
): Promise<void> {
  const at = entry.at ?? new Date();
  const counts: Record<string, number> = {
    ...(entry.notes ?? {}),
    ...entry.removed,
  };
  const total = Object.values(entry.removed).reduce((sum, n) => sum + n, 0);
  await manager.query(
    `INSERT INTO retention_runs
       (category, trigger, dry_run, status, started_at, finished_at, counts,
        total, organization_id, executed_by_user_id, reason, details)
     VALUES ($1, $2, false, 'succeeded', $3, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.category,
      entry.trigger,
      at,
      JSON.stringify(counts),
      total,
      entry.organizationId,
      entry.executedByUserId,
      entry.reason ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    ],
  );
}
