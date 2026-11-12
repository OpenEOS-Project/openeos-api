import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { resetPrivateStorageCache } from '../../common/storage/private-storage';
import {
  PRIVATE_STORAGE_LOCK_KEY,
  PrivateStorageMigrationService,
} from './private-storage-migration.service';

/**
 * Umzug in die private Ablage gegen ein echtes Postgres: Dateien aus dem
 * Upload-Verzeichnis landen in der privaten Ablage, gespeicherte Pfade
 * zeigen danach dorthin, ein zweiter Lauf aendert nichts, und bei
 * gehaltener Sperre zieht eine zweite Instanz nicht parallel um.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5561/openeos_x_scratch pnpm test private-storage-migration.db
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('private storage migration against Postgres', () => {
  let ds: DataSource;
  let root: string;
  let uploads: string;
  let privateDir: string;
  const orgId = randomUUID();
  let unitId: string;
  let eventId: string;
  const serial = 'ab12cd';

  const q = <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => ds.query(sql, params);

  const put = (rel: string, content: string) => {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  const service = () =>
    new PrivateStorageMigrationService(
      {
        get: (key: string) =>
          ({ UPLOAD_DIR: uploads, PRIVATE_STORAGE_DIR: privateDir })[key],
      } as unknown as ConfigService,
      ds,
    );

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    }
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();
    resetPrivateStorageCache();

    root = mkdtempSync(path.join(tmpdir(), 'private-migration-'));
    uploads = path.join(root, 'uploads');
    privateDir = path.join(root, 'private');

    await q(
      `INSERT INTO organizations (id, name, slug, support_pin) VALUES ($1, 'Verein', $2, '123456')`,
      [orgId, `verein-${orgId}`],
    );
    [{ id: eventId }] = await q<{ id: string }>(
      `INSERT INTO events (organization_id, name) VALUES ($1, 'Fest') RETURNING id`,
      [orgId],
    );
    [{ id: unitId }] = await q<{ id: string }>(
      `INSERT INTO tse_units (organization_id, state, product_type, client_id, trigger, serial_number)
       VALUES ($1, 'active', '850004', 'client', 'manual', $2) RETURNING id`,
      [orgId, serial],
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await q(`DELETE FROM tse_exports WHERE organization_id = $1`, [orgId]);
      await q(`DELETE FROM tse_units WHERE organization_id = $1`, [orgId]);
      // Abschluesse sind sonst unloeschbar (Aufbewahrung).
      await q(
        `ALTER TABLE cash_point_closings DISABLE TRIGGER cash_point_closings_immutable`,
      );
      await q(`DELETE FROM cash_point_closings WHERE organization_id = $1`, [
        orgId,
      ]);
      await q(
        `ALTER TABLE cash_point_closings ENABLE TRIGGER cash_point_closings_immutable`,
      );
      await q(`DELETE FROM menu_imports WHERE organization_id = $1`, [orgId]);
      await q(`DELETE FROM events WHERE organization_id = $1`, [orgId]);
      await q(`DELETE FROM organizations WHERE id = $1`, [orgId]);
      await ds.destroy();
    }
    if (root) rmSync(root, { recursive: true, force: true });
    resetPrivateStorageCache();
    jest.restoreAllMocks();
  });

  const insertExport = async (filePath: string) => {
    const [row] = await q<{ id: string }>(
      `INSERT INTO tse_exports (organization_id, tse_unit_id, serial_number, swissbit_export_id, status, trigger, file_path)
       VALUES ($1, $2, $3, $4, 'downloaded', 'manual', $5) RETURNING id`,
      [orgId, unitId, serial, randomUUID(), filePath],
    );
    return row.id;
  };

  const insertClosing = async (zNr: number, filePath: string) => {
    const [row] = await q<{ id: string }>(
      `INSERT INTO cash_point_closings (organization_id, register_id, z_nr, business_date, period_to,
         closing_created_at, trigger, totals, master_data, rows, content_sha256, export_file_path)
       VALUES ($1, 'K1', $2, '2026-11-01', now(), now(), 'manual', '{}', '{}', '{}', $3, $4)
       RETURNING id`,
      [orgId, zNr, 'a'.repeat(64), filePath],
    );
    return row.id;
  };

  const insertImport = async (files: string[]) => {
    const [row] = await q<{ id: string }>(
      `INSERT INTO menu_imports (organization_id, event_id, source, files)
       VALUES ($1, $2, 'image', $3) RETURNING id`,
      [orgId, eventId, JSON.stringify(files)],
    );
    return row.id;
  };

  it('moves files out of the upload directory and points stored paths at private storage', async () => {
    const legacyExports = path.join(uploads, 'tse-exports');
    put(`uploads/tse-exports/${orgId}/${serial}/a.tar`, 'TAR-A');
    put(`uploads/tse-exports/${orgId}/${serial}/b.tar`, 'TAR-B');
    put(`uploads/tse-exports/${orgId}/dsfinvk/Z000001_2026-11-01.zip`, 'ZIP');
    const relativeExport = await insertExport(`${orgId}/${serial}/a.tar`);
    const absoluteExport = await insertExport(
      path.join(legacyExports, orgId, serial, 'b.tar'),
    );
    const closing = await insertClosing(
      1,
      `${orgId}/dsfinvk/Z000001_2026-11-01.zip`,
    );
    put(`uploads/tse-exports/${orgId}/dsfinvk/Z000003_2026-11-02.zip`, 'ZIP-3');
    const absoluteClosing = await insertClosing(
      3,
      path.join(legacyExports, orgId, 'dsfinvk', 'Z000003_2026-11-02.zip'),
    );

    const importA = randomUUID();
    const importB = randomUUID();
    put(`uploads/menu-imports/${importA}/page-01.png`, 'PNG-A');
    put(`uploads/menu-imports/${importB}/page-01.png`, 'PNG-B');
    const rowA = await insertImport([`menu-imports/${importA}/page-01.png`]);
    const rowB = await insertImport([
      path.join(uploads, 'menu-imports', importB, 'page-01.png'),
    ]);
    // Zeile ohne Datei: wird gemeldet, nicht veraendert.
    const missing = await insertClosing(2, `${orgId}/dsfinvk/missing.zip`);

    const report = await service().run();

    expect(report.skipped).toBeUndefined();
    expect(report.updatedRows).toBe(3);
    expect(report.missingFiles).toBeGreaterThanOrEqual(1);
    expect(existsSync(legacyExports)).toBe(false);
    expect(existsSync(path.join(uploads, 'menu-imports'))).toBe(false);

    const exportDir = path.join(privateDir, 'tse-exports');
    const [a] = await q<{ file_path: string }>(
      `SELECT file_path FROM tse_exports WHERE id = $1`,
      [relativeExport],
    );
    const [b] = await q<{ file_path: string }>(
      `SELECT file_path FROM tse_exports WHERE id = $1`,
      [absoluteExport],
    );
    expect(b.file_path).toBe(`${orgId}/${serial}/b.tar`);
    expect(readFileSync(path.join(exportDir, a.file_path), 'utf8')).toBe(
      'TAR-A',
    );
    expect(readFileSync(path.join(exportDir, b.file_path), 'utf8')).toBe(
      'TAR-B',
    );
    const [c] = await q<{ export_file_path: string }>(
      `SELECT export_file_path FROM cash_point_closings WHERE id = $1`,
      [closing],
    );
    expect(readFileSync(path.join(exportDir, c.export_file_path), 'utf8')).toBe(
      'ZIP',
    );
    const [c3] = await q<{ export_file_path: string }>(
      `SELECT export_file_path FROM cash_point_closings WHERE id = $1`,
      [absoluteClosing],
    );
    expect(c3.export_file_path).toBe(`${orgId}/dsfinvk/Z000003_2026-11-02.zip`);
    expect(
      readFileSync(path.join(exportDir, c3.export_file_path), 'utf8'),
    ).toBe('ZIP-3');
    const [m] = await q<{ export_file_path: string }>(
      `SELECT export_file_path FROM cash_point_closings WHERE id = $1`,
      [missing],
    );
    expect(m.export_file_path).toBe(`${orgId}/dsfinvk/missing.zip`);

    const imports = await q<{ id: string; files: string[] }>(
      `SELECT id, files FROM menu_imports WHERE id = ANY($1)`,
      [[rowA, rowB]],
    );
    const filesOf = (id: string) => imports.find((r) => r.id === id)!.files;
    expect(filesOf(rowA)).toEqual([`menu-imports/${importA}/page-01.png`]);
    expect(filesOf(rowB)).toEqual([`menu-imports/${importB}/page-01.png`]);
    for (const [id, content] of [
      [rowA, 'PNG-A'],
      [rowB, 'PNG-B'],
    ]) {
      expect(readFileSync(path.join(privateDir, filesOf(id)[0]), 'utf8')).toBe(
        content,
      );
    }

    const again = await service().run();
    expect(again.updatedRows).toBe(0);
    expect(again.moves.every((move) => move.result.moved === 0)).toBe(true);
  });

  it('leaves the work to the instance holding the lock', async () => {
    put(`uploads/menu-imports/${randomUUID()}/page-01.png`, 'PNG');
    const holder = ds.createQueryRunner();
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [
        PRIVATE_STORAGE_LOCK_KEY,
      ]);
      const report = await service().run();
      expect(report.skipped).toBe('locked');
      expect(existsSync(path.join(uploads, 'menu-imports'))).toBe(true);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [
        PRIVATE_STORAGE_LOCK_KEY,
      ]);
      await holder.release();
    }
    const report = await service().run();
    expect(report.skipped).toBeUndefined();
    expect(existsSync(path.join(uploads, 'menu-imports'))).toBe(false);
  });
});
