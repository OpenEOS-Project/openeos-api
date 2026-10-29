import { POS_ICON_INDEX } from './pos-icon-index';

/**
 * Icon-Vorschlag, Stufe 1: ohne Modell. Produktnamen werden normalisiert
 * und gegen Namen und Suchbegriffe der Icons aus `@openeos/pos-icons`
 * verglichen (Wortabdeckung, dann Trigramm-Jaccard als Rueckfall).
 *
 * Die Liste liegt als schlanker Index im Repo (`pos-icon-index.ts`,
 * erneuern mit `pnpm icons:sync`).
 */
export interface IconIndexEntry {
  id: string;
  terms: string[];
}

export interface IconMatch {
  /** Vollstaendige Referenz, wie sie am Produkt gespeichert wird. */
  icon: string;
  score: number;
}

/** Begriffe, die nur die Art beschreiben und zu allem passen wuerden. */
const STOPWORDS = new Set([
  'food',
  'drink',
  'essen',
  'trinken',
  'getraenk',
  'getraenke',
  'mit',
  'und',
  'with',
  'and',
  'gross',
  'klein',
  'l',
  'ml',
  'cl',
]);

export const ICON_PREFIX = 'pos-icon:';

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter((token) => token && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

interface PreparedTerm {
  text: string;
  tokens: string[];
  grams: Set<string>;
}

interface PreparedEntry {
  id: string;
  terms: PreparedTerm[];
}

function prepare(entries: IconIndexEntry[]): PreparedEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    terms: [entry.id, ...entry.terms]
      .map((term) => {
        const text = normalize(term);
        return { text, tokens: tokens(term), grams: trigrams(text) };
      })
      .filter((term) => term.tokens.length > 0),
  }));
}

/**
 * Aehnlichkeit eines Produktnamens zu einem Suchbegriff (0..1).
 *
 * - gleicher Text: 1
 * - alle Begriffs-Woerter kommen im Namen vor: 0.5 + 0.5 × Anteil der
 *   abgedeckten Namens-Woerter („Currywurst mit Pommes“ ↔ „currywurst
 *   pommes“ schlaegt „currywurst“)
 * - sonst Trigramm-Jaccard (faengt Komposita wie „Rotweinschorle“)
 */
export function termScore(
  nameTokens: string[],
  nameText: string,
  term: PreparedTerm,
): number {
  if (nameText === term.text) return 1;
  if (nameTokens.length === 0) return 0;
  const nameSet = new Set(nameTokens);
  const covered = term.tokens.filter((token) => nameSet.has(token)).length;
  if (covered === term.tokens.length) {
    return 0.5 + 0.5 * (covered / nameTokens.length);
  }
  // Teilweise Wortabdeckung ("Pommes rot-weiss" ↔ "pommes frites"): die
  // gedeckten Woerter zaehlen anteilig, aber unter einer vollen Abdeckung.
  const partial =
    covered > 0
      ? 0.45 * (covered / term.tokens.length) * (covered / nameTokens.length) +
        0.2
      : 0;
  const gram = jaccard(trigrams(nameText), term.grams);
  return Math.max(partial, gram);
}

export class IconIndex {
  private readonly entries: PreparedEntry[];

  constructor(entries: IconIndexEntry[] = POS_ICON_INDEX.icons) {
    this.entries = prepare(entries);
  }

  get version(): string {
    return POS_ICON_INDEX.version;
  }

  ids(): string[] {
    return this.entries.map((entry) => entry.id);
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id);
  }

  /** Beste Treffer fuer einen Namen, absteigend nach Score. */
  match(name: string, limit = 3, minScore = 0.2): IconMatch[] {
    const nameText = normalize(name);
    const nameTokens = tokens(name);
    const scored = this.entries.map((entry) => ({
      id: entry.id,
      score: entry.terms.reduce(
        (best, term) => Math.max(best, termScore(nameTokens, nameText, term)),
        0,
      ),
    }));
    return scored
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((entry) => ({
        icon: `${ICON_PREFIX}${entry.id}`,
        score: Math.round(entry.score * 100) / 100,
      }));
  }
}
