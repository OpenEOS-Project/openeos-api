import type { MenuImportWorkerService } from '../../assistant/menu-import/menu-import-worker.service';
import { select } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

const FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
const IMPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Assistent-Funktionen: hochgeladene Speisekarten 24 Stunden, Vorschlaege
 * 30 Tage. Geloescht wird stuendlich vom Import-Worker; dieser naechtliche
 * Lauf stoesst dieselbe Aufraeumfunktion an, damit auch diese Datenart im
 * Protokoll der Loeschlaeufe steht. Im Probelauf wird nur gezaehlt.
 */
export class AssistantImportsJob implements RetentionJob {
  readonly category = 'assistant_imports' as const;

  constructor(private readonly worker: MenuImportWorkerService) {}

  async run(ctx: RetentionRunContext): Promise<void> {
    if (ctx.dryRun) {
      const [row] = await select<{ files: number; imports: number }>(
        ctx.manager,
        `SELECT count(*) FILTER (WHERE files_deleted_at IS NULL AND created_at < $1)::int AS files,
                count(*) FILTER (WHERE created_at < $2)::int AS imports
           FROM menu_imports`,
        [
          new Date(ctx.now.getTime() - FILE_RETENTION_MS),
          new Date(ctx.now.getTime() - IMPORT_RETENTION_MS),
        ],
      );
      ctx.removed('uploadFoldersDeleted', row?.files ?? 0);
      ctx.removed('importsDeleted', row?.imports ?? 0);
      return;
    }
    const result = await this.worker.cleanupNow(ctx.now);
    ctx.removed('uploadFoldersDeleted', result.filesDeleted);
    ctx.removed('importsDeleted', result.importsDeleted);
  }
}
