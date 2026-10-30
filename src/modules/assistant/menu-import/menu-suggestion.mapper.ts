import {
  MenuSuggestion,
  MenuSuggestionCategory,
  MenuSuggestionProduct,
  MenuSuggestionVariant,
} from '../../../database/entities/menu-import.entity';
import { normalize } from '../icons/icon-index';
import { RawMenuExtraction } from './menu-extraction.schema';

export interface ExistingCategory {
  id: string;
  name: string;
}

export interface ExistingProduct {
  id: string;
  name: string;
}

export interface MapperInput {
  extraction: RawMenuExtraction;
  existingCategories: ExistingCategory[];
  existingProducts: ExistingProduct[];
  /** Steuerbefreite Organisation: alle Saetze werden 0. */
  vatExempt: boolean;
}

export const FALLBACK_CATEGORY_NAME = 'Sonstiges';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clean(
  value: string | null | undefined,
  max: number,
): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

function mapVariants(
  raw: RawMenuExtraction['products'][number]['variants'],
): MenuSuggestionVariant[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const seen = new Set<string>();
  const variants: MenuSuggestionVariant[] = [];
  for (const variant of raw) {
    const name = clean(variant.name, 100);
    if (!name) continue;
    const key = normalize(name);
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({ name, priceModifier: round2(variant.priceModifier) });
  }
  if (variants.length === 0) return undefined;
  // Die guenstigste Variante ist die Basis: ihr Aufpreis wird 0, der
  // Grundpreis uebernimmt die Differenz (siehe mapExtraction).
  return variants;
}

/**
 * Macht aus der geprueften Modellantwort den Vorschlag fuer die Web-App:
 * stabile Schluessel, Kategorien dedupliziert und gegen den Bestand
 * abgeglichen, Produkte mit „bereits vorhanden“-Markierung.
 *
 * Reine Funktion — keine Datenbank, kein Modell. Icon-Vorschlaege haengt
 * der Worker danach an.
 */
export function mapExtraction(input: MapperInput): MenuSuggestion {
  const warnings = [...input.extraction.warnings];
  const existingCategoryByName = new Map(
    input.existingCategories.map((category) => [
      normalize(category.name),
      category,
    ]),
  );
  const existingProductByName = new Map(
    input.existingProducts.map((product) => [normalize(product.name), product]),
  );

  const categories: MenuSuggestionCategory[] = [];
  const categoryKeyByName = new Map<string, string>();
  const addCategory = (rawName: string | undefined): string => {
    const name = clean(rawName, 255) ?? FALLBACK_CATEGORY_NAME;
    const normalized = normalize(name) || normalize(FALLBACK_CATEGORY_NAME);
    const known = categoryKeyByName.get(normalized);
    if (known) return known;
    const key = `c${categories.length + 1}`;
    const existing = existingCategoryByName.get(normalized);
    categories.push({
      key,
      name,
      ...(existing ? { existingCategoryId: existing.id } : {}),
    });
    categoryKeyByName.set(normalized, key);
    return key;
  };

  for (const category of [...input.extraction.categories].sort(
    (a, b) => a.position - b.position,
  )) {
    addCategory(category.name);
  }

  const products: MenuSuggestionProduct[] = [];
  const seenNames = new Set<string>();
  let taxAdjusted = 0;
  for (const raw of input.extraction.products) {
    if (!clean(raw.name, 255)) continue;
    const key = `p${products.length + 1}`;
    const categoryKey = addCategory(raw.category);
    const notes: string[] = [];
    const note = clean(raw.note, 500);
    if (note) notes.push(note);

    let taxRate = raw.taxRate;
    if (input.vatExempt && taxRate !== 0) {
      taxRate = 0;
      taxAdjusted += 1;
    }

    let price = round2(raw.price);
    let variants = mapVariants(raw.variants);
    let name = clean(raw.name, 255) as string;
    if (variants && variants.length === 1) {
      // Eine einzelne Groesse ist keine Variante (Prompt-Regel): sie
      // wandert in den Namen, der Aufpreis in den Preis.
      const [only] = variants;
      if (!normalize(name).includes(normalize(only.name))) {
        name = clean(`${name} ${only.name}`, 255) as string;
      }
      price = round2(price + only.priceModifier);
      variants = undefined;
    }
    if (variants) {
      const base = Math.min(
        ...variants.map((variant) => variant.priceModifier),
      );
      if (base !== 0) {
        price = round2(price + base);
        variants = variants.map((variant) => ({
          ...variant,
          priceModifier: round2(variant.priceModifier - base),
        }));
      }
    }

    const normalized = normalize(name);
    const existing = existingProductByName.get(normalized);
    let confidence = raw.confidence;
    if (seenNames.has(normalized)) {
      notes.push('Steht mehrfach auf der Karte');
      confidence = 'low';
    }
    seenNames.add(normalized);

    const deposit = raw.deposit;
    const pfand =
      deposit && deposit.suggested
        ? {
            suggested: true,
            ...(typeof deposit.amount === 'number' && deposit.amount > 0
              ? { amount: round2(deposit.amount) }
              : {}),
          }
        : undefined;

    const description = clean(raw.description, 1000);
    products.push({
      key,
      categoryKey,
      name,
      ...(description ? { description } : {}),
      price,
      taxRate,
      ...(pfand ? { pfand } : {}),
      ...(variants ? { variants } : {}),
      ...(existing ? { existingProductId: existing.id } : {}),
      confidence,
      ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
    });
  }

  if (taxAdjusted > 0) {
    warnings.push(
      'Deine Organisation weist keine Umsatzsteuer aus — alle Steuersätze wurden auf 0 % gesetzt',
    );
  }
  const existingCount = products.filter(
    (product) => product.existingProductId,
  ).length;
  if (existingCount > 0) {
    warnings.push(
      existingCount === 1
        ? 'Ein Produkt gibt es in dieser Veranstaltung schon'
        : `${existingCount} Produkte gibt es in dieser Veranstaltung schon`,
    );
  }

  return { categories, products, warnings };
}
