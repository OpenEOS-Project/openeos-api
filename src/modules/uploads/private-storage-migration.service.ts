import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { promises as fs } from 'fs';
import * as path from 'path';
import { DataSource, QueryRunner } from 'typeorm';
import {
  PRIVATE_MENU_IMPORT_DIR,
  UPLOAD_FALLBACK_DIR,
  privateStorageFromConfig,
} from '../../common/storage/private-storage';
import {
  MoveResult,
  moveTree,
  normalizedStoredPath,
} from '../../common/storage/private-storage-migration';
import { tseSettingsFromEnv } from '../tse/tse.config';
import { fixHint } from './upload-dir';

/** Sperre, damit bei mehreren Instanzen nur eine umzieht. */
export const PRIVATE_STORAGE_LOCK_KEY = 7_234_118_002;

export interface PrivateStorageMigrationReport {
  skipped?: 'locked' | 'not-writable';
  moves: { from: string; to: string; result: MoveResult }[];
  updatedRows: number;
  missingFiles: number;
}

/**
 * Beim Start: Speisekarten-Importe, TSE-Exporte und DSFinV-K-Archiv, die
 * noch im Upload-Verzeichnis liegen, in die private Ablage umziehen und
 * gespeicherte absolute Pfade auf die neue Ablage umschreiben (relative
 * Pfade bleiben gueltig, die Struktur unter der Ablage ist dieselbe).
 */
@Injectable()
export class PrivateStorageMigrationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PrivateStorageMigrationService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      this.logger.error(
        `Moving private files failed: ${(error as Error).message}`,
      );
    }
  }

  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const key of ['UPLOAD_DIR', 'PRIVATE_STORAGE_DIR', 'TSE_EXPORT_DIR']) {
      const raw = this.configService.get<unknown>(key);
      env[key] = typeof raw === 'string' ? raw : undefined;
    }
    return env;
  }

  async run(): Promise<PrivateStorageMigrationReport> {
    const report: PrivateStorageMigrationReport = {
      moves: [],
      updatedRows: 0,
      missingFiles: 0,
    };
    const storage = privateStorageFromConfig(this.configService);
    const tse = tseSettingsFromEnv(this.env());
    if (storage.fallback) {
      this.logger.warn(
        `Private storage falls back to ${storage.root}: ${storage.reason}. Mount a volume at PRIVATE_STORAGE_DIR (default <UPLOAD_DIR>/../private) owned by uid 1001.`,
      );
    }

    try {
      await fs.mkdir(storage.root, { recursive: true, mode: 0o700 });
      await fs.access(storage.root, fs.constants.W_OK);
    } catch (error) {
      this.logger.warn(
        `Private storage ${storage.root} is not writable (${(error as NodeJS.ErrnoException).code ?? 'error'}) — ${fixHint(storage.root)}`,
      );
      report.skipped = 'not-writable';
      return report;
    }

    const menuTarget = path.join(storage.root, PRIVATE_MENU_IMPORT_DIR);
    const moves = [
      ...[
        path.join(storage.uploadRoot, PRIVATE_MENU_IMPORT_DIR),
        path.join(
          storage.uploadRoot,
          UPLOAD_FALLBACK_DIR,
          PRIVATE_MENU_IMPORT_DIR,
        ),
      ]
        .filter((from) => from !== menuTarget)
        .map((from) => ({ from, to: menuTarget })),
      ...tse.legacyExportDirs.map((from) => ({ from, to: tse.exportDir })),
    ];

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [PRIVATE_STORAGE_LOCK_KEY],
      )) as { locked: boolean }[];
      if (!rows[0]?.locked) {
        report.skipped = 'locked';
        return report;
      }
      try {
        for (const move of moves) {
          const result = await moveTree(move.from, move.to, this.logger);
          if (
            result.moved ||
            result.alreadyPresent ||
            result.conflicts.length
          ) {
            this.logger.log(
              `Private storage: moved ${result.moved} file(s) from ${move.from} to ${move.to} (${result.alreadyPresent} already present, ${result.conflicts.length} conflict(s))`,
            );
          }
          report.moves.push({ ...move, result });
        }
        const exportBases = [tse.exportDir, ...tse.legacyExportDirs];
        report.updatedRows += await this.rewriteColumn(
          runner,
          'tse_exports',
          'file_path',
          exportBases,
        );
        report.updatedRows += await this.rewriteColumn(
          runner,
          'cash_point_closings',
          'export_file_path',
          exportBases,
        );
        report.updatedRows += await this.rewriteMenuImports(runner, [
          storage.root,
          storage.uploadRoot,
        ]);
        report.missingFiles = await this.countMissing(runner, tse.exportDir);
        if (report.missingFiles > 0) {
          this.logger.warn(
            `Private storage: ${report.missingFiles} archived export file(s) not found under ${tse.exportDir}`,
          );
        }
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [
          PRIVATE_STORAGE_LOCK_KEY,
        ]);
      }
    } finally {
      await runner.release();
    }
    return report;
  }

  /** Absolute Pfade in einer Textspalte relativ zur Ablage machen. */
  private async rewriteColumn(
    runner: QueryRunner,
    table: 'tse_exports' | 'cash_point_closings',
    column: 'file_path' | 'export_file_path',
    bases: string[],
  ): Promise<number> {
    const rows = (await runner.query(
      `SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE '/%'`,
    )) as { id: string; value: string }[];
    let updated = 0;
    for (const row of rows) {
      const next = normalizedStoredPath(row.value, bases);
      if (!next) continue;
      await runner.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [
        next,
        row.id,
      ]);
      updated++;
    }
    return updated;
  }

  /** `menu_imports.files` (jsonb-Array) entsprechend. */
  private async rewriteMenuImports(
    runner: QueryRunner,
    bases: string[],
  ): Promise<number> {
    const rows = (await runner.query(
      `SELECT id, files FROM menu_imports
        WHERE files_deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(files) f WHERE f LIKE '/%')`,
    )) as { id: string; files: string[] }[];
    let updated = 0;
    for (const row of rows) {
      const files = row.files.map(
        (file) => normalizedStoredPath(file, bases) ?? file,
      );
      await runner.query('UPDATE menu_imports SET files = $1 WHERE id = $2', [
        JSON.stringify(files),
        row.id,
      ]);
      updated++;
    }
    return updated;
  }

  private async countMissing(
    runner: QueryRunner,
    exportDir: string,
  ): Promise<number> {
    const rows = (await runner.query(
      `SELECT file_path AS value FROM tse_exports WHERE file_path IS NOT NULL
       UNION ALL
       SELECT export_file_path FROM cash_point_closings WHERE export_file_path IS NOT NULL`,
    )) as { value: string }[];
    let missing = 0;
    for (const row of rows) {
      try {
        await fs.access(path.resolve(exportDir, row.value));
      } catch {
        missing++;
      }
    }
    return missing;
  }
}
