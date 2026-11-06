import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { In, type DataSource, type EntityManager } from 'typeorm';

import { Organization } from '../../database/entities/organization.entity';

import {
  daysAfter,
  loadRetentionConfig,
} from '../../modules/retention/retention.config';
import { rowsOf } from '../../modules/tse/tse-sql.util';

/**
 * Zustand einer geloeschten bzw. geschlossenen Organisation (AGB 10.4,
 * AVV 10.2): bis zur endgueltigen Loeschung ist sie fuer ihre
 * Administratoren nur noch lesend nutzbar, damit sie alle Daten
 * exportieren koennen. Danach (`purged`) bleibt nur die gesperrte Huelle
 * mit dem Steuerarchiv.
 */
export interface OrganizationClosure {
  /** Zeitpunkt des Loeschens bzw. Schliessens (`organizations.deleted_at`). */
  closedAt: Date;
  /**
   * Geplante endgueltige Loeschung: Termin der Ankuendigung, sonst
   * Loeschzeitpunkt plus Exportfrist (`RETENTION_EXPORT_PERIOD_DAYS`).
   */
  finalDeletionAt: Date;
  /** Endgueltig geloescht (nur noch Huelle mit Steuerarchiv). */
  purged: boolean;
  /** Immer `true`: Schreibzugriffe lehnt die API ab. */
  readOnly: true;
}

interface ClosureRow {
  id: string;
  deleted_at: Date;
  purged: boolean;
  due_at: Date | null;
}

const CLOSURE_SQL = `
  SELECT o.id, o.deleted_at,
         (o.slug LIKE 'purged-%' OR EXISTS (
            SELECT 1 FROM retention_notices x
             WHERE x.subject_type = 'organization' AND x.subject_id = o.id
               AND x.kind = 'organization_deletion' AND x.executed_at IS NOT NULL
         )) AS purged,
         (SELECT n.due_at FROM retention_notices n
           WHERE n.subject_type = 'organization' AND n.subject_id = o.id
             AND n.kind = 'organization_deletion' AND n.cancelled_at IS NULL
           ORDER BY n.sent_at DESC LIMIT 1) AS due_at
    FROM organizations o
   WHERE o.id = ANY($1::uuid[]) AND o.deleted_at IS NOT NULL`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rein: Zustand aus der Zeile und der Exportfrist. */
export function closureFromRow(
  row: Pick<ClosureRow, 'deleted_at' | 'purged' | 'due_at'>,
  exportPeriodDays: number,
): OrganizationClosure {
  const closedAt = new Date(row.deleted_at);
  return {
    closedAt,
    finalDeletionAt: row.due_at
      ? new Date(row.due_at)
      : daysAfter(closedAt, exportPeriodDays),
    purged: row.purged === true,
    readOnly: true,
  };
}

/**
 * Liest den Loeschzustand von Organisationen. Eine Abfrage je Anfrage
 * (Primaerschluessel), bewusst ohne Zwischenspeicher: nach dem Loeschen
 * darf keine Instanz mehr einen Schreibzugriff durchlassen.
 */
@Injectable()
export class OrganizationClosureService {
  private readonly exportPeriodDays = loadRetentionConfig().exportPeriodDays;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Nur geloeschte bzw. geschlossene Organisationen stehen in der Map. */
  async closures(
    organizationIds: readonly string[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Map<string, OrganizationClosure>> {
    const ids = [...new Set(organizationIds)].filter((id) => UUID.test(id));
    const result = new Map<string, OrganizationClosure>();
    if (ids.length === 0) return result;
    const rows = rowsOf<ClosureRow>(await manager.query(CLOSURE_SQL, [ids]));
    for (const row of rows) {
      result.set(row.id, closureFromRow(row, this.exportPeriodDays));
    }
    return result;
  }

  async closure(organizationId: string): Promise<OrganizationClosure | null> {
    return (await this.closures([organizationId])).get(organizationId) ?? null;
  }

  /** Geloeschte Organisationen als Entity (ohne den Filter fuer `deletedAt`). */
  async deletedOrganizations(
    organizationIds: readonly string[],
  ): Promise<Organization[]> {
    const ids = [...new Set(organizationIds)].filter((id) => UUID.test(id));
    if (ids.length === 0) return [];
    const organizations = await this.dataSource
      .getRepository(Organization)
      .find({ where: { id: In(ids) }, withDeleted: true });
    return organizations.filter((o) => o.deletedAt);
  }

  /** Organisation einer Veranstaltung (fuer Pfade unter `events/:eventId`). */
  async organizationOfEvent(eventId: string): Promise<string | null> {
    if (!UUID.test(eventId)) return null;
    const rows = rowsOf<{ organization_id: string }>(
      await this.dataSource.query(
        `SELECT organization_id FROM events WHERE id = $1`,
        [eventId],
      ),
    );
    return rows[0]?.organization_id ?? null;
  }
}
