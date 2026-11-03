/**
 * Prueft einen DSFinV-K-Export (ZIP) mit der eigenen Pruefung von OpenEOS
 * (src/modules/dsfinvk/dsfinvk-validator.ts) — ohne fremde Werkzeuge.
 *
 *   pnpm dsfinvk:validate <export.zip> [--json] [--warnings]
 *
 * Exit-Code 0 = keine Fehler, 1 = Fehler gefunden, 2 = Aufruf/Datei falsch.
 */
import { readFileSync } from 'fs';
import { validateZip } from '../src/modules/dsfinvk/dsfinvk-validator';

function main(): number {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error(
      'Aufruf: pnpm dsfinvk:validate <export.zip> [--json] [--warnings]',
    );
    return 2;
  }
  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch (error) {
    console.error(`Datei nicht lesbar: ${(error as Error).message}`);
    return 2;
  }
  const result = validateZip(data);
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  const where = (i: { file?: string; line?: number }) =>
    i.file ? ` [${i.file}${i.line ? `:${i.line}` : ''}]` : '';
  console.log(`DSFinV-K-Prüfung: ${file}`);
  console.log(
    `  Abschlüsse: ${result.stats.closings}, Vorgänge: ${result.stats.transactions}, Positionen: ${result.stats.lines}, TSE-Transaktionen: ${result.stats.tseTransactions} (davon mit Fehlerhinweis: ${result.stats.tseFailures})`,
  );
  for (const e of result.errors)
    console.log(`  FEHLER  ${e.code}${where(e)} ${e.message}`);
  if (args.includes('--warnings') || result.errors.length === 0) {
    for (const w of result.warnings)
      console.log(`  HINWEIS ${w.code}${where(w)} ${w.message}`);
  } else if (result.warnings.length) {
    console.log(
      `  (${result.warnings.length} Hinweise, mit --warnings anzeigen)`,
    );
  }
  console.log(
    result.ok ? '  Ergebnis: OK' : `  Ergebnis: ${result.errors.length} Fehler`,
  );
  return result.ok ? 0 : 1;
}

process.exit(main());
