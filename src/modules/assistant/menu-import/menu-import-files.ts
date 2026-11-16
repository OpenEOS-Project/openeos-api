import { promises as fs } from 'fs';
import * as path from 'path';
import { AiImageMediaType } from '../../ai/ai-provider.interface';
import {
  PRIVATE_MENU_IMPORT_DIR,
  absolutePath,
} from '../../../common/storage/private-storage';

/**
 * Ablage der hochgeladenen Speisekarten: `<PRIVATE_STORAGE_DIR>/menu-imports/<id>/`
 * (siehe common/storage/private-storage.ts) — nicht im oeffentlich
 * ausgelieferten Upload-Verzeichnis. Dateien leben nur bis zum Anwenden,
 * Verwerfen oder 24 h (Worker).
 *
 * `storageDir` ist ueberall die Wurzel der privaten Ablage; die in
 * `menu_imports.files` gespeicherten Pfade sind relativ dazu
 * (`menu-imports/<id>/page-01.png`).
 */
export const MENU_IMPORT_DIR = PRIVATE_MENU_IMPORT_DIR;

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

export function importDir(storageDir: string, importId: string): string {
  return path.join(absolutePath(storageDir), MENU_IMPORT_DIR, importId);
}

export interface StoredMenuFile {
  /** Relativer Pfad unter der privaten Ablage. */
  relativePath: string;
  mediaType: MenuFileMediaType;
}

/** Schreibt die Dateien in Seitenreihenfolge und gibt die relativen Pfade zurueck. */
export async function storeFiles(
  storageDir: string,
  importId: string,
  files: { buffer: Buffer; mediaType: MenuFileMediaType }[],
): Promise<StoredMenuFile[]> {
  const dir = importDir(storageDir, importId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
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
  storageDir: string,
  relativePaths: string[],
): Promise<{ buffer: Buffer; mediaType: MenuFileMediaType }[]> {
  const root = absolutePath(storageDir);
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
  storageDir: string,
  importId: string,
): Promise<void> {
  await fs.rm(importDir(storageDir, importId), {
    recursive: true,
    force: true,
  });
}
