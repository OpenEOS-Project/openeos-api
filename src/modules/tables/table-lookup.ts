import { EntityManager } from 'typeorm';
import { LABEL_MAX } from './tables.constants';

/**
 * Sucht best effort einen aktiven Tisch der Organisation zu einer frei
 * eingegebenen Tischnummer (gross/klein und Leerzeichen am Rand egal).
 * Liefert null, wenn es keinen passenden Tisch gibt oder die Suche
 * scheitert — Aufrufer (Shop, QR, Kasse im Modus `free`) lehnen deswegen
 * nie ab; `table_number` bleibt die massgebliche Angabe.
 */
export async function findTableIdByLabel(
  manager: EntityManager,
  organizationId: string,
  label: string | null | undefined,
): Promise<string | null> {
  const trimmed = label?.trim();
  if (!trimmed || trimmed.length > LABEL_MAX) return null;
  try {
    const rows: { id: string }[] = await manager.query(
      `SELECT id FROM dining_tables
        WHERE organization_id = $1
          AND upper(label) = upper($2)
          AND deleted_at IS NULL
          AND is_active
        LIMIT 1`,
      [organizationId, trimmed],
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}
