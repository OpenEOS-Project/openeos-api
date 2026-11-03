import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { createReadStream, existsSync } from 'fs';
import { mkdir, open, stat } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { IsNull, Not, Repository } from 'typeorm';

import { ErrorCodes } from '../../common/constants/error-codes';
import { CronLockService } from '../../common/redis/cron-lock.service';
import { AdminAction } from '../../database/entities/admin-audit-log.entity';
import {
  TseExport,
  type TseExportTrigger,
} from '../../database/entities/tse-export.entity';
import { TseUnit } from '../../database/entities/tse-unit.entity';
import type { User } from '../../database/entities/user.entity';
import { errorCodeOf, errorMessageOf } from './swissbit/swissbit.errors';
import { SwissbitClientProvider } from './swissbit/swissbit-client.provider';
import type { ExportStatus, TseCredentials } from './swissbit/swissbit.types';
import { TseConfig } from './tse.config';
import { TseCryptoService } from './tse-crypto.service';
import { TseNotifyService } from './tse-notify.service';
import { TseUnitService, type RequestMeta } from './tse-unit.service';

const POLL_MS = 5_000; // Swissbit: mindestens 5 s zwischen Abfragen
const DEFAULT_WAIT_MS = 10 * 60_000;
/** Deaktivierte TSE: Abschlussexporte bis zu 30 Tage abholbar (+ Puffer). */
const DEACTIVATED_COLLECT_DAYS = 35;

export interface TseExportView {
  id: string;
  status: TseExport['status'];
  trigger: TseExport['trigger'];
  serialNumber: string;
  swissbitExportId: string;
  filename: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  createdAt: string;
  downloadedAt: string | null;
  remoteDeletedAt: string | null;
  archivedAt: string | null;
  errorCode: string | null;
  downloadable: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function compact(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * TAR-Exporte der Cloud-TSE (TR-03153) ins eigene Archiv holen.
 *
 * Swissbit-Regeln (api-pos.json „Data Export“): Exporte sind inkrementell
 * und loeschen die Daten auf der TSE; das TAR bleibt abrufbar, bis wir den
 * Export loeschen. Neue Exporte gehen erst, wenn alle erfolgreichen
 * geloescht sind — deshalb: herunterladen, SHA-256 bilden, ablegen, **erst
 * dann** bei Swissbit loeschen (ausdruecklich so vorgesehen). Swissbit
 * exportiert nachts (01:30–05:30) auch selbst; der Lauf um 06:15 holt
 * diese mit ab. Nur der Server exportiert (eine Stelle je TSE).
 */
@Injectable()
export class TseExportService {
  private readonly logger = new Logger(TseExportService.name);
  private readonly running = new Set<string>();

  constructor(
    @InjectRepository(TseExport)
    private readonly exportRepository: Repository<TseExport>,
    @InjectRepository(TseUnit)
    private readonly unitRepository: Repository<TseUnit>,
    private readonly config: TseConfig,
    private readonly swissbit: SwissbitClientProvider,
    private readonly crypto: TseCryptoService,
    private readonly units: TseUnitService,
    private readonly notify: TseNotifyService,
    private readonly cronLock: CronLockService,
  ) {}

  /** Taeglich 06:15 (Berlin), nach den automatischen Swissbit-Exporten. */
  @Cron('15 6 * * *', { name: 'tse-exports', timeZone: 'Europe/Berlin' })
  async nightlyJob(): Promise<void> {
    if (!this.config.enabled) return;
    await this.cronLock.runExclusive('tse-exports', () => this.runAll());
  }

  async runAll(): Promise<void> {
    const since = new Date(
      Date.now() - DEACTIVATED_COLLECT_DAYS * 24 * 3600_000,
    );
    const units = await this.unitRepository
      .createQueryBuilder('unit')
      .addSelect('unit.accessTokenEnc')
      .where('unit.serialNumber IS NOT NULL')
      .andWhere(
        `(unit.state = 'active' OR (unit.state = 'deactivated' AND unit.deactivatedAt > :since))`,
        { since },
      )
      .getMany();
    for (const unit of units) {
      try {
        await this.collect(unit, {
          startNew: unit.state === 'active',
          trigger: unit.state === 'active' ? 'scheduled' : 'deactivation',
        });
      } catch (error) {
        this.logger.error(
          `TSE export for unit ${unit.id} failed: ${errorMessageOf(error)}`,
        );
        void this.notify.notifyAdmins(unit.organizationId, 'export_failed', [
          ['Fehler', errorCodeOf(error)],
        ]);
      }
    }
  }

  /** Laedt die TSE (mit Token) und holt ihre Exporte ab; wirft nie. */
  async collectById(unitId: string, trigger: TseExportTrigger): Promise<void> {
    try {
      const unit = await this.unitRepository
        .createQueryBuilder('unit')
        .addSelect('unit.accessTokenEnc')
        .where('unit.id = :unitId', { unitId })
        .getOne();
      if (!unit?.serialNumber) return;
      await this.collect(unit, { startNew: false, trigger });
    } catch (error) {
      this.logger.warn(
        `Collecting exports of unit ${unitId} failed: ${errorMessageOf(error)}`,
      );
    }
  }

  private credentials(unit: TseUnit): TseCredentials {
    if (!unit.serialNumber || !unit.accessTokenEnc) {
      throw new Error(`TSE unit ${unit.id} has no credentials`);
    }
    return {
      serialNumber: unit.serialNumber,
      accessToken: this.crypto.decrypt(unit.accessTokenEnc),
    };
  }

  /**
   * Holt alle fertigen Exporte der TSE ab; mit `startNew` wird zusaetzlich
   * ein neuer Export gestartet (wenn keiner in Arbeit ist) und bis
   * `waitMs` auf ihn gewartet. Gibt die neu abgeholten Exporte zurueck.
   */
  async collect(
    unit: TseUnit,
    options: {
      startNew: boolean;
      trigger: TseExportTrigger;
      userId?: string | null;
      waitMs?: number;
    },
  ): Promise<TseExport[]> {
    if (this.running.has(unit.id)) return [];
    this.running.add(unit.id);
    try {
      const credentials = this.credentials(unit);
      const client = this.swissbit.client;
      const downloaded: TseExport[] = [];

      const process = async (list: ExportStatus[]) => {
        for (const status of list) {
          const row = await this.upsertRow(unit, status, options);
          if (row.status === 'downloaded') {
            if (!row.remoteDeletedAt) await this.deleteRemote(credentials, row);
            continue;
          }
          if (status.status === 'success' && status.downloadUrl) {
            const done = await this.download(unit, row, status);
            if (done) {
              downloaded.push(done);
              await this.deleteRemote(credentials, done);
            }
          } else if (status.status === 'failure') {
            await this.exportRepository.update(row.id, {
              status: 'failed',
              errorCode: (status.errorCode || 'E_EXPORT_FAILED').slice(0, 60),
              errorMessage: status.errorMessage?.slice(0, 500) ?? null,
            });
          }
        }
      };

      const listed = (await client.listExports(credentials)).value;
      await process(listed);

      if (!options.startNew || listed.some((e) => e.status === 'pending')) {
        return downloaded;
      }

      let exportId: string;
      try {
        exportId = (await client.startExport(credentials)).value.id;
      } catch (error) {
        const code = errorCodeOf(error);
        if (
          code === 'E_EXPORT_ALREADY_IN_PROGRESS' ||
          code === 'E_EXPORT_RESULT_PENDING'
        ) {
          return downloaded;
        }
        throw error;
      }
      await this.upsertRow(
        unit,
        {
          id: exportId,
          status: 'pending',
          createdAt: Math.floor(Date.now() / 1000),
          downloadUrl: null,
          filename: null,
          errorCode: null,
          errorMessage: null,
        },
        { ...options, ours: true },
      );

      const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        const status = (await client.exportStatus(credentials, exportId)).value;
        if (status.status === 'pending') continue;
        await process([status]);
        break;
      }
      return downloaded;
    } finally {
      this.running.delete(unit.id);
    }
  }

  private async upsertRow(
    unit: TseUnit,
    status: ExportStatus,
    options: {
      trigger: TseExportTrigger;
      userId?: string | null;
      ours?: boolean;
    },
  ): Promise<TseExport> {
    const existing = await this.exportRepository.findOne({
      where: { tseUnitId: unit.id, swissbitExportId: status.id },
    });
    if (existing) return existing;
    // Exporte, die wir nicht gestartet haben, stammen von Swissbit selbst
    // (automatischer Export) bzw. aus der Deaktivierung.
    const trigger: TseExportTrigger =
      options.trigger === 'deactivation' || unit.state === 'deactivated'
        ? 'deactivation'
        : options.ours
          ? options.trigger
          : 'swissbit';
    try {
      return await this.exportRepository.save(
        this.exportRepository.create({
          organizationId: unit.organizationId,
          tseUnitId: unit.id,
          serialNumber: unit.serialNumber ?? '',
          swissbitExportId: status.id,
          status: 'pending',
          trigger,
          swissbitCreatedAt: status.createdAt
            ? new Date(status.createdAt * 1000)
            : null,
          requestedByUserId: options.userId ?? null,
        }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const row = await this.exportRepository.findOne({
          where: { tseUnitId: unit.id, swissbitExportId: status.id },
        });
        if (row) return row;
      }
      throw error;
    }
  }

  private async download(
    unit: TseUnit,
    row: TseExport,
    status: ExportStatus,
  ): Promise<TseExport | null> {
    const previous = await this.exportRepository.findOne({
      where: {
        tseUnitId: unit.id,
        status: 'downloaded',
        id: Not(row.id),
      },
      order: { periodTo: 'DESC' },
    });
    const periodFrom =
      previous?.periodTo ?? unit.activatedAt ?? unit.createdAt ?? new Date();
    const periodTo = status.createdAt
      ? new Date(status.createdAt * 1000)
      : new Date();

    const baseDir = resolve(this.config.settings.exportDir);
    const dir = join(
      baseDir,
      unit.organizationId,
      unit.serialNumber ?? unit.id,
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let target = join(dir, `${compact(periodFrom)}_${compact(periodTo)}.tar`);
    if (existsSync(target)) {
      target = target.replace(
        /\.tar$/,
        `-${status.id.replace(/[^A-Za-z0-9-]/g, '')}.tar`,
      );
    }

    try {
      const result = await this.swissbit.client.downloadExport(
        status.downloadUrl!,
        target,
      );
      if (result.sizeBytes === 0) throw new Error('export file is empty');
      const isTar = await looksLikeTar(target);
      if (!isTar) {
        this.logger.warn(
          `Export ${status.id} of unit ${unit.id} does not look like a TAR file`,
        );
      }
      await this.exportRepository.update(row.id, {
        status: 'downloaded',
        filename: status.filename?.slice(0, 255) ?? null,
        filePath: relative(baseDir, target),
        sha256: result.sha256,
        sizeBytes: String(result.sizeBytes),
        periodFrom,
        periodTo,
        downloadedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      });
      this.logger.log(
        `TSE export ${status.id} of org ${unit.organizationId} stored (${result.sizeBytes} bytes, sha256 ${result.sha256.slice(0, 12)}…)`,
      );
      return this.exportRepository.findOne({ where: { id: row.id } });
    } catch (error) {
      await this.exportRepository.update(row.id, {
        errorCode: 'E_DOWNLOAD',
        errorMessage: errorMessageOf(error),
      });
      this.logger.error(
        `Download of TSE export ${status.id} failed: ${errorMessageOf(error)}`,
      );
      return null;
    }
  }

  /** Erst nach erfolgreicher Ablage (Datei + Pruefsumme) bei Swissbit loeschen. */
  private async deleteRemote(
    credentials: TseCredentials,
    row: TseExport,
  ): Promise<void> {
    if (!row.filePath || !row.sha256) return;
    const full = join(resolve(this.config.settings.exportDir), row.filePath);
    try {
      const info = await stat(full);
      if (String(info.size) !== String(row.sizeBytes)) {
        this.logger.error(
          `Export file ${row.filePath} size mismatch – not deleting at Swissbit`,
        );
        return;
      }
    } catch {
      this.logger.error(
        `Export file ${row.filePath} missing – not deleting at Swissbit`,
      );
      return;
    }
    try {
      await this.swissbit.client.deleteExport(
        credentials,
        row.swissbitExportId,
      );
    } catch (error) {
      if (errorCodeOf(error) !== 'E_JOB_NOT_FOUND') {
        this.logger.warn(
          `Deleting export ${row.swissbitExportId} at Swissbit failed: ${errorCodeOf(error)} – retry next run`,
        );
        return;
      }
    }
    await this.exportRepository.update(row.id, { remoteDeletedAt: new Date() });
  }

  // ----------------------------------------------------- Verwaltung

  async list(organizationId: string, user: User): Promise<TseExportView[]> {
    await this.units.assertAdmin(organizationId, user);
    const rows = await this.exportRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
      take: 500,
    });
    return rows.map((row) => exportView(row, this.config.settings.exportDir));
  }

  /** `POST …/tse/exports`: jetzt exportieren (im Hintergrund). */
  async requestManual(
    organizationId: string,
    user: User,
    meta: RequestMeta,
  ): Promise<{ started: boolean; unitId: string }> {
    await this.units.assertAdmin(organizationId, user);
    const unit = await this.unitRepository
      .createQueryBuilder('unit')
      .addSelect('unit.accessTokenEnc')
      .where('unit.organizationId = :organizationId', { organizationId })
      .andWhere(`unit.state = 'active'`)
      .getOne();
    if (!unit) {
      throw new ConflictException({
        code: ErrorCodes.TSE_NOT_ACTIVE,
        message: 'Die Cloud-TSE ist nicht aktiv',
      });
    }
    await this.units.audit(
      AdminAction.TSE_EXPORT_REQUESTED,
      organizationId,
      unit.id,
      {
        userId: user.id,
        meta,
        details: { serialNumber: unit.serialNumber },
      },
    );
    const started = !this.running.has(unit.id);
    void this.collect(unit, {
      startNew: true,
      trigger: 'manual',
      userId: user.id,
    }).catch((error) =>
      this.logger.error(
        `Manual TSE export for ${organizationId} failed: ${errorMessageOf(error)}`,
      ),
    );
    return { started, unitId: unit.id };
  }

  async fileFor(
    organizationId: string,
    exportId: string,
    user: User,
  ): Promise<{
    path: string;
    filename: string;
    sizeBytes: number;
    sha256: string;
  }> {
    await this.units.assertAdmin(organizationId, user);
    const row = await this.exportRepository.findOne({
      where: { id: exportId, organizationId },
    });
    if (!row) {
      throw new NotFoundException({
        code: ErrorCodes.TSE_EXPORT_NOT_FOUND,
        message: 'Export nicht gefunden',
      });
    }
    const base = resolve(this.config.settings.exportDir);
    const full = row.filePath ? resolve(base, row.filePath) : null;
    if (
      row.status !== 'downloaded' ||
      !full ||
      !full.startsWith(base + '/') ||
      !existsSync(full)
    ) {
      throw new ConflictException({
        code: ErrorCodes.TSE_EXPORT_NOT_READY,
        message:
          'Der Export ist noch nicht abgeholt – bitte versuch es später noch einmal',
      });
    }
    const name = `TSE_${row.serialNumber.slice(0, 16)}_${full.split('/').pop()}`;
    return {
      path: full,
      filename: name,
      sizeBytes: Number(row.sizeBytes ?? 0),
      sha256: row.sha256 ?? '',
    };
  }

  stream(path: string) {
    return createReadStream(path);
  }

  /** Fuer den Lebenszyklus `per_event` und Tests. */
  pendingCount(organizationId: string): Promise<number> {
    return this.exportRepository.count({
      where: { organizationId, status: 'pending' },
    });
  }

  lastDownloaded(organizationId: string): Promise<TseExport | null> {
    return this.exportRepository.findOne({
      where: {
        organizationId,
        status: 'downloaded',
        downloadedAt: Not(IsNull()),
      },
      order: { downloadedAt: 'DESC' },
    });
  }
}

export function exportView(row: TseExport, exportDir: string): TseExportView {
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    serialNumber: row.serialNumber,
    swissbitExportId: row.swissbitExportId,
    filename: row.filename,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    periodFrom: iso(row.periodFrom),
    periodTo: iso(row.periodTo),
    createdAt: iso(row.createdAt) ?? '',
    downloadedAt: iso(row.downloadedAt),
    remoteDeletedAt: iso(row.remoteDeletedAt),
    archivedAt: iso(row.archivedAt),
    errorCode: row.errorCode,
    downloadable:
      row.status === 'downloaded' &&
      !!row.filePath &&
      existsSync(join(resolve(exportDir), row.filePath)),
  };
}

/** TAR (ustar): Kennung an Byte 257. */
async function looksLikeTar(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 257);
    return (
      bytesRead >= 5 && buffer.subarray(0, 5).toString('ascii') === 'ustar'
    );
  } finally {
    await handle.close();
  }
}
