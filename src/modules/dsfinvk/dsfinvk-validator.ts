import { parseCsv } from './dsfinvk-format';
import { parseBestellung, parseKassenbeleg } from './dsfinvk-process-data';
import {
  DSFINVK_TABLES,
  TABLE_BY_NAME,
  type TableDef,
  type TableName,
} from './dsfinvk-schema';
import { readZip, type ZipEntry } from './dsfinvk-zip';
import { BON_TYPES, GV_TYPES, PAYMENT_TYPES } from './dsfinvk-builder';
import { DTD_FILE, INDEX_FILE, officialTemplates } from './dsfinvk-export';

/**
 * Eigene Pruefung eines DSFinV-K-Exports gegen die Regeln der
 * DSFinV-K 2.4 (BZSt) — ohne fremde Werkzeuge. Geprueft wird:
 *
 * 1. Dateien: index.xml, DTD und alle 20 Tabellen laut amtlicher index.xml.
 * 2. index.xml: Tabellen, Spalten, Reihenfolge, Typen, Laengen,
 *    Trennzeichen und Kodierung wie in der amtlichen Vorlage.
 * 3. CSV: Kopfzeile, Spaltenzahl, CR LF, UTF-8, Laengen, Zahlenformat
 *    (Dezimalkomma, Nachkommastellen), Datums-/Zeitformate, Wertelisten
 *    (BON_TYP, GV_TYP, ZAHLART_TYP, REF_TYP, …), Pflichtfelder.
 * 4. Beziehungen: jede Zeile gehoert zu einem Abschluss (Z_KASSE_ID,
 *    Z_ERSTELLUNG, Z_NR), Positionen zu Bons, Detailzeilen zu Positionen,
 *    USt-Schluessel/Terminals/TSE/Agenturen zu den Stammdaten, Referenzen
 *    auf vorhandene Vorgaenge.
 * 5. Summen: Bonkopf = Σ Bonkopf_USt = Σ Bonkopf_Zahlarten, Bonkopf_USt je
 *    Schluessel = Σ Bonpos_USt, Netto + USt = Brutto, Kassenabschluss
 *    (Z_GV_Typ, Z_Zahlart, Z_SE_*, Z_Waehrungen) = Σ der Belege.
 * 6. Folgen: Z_NR und BON_ID lueckenlos, Z_START_ID/Z_ENDE_ID.
 * 7. TSE: jeder Vorgang hat TSE-Daten (Signatur oder Fehlerhinweis),
 *    Prozessdaten passen zu Bonkopf und Zahlarten.
 */

export type IssueLevel = 'error' | 'warning';

export interface ValidationIssue {
  level: IssueLevel;
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: {
    closings: number;
    transactions: number;
    lines: number;
    tseTransactions: number;
    tseFailures: number;
    rowsPerFile: Record<string, number>;
  };
}

type Rec = Record<string, string> & { __line: string };

const RFC3339 =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TSE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const NUMBER = /^-?\d+(,\d+)?$/;

const REF_TYPES = [
  'ExterneRechnung',
  'ExternerLieferschein',
  'Transaktion',
  'ExterneSonstige',
];
const PRICE_TYPES = [
  'base_amount',
  'Grundpreis',
  'discount',
  'Rabatt',
  'extra_amount',
  'Zuschlag',
];
const SIG_ALGOS = [
  'ecdsa-plain-SHA224',
  'ecdsa-plain-SHA256',
  'ecdsa-plain-SHA384',
  'ecdsa-plain-SHA512',
  'ecdsa-plain-SHA3-224',
  'ecdsa-plain-SHA3-256',
  'ecdsa-plain-SHA3-384',
  'ecdsa-plain-SHA3-512',
  'ecsdsa-plain-SHA224',
  'ecsdsa-plain-SHA256',
  'ecsdsa-plain-SHA384',
  'ecsdsa-plain-SHA512',
  'ecsdsa-plain-SHA3-224',
  'ecsdsa-plain-SHA3-256',
  'ecsdsa-plain-SHA3-384',
  'ecsdsa-plain-SHA3-512',
];
const TIME_FORMATS = [
  'unixTime',
  'utcTime',
  'utcTimeWithSeconds',
  'generalizedTime',
  'generalizedTimeWithMilliseconds',
];
const PROCESS_TYPES = ['Kassenbeleg-V1', 'Bestellung-V1', 'SonstigerVorgang'];
const TAXONOMY_VERSIONS = ['2.0', '2.1', '2.2', '2.3', '2.4'];
/** Slot (1..5) der Prozessdaten je USt-Schluessel (Anhang I, Anlage 2). */
const SLOT_OF_KEY: Record<number, number> = {
  1: 1,
  11: 1,
  21: 1,
  2: 2,
  12: 2,
  22: 2,
  3: 3,
  13: 3,
  23: 3,
  33: 3,
  43: 3,
  4: 4,
  5: 5,
  6: 5,
  7: 5,
  8: 5,
};

/** Pflichtfelder (nicht leer) je Tabelle, nach Anhang E. */
const REQUIRED: Partial<Record<TableName, string[]>> = {
  Stamm_Abschluss: [
    'TAXONOMIE_VERSION',
    'NAME',
    'STRASSE',
    'PLZ',
    'ORT',
    'LAND',
    'Z_SE_ZAHLUNGEN',
    'Z_SE_BARZAHLUNGEN',
  ],
  Stamm_Kassen: [
    'KASSE_BRAND',
    'KASSE_MODELL',
    'KASSE_SERIENNR',
    'KASSE_SW_BRAND',
    'KASSE_SW_VERSION',
    'KASSE_BASISWAEH_CODE',
  ],
  Stamm_Terminals: ['TERMINAL_ID'],
  Stamm_Agenturen: ['AGENTUR_ID', 'AGENTUR_NAME'],
  Stamm_USt: ['UST_SCHLUESSEL', 'UST_SATZ'],
  Stamm_TSE: [
    'TSE_ID',
    'TSE_SERIAL',
    'TSE_SIG_ALGO',
    'TSE_ZEITFORMAT',
    'TSE_PD_ENCODING',
    'TSE_PUBLIC_KEY',
  ],
  Z_GV_Typ: [
    'GV_TYP',
    'AGENTUR_ID',
    'UST_SCHLUESSEL',
    'Z_UMS_BRUTTO',
    'Z_UMS_NETTO',
    'Z_UST',
  ],
  Z_Zahlart: ['ZAHLART_TYP', 'Z_ZAHLART_BETRAG'],
  Z_Waehrungen: ['ZAHLART_WAEH', 'ZAHLART_BETRAG_WAEH'],
  Bonkopf: [
    'BON_ID',
    'BON_NR',
    'BON_TYP',
    'BON_STORNO',
    'BON_START',
    'BON_ENDE',
    'UMS_BRUTTO',
  ],
  Bonkopf_USt: [
    'BON_ID',
    'UST_SCHLUESSEL',
    'BON_BRUTTO',
    'BON_NETTO',
    'BON_UST',
  ],
  Bonkopf_AbrKreis: ['BON_ID', 'ABRECHNUNGSKREIS'],
  Bonkopf_Zahlarten: ['BON_ID', 'ZAHLART_TYP', 'BASISWAEH_BETRAG'],
  Bonpos: ['BON_ID', 'POS_ZEILE', 'GV_TYP', 'AGENTUR_ID', 'MENGE'],
  Bonpos_USt: ['BON_ID', 'POS_ZEILE', 'UST_SCHLUESSEL'],
  Bonpos_Preisfindung: [
    'BON_ID',
    'POS_ZEILE',
    'TYP',
    'UST_SCHLUESSEL',
    'PF_BRUTTO',
  ],
  Bonpos_Zusatzinfo: ['BON_ID', 'POS_ZEILE'],
  Bon_Referenzen: ['BON_ID', 'REF_TYP', 'REF_BON_ID'],
  TSE_Transaktionen: ['BON_ID', 'TSE_ID'],
};

const ENUMS: Record<string, readonly string[]> = {
  BON_TYP: BON_TYPES,
  GV_TYP: GV_TYPES,
  ZAHLART_TYP: PAYMENT_TYPES,
  REF_TYP: REF_TYPES,
  TSE_SIG_ALGO: SIG_ALGOS,
  TSE_ZEITFORMAT: TIME_FORMATS,
  TSE_PD_ENCODING: ['UTF-8', 'ASCII'],
  TSE_TA_VORGANGSART: PROCESS_TYPES,
  BON_STORNO: ['0', '1'],
  P_STORNO: ['0', '1'],
  INHAUS: ['0', '1'],
  KEINE_UST_ZUORDNUNG: ['0', '1'],
  TAXONOMIE_VERSION: TAXONOMY_VERSIONS,
};

const TIMESTAMP_FIELDS = ['Z_ERSTELLUNG', 'BON_START', 'BON_ENDE', 'REF_DATUM'];
const TSE_TIME_FIELDS = ['TSE_TA_START', 'TSE_TA_ENDE'];
const COUNTRY_FIELDS = ['LAND', 'LOC_LAND', 'AGENTUR_LAND', 'KUNDE_LAND'];
const CURRENCY_FIELDS = [
  'KASSE_BASISWAEH_CODE',
  'ZAHLWAEH_CODE',
  'ZAHLART_WAEH',
];
const VATID_FIELDS = ['USTID', 'LOC_USTID', 'AGENTUR_USTID', 'KUNDE_USTID'];
/** Betragsfelder: zwei Nachkommastellen (Tz. 4.1); STK_BR darf bis zu fuenf haben. */
const AMOUNT_FIELDS_EXACT2 = new Set([
  'Z_SE_ZAHLUNGEN',
  'Z_SE_BARZAHLUNGEN',
  'Z_UMS_BRUTTO',
  'Z_UMS_NETTO',
  'Z_UST',
  'Z_ZAHLART_BETRAG',
  'ZAHLART_BETRAG_WAEH',
  'UMS_BRUTTO',
  'BON_BRUTTO',
  'BON_NETTO',
  'BON_UST',
  'ZAHLWAEH_BETRAG',
  'BASISWAEH_BETRAG',
  'POS_BRUTTO',
  'POS_NETTO',
  'POS_UST',
  'PF_BRUTTO',
  'PF_NETTO',
  'PF_UST',
  'ZI_BASISPREIS_BRUTTO',
  'ZI_BASISPREIS_NETTO',
  'ZI_BASISPREIS_UST',
  'UST_SATZ',
]);

/** Dezimalzahl mit Komma → Wert in 1/100000 (exakt, ohne Gleitkomma). */
function parseFixed(text: string): number | null {
  if (!NUMBER.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split(',');
  if (fraction.length > 5) return null;
  const value = Number(whole) * 100000 + Number(fraction.padEnd(5, '0'));
  return negative ? -value : value;
}

/** Betrag → Cent (nur fuer Felder mit hoechstens zwei relevanten Stellen). */
function centsOf(text: string | undefined): number {
  if (!text) return 0;
  const v = parseFixed(text);
  return v === null ? 0 : Math.round(v / 1000);
}

interface Model {
  tables: Record<TableName, Rec[]>;
}

class Collector {
  errors: ValidationIssue[] = [];
  warnings: ValidationIssue[] = [];
  private perCode = new Map<string, number>();
  private static readonly LIMIT = 50;

  add(
    level: IssueLevel,
    code: string,
    message: string,
    file?: string,
    line?: number,
  ) {
    const n = (this.perCode.get(code) ?? 0) + 1;
    this.perCode.set(code, n);
    const list = level === 'error' ? this.errors : this.warnings;
    if (n === Collector.LIMIT + 1) {
      list.push({
        level,
        code,
        message: `… weitere Befunde ${code} unterdrückt`,
        file,
      });
      return;
    }
    if (n > Collector.LIMIT + 1) return;
    list.push({ level, code, message, file, line });
  }
  error(code: string, message: string, file?: string, line?: number) {
    this.add('error', code, message, file, line);
  }
  warn(code: string, message: string, file?: string, line?: number) {
    this.add('warning', code, message, file, line);
  }
}

// ------------------------------------------------------------ index.xml

interface IndexColumn {
  name: string;
  type: 'alpha' | 'numeric';
  maxLength?: number;
  accuracy?: number;
}
interface IndexTable {
  url: string;
  name: string;
  columns: IndexColumn[];
  block: string;
}

export function parseIndexXml(xml: string): IndexTable[] {
  const tables: IndexTable[] = [];
  for (const match of xml.matchAll(/<Table>([\s\S]*?)<\/Table>/g)) {
    const block = match[1];
    const url = /<URL>([^<]*)<\/URL>/.exec(block)?.[1] ?? '';
    const name = /<\/URL>\s*<Name>([^<]*)<\/Name>/.exec(block)?.[1] ?? '';
    const columns: IndexColumn[] = [];
    for (const col of block.matchAll(
      /<Variable(?:Column|PrimaryKey)>([\s\S]*?)<\/Variable(?:Column|PrimaryKey)>/g,
    )) {
      const body = col[1];
      const colName = /<Name>([^<]*)<\/Name>/.exec(body)?.[1] ?? '';
      if (/<AlphaNumeric\s*\/>/.test(body)) {
        const max = /<MaxLength>(\d+)<\/MaxLength>/.exec(body)?.[1];
        columns.push({
          name: colName,
          type: 'alpha',
          maxLength: max ? Number(max) : undefined,
        });
      } else {
        const acc = /<Accuracy>(\d+)<\/Accuracy>/.exec(body)?.[1];
        columns.push({
          name: colName,
          type: 'numeric',
          accuracy: acc ? Number(acc) : 0,
        });
      }
    }
    tables.push({ url, name, columns, block });
  }
  return tables;
}

function checkIndex(xml: string, c: Collector): void {
  if (!/<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004\.dtd">/.test(xml)) {
    c.error(
      'INDEX_DOCTYPE',
      'index.xml verweist nicht auf gdpdu-01-09-2004.dtd',
      INDEX_FILE,
    );
  }
  const supplier =
    /<DataSupplier>([\s\S]*?)<\/DataSupplier>/.exec(xml)?.[1] ?? '';
  if (!supplier || /<Name\s*\/>/.test(supplier)) {
    c.warn('INDEX_SUPPLIER', 'DataSupplier/Name ist leer', INDEX_FILE);
  }
  const tables = parseIndexXml(xml);
  const official = parseIndexXml(officialTemplates().index);
  for (const ref of official) {
    const t = tables.find((x) => x.url === ref.url);
    if (!t) {
      c.error(
        'INDEX_TABLE_MISSING',
        `Tabelle ${ref.name} (${ref.url}) fehlt in index.xml`,
        INDEX_FILE,
      );
      continue;
    }
    if (t.name !== ref.name) {
      c.error(
        'INDEX_TABLE_NAME',
        `${ref.url}: Name ${t.name}, erwartet ${ref.name}`,
        INDEX_FILE,
      );
    }
    // Zusaetzliche Felder sind am Zeilenende erlaubt (Tz. 1.3), die
    // amtlichen muessen in Reihenfolge und Typ uebereinstimmen.
    ref.columns.forEach((col, i) => {
      const got = t.columns[i];
      if (!got || got.name !== col.name) {
        c.error(
          'INDEX_COLUMN',
          `${ref.url}: Spalte ${i + 1} ist ${got?.name ?? '–'}, erwartet ${col.name}`,
          INDEX_FILE,
        );
      } else if (
        got.type !== col.type ||
        (col.type === 'alpha' && got.maxLength !== col.maxLength) ||
        (col.type === 'numeric' && got.accuracy !== col.accuracy)
      ) {
        c.error(
          'INDEX_COLUMN_TYPE',
          `${ref.url}: Spalte ${col.name} hat abweichenden Typ/Länge`,
          INDEX_FILE,
        );
      }
    });
    const checks: [RegExp, string][] = [
      [/<UTF8\s*\/>/, 'UTF8'],
      [/<DecimalSymbol>,<\/DecimalSymbol>/, 'DecimalSymbol ,'],
      [/<ColumnDelimiter>;<\/ColumnDelimiter>/, 'ColumnDelimiter ;'],
      [
        /<RecordDelimiter>&#xD;&#xA;<\/RecordDelimiter>/,
        'RecordDelimiter CR LF',
      ],
      [/<TextEncapsulator>"<\/TextEncapsulator>/, 'TextEncapsulator "'],
      [/<Range>\s*<From>2<\/From>/, 'Range From 2 (Kopfzeile)'],
    ];
    for (const [re, label] of checks) {
      if (!re.test(t.block))
        c.error('INDEX_FORMAT', `${ref.url}: ${label} fehlt`, INDEX_FILE);
    }
  }
  for (const t of tables) {
    if (!official.some((o) => o.url === t.url)) {
      c.warn(
        'INDEX_EXTRA_TABLE',
        `Zusätzliche Tabelle ${t.url} in index.xml`,
        INDEX_FILE,
      );
    }
  }
}

// ---------------------------------------------------------------- CSV

function checkTable(def: TableDef, data: Buffer, c: Collector): Rec[] {
  const file = def.file;
  let text = data.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(data)) {
    c.error('CSV_ENCODING', 'Datei ist kein gültiges UTF-8', file);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    c.warn('CSV_BOM', 'Datei beginnt mit einem Byte-Order-Mark', file);
    text = text.slice(1);
  }
  const parsed = parseCsv(text);
  if (parsed.unterminatedQuote)
    c.error('CSV_QUOTE', 'Nicht geschlossener Textbegrenzer', file);
  for (const line of parsed.badRecordDelimiters.slice(0, 5)) {
    c.error(
      'CSV_RECORD_DELIMITER',
      'Datensatztrenner ist nicht CR LF',
      file,
      line,
    );
  }
  if (parsed.records.length === 0) {
    c.error('CSV_HEADER', 'Kopfzeile fehlt', file);
    return [];
  }
  const header = parsed.records[0].values;
  const names = def.columns.map((col) => col.name);
  if (header.length < names.length || names.some((n, i) => header[i] !== n)) {
    c.error(
      'CSV_HEADER',
      `Kopfzeile passt nicht zur index.xml (erwartet ${names.join(';')})`,
      file,
      1,
    );
  }
  const required = new Set(REQUIRED[def.name as TableName] ?? []);
  for (const k of ['Z_KASSE_ID', 'Z_ERSTELLUNG', 'Z_NR']) required.add(k);
  const out: Rec[] = [];
  for (const record of parsed.records.slice(1)) {
    const line = record.line;
    if (record.values.length !== header.length) {
      c.error(
        'CSV_COLUMNS',
        `${record.values.length} Felder statt ${header.length}`,
        file,
        line,
      );
      continue;
    }
    const rec = { __line: String(line) } as Rec;
    def.columns.forEach((col, i) => {
      const value = record.values[i];
      rec[col.name] = value;
      if (value === '') {
        if (required.has(col.name))
          c.error('FIELD_REQUIRED', `${col.name} ist leer`, file, line);
        return;
      }
      if (col.type === 'alpha') {
        if ([...value].length > (col.maxLength ?? Infinity)) {
          c.error(
            'FIELD_LENGTH',
            `${col.name} länger als ${col.maxLength} Zeichen`,
            file,
            line,
          );
        }
        if (!record.quoted[i])
          c.warn(
            'FIELD_UNQUOTED',
            `${col.name} ohne Textbegrenzer`,
            file,
            line,
          );
      } else {
        if (record.quoted[i])
          c.warn(
            'FIELD_QUOTED_NUMBER',
            `Zahl ${col.name} in Textbegrenzern`,
            file,
            line,
          );
        const fraction = value.split(',')[1] ?? '';
        if (!NUMBER.test(value)) {
          c.error(
            'FIELD_NUMBER',
            `${col.name} „${value}“ ist keine Zahl im Format 1234,56`,
            file,
            line,
          );
        } else if (fraction.length > (col.accuracy ?? 0)) {
          c.error(
            'FIELD_DECIMALS',
            `${col.name} hat mehr als ${col.accuracy ?? 0} Nachkommastellen`,
            file,
            line,
          );
        } else if (
          AMOUNT_FIELDS_EXACT2.has(col.name) &&
          fraction.length !== 2
        ) {
          c.warn(
            'FIELD_AMOUNT_DECIMALS',
            `${col.name} sollte zwei Nachkommastellen haben (Tz. 4.1)`,
            file,
            line,
          );
        }
      }
      const allowed = ENUMS[col.name];
      if (allowed && !allowed.includes(value)) {
        c.error(
          'FIELD_ENUM',
          `${col.name} „${value}“ ist kein zulässiger Wert`,
          file,
          line,
        );
      }
      if (TIMESTAMP_FIELDS.includes(col.name) && !RFC3339.test(value)) {
        c.error(
          'FIELD_TIMESTAMP',
          `${col.name} „${value}“ entspricht nicht ISO 8601/RFC 3339`,
          file,
          line,
        );
      }
      if (col.name === 'Z_BUCHUNGSTAG' && !DATE.test(value)) {
        c.error(
          'FIELD_DATE',
          `Z_BUCHUNGSTAG „${value}“ ist kein Datum (YYYY-MM-DD)`,
          file,
          line,
        );
      }
      if (TSE_TIME_FIELDS.includes(col.name) && !TSE_TIME.test(value)) {
        c.error(
          'FIELD_TSE_TIME',
          `${col.name} „${value}“ nicht im Format YYYY-MM-DDThh:mm:ss.fffZ`,
          file,
          line,
        );
      }
      if (COUNTRY_FIELDS.includes(col.name) && !/^[A-Z]{3}$/.test(value)) {
        c.error(
          'FIELD_COUNTRY',
          `${col.name} „${value}“ ist kein ISO-3166-Alpha-3-Code`,
          file,
          line,
        );
      }
      if (CURRENCY_FIELDS.includes(col.name) && !/^[A-Z]{3}$/.test(value)) {
        c.error(
          'FIELD_CURRENCY',
          `${col.name} „${value}“ ist kein ISO-4217-Code`,
          file,
          line,
        );
      }
      if (
        VATID_FIELDS.includes(col.name) &&
        !/^[A-Z]{2}[0-9A-Za-z+*.]{2,13}$/.test(value)
      ) {
        c.warn(
          'FIELD_VATID',
          `${col.name} „${value}“ sieht nicht wie eine USt-IdNr. aus`,
          file,
          line,
        );
      }
      if (col.name === 'KASSE_SERIENNR' && /[/_]/.test(value)) {
        c.error(
          'FIELD_SERIAL',
          'KASSE_SERIENNR darf weder „/“ noch „_“ enthalten',
          file,
          line,
        );
      }
      if (col.name === 'TSE_VORGANGSDATEN' && value.trim() !== value) {
        c.error(
          'FIELD_PROCESS_DATA',
          'TSE_VORGANGSDATEN mit Leerzeichen am Anfang/Ende',
          file,
          line,
        );
      }
      if (
        col.name === 'TYP' &&
        def.name === 'Bonpos_Preisfindung' &&
        !PRICE_TYPES.includes(value)
      ) {
        c.error(
          'FIELD_ENUM',
          `TYP „${value}“ ist kein zulässiger Wert`,
          file,
          line,
        );
      }
      if (
        (col.name === 'TSE_TA_SIG' || col.name === 'TSE_PUBLIC_KEY') &&
        !BASE64.test(value)
      ) {
        c.error(
          'FIELD_BASE64',
          `${col.name} ist nicht base64-codiert`,
          file,
          line,
        );
      }
    });
    out.push(rec);
  }
  return out;
}

// ----------------------------------------------------------- Inhalte

const zKey = (r: Rec) => `${r.Z_KASSE_ID}|${r.Z_NR}`;
const bonKey = (r: Rec) => `${r.Z_KASSE_ID}|${r.Z_NR}|${r.BON_ID}`;
const posKey = (r: Rec) => `${bonKey(r)}|${r.POS_ZEILE}`;

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function checkContent(m: Model, c: Collector): ValidationResult['stats'] {
  const t = m.tables;
  const where = (table: TableName, r: Rec): [string, number] => [
    TABLE_BY_NAME[table].file,
    Number(r.__line),
  ];

  // -- Abschluesse
  const closings = new Map<string, Rec>();
  for (const r of t.Stamm_Abschluss) {
    if (closings.has(zKey(r)))
      c.error(
        'CLOSING_DUPLICATE',
        `Abschluss ${r.Z_NR} doppelt`,
        ...where('Stamm_Abschluss', r),
      );
    closings.set(zKey(r), r);
    if (!r.STNR && !r.USTID) {
      c.error(
        'COMPANY_TAX_ID',
        `Abschluss ${r.Z_NR}: weder STNR noch USTID angegeben (§ 14 Abs. 4 Nr. 2 UStG)`,
        ...where('Stamm_Abschluss', r),
      );
    }
  }
  for (const def of DSFINVK_TABLES) {
    const name = def.name;
    if (name === 'Stamm_Abschluss') continue;
    for (const r of t[name]) {
      const closing = closings.get(zKey(r));
      if (!closing) {
        c.error(
          'REF_CLOSING',
          `Kein Abschluss ${r.Z_KASSE_ID}/${r.Z_NR} in Stamm_Abschluss`,
          ...where(name, r),
        );
      } else if (closing.Z_ERSTELLUNG !== r.Z_ERSTELLUNG) {
        c.error(
          'REF_CLOSING_TIME',
          `Z_ERSTELLUNG weicht vom Abschluss ${r.Z_NR} ab`,
          ...where(name, r),
        );
      }
    }
  }
  const perClosing = (table: TableName) => groupBy(t[table], zKey);
  const kassen = perClosing('Stamm_Kassen');
  const orte = perClosing('Stamm_Orte');
  const ust = perClosing('Stamm_USt');
  const terminals = perClosing('Stamm_Terminals');
  const tses = perClosing('Stamm_TSE');
  const agencies = perClosing('Stamm_Agenturen');
  for (const [k, closing] of closings) {
    const kasse = kassen.get(k) ?? [];
    if (kasse.length !== 1) {
      c.error(
        'MASTER_REGISTER',
        `Abschluss ${closing.Z_NR}: ${kasse.length} Zeilen in Stamm_Kassen (erwartet 1)`,
        'cashregister.csv',
      );
    } else if (kasse[0].KASSE_SERIENNR !== closing.Z_KASSE_ID) {
      c.warn(
        'MASTER_REGISTER_SERIAL',
        `Abschluss ${closing.Z_NR}: KASSE_SERIENNR weicht von Z_KASSE_ID ab`,
        'cashregister.csv',
      );
    }
    if ((orte.get(k) ?? []).length !== 1) {
      c.error(
        'MASTER_LOCATION',
        `Abschluss ${closing.Z_NR}: Stamm_Orte braucht genau eine Zeile`,
        'location.csv',
      );
    }
    const keys = (ust.get(k) ?? []).map((r) => r.UST_SCHLUESSEL);
    if (new Set(keys).size !== keys.length)
      c.error(
        'MASTER_VAT_DUPLICATE',
        `Abschluss ${closing.Z_NR}: USt-Schlüssel doppelt`,
        'vat.csv',
      );
    const tseIds = (tses.get(k) ?? []).map((r) => r.TSE_ID);
    if (new Set(tseIds).size !== tseIds.length)
      c.error(
        'MASTER_TSE_DUPLICATE',
        `Abschluss ${closing.Z_NR}: TSE_ID doppelt`,
        'tse.csv',
      );
    for (const r of tses.get(k) ?? []) {
      if (!/^[0-9a-fA-F]{2,68}$/.test(r.TSE_SERIAL))
        c.warn(
          'MASTER_TSE_SERIAL',
          'TSE_SERIAL ist keine Hex-Darstellung',
          ...where('Stamm_TSE', r),
        );
      if (!r.TSE_ZERTIFIKAT_I)
        c.warn(
          'MASTER_TSE_CERT',
          `TSE ${r.TSE_ID}: Zertifikat (TSE_ZERTIFIKAT_I) nicht angegeben`,
          ...where('Stamm_TSE', r),
        );
    }
  }
  const ustRate = new Map<string, number>();
  for (const r of t.Stamm_USt)
    ustRate.set(
      `${zKey(r)}|${r.UST_SCHLUESSEL}`,
      (parseFixed(r.UST_SATZ) ?? 0) / 100000,
    );
  const hasKey = (r: Rec, field = 'UST_SCHLUESSEL') =>
    ustRate.has(`${zKey(r)}|${r[field]}`);

  // -- Bons
  const bons = new Map<string, Rec>();
  const bonIdsPerKasse = new Map<string, Map<string, string>>();
  const bonNrPerClosing = new Set<string>();
  for (const r of t.Bonkopf) {
    if (bons.has(bonKey(r)))
      c.error(
        'BON_DUPLICATE',
        `BON_ID ${r.BON_ID} doppelt im Abschluss ${r.Z_NR}`,
        ...where('Bonkopf', r),
      );
    bons.set(bonKey(r), r);
    const ids = bonIdsPerKasse.get(r.Z_KASSE_ID) ?? new Map<string, string>();
    if (ids.has(r.BON_ID) && ids.get(r.BON_ID) !== r.Z_NR) {
      c.error(
        'BON_ID_REUSED',
        `BON_ID ${r.BON_ID} in mehreren Abschlüssen`,
        ...where('Bonkopf', r),
      );
    }
    ids.set(r.BON_ID, r.Z_NR);
    bonIdsPerKasse.set(r.Z_KASSE_ID, ids);
    const nr = `${zKey(r)}|${r.BON_NR}`;
    if (bonNrPerClosing.has(nr))
      c.error(
        'BON_NR_DUPLICATE',
        `BON_NR ${r.BON_NR} doppelt im Abschluss ${r.Z_NR}`,
        ...where('Bonkopf', r),
      );
    bonNrPerClosing.add(nr);
    if (r.BON_TYP === 'AVSonstige' && !r.BON_NAME)
      c.error(
        'BON_NAME_REQUIRED',
        'AVSonstige braucht BON_NAME',
        ...where('Bonkopf', r),
      );
    if (
      r.BON_START &&
      r.BON_ENDE &&
      Date.parse(r.BON_START) > Date.parse(r.BON_ENDE)
    ) {
      c.error(
        'BON_TIME_ORDER',
        'BON_START liegt nach BON_ENDE',
        ...where('Bonkopf', r),
      );
    }
    if (r.TERMINAL_ID) {
      c.warn(
        'BON_TERMINAL',
        'TERMINAL_ID nur angeben, wenn die Terminal-Seriennummer als ClientID an die TSE ging (Anhang E)',
        ...where('Bonkopf', r),
      );
      if (
        !(terminals.get(zKey(r)) ?? []).some(
          (x) => x.TERMINAL_ID === r.TERMINAL_ID,
        )
      ) {
        c.error(
          'REF_TERMINAL',
          `TERMINAL_ID ${r.TERMINAL_ID} fehlt in Stamm_Terminals`,
          ...where('Bonkopf', r),
        );
      }
    }
  }
  const bonTables: TableName[] = [
    'Bonkopf_USt',
    'Bonkopf_AbrKreis',
    'Bonkopf_Zahlarten',
    'Bonpos',
    'Bon_Referenzen',
    'TSE_Transaktionen',
  ];
  for (const name of bonTables) {
    for (const r of t[name]) {
      if (!bons.has(bonKey(r)))
        c.error(
          'REF_BON',
          `BON_ID ${r.BON_ID} fehlt in Bonkopf`,
          ...where(name, r),
        );
    }
  }
  const positions = new Map<string, Rec>();
  for (const r of t.Bonpos) {
    if (positions.has(posKey(r)))
      c.error(
        'POS_DUPLICATE',
        `POS_ZEILE ${r.POS_ZEILE} doppelt (BON_ID ${r.BON_ID})`,
        ...where('Bonpos', r),
      );
    positions.set(posKey(r), r);
    if (
      r.POS_TERMINAL_ID &&
      !(terminals.get(zKey(r)) ?? []).some(
        (x) => x.TERMINAL_ID === r.POS_TERMINAL_ID,
      )
    ) {
      c.error(
        'REF_TERMINAL',
        `POS_TERMINAL_ID ${r.POS_TERMINAL_ID} fehlt in Stamm_Terminals`,
        ...where('Bonpos', r),
      );
    }
    if (
      r.AGENTUR_ID &&
      r.AGENTUR_ID !== '0' &&
      !(agencies.get(zKey(r)) ?? []).some((x) => x.AGENTUR_ID === r.AGENTUR_ID)
    ) {
      c.error(
        'REF_AGENCY',
        `AGENTUR_ID ${r.AGENTUR_ID} fehlt in Stamm_Agenturen`,
        ...where('Bonpos', r),
      );
    }
  }
  for (const [k, list] of groupBy(t.Bonpos, bonKey)) {
    const numbers = list.map((r) => Number(r.POS_ZEILE));
    if (numbers.some((n) => !Number.isInteger(n))) {
      c.warn(
        'POS_NOT_NUMERIC',
        `POS_ZEILE nicht numerisch (${k})`,
        'lines.csv',
      );
      continue;
    }
    const sorted = [...numbers].sort((a, b) => a - b);
    if (sorted.some((n, i) => n !== i + 1))
      c.error(
        'POS_SEQUENCE',
        `POS_ZEILE nicht fortlaufend ab 1 (BON_ID ${list[0].BON_ID})`,
        'lines.csv',
      );
  }
  for (const name of [
    'Bonpos_USt',
    'Bonpos_Preisfindung',
    'Bonpos_Zusatzinfo',
  ] as TableName[]) {
    for (const r of t[name]) {
      if (!positions.has(posKey(r)))
        c.error(
          'REF_POSITION',
          `Position ${r.BON_ID}/${r.POS_ZEILE} fehlt in Bonpos`,
          ...where(name, r),
        );
    }
  }
  for (const r of t.Bon_Referenzen) {
    if (r.POS_ZEILE && !positions.has(posKey(r)))
      c.error(
        'REF_POSITION',
        `Position ${r.BON_ID}/${r.POS_ZEILE} fehlt in Bonpos`,
        ...where('Bon_Referenzen', r),
      );
  }
  for (const [name, field] of [
    ['Bonkopf_USt', 'UST_SCHLUESSEL'],
    ['Bonpos_USt', 'UST_SCHLUESSEL'],
    ['Bonpos_Preisfindung', 'UST_SCHLUESSEL'],
    ['Z_GV_Typ', 'UST_SCHLUESSEL'],
    ['Bonpos_Zusatzinfo', 'ZI_UST_SCHLUESSEL'],
  ] as [TableName, string][]) {
    for (const r of t[name]) {
      if (r[field] && !hasKey(r, field))
        c.error(
          'REF_VAT',
          `USt-Schlüssel ${r[field]} fehlt in Stamm_USt`,
          ...where(name, r),
        );
    }
  }

  // -- Referenzen
  for (const r of t.Bon_Referenzen) {
    if (r.REF_TYP === 'Transaktion') {
      if (!r.REF_Z_KASSE_ID || !r.REF_Z_NR || !r.REF_DATUM) {
        c.error(
          'REF_INCOMPLETE',
          'REF_TYP Transaktion braucht REF_DATUM, REF_Z_KASSE_ID und REF_Z_NR',
          ...where('Bon_Referenzen', r),
        );
        continue;
      }
      const target = closings.get(`${r.REF_Z_KASSE_ID}|${r.REF_Z_NR}`);
      if (!target) {
        c.warn(
          'REF_OUTSIDE',
          `Referenz auf Abschluss ${r.REF_Z_NR} außerhalb dieses Exports`,
          ...where('Bon_Referenzen', r),
        );
        continue;
      }
      if (target.Z_ERSTELLUNG !== r.REF_DATUM)
        c.error(
          'REF_DATE',
          `REF_DATUM passt nicht zu Abschluss ${r.REF_Z_NR}`,
          ...where('Bon_Referenzen', r),
        );
      if (!bons.has(`${r.REF_Z_KASSE_ID}|${r.REF_Z_NR}|${r.REF_BON_ID}`)) {
        c.error(
          'REF_TARGET',
          `Referenzierter Vorgang ${r.REF_BON_ID} (Abschluss ${r.REF_Z_NR}) fehlt`,
          ...where('Bon_Referenzen', r),
        );
      }
    } else if (r.REF_TYP === 'ExterneSonstige' && !r.REF_NAME) {
      c.error(
        'REF_NAME',
        'ExterneSonstige braucht REF_NAME',
        ...where('Bon_Referenzen', r),
      );
    }
  }

  // -- Summen je Bon
  const headVat = groupBy(t.Bonkopf_USt, bonKey);
  const posVat = groupBy(t.Bonpos_USt, bonKey);
  const pays = groupBy(t.Bonkopf_Zahlarten, bonKey);
  const tseRows = groupBy(t.TSE_Transaktionen, bonKey);
  const posVatByPos = groupBy(t.Bonpos_USt, posKey);
  const priceByPos = groupBy(t.Bonpos_Preisfindung, posKey);
  const grossOf = (r: Rec, prefix: string) =>
    r[`${prefix}_BRUTTO`] !== ''
      ? centsOf(r[`${prefix}_BRUTTO`])
      : centsOf(r[`${prefix}_NETTO`]) + centsOf(r[`${prefix}_UST`]);

  for (const [k, bon] of bons) {
    const [file, line] = where('Bonkopf', bon);
    const total = centsOf(bon.UMS_BRUTTO);
    const vatRows = headVat.get(k) ?? [];
    const vatSum = vatRows.reduce((s, r) => s + centsOf(r.BON_BRUTTO), 0);
    if (vatSum !== total)
      c.error(
        'SUM_BON_VAT',
        `BON_ID ${bon.BON_ID}: UMS_BRUTTO ${bon.UMS_BRUTTO} ≠ Σ Bonkopf_USt`,
        file,
        line,
      );
    const seenKeys = new Set<string>();
    for (const r of vatRows) {
      if (seenKeys.has(r.UST_SCHLUESSEL))
        c.error(
          'BON_VAT_DUPLICATE',
          `BON_ID ${bon.BON_ID}: USt-Schlüssel ${r.UST_SCHLUESSEL} doppelt`,
          ...where('Bonkopf_USt', r),
        );
      seenKeys.add(r.UST_SCHLUESSEL);
      const g = centsOf(r.BON_BRUTTO);
      const n = centsOf(r.BON_NETTO);
      const v = centsOf(r.BON_UST);
      if (n + v !== g)
        c.error(
          'SUM_NET_VAT',
          `BON_ID ${bon.BON_ID}: Netto + USt ≠ Brutto (Schlüssel ${r.UST_SCHLUESSEL})`,
          ...where('Bonkopf_USt', r),
        );
      const rate = ustRate.get(`${zKey(r)}|${r.UST_SCHLUESSEL}`) ?? 0;
      const expected =
        Math.sign(g) * Math.round((Math.abs(g) * rate) / (100 + rate));
      if (Math.abs(expected - v) > 1)
        c.warn(
          'VAT_RATE',
          `BON_ID ${bon.BON_ID}: USt ${r.BON_UST} passt nicht zum Satz ${rate} %`,
          ...where('Bonkopf_USt', r),
        );
      const lineSum = (posVat.get(k) ?? [])
        .filter((p) => p.UST_SCHLUESSEL === r.UST_SCHLUESSEL)
        .reduce((s, p) => s + grossOf(p, 'POS'), 0);
      if (lineSum !== g)
        c.error(
          'SUM_BON_LINES',
          `BON_ID ${bon.BON_ID}: Σ Bonpos_USt (Schlüssel ${r.UST_SCHLUESSEL}) ${lineSum / 100} ≠ BON_BRUTTO ${r.BON_BRUTTO}`,
          ...where('Bonkopf_USt', r),
        );
    }
    for (const p of posVat.get(k) ?? []) {
      if (!seenKeys.has(p.UST_SCHLUESSEL) && grossOf(p, 'POS') !== 0) {
        c.error(
          'SUM_BON_LINES',
          `BON_ID ${bon.BON_ID}: Position mit Schlüssel ${p.UST_SCHLUESSEL} ohne Bonkopf_USt`,
          ...where('Bonpos_USt', p),
        );
      }
    }
    const payRows = pays.get(k) ?? [];
    if (payRows.length > 0) {
      const paySum = payRows.reduce(
        (s, r) => s + centsOf(r.BASISWAEH_BETRAG),
        0,
      );
      if (paySum !== total)
        c.error(
          'SUM_BON_PAYMENTS',
          `BON_ID ${bon.BON_ID}: Σ Bonkopf_Zahlarten ${paySum / 100} ≠ UMS_BRUTTO ${bon.UMS_BRUTTO}`,
          file,
          line,
        );
    } else if (total !== 0) {
      const level =
        bon.BON_TYP === 'Beleg' || bon.BON_TYP === 'AVTraining'
          ? 'error'
          : 'warning';
      c.add(
        level,
        'BON_NO_PAYMENT',
        `BON_ID ${bon.BON_ID}: keine Zahlart`,
        file,
        line,
      );
    }
    if (
      bon.BON_TYP !== 'Beleg' &&
      bon.BON_TYP !== 'AVTraining' &&
      payRows.some((r) => r.ZAHLART_TYP !== 'Keine')
    ) {
      c.error(
        'BON_AV_PAYMENT',
        `BON_ID ${bon.BON_ID}: ${bon.BON_TYP} erlaubt nur die Zahlart „Keine“ (Anhang B)`,
        file,
        line,
      );
    }

    // -- TSE
    const tse = tseRows.get(k) ?? [];
    if (tse.length === 0)
      c.error(
        'TSE_MISSING',
        `BON_ID ${bon.BON_ID}: keine Zeile in TSE_Transaktionen`,
        file,
        line,
      );
    for (const r of tse) {
      const [tf, tl] = where('TSE_Transaktionen', r);
      if (!(tses.get(zKey(r)) ?? []).some((x) => x.TSE_ID === r.TSE_ID))
        c.error('REF_TSE', `TSE_ID ${r.TSE_ID} fehlt in Stamm_TSE`, tf, tl);
      if (r.TSE_TA_FEHLER) continue;
      for (const f of [
        'TSE_TANR',
        'TSE_TA_START',
        'TSE_TA_ENDE',
        'TSE_TA_VORGANGSART',
        'TSE_TA_SIGZ',
        'TSE_TA_SIG',
      ]) {
        if (!r[f])
          c.error(
            'TSE_INCOMPLETE',
            `BON_ID ${bon.BON_ID}: ${f} fehlt (und kein TSE_TA_FEHLER)`,
            tf,
            tl,
          );
      }
      if (r.TSE_TA_START && r.TSE_TA_ENDE && r.TSE_TA_START > r.TSE_TA_ENDE)
        c.error(
          'TSE_TIME_ORDER',
          `BON_ID ${bon.BON_ID}: TSE_TA_START nach TSE_TA_ENDE`,
          tf,
          tl,
        );
      const pd = r.TSE_VORGANGSDATEN;
      if (!pd) continue;
      if (r.TSE_TA_VORGANGSART === 'Kassenbeleg-V1') {
        const parsed = parseKassenbeleg(pd);
        if (!parsed) {
          c.error(
            'TSE_PROCESS_DATA',
            `BON_ID ${bon.BON_ID}: TSE_VORGANGSDATEN ist kein gültiges Kassenbeleg-V1`,
            tf,
            tl,
          );
          continue;
        }
        if (parsed.type !== bon.BON_TYP)
          c.error(
            'TSE_BON_TYPE',
            `BON_ID ${bon.BON_ID}: Vorgangstyp ${parsed.type} ≠ BON_TYP ${bon.BON_TYP}`,
            tf,
            tl,
          );
        const slots = [0, 0, 0, 0, 0];
        for (const v of vatRows)
          slots[(SLOT_OF_KEY[Number(v.UST_SCHLUESSEL)] ?? 5) - 1] += centsOf(
            v.BON_BRUTTO,
          );
        if (slots.some((v, i) => v !== parsed.slots[i])) {
          c.error(
            'TSE_VAT_SLOTS',
            `BON_ID ${bon.BON_ID}: Brutto je Steuersatz (${parsed.slots.join('/')}) ≠ Bonkopf_USt (${slots.join('/')})`,
            tf,
            tl,
          );
        }
        const bar = parsed.payments
          .filter((p) => p.type === 'Bar')
          .reduce((s, p) => s + p.cents, 0);
        const unbar = parsed.payments
          .filter((p) => p.type === 'Unbar')
          .reduce((s, p) => s + p.cents, 0);
        const payBar = payRows
          .filter((p) => p.ZAHLART_TYP === 'Bar')
          .reduce((s, p) => s + centsOf(p.BASISWAEH_BETRAG), 0);
        const payUnbar = payRows
          .filter((p) => p.ZAHLART_TYP !== 'Bar' && p.ZAHLART_TYP !== 'Keine')
          .reduce((s, p) => s + centsOf(p.BASISWAEH_BETRAG), 0);
        if (bar !== payBar || unbar !== payUnbar) {
          c.error(
            'TSE_PAYMENTS',
            `BON_ID ${bon.BON_ID}: Zahlungen der TSE (Bar ${bar / 100}, Unbar ${unbar / 100}) ≠ Bonkopf_Zahlarten (${payBar / 100}/${payUnbar / 100})`,
            tf,
            tl,
          );
        }
      } else if (r.TSE_TA_VORGANGSART === 'Bestellung-V1') {
        const lines = parseBestellung(pd);
        if (!lines) {
          c.error(
            'TSE_PROCESS_DATA',
            `BON_ID ${bon.BON_ID}: TSE_VORGANGSDATEN ist kein gültiges Bestellung-V1`,
            tf,
            tl,
          );
          continue;
        }
        const sum = lines.reduce(
          (s, l) => s + Math.round(l.quantity * l.unitCents),
          0,
        );
        if (sum !== total)
          c.error(
            'TSE_ORDER_SUM',
            `BON_ID ${bon.BON_ID}: Σ Bestellung ${sum / 100} ≠ UMS_BRUTTO ${bon.UMS_BRUTTO}`,
            tf,
            tl,
          );
      }
    }
  }
  const signedTa = new Set<string>();
  for (const r of t.TSE_Transaktionen) {
    if (r.TSE_TA_FEHLER || !r.TSE_TANR) continue;
    const k = `${zKey(r)}|${r.TSE_ID}|${r.TSE_TANR}|${r.TSE_TA_SIGZ}`;
    if (signedTa.has(k))
      c.error(
        'TSE_DUPLICATE',
        `TSE-Transaktion ${r.TSE_TANR} doppelt`,
        ...where('TSE_Transaktionen', r),
      );
    signedTa.add(k);
  }

  // -- Positionen
  for (const [k, pos] of positions) {
    const [file, line] = where('Bonpos', pos);
    const rows = posVatByPos.get(k) ?? [];
    if (rows.length === 0)
      c.error(
        'POS_NO_VAT',
        `Position ${pos.BON_ID}/${pos.POS_ZEILE} ohne Bonpos_USt`,
        file,
        line,
      );
    for (const r of rows) {
      if (
        r.POS_BRUTTO &&
        r.POS_NETTO &&
        r.POS_UST &&
        centsOf(r.POS_NETTO) + centsOf(r.POS_UST) !== centsOf(r.POS_BRUTTO)
      ) {
        c.error(
          'SUM_NET_VAT',
          `Position ${pos.BON_ID}/${pos.POS_ZEILE}: Netto + USt ≠ Brutto`,
          ...where('Bonpos_USt', r),
        );
      }
    }
    const gross = rows.reduce((s, r) => s + grossOf(r, 'POS'), 0);
    const qty = parseFixed(pos.MENGE);
    const unit = parseFixed(pos.STK_BR || '0');
    const factor = parseFixed(pos.FAKTOR || '1,000') || 100000;
    if (qty !== null && unit !== null && pos.STK_BR) {
      const expected = Math.round(((qty / factor) * unit) / 1000);
      if (
        Math.abs(expected - gross) >
        1 + Math.ceil(Math.abs(qty) / 100000 / 2)
      ) {
        c.warn(
          'POS_PRICE',
          `Position ${pos.BON_ID}/${pos.POS_ZEILE}: MENGE × STK_BR ≠ POS_BRUTTO`,
          file,
          line,
        );
      }
    }
    const prices = priceByPos.get(k) ?? [];
    if (prices.length > 0) {
      const sum = prices.reduce((s, r) => s + grossOf(r, 'PF'), 0);
      if (sum !== gross)
        c.error(
          'SUM_PRICE',
          `Position ${pos.BON_ID}/${pos.POS_ZEILE}: Σ Bonpos_Preisfindung ≠ POS_BRUTTO`,
          file,
          line,
        );
    }
  }

  // -- Kassenabschluss
  const belegKeys = new Set(
    [...bons.values()].filter((b) => b.BON_TYP === 'Beleg').map(bonKey),
  );
  const bonsPerClosing = groupBy([...bons.values()], zKey);
  const gvPerClosing = perClosing('Z_GV_Typ');
  const zPayPerClosing = perClosing('Z_Zahlart');
  const currencyPerClosing = perClosing('Z_Waehrungen');
  for (const [k, closing] of closings) {
    const [file, line] = where('Stamm_Abschluss', closing);
    const closingBons = bonsPerClosing.get(k) ?? [];
    const expectedGv = new Map<string, { g: number; n: number; v: number }>();
    for (const p of t.Bonpos) {
      if (zKey(p) !== k || !belegKeys.has(bonKey(p))) continue;
      for (const r of posVatByPos.get(posKey(p)) ?? []) {
        const gk = `${p.GV_TYP}|${p.GV_NAME}|${p.AGENTUR_ID || '0'}|${r.UST_SCHLUESSEL}`;
        const s = expectedGv.get(gk) ?? { g: 0, n: 0, v: 0 };
        s.g += grossOf(r, 'POS');
        s.n += centsOf(r.POS_NETTO);
        s.v += centsOf(r.POS_UST);
        expectedGv.set(gk, s);
      }
    }
    const seenGv = new Set<string>();
    for (const r of gvPerClosing.get(k) ?? []) {
      const gk = `${r.GV_TYP}|${r.GV_NAME}|${r.AGENTUR_ID || '0'}|${r.UST_SCHLUESSEL}`;
      if (seenGv.has(gk))
        c.error(
          'Z_GV_DUPLICATE',
          `Z_GV_Typ ${gk} doppelt`,
          ...where('Z_GV_Typ', r),
        );
      seenGv.add(gk);
      const s = expectedGv.get(gk) ?? { g: 0, n: 0, v: 0 };
      if (centsOf(r.Z_UMS_BRUTTO) !== s.g)
        c.error(
          'SUM_Z_GV',
          `Abschluss ${closing.Z_NR}: Z_GV_Typ ${r.GV_TYP}/${r.UST_SCHLUESSEL} ${r.Z_UMS_BRUTTO} ≠ Σ Belege ${s.g / 100}`,
          ...where('Z_GV_Typ', r),
        );
      if (
        Math.abs(centsOf(r.Z_UMS_NETTO) - s.n) > 1 ||
        Math.abs(centsOf(r.Z_UST) - s.v) > 1
      ) {
        c.warn(
          'SUM_Z_GV_NET',
          `Abschluss ${closing.Z_NR}: Netto/USt von ${r.GV_TYP}/${r.UST_SCHLUESSEL} weicht von Σ Positionen ab`,
          ...where('Z_GV_Typ', r),
        );
      }
    }
    for (const [gk, s] of expectedGv) {
      if (!seenGv.has(gk) && s.g !== 0)
        c.error(
          'SUM_Z_GV_MISSING',
          `Abschluss ${closing.Z_NR}: Z_GV_Typ ${gk} fehlt (${s.g / 100})`,
          file,
          line,
        );
    }
    const expectedPay = new Map<string, number>();
    for (const r of t.Bonkopf_Zahlarten) {
      if (zKey(r) !== k || !belegKeys.has(bonKey(r))) continue;
      const pk = `${r.ZAHLART_TYP}|${r.ZAHLART_NAME}`;
      expectedPay.set(
        pk,
        (expectedPay.get(pk) ?? 0) + centsOf(r.BASISWAEH_BETRAG),
      );
    }
    const zPays = zPayPerClosing.get(k) ?? [];
    const seenPay = new Set<string>();
    for (const r of zPays) {
      const pk = `${r.ZAHLART_TYP}|${r.ZAHLART_NAME}`;
      seenPay.add(pk);
      if (centsOf(r.Z_ZAHLART_BETRAG) !== (expectedPay.get(pk) ?? 0)) {
        c.error(
          'SUM_Z_PAYMENT',
          `Abschluss ${closing.Z_NR}: Z_Zahlart ${pk} ${r.Z_ZAHLART_BETRAG} ≠ Σ Belege ${(expectedPay.get(pk) ?? 0) / 100}`,
          ...where('Z_Zahlart', r),
        );
      }
    }
    for (const [pk, v] of expectedPay) {
      if (!seenPay.has(pk) && v !== 0)
        c.error(
          'SUM_Z_PAYMENT_MISSING',
          `Abschluss ${closing.Z_NR}: Z_Zahlart ${pk} fehlt`,
          file,
          line,
        );
    }
    const zTotal = zPays.reduce((s, r) => s + centsOf(r.Z_ZAHLART_BETRAG), 0);
    const zCash = zPays
      .filter((r) => r.ZAHLART_TYP === 'Bar')
      .reduce((s, r) => s + centsOf(r.Z_ZAHLART_BETRAG), 0);
    if (centsOf(closing.Z_SE_ZAHLUNGEN) !== zTotal)
      c.error(
        'SUM_Z_SE',
        `Abschluss ${closing.Z_NR}: Z_SE_ZAHLUNGEN ≠ Σ Z_Zahlart`,
        file,
        line,
      );
    if (centsOf(closing.Z_SE_BARZAHLUNGEN) !== zCash)
      c.error(
        'SUM_Z_SE_CASH',
        `Abschluss ${closing.Z_NR}: Z_SE_BARZAHLUNGEN ≠ Σ Z_Zahlart Bar`,
        file,
        line,
      );
    const base = (kassen.get(k) ?? [])[0]?.KASSE_BASISWAEH_CODE || 'EUR';
    const currencies = currencyPerClosing.get(k) ?? [];
    const baseRow = currencies.find((r) => r.ZAHLART_WAEH === base);
    if (
      currencies.length <= 1 &&
      centsOf(baseRow?.ZAHLART_BETRAG_WAEH) !== zCash
    ) {
      c.error(
        'SUM_Z_CURRENCY',
        `Abschluss ${closing.Z_NR}: Z_Waehrungen ${base} ≠ Barzahlungen`,
        'cash_per_currency.csv',
      );
    }
    const numeric = closingBons
      .map((b) => Number(b.BON_ID))
      .filter((n) => Number.isInteger(n));
    if (numeric.length === closingBons.length && numeric.length > 0) {
      const min = String(Math.min(...numeric));
      const max = String(Math.max(...numeric));
      if (closing.Z_START_ID !== min || closing.Z_ENDE_ID !== max) {
        c.error(
          'Z_START_END',
          `Abschluss ${closing.Z_NR}: Z_START_ID/Z_ENDE_ID (${closing.Z_START_ID}/${closing.Z_ENDE_ID}) ≠ erste/letzte BON_ID (${min}/${max})`,
          file,
          line,
        );
      }
    } else if (
      closingBons.length === 0 &&
      (closing.Z_START_ID || closing.Z_ENDE_ID)
    ) {
      c.warn(
        'Z_START_END',
        `Abschluss ${closing.Z_NR}: ohne Vorgänge, aber Z_START_ID/Z_ENDE_ID gesetzt`,
        file,
        line,
      );
    }
  }

  // -- Folgen
  for (const [kasse, list] of groupBy(
    [...closings.values()],
    (r) => r.Z_KASSE_ID,
  )) {
    const sorted = list
      .map((r) => ({ nr: Number(r.Z_NR), at: Date.parse(r.Z_ERSTELLUNG) }))
      .sort((a, b) => a.nr - b.nr);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].nr !== sorted[i - 1].nr + 1)
        c.error(
          'Z_NR_GAP',
          `Kasse ${kasse}: Z_NR springt von ${sorted[i - 1].nr} auf ${sorted[i].nr}`,
          'cashpointclosing.csv',
        );
      if (sorted[i].at < sorted[i - 1].at)
        c.warn(
          'Z_NR_TIME',
          `Kasse ${kasse}: Abschluss ${sorted[i].nr} älter als ${sorted[i - 1].nr}`,
          'cashpointclosing.csv',
        );
    }
    const ids = [...(bonIdsPerKasse.get(kasse)?.keys() ?? [])];
    const numeric = ids.map(Number);
    if (numeric.some((n) => !Number.isInteger(n))) {
      c.warn(
        'BON_ID_NOT_NUMERIC',
        `Kasse ${kasse}: BON_ID nicht numerisch, Lückenprüfung entfällt`,
        'transactions.csv',
      );
      continue;
    }
    numeric.sort((a, b) => a - b);
    for (let i = 1; i < numeric.length; i++) {
      if (numeric[i] !== numeric[i - 1] + 1)
        c.error(
          'BON_ID_GAP',
          `Kasse ${kasse}: BON_ID springt von ${numeric[i - 1]} auf ${numeric[i]}`,
          'transactions.csv',
        );
    }
  }

  return {
    closings: closings.size,
    transactions: bons.size,
    lines: positions.size,
    tseTransactions: t.TSE_Transaktionen.length,
    tseFailures: t.TSE_Transaktionen.filter((r) => r.TSE_TA_FEHLER).length,
    rowsPerFile: Object.fromEntries(
      DSFINVK_TABLES.map((d) => [d.file, t[d.name].length]),
    ),
  };
}

/** Prueft die Dateien eines Exports. */
export function validateFiles(entries: ZipEntry[]): ValidationResult {
  const c = new Collector();
  const files = new Map(
    entries.map((e) => [e.name.replace(/^.*\//, ''), e.data]),
  );
  const index = files.get(INDEX_FILE);
  if (!index) c.error('FILE_MISSING', 'index.xml fehlt');
  else checkIndex(index.toString('utf8'), c);
  const dtd = files.get(DTD_FILE);
  if (!dtd) c.error('FILE_MISSING', `${DTD_FILE} fehlt`);
  else if (!dtd.equals(officialTemplates().dtd))
    c.warn('DTD_CHANGED', `${DTD_FILE} weicht von der amtlichen Fassung ab`);

  const tables = {} as Record<TableName, Rec[]>;
  for (const def of DSFINVK_TABLES) {
    const data = files.get(def.file);
    if (!data) {
      c.error('FILE_MISSING', `${def.file} (${def.name}) fehlt`);
      tables[def.name] = [];
      continue;
    }
    tables[def.name] = checkTable(def, data, c);
  }
  for (const name of files.keys()) {
    if (
      name !== INDEX_FILE &&
      name !== DTD_FILE &&
      !DSFINVK_TABLES.some((d) => d.file === name)
    ) {
      c.warn('FILE_EXTRA', `Zusätzliche Datei ${name}`);
    }
  }
  const stats = checkContent({ tables }, c);
  return {
    ok: c.errors.length === 0,
    errors: c.errors,
    warnings: c.warnings,
    stats,
  };
}

export function validateZip(buffer: Buffer): ValidationResult {
  try {
    return validateFiles(readZip(buffer));
  } catch (error) {
    return {
      ok: false,
      errors: [
        { level: 'error', code: 'ZIP', message: (error as Error).message },
      ],
      warnings: [],
      stats: {
        closings: 0,
        transactions: 0,
        lines: 0,
        tseTransactions: 0,
        tseFailures: 0,
        rowsPerFile: {},
      },
    };
  }
}
