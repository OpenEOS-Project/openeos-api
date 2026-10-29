import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  deleteFiles,
  importDir,
  readFiles,
  sniffMediaType,
  storeFiles,
} from './menu-import-files';

const FIXTURES = join(__dirname, '../../../../test/fixtures/menu');

describe('menu-import-files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'menu-import-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sniffs the media type from magic bytes, not from names', () => {
    expect(sniffMediaType(readFileSync(join(FIXTURES, 'getraenke.png')))).toBe(
      'image/png',
    );
    expect(
      sniffMediaType(
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBe('image/jpeg');
    expect(sniffMediaType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(
      'image/webp',
    );
    expect(sniffMediaType(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'))).toBe(
      'application/pdf',
    );
    expect(sniffMediaType(Buffer.from('<html>not an image</html>'))).toBeNull();
    expect(sniffMediaType(Buffer.from('tiny'))).toBeNull();
  });

  it('stores pages in order under menu-imports/<id>/ and reads them back', async () => {
    const png = readFileSync(join(FIXTURES, 'getraenke.png'));
    const stored = await storeFiles(dir, 'import-1', [
      { buffer: png, mediaType: 'image/png' },
      {
        buffer: Buffer.from('%PDF-1.4 fake pdf body'),
        mediaType: 'application/pdf',
      },
    ]);
    expect(stored.map((file) => file.relativePath)).toEqual([
      'menu-imports/import-1/page-01.png',
      'menu-imports/import-1/page-02.pdf',
    ]);
    const files = await readFiles(
      dir,
      stored.map((file) => file.relativePath),
    );
    expect(files[0].mediaType).toBe('image/png');
    expect(files[0].buffer.equals(png)).toBe(true);
    expect(files[1].mediaType).toBe('application/pdf');

    await deleteFiles(dir, 'import-1');
    expect(existsSync(importDir(dir, 'import-1'))).toBe(false);
    await expect(deleteFiles(dir, 'import-1')).resolves.toBeUndefined();
  });

  it('refuses paths outside the upload directory', async () => {
    await expect(readFiles(dir, ['../../etc/passwd'])).rejects.toThrow(
      /Ungültiger Dateipfad/,
    );
  });
});
