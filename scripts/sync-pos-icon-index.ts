/*
 * Schreibt die Namen und Suchbegriffe aller Icons aus @openeos/pos-icons
 * nach src/modules/assistant/icons/pos-icon-index.ts.
 *
 * Das Paket ist ESM mit React als Peer und exportiert `data/index.json`
 * nicht als Unterpfad — zur Laufzeit will die API es nicht laden. Der
 * schlanke Index (ohne Bilddaten) liegt deshalb im Repo und wird nach
 * einem Paket-Update mit `pnpm icons:sync` erneuert.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface PackageIconEntry {
  id: string;
  terms: string[];
}

const packageDir = join(
  __dirname,
  '..',
  'node_modules',
  '@openeos',
  'pos-icons',
);
const version = (
  JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
const entries = JSON.parse(
  readFileSync(join(packageDir, 'data', 'index.json'), 'utf8'),
) as PackageIconEntry[];

const slim = {
  package: '@openeos/pos-icons',
  version,
  icons: entries.map((entry) => ({ id: entry.id, terms: entry.terms })),
};

const target = join(
  __dirname,
  '..',
  'src',
  'modules',
  'assistant',
  'icons',
  'pos-icon-index.ts',
);
// Als TypeScript-Modul statt JSON: tsconfig hat kein resolveJsonModule,
// und nest build kopiert keine JSON-Dateien nach dist.
writeFileSync(
  target,
  [
    '/* Erzeugt von scripts/sync-pos-icon-index.ts — nicht von Hand aendern. */',
    'export interface PosIconIndexEntry {',
    '  id: string;',
    '  terms: string[];',
    '}',
    '',
    'export const POS_ICON_INDEX: {',
    '  package: string;',
    '  version: string;',
    '  icons: PosIconIndexEntry[];',
    `} = ${JSON.stringify(slim, null, 2)};`,
    '',
  ].join('\n'),
);
console.log(`${slim.icons.length} Icons (v${version}) → ${target}`);
