import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Oeffentliche Auslieferung des Upload-Verzeichnisses unter `/uploads/`.
 *
 * Ausgeliefert wird nur, was `UploadsService` selbst anlegt:
 * `/uploads/<uuid>/<kategorie>/<datei>` — Organisations- bzw. Benutzer-ID,
 * eine der Upload-Kategorien und ein schlichter Dateiname. Der Pfad wird
 * vorher dekodiert (auch mehrfach) und normalisiert; alles andere — andere
 * Verzeichnisse, Punkt-Segmente, Backslashes, NUL — endet mit 404, bevor
 * der statische Handler das Dateisystem sieht.
 */

export const PUBLIC_UPLOAD_PREFIX = '/uploads';

/** Muss zu UploadCategory plus 'general' passen (uploads.service.ts). */
export const PUBLIC_UPLOAD_DIRECTORIES = new Set([
  'product',
  'category',
  'organization',
  'user',
  'event',
  'general',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_FILENAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9]{1,10}$/;
const MAX_DECODE_ROUNDS = 4;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/** Pfad (ohne Query) so lange dekodieren, bis er sich nicht mehr aendert. */
function fullyDecoded(pathname: string): string | null {
  let current = pathname;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null;
}

/**
 * Kanonischer Pfad unterhalb von `/uploads` (z. B. `/<uuid>/product/<datei>`)
 * oder `null`, wenn die Anfrage nicht auf eine oeffentliche Datei zeigt.
 * `relativeUrl` ist der Teil nach `/uploads` (Express setzt ihn beim
 * Einhaengen als `req.url`).
 */
export function publicUploadPath(relativeUrl: string): string | null {
  const pathname = relativeUrl.split(/[?#]/, 1)[0];
  const decoded = fullyDecoded(pathname);
  if (decoded === null) return null;
  if (decoded.includes('\\') || hasControlCharacter(decoded)) return null;

  const segments = decoded.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment.startsWith('.'))) return null;
  if (segments.length !== 3) return null;

  const [owner, directory, filename] = segments;
  if (!UUID.test(owner)) return null;
  if (!PUBLIC_UPLOAD_DIRECTORIES.has(directory)) return null;
  if (!PUBLIC_FILENAME.test(filename)) return null;
  return `/${owner}/${directory}/${filename}`;
}

/** Gilt die Anfrage (voller Pfad) dem Upload-Bereich? Ebenfalls dekodiert. */
export function targetsUploads(originalUrl: string): boolean {
  const pathname = originalUrl.split(/[?#]/, 1)[0];
  const decoded = fullyDecoded(pathname) ?? pathname;
  const collapsed = decoded.replace(/[\\/]+/g, '/').toLowerCase();
  return (
    collapsed === PUBLIC_UPLOAD_PREFIX ||
    collapsed.startsWith(`${PUBLIC_UPLOAD_PREFIX}/`) ||
    collapsed.startsWith(`${PUBLIC_UPLOAD_PREFIX}.`)
  );
}

function notFound(res: Response): void {
  res.status(404).end();
}

/**
 * Erste Linie, vor allen Routen: jede Anfrage, die nach dem Dekodieren auf
 * `/uploads…` zielt, muss die Form einer oeffentlichen Datei haben — sonst
 * 404, egal wie Express die Einhaengepunkte spaeter auswertet.
 */
export function uploadsRequestFilter(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!targetsUploads(req.url)) {
    next();
    return;
  }
  const pathname = req.url.split(/[?#]/, 1)[0];
  const decoded = fullyDecoded(pathname);
  const collapsed = decoded?.replace(/\/+/g, '/');
  if (
    !collapsed ||
    !collapsed.startsWith(`${PUBLIC_UPLOAD_PREFIX}/`) ||
    publicUploadPath(collapsed.slice(PUBLIC_UPLOAD_PREFIX.length)) === null
  ) {
    notFound(res);
    return;
  }
  next();
}

/**
 * Zweite Linie, am Einhaengepunkt des statischen Handlers: nur kanonische
 * Pfade erreichen ihn; `req.url` wird auf die gepruefte Form gesetzt.
 */
export function publicUploadsGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const canonical = publicUploadPath(req.url);
  if (!canonical) {
    notFound(res);
    return;
  }
  req.url = canonical;
  next();
}

/** Haengt Filter und statischen Handler ein (main.ts und Tests). */
export function mountPublicUploads(
  app: NestExpressApplication,
  uploadRoot: string,
): void {
  app.use(uploadsRequestFilter);
  app.use(PUBLIC_UPLOAD_PREFIX, publicUploadsGuard);
  app.useStaticAssets(uploadRoot, {
    prefix: `${PUBLIC_UPLOAD_PREFIX}/`,
    index: false,
    redirect: false,
    dotfiles: 'deny',
  });
}
