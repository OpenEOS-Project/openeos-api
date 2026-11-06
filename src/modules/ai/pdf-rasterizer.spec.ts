import { execFileSync } from 'child_process';
import { promises as fs, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { ExecFileFn, PdfRasterizer, PdfReadError } from './pdf-rasterizer';

type Call = { file: string; args: string[] };

/** Ersatz fuer pdfinfo/pdftoppm: schreibt Seiten wie das echte Werkzeug. */
function fakeExec(
  options: { pages?: number; fail?: string; missing?: boolean } = {},
) {
  const calls: Call[] = [];
  const exec: ExecFileFn = async (file, args) => {
    calls.push({ file, args });
    if (options.missing) {
      throw Object.assign(new Error(`spawn ${file} ENOENT`), {
        code: 'ENOENT',
      });
    }
    if (options.fail) {
      throw Object.assign(new Error('Command failed'), {
        code: 1,
        stderr: options.fail,
      });
    }
    if (args[0] === '-v') return { stdout: '', stderr: `${file} 25.12.0` };
    if (file === 'pdfinfo') {
      return {
        stdout: `Producer: test\nPages:          ${options.pages ?? 2}\nEncrypted: no\n`,
        stderr: '',
      };
    }
    // pdftoppm -f 1 -l N … input prefix → prefix-01.jpg … (zweistellig ab 10 Seiten)
    const last = Math.min(
      options.pages ?? 2,
      parseInt(args[args.indexOf('-l') + 1], 10),
    );
    const prefix = args[args.length - 1];
    const width = (options.pages ?? 2) >= 10 ? 2 : 1;
    for (let page = 1; page <= last; page += 1) {
      await fs.writeFile(
        `${prefix}-${String(page).padStart(width, '0')}.jpg`,
        Buffer.from(`page ${page}`),
      );
    }
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

describe('PdfRasterizer', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'raster-spec-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('is available when pdfinfo and pdftoppm answer, not when they are missing', async () => {
    await expect(
      new PdfRasterizer({ exec: fakeExec().exec }).isAvailable(),
    ).resolves.toBe(true);
    const missing = fakeExec({ missing: true });
    const rasterizer = new PdfRasterizer({ exec: missing.exec });
    await expect(rasterizer.isAvailable()).resolves.toBe(false);
    await rasterizer.isAvailable();
    // einmal geprueft, dann gemerkt
    expect(missing.calls).toHaveLength(2);
  });

  it('counts pages with pdfinfo and cleans up its temp folder', async () => {
    const { exec, calls } = fakeExec({ pages: 7 });
    const rasterizer = new PdfRasterizer({ exec, tmpDir: tmp });
    await expect(rasterizer.pageCount(Buffer.from('%PDF-1.4'))).resolves.toBe(
      7,
    );
    expect(calls[0].file).toBe('pdfinfo');
    expect(calls[0].args[0]).toMatch(/openeos-pdf-.*\/input\.pdf$/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('renders the first maxPages pages at 1600 px in page order and removes all temp files', async () => {
    const { exec, calls } = fakeExec({ pages: 12 });
    const rasterizer = new PdfRasterizer({ exec, tmpDir: tmp });
    const pages = await rasterizer.render(Buffer.from('%PDF-1.4'), {
      maxPages: 11,
      longEdgePx: 1600,
    });
    expect(pages.map((page) => page.toString())).toEqual(
      Array.from({ length: 11 }, (_, i) => `page ${i + 1}`),
    );
    const args = calls[0].args;
    expect(calls[0].file).toBe('pdftoppm');
    expect(args.slice(0, 9)).toEqual([
      '-f',
      '1',
      '-l',
      '11',
      '-scale-to',
      '1600',
      '-jpeg',
      '-jpegopt',
      'quality=90',
    ]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('turns tool failures into PdfReadError and still cleans up', async () => {
    const rasterizer = new PdfRasterizer({
      exec: fakeExec({ fail: 'Command Line Error: Incorrect password' }).exec,
      tmpDir: tmp,
    });
    await expect(
      rasterizer.pageCount(Buffer.from('%PDF-1.4')),
    ).rejects.toBeInstanceOf(PdfReadError);
    await expect(
      rasterizer.render(Buffer.from('%PDF-1.4'), {
        maxPages: 2,
        longEdgePx: 1600,
      }),
    ).rejects.toThrow(/Incorrect password/);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

/*
 * Mit echtem poppler-utils (im Docker-Image vorhanden, lokal/CI oft nicht):
 * eine zweiseitige PDF wird zu zwei JPEGs mit 1600 px langer Kante.
 */
const hasPoppler = (() => {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

(hasPoppler ? describe : describe.skip)('PdfRasterizer with poppler', () => {
  it('renders a real two-page PDF', async () => {
    // Minimale PDF mit zwei leeren A4-Seiten (Byte-Offsets ignoriert poppler tolerant).
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
        '2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
        '4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
        'trailer<</Root 1 0 R>>\n%%EOF\n',
    );
    const rasterizer = new PdfRasterizer();
    await expect(rasterizer.isAvailable()).resolves.toBe(true);
    await expect(rasterizer.pageCount(pdf)).resolves.toBe(2);
    const pages = await rasterizer.render(pdf, {
      maxPages: 6,
      longEdgePx: 1600,
    });
    expect(pages).toHaveLength(2);
    const meta = await sharp(pages[0]).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.height).toBe(1600);
  });
});
