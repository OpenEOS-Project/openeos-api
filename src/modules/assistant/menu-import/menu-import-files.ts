import { promises as fs } from 'fs';
import * as path from 'path';
import { AiImageMediaType } from '../../ai/ai-provider.interface';

/**
 * Ablage der hochgeladenen Speisekarten: `<UPLOAD_DIR>/menu-imports/<id>/`.
 *
 * Das Upload-Verzeichnis wird statisch ausgeliefert; `main.ts` sperrt den
 * Pfad `/uploads/menu-imports` ausdruecklich, damit die Karten nicht
 * oeffentlich abrufbar sind. Dateien leben nur bis zum Anwenden,
 * Verwerfen oder 24 h (Worker).
 */
export const MENU_IMPORT_DIR = 'menu-imports';

export type MenuFileMediaType = AiImageMediaType | 'application/pdf';

/** Erkennt den Typ an den ersten Bytes — nicht am Dateinamen oder Header. */
export function sniffMediaType(buffer: Buffer): MenuFileMediaType | null {
  if (buffer.length < 12) return null;
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}

const EXTENSIONS: Record<MenuFileMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function resolveUploadDir(uploadDir: string): string {
  return path.resolve(process.cwd(), uploadDir.replace(/^\.\//, ''));
}

export function importDir(uploadDir: string, importId: string): string {
  return path.join(resolveUploadDir(uploadDir), MENU_IMPORT_DIR, importId);
}

export interface StoredMenuFile {
  /** Relativer Pfad unter dem Upload-Verzeichnis. */
  relativePath: string;
  mediaType: MenuFileMediaType;
}

/** Schreibt die Dateien in Seitenreihenfolge und gibt die relativen Pfade zurueck. */
export async function storeFiles(
  uploadDir: string,
  importId: string,
  files: { buffer: Buffer; mediaType: MenuFileMediaType }[],
): Promise<StoredMenuFile[]> {
  const dir = importDir(uploadDir, importId);
  await fs.mkdir(dir, { recursive: true });
  const stored: StoredMenuFile[] = [];
  for (const [index, file] of files.entries()) {
    const filename = `page-${String(index + 1).padStart(2, '0')}.${EXTENSIONS[file.mediaType]}`;
    await fs.writeFile(path.join(dir, filename), file.buffer, { mode: 0o600 });
    stored.push({
      relativePath: path.posix.join(MENU_IMPORT_DIR, importId, filename),
      mediaType: file.mediaType,
    });
  }
  return stored;
}

export async function readFiles(
  uploadDir: string,
  relativePaths: string[],
): Promise<{ buffer: Buffer; mediaType: MenuFileMediaType }[]> {
  const root = resolveUploadDir(uploadDir);
  const files: { buffer: Buffer; mediaType: MenuFileMediaType }[] = [];
  for (const relativePath of relativePaths) {
    const full = path.resolve(root, relativePath);
    if (!full.startsWith(root + path.sep)) {
      throw new Error('Ungültiger Dateipfad');
    }
    const buffer = await fs.readFile(full);
    const mediaType = sniffMediaType(buffer);
    if (!mediaType) throw new Error('Datei hat ein unbekanntes Format');
    files.push({ buffer, mediaType });
  }
  return files;
}

export async function deleteFiles(
  uploadDir: string,
  importId: string,
): Promise<void> {
  await fs.rm(importDir(uploadDir, importId), { recursive: true, force: true });
}
