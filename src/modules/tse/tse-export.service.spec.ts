import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { TseExport } from '../../database/entities/tse-export.entity';
import type { TseUnit } from '../../database/entities/tse-unit.entity';
import { TseExportService } from './tse-export.service';

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

const UNIT = {
  id: 'unit-1',
  organizationId: 'org-1',
  state: 'active',
  serialNumber: 'ff00aa',
  accessTokenEnc: 'enc:token',
  activatedAt: new Date('2026-11-01T10:00:00Z'),
  createdAt: new Date('2026-11-01T09:00:00Z'),
} as unknown as TseUnit;

/** Minimal-TAR: 512-Byte-Kopf mit „ustar“ an Byte 257. */
function tarBytes(): Buffer {
  const buffer = Buffer.alloc(1024);
  buffer.write('Export_Unixt_1.tar', 0);
  buffer.write('ustar', 257);
  return buffer;
}

function setup(
  listed: Array<Record<string, unknown>>,
  startStatus?: Record<string, unknown>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'tse-export-'));
  const rows = new Map<string, TseExport>();
  let seq = 0;
  const exportRepository = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      const match = [...rows.values()].find((row) =>
        Object.entries(where).every(([key, value]) =>
          typeof value === 'object' && value !== null
            ? true
            : (row as never)[key] === value,
        ),
      );
      return Promise.resolve(match ?? null);
    }),
    create: jest.fn((data: Partial<TseExport>) => ({ ...data })),
    save: jest.fn((data: TseExport) => {
      const row = {
        ...data,
        id: data.id ?? `exp-${++seq}`,
        createdAt: new Date(),
      } as TseExport;
      rows.set(row.id, row);
      return Promise.resolve(row);
    }),
    update: jest.fn((id: string, patch: Partial<TseExport>) => {
      rows.set(id, { ...rows.get(id)!, ...patch });
      return Promise.resolve();
    }),
  };
  const payload = tarBytes();
  const client = {
    listExports: jest.fn(() =>
      Promise.resolve({ value: listed, requestId: 'r', durationMs: 1 }),
    ),
    startExport: jest.fn(() =>
      Promise.resolve({
        value: { id: 'new-export' },
        requestId: 'r',
        durationMs: 1,
      }),
    ),
    exportStatus: jest.fn(() =>
      Promise.resolve({
        value: startStatus ?? {
          id: 'new-export',
          status: 'success',
          createdAt: 1793750000,
          downloadUrl: 'https://download/new',
          filename: 'Export_Unixt_1793750000.tar',
        },
        requestId: 'r',
        durationMs: 1,
      }),
    ),
    downloadExport: jest.fn((_url: string, target: string) => {
      writeFileSync(target, payload);
      return Promise.resolve({
        path: target,
        sha256: createHash('sha256').update(payload).digest('hex'),
        sizeBytes: payload.length,
        durationMs: 1,
      });
    }),
    deleteExport: jest.fn(() =>
      Promise.resolve({ value: null, requestId: 'r', durationMs: 1 }),
    ),
  };
  const service = new TseExportService(
    exportRepository as never,
    {} as never,
    { enabled: true, settings: { exportDir: dir } } as never,
    { client } as never,
    { decrypt: (s: string) => s.replace(/^enc:/, '') } as never,
    {} as never,
    { notifyAdmins: jest.fn() } as never,
    {} as never,
  );
  // Swissbit verlangt 5 s zwischen Abfragen; im Test nicht warten.
  jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as never;
  }) as never);
  return { service, client, rows, dir, payload };
}

afterEach(() => jest.restoreAllMocks());

describe('TseExportService', () => {
  it('starts an export, downloads it with SHA-256 and only then deletes it at Swissbit', async () => {
    const { service, client, rows, dir, payload } = setup([]);
    try {
      const downloaded = await service.collect(UNIT, {
        startNew: true,
        trigger: 'scheduled',
      });
      expect(client.startExport).toHaveBeenCalledTimes(1);
      expect(downloaded).toHaveLength(1);
      const row = [...rows.values()][0];
      expect(row).toMatchObject({
        status: 'downloaded',
        trigger: 'scheduled',
        swissbitExportId: 'new-export',
        sha256: createHash('sha256').update(payload).digest('hex'),
        sizeBytes: String(payload.length),
        filename: 'Export_Unixt_1793750000.tar',
      });
      expect(row.filePath).toMatch(
        /^org-1\/ff00aa\/\d{8}T\d{6}Z_\d{8}T\d{6}Z_[0-9a-f]{32}\.tar$/,
      );
      expect(readFileSync(join(dir, row.filePath!))).toEqual(payload);
      expect(client.deleteExport).toHaveBeenCalledWith(
        { serialNumber: 'ff00aa', accessToken: 'token' },
        'new-export',
      );
      expect(client.downloadExport.mock.invocationCallOrder[0]).toBeLessThan(
        client.deleteExport.mock.invocationCallOrder[0],
      );
      expect([...rows.values()][0].remoteDeletedAt).toBeInstanceOf(Date);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collects automatic Swissbit exports and does not start a new one while one is pending', async () => {
    const { service, client, rows, dir } = setup([
      {
        id: 'auto-1',
        status: 'success',
        createdAt: 1793700000,
        downloadUrl: 'https://d/1',
        filename: 'a.tar',
      },
      {
        id: 'auto-2',
        status: 'pending',
        createdAt: 1793710000,
        downloadUrl: null,
        filename: null,
      },
    ]);
    try {
      await service.collect(UNIT, { startNew: true, trigger: 'scheduled' });
      expect(client.startExport).not.toHaveBeenCalled();
      const byId = new Map(
        [...rows.values()].map((r) => [r.swissbitExportId, r]),
      );
      expect(byId.get('auto-1')).toMatchObject({
        status: 'downloaded',
        trigger: 'swissbit',
      });
      expect(byId.get('auto-2')).toMatchObject({
        status: 'pending',
        trigger: 'swissbit',
      });
      expect(client.deleteExport).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never deletes at Swissbit when the download failed', async () => {
    const { service, client, rows, dir } = setup([
      {
        id: 'x',
        status: 'success',
        createdAt: 1793700000,
        downloadUrl: 'https://d/x',
        filename: 'x.tar',
      },
    ]);
    try {
      client.downloadExport.mockRejectedValueOnce(
        new Error('download failed with HTTP 500'),
      );
      await service.collect(UNIT, { startNew: false, trigger: 'scheduled' });
      expect(client.deleteExport).not.toHaveBeenCalled();
      expect([...rows.values()][0]).toMatchObject({
        status: 'pending',
        errorCode: 'E_DOWNLOAD',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks exports of a deactivated TSE as deactivation exports', async () => {
    const { service, rows, dir } = setup([
      {
        id: 'final',
        status: 'success',
        createdAt: 1793700000,
        downloadUrl: 'https://d/f',
        filename: 'f.tar',
      },
    ]);
    try {
      await service.collect({ ...UNIT, state: 'deactivated' } as TseUnit, {
        startNew: false,
        trigger: 'deactivation',
      });
      expect([...rows.values()][0]).toMatchObject({
        trigger: 'deactivation',
        status: 'downloaded',
      });
      expect(existsSync(join(dir, 'org-1', 'ff00aa'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records a failed export without deleting anything', async () => {
    const { service, client, rows, dir } = setup([], {
      id: 'new-export',
      status: 'failure',
      createdAt: 1,
      downloadUrl: null,
      filename: null,
      errorCode: 'E_EXPORT',
      errorMessage: 'nope',
    });
    try {
      await service.collect(UNIT, { startNew: true, trigger: 'manual' });
      expect([...rows.values()][0]).toMatchObject({
        status: 'failed',
        trigger: 'manual',
        errorCode: 'E_EXPORT',
      });
      expect(client.deleteExport).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
