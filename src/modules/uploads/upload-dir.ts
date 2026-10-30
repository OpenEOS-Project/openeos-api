import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { constants as fsConstants, promises as fs } from 'fs';
import * as path from 'path';
import { ErrorCodes, ErrorMessages } from '../../common/constants/error-codes';

/**
 * Schreibfehler im Upload-Verzeichnis, die der Betreiber beheben muss:
 * falscher Eigentuemer eines Bind-Mounts (EACCES/EPERM), schreibgeschuetzt
 * eingehaengt (EROFS) oder volle Platte (ENOSPC). Alles andere (etwa ein
 * ungueltiger Pfad) bleibt ein normaler Fehler.
 */
const STORAGE_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']);

/** UID, unter der der Container laeuft (Dockerfile: Nutzer `nestjs`). */
export const CONTAINER_UID = 1001;

export function resolveUploadDir(uploadDir: string): string {
  return path.resolve(process.cwd(), uploadDir.replace(/^\.\//, ''));
}

export function isUploadDirError(
  error: unknown,
): error is NodeJS.ErrnoException {
  // Kein `instanceof Error`: fs-Fehler kommen aus Nodes eigenem Realm und
  // sind in einer VM-Sandbox (Jest) keine Instanz der lokalen Error-Klasse.
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && STORAGE_ERROR_CODES.has(code);
}

/** Hinweis fuer das Log — der haeufigste Fall ist der Bind-Mount von root. */
export function fixHint(dir: string): string {
  return `Abhilfe auf dem Host: chown -R ${CONTAINER_UID} ${dir} (der Container läuft als uid ${CONTAINER_UID})`;
}

/**
 * Macht aus dem fs-Fehler die Antwort fuer den Client (503, fester Code)
 * und schreibt genau eine klare Zeile ins Log — mit Pfad und Abhilfe,
 * ohne Stacktrace-Rauschen.
 */
export function uploadDirNotWritable(
  logger: Logger,
  error: NodeJS.ErrnoException,
  dir: string,
): ServiceUnavailableException {
  logger.error(
    `Upload-Verzeichnis nicht beschreibbar (${error.code}): ${error.path ?? dir} — ${fixHint(dir)}`,
  );
  return new ServiceUnavailableException({
    code: ErrorCodes.UPLOAD_DIR_NOT_WRITABLE,
    message: ErrorMessages[ErrorCodes.UPLOAD_DIR_NOT_WRITABLE],
  });
}

/**
 * Startpruefung: legt das Verzeichnis an, falls es fehlt, und prueft, ob
 * der Prozess darin schreiben darf. Scheitert das, bleibt der Start
 * moeglich (Text-Import, alles ohne Dateien), aber das Log sagt klar,
 * was zu tun ist. Liefert `true`, wenn geschrieben werden kann.
 */
export async function checkUploadDirWritable(
  uploadDir: string,
  logger: Logger,
): Promise<boolean> {
  const dir = resolveUploadDir(uploadDir);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, fsConstants.W_OK);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'Fehler';
    logger.warn(
      `Upload-Verzeichnis ${dir} ist nicht beschreibbar (${code}) — Datei-Uploads und der Speisekarten-Import per Foto/PDF antworten mit 503 UPLOAD_DIR_NOT_WRITABLE. ${fixHint(dir)}`,
    );
    return false;
  }
}
