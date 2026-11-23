import type {
  ProductOption,
  ProductOptions,
  ProductOptionGroup,
} from '../../database/entities/product.entity';

/**
 * Parsed representation of one CSV product row, before category/pfand
 * resolution. Field names mirror the documented CSV columns.
 */
export interface ParsedProductRow {
  /** 1-based source line (header is line 1) for error reporting. */
  line: number;
  category: string;
  name: string;
  description: string | null;
  price: number;
  /** Deposit amount in EUR, or null when the column was empty. */
  pfand: number | null;
  /** VAT rate in percent, or null when the column was missing/empty. */
  taxRate: number | null;
  options: ProductOptions;
  /**
   * pos-icon-database icon id (stored as imageUrl `pos-icon:<id>`), or a
   * line icon `oe:<name>` (stored in `icon`), or null.
   */
  iconId: string | null;
  isAvailable: boolean;
  trackInventory: boolean;
  stockQuantity: number;
  sortOrder: number | null;
  /** Non-empty when the row could not be parsed into a valid product. */
  error: string | null;
}

// Accept German and English header names; map to canonical keys.
const HEADER_ALIASES: Record<string, string> = {
  category: 'category',
  kategorie: 'category',
  name: 'name',
  produkt: 'name',
  description: 'description',
  beschreibung: 'description',
  price: 'price',
  preis: 'price',
  pfand: 'pfand',
  deposit: 'pfand',
  taxrate: 'taxRate',
  steuersatz: 'taxRate',
  mwst: 'taxRate',
  ust: 'taxRate',
  vat: 'taxRate',
  icon: 'icon',
  symbol: 'icon',
  bild: 'icon',
  ingredients: 'ingredients',
  zutaten: 'ingredients',
  choices: 'choices',
  auswahl: 'choices',
  extras: 'extras',
  available: 'available',
  verfuegbar: 'available',
  verfügbar: 'available',
  trackinventory: 'trackInventory',
  lager: 'trackInventory',
  stockquantity: 'stockQuantity',
  bestand: 'stockQuantity',
  sortorder: 'sortOrder',
  reihenfolge: 'sortOrder',
};

/** RFC-4180-ish parser supporting quotes, escaped quotes and CRLF. */
function parseCsvRows(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  // Strip a leading UTF-8 BOM Excel likes to add.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // handled by the \n branch (skip lone CR)
    } else {
      field += c;
    }
  }
  // Flush trailing field/row when the file has no final newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Detect , vs ; by counting occurrences in the header line. */
function detectDelimiter(input: string): string {
  const firstLine = input.split(/\r?\n/, 1)[0] ?? '';
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

function parseNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/[€\s]/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseBool(raw: string, fallback: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'ja', 'yes', 'wahr', 'x'].includes(v);
}

/** `A | B | C` -> a single removable-ingredients group named "Zutaten". */
function parseIngredients(cell: string): ProductOptionGroup | null {
  const names = cell
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  return {
    name: 'Zutaten',
    type: 'ingredients',
    required: false,
    options: names.map((name) => ({ name, priceModifier: 0 })),
  };
}

/** `*Käse +0,50` -> name, surcharge (or `-0,50`) and the default mark `*`. */
function parseOptionEntry(entry: string): {
  name: string;
  priceModifier: number;
  isDefault: boolean;
} {
  const marked = entry.startsWith('*');
  const text = marked ? entry.slice(1).trim() : entry;
  const m = text.match(/^(.*?\S)\s*([+-])\s*(\d+(?:[.,]\d{1,2})?)$/);
  // `-` nur mit Leerzeichen davor und Betrag mit Nachkommastellen — „Cola 0-5“
  // oder „Größe XS-40“ sind Namen.
  const negativeOk = m?.[2] === '+' || /\s-\s*\d+[.,]\d{2}$/.test(text);
  if (m && negativeOk) {
    const amount = parseNumber(m[3]) ?? 0;
    return {
      name: m[1].trim(),
      priceModifier: m[2] === '-' ? -amount : amount,
      isDefault: marked,
    };
  }
  return { name: text, priceModifier: 0, isDefault: marked };
}

function parseEntries(cell: string) {
  return cell
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseOptionEntry)
    .filter((o) => o.name.length > 0);
}

/**
 * `Sauce: Ketchup | Mayo +0,50 || Brot?: Weiß | *Körner` -> single-choice
 * groups. `?` after the group name makes it optional, `*` marks the default
 * (otherwise the first option).
 */
function parseChoices(cell: string): ProductOptionGroup[] {
  const groups: ProductOptionGroup[] = [];
  for (const chunk of cell.split('||')) {
    const part = chunk.trim();
    if (!part) continue;
    const sep = part.indexOf(':');
    if (sep === -1) continue;
    const rawName = part.slice(0, sep).trim();
    const optional = rawName.endsWith('?');
    const groupName = optional ? rawName.slice(0, -1).trim() : rawName;
    const entries = parseEntries(part.slice(sep + 1));
    if (!groupName || entries.length === 0) continue;
    const marked = entries.findIndex((e) => e.isDefault);
    // Ohne Markierung ist die erste Option einer Pflichtauswahl vorgewaehlt.
    const defaultIndex = marked >= 0 ? marked : optional ? -1 : 0;
    groups.push({
      name: groupName,
      type: 'single',
      required: !optional,
      options: entries.map(({ name, priceModifier }, idx) => ({
        name,
        priceModifier,
        default: idx === defaultIndex,
      })),
    });
  }
  return groups;
}

/**
 * `Käse +0.50 | Bacon +1.00` -> one multiple-choice "Extras" group. With
 * several groups: `Saucen: Mayo | Senf || Beilage!: Pommes +2,00 | Salat`
 * (`!` = required).
 */
function parseExtras(cell: string): ProductOptionGroup[] {
  const groups: ProductOptionGroup[] = [];
  for (const chunk of cell.split('||')) {
    const first = chunk.split('|', 1)[0];
    const sep = first.indexOf(':');
    const rawName = sep > 0 ? first.slice(0, sep).trim() : 'Extras';
    const required = rawName.endsWith('!');
    const name = (required ? rawName.slice(0, -1).trim() : rawName) || 'Extras';
    const entries = parseEntries(sep > 0 ? chunk.slice(sep + 1) : chunk);
    if (entries.length === 0) continue;
    groups.push({
      name,
      type: 'multiple',
      required,
      options: entries.map((e) => ({
        name: e.name,
        priceModifier: e.priceModifier,
        ...(e.isDefault ? { default: true } : {}),
      })),
    });
  }
  return groups;
}

export interface CsvParseResult {
  rows: ParsedProductRow[];
  /** File-level errors (no header, unknown columns) — block the whole import. */
  fatalError: string | null;
}

/** Parse a product-import CSV into validated rows. Never throws. */
export function parseProductCsv(csv: string): CsvParseResult {
  if (!csv || !csv.trim()) {
    return { rows: [], fatalError: 'Die Datei ist leer.' };
  }

  const delimiter = detectDelimiter(csv);
  const raw = parseCsvRows(csv, delimiter).filter(
    (r) => r.some((c) => c.trim() !== ''), // drop blank lines
  );
  if (raw.length === 0) {
    return { rows: [], fatalError: 'Die Datei enthält keine Daten.' };
  }

  const header = raw[0].map(
    (h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? '',
  );
  if (!header.includes('name') || !header.includes('price')) {
    return {
      rows: [],
      fatalError:
        'Pflichtspalten fehlen: Die Kopfzeile muss mindestens "name" und "price" (bzw. "Preis") enthalten.',
    };
  }

  const col = (cells: string[], key: string): string => {
    const idx = header.indexOf(key);
    const value = idx === -1 ? '' : (cells[idx] ?? '').trim();
    // Schutz-Apostroph des Exports (quoteField) wieder entfernen.
    return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
  };

  const rows: ParsedProductRow[] = [];
  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i];
    const line = i + 1;
    const name = col(cells, 'name');
    const category = col(cells, 'category');
    const price = parseNumber(col(cells, 'price'));
    const pfand = parseNumber(col(cells, 'pfand'));
    const taxRate = parseNumber(col(cells, 'taxRate').replace('%', ''));

    const groups: ProductOptionGroup[] = [];
    const ing = parseIngredients(col(cells, 'ingredients'));
    if (ing) groups.push(ing);
    groups.push(...parseChoices(col(cells, 'choices')));
    groups.push(...parseExtras(col(cells, 'extras')));

    let error: string | null = null;
    if (!name) error = 'Name fehlt';
    else if (!category) error = 'Kategorie fehlt';
    else if (price === null) error = 'Ungültiger oder fehlender Preis';
    else if (price < 0) error = 'Preis darf nicht negativ sein';
    else if (pfand !== null && pfand < 0)
      error = 'Pfand darf nicht negativ sein';
    else if (taxRate !== null && (taxRate < 0 || taxRate > 100))
      error = 'Ungültiger Steuersatz';

    rows.push({
      line,
      category,
      name,
      description: col(cells, 'description') || null,
      price: price ?? 0,
      pfand: pfand !== null && pfand > 0 ? Math.round(pfand * 100) / 100 : null,
      taxRate,
      options: { groups },
      iconId: col(cells, 'icon').trim() || null,
      isAvailable: parseBool(col(cells, 'available'), true),
      trackInventory: parseBool(col(cells, 'trackInventory'), false),
      stockQuantity: parseNumber(col(cells, 'stockQuantity')) ?? 0,
      sortOrder: parseNumber(col(cells, 'sortOrder')),
      error,
    });
  }

  return { rows, fatalError: null };
}

// ---------------------------------------------------------------- Export

/** Spalten des Exports — genau die, die `parseProductCsv` liest. */
export const PRODUCT_CSV_EXPORT_COLUMNS = [
  'category',
  'name',
  'description',
  'price',
  'taxRate',
  'pfand',
  'icon',
  'ingredients',
  'choices',
  'extras',
  'available',
  'trackInventory',
  'stockQuantity',
  'sortOrder',
] as const;

export interface ProductCsvExportRow {
  category: string;
  name: string;
  description: string | null;
  price: number;
  taxRate: number | null;
  /** Pfandbetrag in Euro (Pfandart der Organisation), sonst null. */
  pfand: number | null;
  imageUrl: string | null;
  icon: string | null;
  options: ProductOptions | null;
  isAvailable: boolean;
  trackInventory: boolean;
  stockQuantity: number;
  sortOrder: number;
}

/** Dezimalkomma wie Excel (de-DE); der Import liest Punkt und Komma. */
function formatDecimal(value: number): string {
  const n = Number(value) || 0;
  return (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');
}

function formatRate(value: number): string {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

/** Feld quoten, wenn es Trenner, Anfuehrungszeichen oder Umbrueche enthaelt. */
function quoteField(value: string, delimiter: string): string {
  // Formeln in Excel nicht ausfuehren lassen (CSV-Injection).
  const safe =
    /^[=+\-@\t\r]/.test(value) && !/^-?[0-9]/.test(value) ? `'${value}` : value;
  return safe.includes(delimiter) ||
    safe.includes('"') ||
    safe.includes('\n') ||
    safe.includes('\r')
    ? `"${safe.replace(/"/g, '""')}"`
    : safe;
}

/** Optionsnamen duerfen die Trenner der Zellen nicht enthalten. */
function cleanOptionName(name: string): string {
  return name.replace(/\|/g, '/').replace(/:/g, ' ').replace(/^\*+/, '').trim();
}

function optionCell(option: ProductOption, markDefault: boolean): string {
  const modifier = Number(option.priceModifier) || 0;
  const amount =
    modifier === 0
      ? ''
      : ` ${modifier < 0 ? '-' : '+'}${formatDecimal(Math.abs(modifier))}`;
  return `${markDefault ? '*' : ''}${cleanOptionName(option.name)}${amount}`;
}

/**
 * Optionen in die drei Spalten des Imports: Zutaten (abwaehlbar, eine
 * Gruppe), Auswahl (je Gruppe eine Wahl) und Extras (Mehrfachwahl).
 */
function optionColumns(options: ProductOptions | null): {
  ingredients: string;
  choices: string;
  extras: string;
} {
  const groups = (options?.groups ?? []).filter((g) => g.options.length > 0);
  const ingredients = groups
    .filter((g) => g.type === 'ingredients')
    .flatMap((g) => g.options.map((o) => cleanOptionName(o.name)))
    .filter(Boolean)
    .join(' | ');
  const choices = groups
    .filter((g) => g.type === 'single')
    .map((g) => {
      const chosen = g.options.findIndex((o) => o.default);
      // Die erste Option einer Pflichtauswahl braucht keine Markierung.
      const implicit = g.required && chosen <= 0;
      return `${cleanOptionName(g.name)}${g.required ? '' : '?'}: ${g.options
        .map((o, i) => optionCell(o, !implicit && i === chosen))
        .join(' | ')}`;
    })
    .join(' || ');
  const multiple = groups.filter((g) => g.type === 'multiple');
  const plain =
    multiple.length === 1 &&
    multiple[0].name === 'Extras' &&
    !multiple[0].required;
  const extras = multiple
    .map((g) => {
      const cells = g.options
        .map((o) => optionCell(o, !!o.default))
        .join(' | ');
      return plain
        ? cells
        : `${cleanOptionName(g.name)}${g.required ? '!' : ''}: ${cells}`;
    })
    .join(' || ');
  return { ingredients, choices, extras };
}

/** Symbol fuer die Spalte `icon`: pos-icon-ID oder `oe:<name>`. */
function iconCell(imageUrl: string | null, icon: string | null): string {
  if (imageUrl?.startsWith('pos-icon:')) return imageUrl.slice(9);
  if (icon?.startsWith('oe:')) return icon;
  return '';
}

/**
 * Produkte als CSV, die der Import unveraendert wieder liest: Semikolon,
 * UTF-8 mit BOM, Dezimalkomma, CRLF — passend fuer Excel (de-DE).
 */
export function serializeProductCsv(rows: ProductCsvExportRow[]): string {
  const delimiter = ';';
  const lines: string[] = [PRODUCT_CSV_EXPORT_COLUMNS.join(delimiter)];
  for (const row of rows) {
    const options = optionColumns(row.options);
    const cells: Record<(typeof PRODUCT_CSV_EXPORT_COLUMNS)[number], string> = {
      category: row.category,
      name: row.name,
      description: (row.description ?? '').replace(/\r?\n/g, ' '),
      price: formatDecimal(row.price),
      taxRate: row.taxRate === null ? '' : formatRate(row.taxRate),
      pfand: row.pfand ? formatDecimal(row.pfand) : '',
      icon: iconCell(row.imageUrl, row.icon),
      ingredients: options.ingredients,
      choices: options.choices,
      extras: options.extras,
      available: row.isAvailable ? 'ja' : 'nein',
      trackInventory: row.trackInventory ? 'ja' : 'nein',
      stockQuantity: String(row.stockQuantity ?? 0),
      sortOrder: String(row.sortOrder ?? 0),
    };
    lines.push(
      PRODUCT_CSV_EXPORT_COLUMNS.map((key) =>
        quoteField(cells[key], delimiter),
      ).join(delimiter),
    );
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}
