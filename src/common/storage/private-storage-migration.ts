import { createHash } from 'crypto';
import { createReadStream, constants as fsConstants, promises as fs } from 'fs';
import * as path from 'path';
import type { Logger } from '@nestjs/common';
import { isInsideDir } from './private-storage';

/**
 * Umzug privater Dateien aus dem Upload-Verzeichnis in die private Ablage.
 *
 * - Dateien werden einzeln verschoben (umbenannt, bei getrennten Volumes
 *   kopiert, geprueft und erst dann am alten Ort entfernt).
 * - Liegt am Ziel schon eine Datei gleichen Namens, bleibt die Quelle nur
 *   dann nicht stehen, wenn beide denselben Inhalt haben; sonst bleibt sie
 *   unangetastet und das Log meldet den Konflikt.
 * - Leere Verzeichnisse am alten Ort werden danach entfernt.
 * - Symbolische Links werden nicht verfolgt.
 *
 * Mehrfaches Ausfuehren ist gefahrlos.
 */

export interface MoveResult {
  moved: number;
  alreadyPresent: number;
  conflicts: string[];
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function sameContent(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ha, hb] = await Promise.all([sha256Of(a), sha256Of(b)]);
  return ha === hb;
}

async function moveFile(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  // Anderes Volume: kopieren, pruefen, dann erst die Quelle entfernen.
  const part = `${target}.part`;
  await fs.rm(part, { force: true });
  await fs.copyFile(source, part, fsConstants.COPYFILE_EXCL);
  if (!(await sameContent(source, part))) {
    await fs.rm(part, { force: true });
    throw new Error(`copy of ${source} does not match`);
  }
  await fs.rename(part, target);
  await fs.unlink(source);
}

async function removeEmptyDirs(dir: string, keepRoot: boolean): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await removeEmptyDirs(path.join(dir, entry.name), false);
    }
  }
  if (keepRoot) return;
  try {
    await fs.rmdir(dir);
  } catch {
    // nicht leer (Konflikt) oder schon weg
  }
}

/** Verschiebt den Inhalt von `from` nach `to` (beide absolut). */
export async function moveTree(
  from: string,
  to: string,
  logger?: Pick<Logger, 'warn'>,
): Promise<MoveResult> {
  const result: MoveResult = { moved: 0, alreadyPresent: 0, conflicts: [] };
  if (from === to || isInsideDir(to, from) || isInsideDir(from, to)) {
    return result;
  }
  let rootStat: import('fs').Stats;
  try {
    rootStat = await fs.lstat(from);
  } catch {
    return result;
  }
  if (!rootStat.isDirectory()) return result;

  const walk = async (relative: string): Promise<void> => {
    const sourceDir = path.join(from, relative);
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = path.join(relative, entry.name);
      const source = path.join(from, rel);
      const target = path.join(to, rel);
      if (entry.isDirectory()) {
        await walk(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (await exists(target)) {
        if (await sameContent(source, target)) {
          await fs.unlink(source);
          result.alreadyPresent++;
        } else {
          result.conflicts.push(rel);
          logger?.warn(
            `Private storage: ${target} already exists with different content – kept ${source}`,
          );
        }
        continue;
      }
      await moveFile(source, target);
      result.moved++;
    }
  };

  await walk('');
  await removeEmptyDirs(from, false);
  return result;
}

/**
 * Neuer Wert fuer einen gespeicherten Pfad, oder `null`, wenn er bleiben
 * kann. Relative Pfade gelten bereits relativ zur Ablage. Absolute Pfade
 * in einer der bekannten Ablagen werden relativ zu dieser gemacht.
 */
export function normalizedStoredPath(
  stored: string,
  bases: string[],
): string | null {
  if (!path.isAbsolute(stored)) return null;
  const resolved = path.resolve(stored);
  for (const base of bases) {
    if (isInsideDir(resolved, base) && resolved !== base) {
      return path.relative(base, resolved).split(path.sep).join('/');
    }
  }
  return null;
}
