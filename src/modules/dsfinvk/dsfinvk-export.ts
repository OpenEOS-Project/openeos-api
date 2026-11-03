import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { encodeTable, type CsvRow } from './dsfinvk-format';
import { DSFINVK_TABLES, TABLE_NAMES } from './dsfinvk-schema';
import type { DsfinvkRows } from './dsfinvk-types';
import { createZip, type ZipEntry } from './dsfinvk-zip';

/**
 * Export-Archiv: 20 CSV-Dateien + `index.xml` + `gdpdu-01-09-2004.dtd`
 * (amtliche Vorlagen aus `assets/dsfinvk/`, DSFinV-K 2.4) als ZIP.
 */

export const INDEX_FILE = 'index.xml';
export const DTD_FILE = 'gdpdu-01-09-2004.dtd';

function assetPath(name: string): string {
  const candidates = [
    resolve(process.cwd(), 'assets/dsfinvk', name),
    resolve(__dirname, '../../../assets/dsfinvk', name),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`DSFinV-K asset ${name} not found`);
  return found;
}

let cache: { index: string; dtd: Buffer } | null = null;

/** Amtliche Vorlagen (index.xml mit BOM und CR LF, DTD), unveraendert. */
export function officialTemplates(): { index: string; dtd: Buffer } {
  if (!cache) {
    cache = {
      index: readFileSync(assetPath(INDEX_FILE), 'utf8'),
      dtd: readFileSync(assetPath(DTD_FILE)),
    };
  }
  return cache;
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * index.xml aus der amtlichen Vorlage; nur `DataSupplier` (Name und Ort
 * des Unternehmens) wird gefuellt. Tabellen und Spalten bleiben exakt wie
 * vom BZSt veroeffentlicht.
 */
export function buildIndexXml(supplier: {
  name: string;
  location: string;
}): string {
  const template = officialTemplates().index;
  return template.replace(
    /<DataSupplier>([\s\S]*?)<Name \/>([\s\S]*?)<Location \/>/,
    (_m, a: string, b: string) =>
      `<DataSupplier>${a}<Name>${xmlEscape(supplier.name)}</Name>${b}<Location>${xmlEscape(supplier.location)}</Location>`,
  );
}

/** Zeilen mehrerer Abschluesse (in Z_NR-Reihenfolge) zusammenfuehren. */
export function mergeRows(parts: DsfinvkRows[]): DsfinvkRows {
  const merged = Object.fromEntries(
    TABLE_NAMES.map((n) => [n, [] as CsvRow[]]),
  ) as DsfinvkRows;
  for (const part of parts) {
    for (const name of TABLE_NAMES) {
      for (const row of part[name] ?? []) merged[name].push(row);
    }
  }
  return merged;
}

/** Alle Dateien des Exports (Name → Inhalt). */
export function buildExportFiles(
  rows: DsfinvkRows,
  supplier: { name: string; location: string },
): ZipEntry[] {
  const entries: ZipEntry[] = [
    { name: INDEX_FILE, data: Buffer.from(buildIndexXml(supplier), 'utf8') },
    { name: DTD_FILE, data: officialTemplates().dtd },
  ];
  for (const table of DSFINVK_TABLES) {
    entries.push({
      name: table.file,
      data: Buffer.from(
        encodeTable(table.name, rows[table.name] ?? []),
        'utf8',
      ),
    });
  }
  return entries;
}

export function buildExportZip(
  rows: DsfinvkRows,
  supplier: { name: string; location: string },
  modified: Date,
): Buffer {
  return createZip(buildExportFiles(rows, supplier), modified);
}

/**
 * Pruefsumme ueber den Inhalt eines Abschlusses: SHA-256 der CSV-Dateien
 * in fester Reihenfolge (`<Dateiname>\n<CSV>`). Gleiche Daten → gleiche
 * Summe; damit laesst sich ein spaeterer Export gegen den gespeicherten
 * Abschluss pruefen.
 */
export function contentHash(rows: DsfinvkRows): string {
  const hash = createHash('sha256');
  for (const table of DSFINVK_TABLES) {
    hash.update(`${table.file}\n`);
    hash.update(encodeTable(table.name, rows[table.name] ?? []));
  }
  return hash.digest('hex');
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
