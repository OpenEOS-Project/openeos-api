import type { ProductOptions, ProductOptionGroup } from '../../database/entities/product.entity';

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
  options: ProductOptions;
  /** pos-icon-database icon id (stored as imageUrl `pos-icon:<id>`), or null. */
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

/** `Sauce: Ketchup | Mayo || Brot: Weiß | Körner` -> single-choice groups. */
function parseChoices(cell: string): ProductOptionGroup[] {
  const groups: ProductOptionGroup[] = [];
  for (const chunk of cell.split('||')) {
    const part = chunk.trim();
    if (!part) continue;
    const sep = part.indexOf(':');
    if (sep === -1) continue;
    const groupName = part.slice(0, sep).trim();
    const optionNames = part
      .slice(sep + 1)
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!groupName || optionNames.length === 0) continue;
    groups.push({
      name: groupName,
      type: 'single',
      required: true,
      options: optionNames.map((name, idx) => ({
        name,
        priceModifier: 0,
        default: idx === 0,
      })),
    });
  }
  return groups;
}

/** `Käse +0.50 | Bacon +1.00` -> one multiple-choice "Extras" group. */
function parseExtras(cell: string): ProductOptionGroup | null {
  const options = cell
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^(.*?)(?:\s*\+\s*([0-9.,]+))?\s*$/);
      const name = (m?.[1] ?? entry).trim();
      const priceModifier = m?.[2] ? parseNumber(m[2]) ?? 0 : 0;
      return { name, priceModifier };
    })
    .filter((o) => o.name.length > 0);
  if (options.length === 0) return null;
  return { name: 'Extras', type: 'multiple', required: false, options };
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

  const header = raw[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? '');
  if (!header.includes('name') || !header.includes('price')) {
    return {
      rows: [],
      fatalError:
        'Pflichtspalten fehlen: Die Kopfzeile muss mindestens "name" und "price" (bzw. "Preis") enthalten.',
    };
  }

  const col = (cells: string[], key: string): string => {
    const idx = header.indexOf(key);
    return idx === -1 ? '' : (cells[idx] ?? '').trim();
  };

  const rows: ParsedProductRow[] = [];
  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i];
    const line = i + 1;
    const name = col(cells, 'name');
    const category = col(cells, 'category');
    const price = parseNumber(col(cells, 'price'));
    const pfand = parseNumber(col(cells, 'pfand'));

    const groups: ProductOptionGroup[] = [];
    const ing = parseIngredients(col(cells, 'ingredients'));
    if (ing) groups.push(ing);
    groups.push(...parseChoices(col(cells, 'choices')));
    const extras = parseExtras(col(cells, 'extras'));
    if (extras) groups.push(extras);

    let error: string | null = null;
    if (!name) error = 'Name fehlt';
    else if (!category) error = 'Kategorie fehlt';
    else if (price === null) error = 'Ungültiger oder fehlender Preis';
    else if (price < 0) error = 'Preis darf nicht negativ sein';
    else if (pfand !== null && pfand < 0) error = 'Pfand darf nicht negativ sein';

    rows.push({
      line,
      category,
      name,
      description: col(cells, 'description') || null,
      price: price ?? 0,
      pfand: pfand !== null && pfand > 0 ? Math.round(pfand * 100) / 100 : null,
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
