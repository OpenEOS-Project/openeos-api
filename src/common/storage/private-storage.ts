import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

/**
 * Ablage fuer Dateien, die nie oeffentlich ausgeliefert werden: hochgeladene
 * Speisekarten (Assistent), TAR-Exporte der Cloud-TSE und das DSFinV-K-Archiv.
 *
 * Das Upload-Verzeichnis (`UPLOAD_DIR`) wird unter `/uploads/` statisch
 * ausgeliefert. Private Dateien liegen deshalb in einem eigenen Verzeichnis
 * daneben (`PRIVATE_STORAGE_DIR`, Standard: `<UPLOAD_DIR>/../private`) und
 * sind nur ueber die angemeldeten Download-Endpunkte erreichbar.
 *
 * Laeuft der Prozess in einem Container und das Verzeichnis ist kein
 * eingehaengtes Volume, gingen die Dateien beim naechsten Deploy verloren.
 * Dann weicht die Ablage auf `<UPLOAD_DIR>/.private` aus (liegt im Volume
 * der Uploads, wird aber nie ausgeliefert) und das Log sagt, was zu tun ist.
 */

/** Unterverzeichnisse der privaten Ablage. */
export const PRIVATE_MENU_IMPORT_DIR = 'menu-imports';
export const PRIVATE_TSE_EXPORT_DIR = 'tse-exports';

/** Ausweichort innerhalb des Upload-Verzeichnisses (nie ausgeliefert). */
export const UPLOAD_FALLBACK_DIR = '.private';

export interface PrivateStorage {
  /** Absoluter Pfad der privaten Ablage. */
  root: string;
  /** Absoluter Pfad des oeffentlichen Upload-Verzeichnisses. */
  uploadRoot: string;
  /** `true`, wenn die Ablage auf den Ausweichort umgelenkt wurde. */
  fallback: boolean;
  /** Grund fuer den Ausweichort (fuer das Log). */
  reason?: string;
}

function value(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const raw = env[key];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

export function absolutePath(dir: string): string {
  return path.resolve(process.cwd(), dir.replace(/^\.\//, ''));
}

/** Liegt `child` in `parent` (oder ist es)? Beide absolut. */
export function isInsideDir(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Eingehaengte Verzeichnisse laut /proc/self/mountinfo (nur Linux). */
function mountPoints(): string[] | null {
  try {
    return readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .map((line) => line.split(' ')[4])
      .filter((mount): mount is string => !!mount)
      .map((mount) =>
        mount.replace(/\\(\d{3})/g, (_m, octal: string) =>
          String.fromCharCode(parseInt(octal, 8)),
        ),
      );
  } catch {
    return null;
  }
}

export interface DurabilityProbe {
  inContainer: boolean;
  mounts: string[] | null;
}

function defaultProbe(): DurabilityProbe {
  return { inContainer: existsSync('/.dockerenv'), mounts: mountPoints() };
}

/**
 * Bleibt ein Verzeichnis ueber einen Neustart des Containers erhalten?
 * Ausserhalb eines Containers immer ja; im Container nur, wenn es (oder ein
 * uebergeordnetes Verzeichnis ausser `/`) eingehaengt ist.
 */
export function isDurableDir(dir: string, probe: DurabilityProbe): boolean {
  if (!probe.inContainer) return true;
  if (!probe.mounts) return true;
  return probe.mounts.some((mount) => mount !== '/' && isInsideDir(dir, mount));
}

export function resolvePrivateStorage(
  env: Record<string, string | undefined>,
  probe: DurabilityProbe = defaultProbe(),
): PrivateStorage {
  const uploadRoot = absolutePath(value(env, 'UPLOAD_DIR') || './uploads');
  const configured = value(env, 'PRIVATE_STORAGE_DIR');
  const root = configured
    ? absolutePath(configured)
    : path.join(path.dirname(uploadRoot), 'private');
  const fallbackRoot = path.join(uploadRoot, UPLOAD_FALLBACK_DIR);

  if (isInsideDir(root, uploadRoot)) {
    return {
      root: fallbackRoot,
      uploadRoot,
      fallback: true,
      reason: `PRIVATE_STORAGE_DIR (${root}) liegt im Upload-Verzeichnis`,
    };
  }
  if (!isDurableDir(root, probe) && isDurableDir(uploadRoot, probe)) {
    return {
      root: fallbackRoot,
      uploadRoot,
      fallback: true,
      reason: `${root} ist im Container kein eingehängtes Volume`,
    };
  }
  return { root, uploadRoot, fallback: false };
}

let cached: { key: string; storage: PrivateStorage } | null = null;

/** Wie `resolvePrivateStorage`, aber je Konfiguration nur einmal ermittelt. */
export function privateStorageFromEnv(
  env: Record<string, string | undefined> = process.env,
): PrivateStorage {
  const key = `${value(env, 'UPLOAD_DIR') ?? ''}\u0000${value(env, 'PRIVATE_STORAGE_DIR') ?? ''}`;
  if (cached?.key !== key) {
    cached = { key, storage: resolvePrivateStorage(env) };
  }
  return cached.storage;
}

/** Fuer Tests: Zwischenspeicher leeren. */
export function resetPrivateStorageCache(): void {
  cached = null;
}

/** 128 Bit Zufall fuer Dateinamen in der privaten Ablage. */
export function unguessableSuffix(): string {
  return randomBytes(16).toString('hex');
}

/** Private Ablage aus der Nest-Konfiguration (UPLOAD_DIR, PRIVATE_STORAGE_DIR). */
export function privateStorageFromConfig(config: {
  get<T = unknown>(key: string): T | undefined;
}): PrivateStorage {
  const read = (key: string): string | undefined => {
    const raw = config.get<unknown>(key);
    return typeof raw === 'string' ? raw : undefined;
  };
  return privateStorageFromEnv({
    UPLOAD_DIR: read('UPLOAD_DIR'),
    PRIVATE_STORAGE_DIR: read('PRIVATE_STORAGE_DIR'),
  });
}
