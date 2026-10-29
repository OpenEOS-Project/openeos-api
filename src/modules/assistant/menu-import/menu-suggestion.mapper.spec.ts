import { readFileSync } from 'fs';
import { join } from 'path';
import { validateExtraction } from './menu-extraction.schema';
import { mapExtraction } from './menu-suggestion.mapper';

const FIXTURES = join(__dirname, '../../../../test/fixtures/menu');

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

describe('mapExtraction (golden)', () => {
  it('maps the text menu: keys, existing category/product, variants, deposit', () => {
    const extraction = validateExtraction(load('speisekarte.extraction.json'));
    const suggestion = mapExtraction({
      extraction,
      existingCategories: [
        { id: '11111111-1111-4111-8111-111111111111', name: 'Getränke' },
      ],
      existingProducts: [
        { id: '22222222-2222-4222-8222-222222222222', name: 'Radler' },
      ],
      vatExempt: false,
    });
    expect(suggestion).toEqual(load('speisekarte.expected.json'));
  });

  it('maps the drinks photo: fallback category, base price from variants, tax reset for exempt orgs', () => {
    const extraction = validateExtraction(load('getraenke.extraction.json'));
    const suggestion = mapExtraction({
      extraction,
      existingCategories: [],
      existingProducts: [],
      vatExempt: true,
    });
    expect(suggestion).toEqual(load('getraenke.expected.json'));
    // 2.50 + smallest modifier 0.50 → base 3.00, modifiers shifted to 0 / 1.00
    expect(suggestion.products[0]).toMatchObject({
      price: 3,
      variants: [
        { name: '0,3 l', priceModifier: 0 },
        { name: '0,5 l', priceModifier: 1 },
      ],
    });
    expect(suggestion.categories[1]).toEqual({ key: 'c2', name: 'Sonstiges' });
  });

  it('marks duplicates and dedupes categories by normalized name', () => {
    const suggestion = mapExtraction({
      extraction: validateExtraction({
        categories: [
          { name: 'Getränke', position: 2 },
          { name: 'getraenke', position: 1 },
        ],
        products: [
          {
            name: 'Bier',
            category: 'Getränke',
            price: 3,
            taxRate: 19,
            confidence: 'high',
          },
          {
            name: 'bier',
            category: 'GETRÄNKE',
            price: 3.5,
            taxRate: 19,
            confidence: 'high',
          },
        ],
        warnings: [],
      }),
      existingCategories: [],
      existingProducts: [],
      vatExempt: false,
    });
    expect(suggestion.categories).toHaveLength(1);
    expect(suggestion.products[1]).toMatchObject({
      confidence: 'low',
      note: 'Steht mehrfach auf der Karte',
    });
  });
});
