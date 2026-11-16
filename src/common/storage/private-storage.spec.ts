import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { tseSettingsFromEnv } from '../../modules/tse/tse.config';
import {
  isDurableDir,
  resetPrivateStorageCache,
  resolvePrivateStorage,
  unguessableSuffix,
} from './private-storage';
import { moveTree, normalizedStoredPath } from './private-storage-migration';

const outside = { inContainer: false, mounts: null };

describe('private storage location', () => {
  afterEach(() => resetPrivateStorageCache());

  it('defaults to a sibling of the upload directory', () => {
    const storage = resolvePrivateStorage(
      { UPLOAD_DIR: '/srv/app/uploads' },
      outside,
    );
    expect(storage).toEqual({
      root: '/srv/app/private',
      uploadRoot: '/srv/app/uploads',
      fallback: false,
    });
  });

  it('uses PRIVATE_STORAGE_DIR when set outside the upload directory', () => {
    const storage = resolvePrivateStorage(
      { UPLOAD_DIR: '/srv/app/uploads', PRIVATE_STORAGE_DIR: '/data/private' },
      outside,
    );
    expect(storage.root).toBe('/data/private');
    expect(storage.fallback).toBe(false);
  });

  it('never places private storage inside the upload directory', () => {
    const storage = resolvePrivateStorage(
      {
        UPLOAD_DIR: '/srv/app/uploads',
        PRIVATE_STORAGE_DIR: '/srv/app/uploads/private',
      },
      outside,
    );
    expect(storage.root).toBe('/srv/app/uploads/.private');
    expect(storage.fallback).toBe(true);
  });

  it('keeps files on the upload volume when the private directory is not mounted in a container', () => {
    const probe = {
      inContainer: true,
      mounts: ['/', '/proc', '/app/uploads', '/etc/hosts'],
    };
    const storage = resolvePrivateStorage(
      { UPLOAD_DIR: '/app/uploads' },
      probe,
    );
    expect(storage.root).toBe('/app/uploads/.private');
    expect(storage.fallback).toBe(true);

    const mounted = resolvePrivateStorage(
      { UPLOAD_DIR: '/app/uploads' },
      { ...probe, mounts: [...probe.mounts, '/app/private'] },
    );
    expect(mounted.root).toBe('/app/private');
    expect(mounted.fallback).toBe(false);
  });

  it('treats any mount below the root as durable', () => {
    const probe = { inContainer: true, mounts: ['/', '/data'] };
    expect(isDurableDir('/data/private', probe)).toBe(true);
    expect(isDurableDir('/app/private', probe)).toBe(false);
    expect(isDurableDir('/app/private', outside)).toBe(true);
  });

  it('stores TSE exports in private storage and lists the former locations', () => {
    const settings = tseSettingsFromEnv({ UPLOAD_DIR: '/tmp/sec-a/uploads' });
    expect(settings.exportDir).toBe('/tmp/sec-a/private/tse-exports');
    expect(settings.legacyExportDirs).toEqual([
      '/tmp/sec-a/uploads/tse-exports',
      '/tmp/sec-a/uploads/.private/tse-exports',
    ]);
  });

  it('ignores a TSE_EXPORT_DIR inside the upload directory', () => {
    const settings = tseSettingsFromEnv({
      UPLOAD_DIR: '/tmp/sec-b/uploads',
      TSE_EXPORT_DIR: '/tmp/sec-b/uploads/archive',
    });
    expect(settings.exportDir).toBe('/tmp/sec-b/private/tse-exports');
    expect(settings.legacyExportDirs).toContain('/tmp/sec-b/uploads/archive');

    const whole = tseSettingsFromEnv({
      UPLOAD_DIR: '/tmp/sec-c/uploads',
      TSE_EXPORT_DIR: '/tmp/sec-c/uploads',
    });
    expect(whole.legacyExportDirs).not.toContain('/tmp/sec-c/uploads');
  });

  it('keeps an explicit TSE_EXPORT_DIR outside the upload directory', () => {
    const settings = tseSettingsFromEnv({
      UPLOAD_DIR: '/tmp/sec-d/uploads',
      TSE_EXPORT_DIR: '/archive/tse',
    });
    expect(settings.exportDir).toBe('/archive/tse');
  });

  it('generates 128-bit random file name parts', () => {
    const a = unguessableSuffix();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(unguessableSuffix()).not.toBe(a);
  });
});

describe('moving files into private storage', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'private-move-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const put = (rel: string, content: string) => {
    const file = path.join(base, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  it('moves nested files, removes the empty source and is repeatable', async () => {
    put('uploads/tse-exports/org/serial/a.tar', 'A');
    put('uploads/tse-exports/org/dsfinvk/z.zip', 'Z');
    const from = path.join(base, 'uploads/tse-exports');
    const to = path.join(base, 'private/tse-exports');

    const first = await moveTree(from, to);
    expect(first).toEqual({ moved: 2, alreadyPresent: 0, conflicts: [] });
    expect(readFileSync(path.join(to, 'org/serial/a.tar'), 'utf8')).toBe('A');
    expect(readFileSync(path.join(to, 'org/dsfinvk/z.zip'), 'utf8')).toBe('Z');
    expect(existsSync(from)).toBe(false);

    const second = await moveTree(from, to);
    expect(second).toEqual({ moved: 0, alreadyPresent: 0, conflicts: [] });
  });

  it('keeps the source when the target differs and drops exact duplicates', async () => {
    put('uploads/menu-imports/i1/page-01.png', 'same');
    put('private/menu-imports/i1/page-01.png', 'same');
    put('uploads/menu-imports/i2/page-01.png', 'old');
    put('private/menu-imports/i2/page-01.png', 'new');
    const from = path.join(base, 'uploads/menu-imports');
    const to = path.join(base, 'private/menu-imports');

    const result = await moveTree(from, to, { warn: jest.fn() });
    expect(result.alreadyPresent).toBe(1);
    expect(result.conflicts).toEqual([path.join('i2', 'page-01.png')]);
    expect(existsSync(path.join(from, 'i1'))).toBe(false);
    expect(readFileSync(path.join(from, 'i2/page-01.png'), 'utf8')).toBe('old');
    expect(readFileSync(path.join(to, 'i2/page-01.png'), 'utf8')).toBe('new');
  });

  it('does nothing for nested or identical directories', async () => {
    put('uploads/x/a.txt', 'A');
    const dir = path.join(base, 'uploads');
    expect((await moveTree(dir, dir)).moved).toBe(0);
    expect((await moveTree(dir, path.join(dir, 'x'))).moved).toBe(0);
    expect(existsSync(path.join(dir, 'x/a.txt'))).toBe(true);
  });

  it('rewrites absolute stored paths relative to their storage', () => {
    const bases = ['/app/private/tse-exports', '/app/uploads/tse-exports'];
    expect(
      normalizedStoredPath('/app/uploads/tse-exports/org/s/a.tar', bases),
    ).toBe('org/s/a.tar');
    expect(
      normalizedStoredPath('/app/private/tse-exports/org/s/a.tar', bases),
    ).toBe('org/s/a.tar');
    expect(normalizedStoredPath('org/s/a.tar', bases)).toBeNull();
    expect(normalizedStoredPath('/etc/passwd', bases)).toBeNull();
  });
});
