import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

/**
 * PDF → Seitenbilder fuer Anbieter ohne PDF-Eingabe (OpenAI-kompatibel,
 * z. B. IONOS AI Model Hub).
 *
 * Nutzt `pdfinfo` und `pdftoppm` aus poppler-utils (GPL, als eigener
 * Prozess aufgerufen, im Docker-Image per `apk add poppler-utils`). Fehlen
 * die Werkzeuge, meldet `isAvailable()` false und der Import nimmt fuer
 * solche Anbieter nur Bilder. Jede Datei landet kurz in einem eigenen
 * Temp-Ordner (0700), der danach in jedem Fall geloescht wird.
 */
export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface PdfRasterizerOptions {
  /** Nur fuer Tests: Ersatz fuer child_process.execFile. */
  exec?: ExecFileFn;
  /** Wo die Temp-Ordner entstehen (Standard: os.tmpdir()). */
  tmpDir?: string;
  /** Hoechstdauer je Werkzeug-Aufruf. */
  timeoutMs?: number;
}

export interface RenderOptions {
  /** Nur die ersten so vielen Seiten. */
  maxPages: number;
  /** Lange Kante in Pixeln (A4: 1600 px ≈ 137 dpi). */
  longEdgePx: number;
}

/** Die PDF ist kaputt, verschluesselt oder das Werkzeug ist gescheitert. */
export class PdfReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfReadError';
  }
}

const defaultExec: ExecFileFn = async (file, args, options) => {
  const { stdout, stderr } = await promisify(execFile)(file, args, {
    ...options,
    encoding: 'utf8',
  });
  return { stdout, stderr };
};

export class PdfRasterizer {
  private readonly exec: ExecFileFn;
  private readonly tmpDir: string;
  private readonly timeoutMs: number;
  private availability: Promise<boolean> | null = null;

  constructor(options: PdfRasterizerOptions = {}) {
    this.exec = options.exec ?? defaultExec;
    this.tmpDir = options.tmpDir ?? os.tmpdir();
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Sind `pdfinfo` und `pdftoppm` aufrufbar? Einmal geprueft, dann gemerkt. */
  isAvailable(): Promise<boolean> {
    this.availability ??= Promise.all([
      this.probe('pdfinfo'),
      this.probe('pdftoppm'),
    ]).then(([info, ppm]) => info && ppm);
    return this.availability;
  }

  /** Seitenzahl laut `pdfinfo`. */
  async pageCount(pdf: Buffer): Promise<number> {
    return this.withTempDir(async (dir) => {
      const input = await this.writeInput(dir, pdf);
      let stdout: string;
      try {
        ({ stdout } = await this.run('pdfinfo', [input]));
      } catch (error) {
        throw new PdfReadError(
          `pdfinfo: ${this.describe(error)} — PDF beschädigt oder verschlüsselt?`,
        );
      }
      const match = /^Pages:\s+(\d+)/m.exec(stdout);
      if (!match) throw new PdfReadError('pdfinfo: keine Seitenzahl');
      return parseInt(match[1], 10);
    });
  }

  /** Rendert die ersten `maxPages` Seiten als JPEG, in Seitenreihenfolge. */
  async render(pdf: Buffer, options: RenderOptions): Promise<Buffer[]> {
    return this.withTempDir(async (dir) => {
      const input = await this.writeInput(dir, pdf);
      try {
        await this.run('pdftoppm', [
          '-f',
          '1',
          '-l',
          String(Math.max(1, options.maxPages)),
          '-scale-to',
          String(options.longEdgePx),
          '-jpeg',
          '-jpegopt',
          'quality=90',
          input,
          path.join(dir, 'page'),
        ]);
      } catch (error) {
        throw new PdfReadError(`pdftoppm: ${this.describe(error)}`);
      }
      // pdftoppm nummeriert je nach Seitenzahl page-1.jpg oder page-01.jpg.
      const pages = (await fs.readdir(dir))
        .map((name) => ({ name, match: /^page-(\d+)\.jpg$/.exec(name) }))
        .filter((entry) => entry.match)
        .sort((a, b) => parseInt(a.match![1], 10) - parseInt(b.match![1], 10));
      if (pages.length === 0) {
        throw new PdfReadError('pdftoppm: keine Seite erzeugt');
      }
      return Promise.all(
        pages.map((page) => fs.readFile(path.join(dir, page.name))),
      );
    });
  }

  private async probe(tool: string): Promise<boolean> {
    try {
      await this.run(tool, ['-v']);
      return true;
    } catch (error) {
      // Nur „nicht gefunden“ heisst nicht da; ein Exit-Code != 0 bei `-v`
      // (aeltere poppler-Versionen) zaehlt als vorhanden.
      return (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
    }
  }

  private run(tool: string, args: string[]) {
    return this.exec(tool, args, {
      timeout: this.timeoutMs,
      maxBuffer: 1024 * 1024,
    });
  }

  private async writeInput(dir: string, pdf: Buffer): Promise<string> {
    const input = path.join(dir, 'input.pdf');
    await fs.writeFile(input, pdf, { mode: 0o600 });
    return input;
  }

  private async withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(this.tmpDir, 'openeos-pdf-'));
    try {
      return await work(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private describe(error: unknown): string {
    const err = error as {
      stderr?: string;
      message?: string;
      killed?: boolean;
    };
    if (err?.killed) return 'Zeitlimit überschritten';
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    return (stderr || err?.message || String(error)).slice(0, 300);
  }
}
