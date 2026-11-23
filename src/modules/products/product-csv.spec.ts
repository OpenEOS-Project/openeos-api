import {
  parseProductCsv,
  serializeProductCsv,
  type ProductCsvExportRow,
} from './product-csv';

const base: ProductCsvExportRow = {
  category: 'Getränke',
  name: 'Cola 0,5 l',
  description: null,
  price: 3.5,
  taxRate: 19,
  pfand: null,
  imageUrl: null,
  icon: null,
  options: { groups: [] },
  isAvailable: true,
  trackInventory: false,
  stockQuantity: 0,
  sortOrder: 0,
};

describe('product CSV export', () => {
  it('writes Excel-friendly CSV: BOM, semicolon, decimal comma, CRLF', () => {
    const csv = serializeProductCsv([{ ...base, pfand: 1 }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'category;name;description;price;taxRate;pfand;icon;ingredients;choices;extras;available;trackInventory;stockQuantity;sortOrder',
    );
    expect(lines[1]).toBe('Getränke;Cola 0,5 l;;3,50;19;1,00;;;;;ja;nein;0;0');
    expect(lines[2]).toBe('');
  });

  it('round-trips through the import parser', () => {
    const rows: ProductCsvExportRow[] = [
      {
        ...base,
        description: 'Mit "Eis"; eiskalt\nund lecker',
        pfand: 2.5,
        imageUrl: 'pos-icon:cola-bottle',
        isAvailable: false,
        trackInventory: true,
        stockQuantity: 48,
        sortOrder: 3,
      },
      {
        ...base,
        category: 'Essen',
        name: 'Burger',
        price: 9.9,
        taxRate: 7,
        icon: 'oe:burger',
        options: {
          groups: [
            {
              name: 'Zutaten',
              type: 'ingredients',
              required: false,
              options: [
                { name: 'Zwiebeln', priceModifier: 0 },
                { name: 'Gurke', priceModifier: 0 },
              ],
            },
            {
              name: 'Brot',
              type: 'single',
              required: true,
              options: [
                { name: 'Weiß', priceModifier: 0, default: true },
                { name: 'Körner', priceModifier: 0, default: false },
              ],
            },
            {
              name: 'Größe',
              type: 'single',
              required: false,
              options: [
                { name: 'Klein', priceModifier: -0.5, default: false },
                { name: 'Groß', priceModifier: 1.5, default: true },
              ],
            },
            {
              name: 'Soße',
              type: 'multiple',
              required: true,
              options: [{ name: 'Mayo', priceModifier: 0, default: true }],
            },
            {
              name: 'Extras',
              type: 'multiple',
              required: false,
              options: [
                { name: 'Käse', priceModifier: 0.5 },
                { name: 'Bacon', priceModifier: 1 },
              ],
            },
          ],
        },
      },
      { ...base, name: 'Wasser', taxRate: 0, price: 0 },
    ];

    const parsed = parseProductCsv(serializeProductCsv(rows));
    expect(parsed.fatalError).toBeNull();
    expect(parsed.rows.map((r) => r.error)).toEqual([null, null, null]);

    const [cola, burger, wasser] = parsed.rows;
    expect(cola).toMatchObject({
      category: 'Getränke',
      name: 'Cola 0,5 l',
      // Zeilenumbrueche werden im Export zu Leerzeichen.
      description: 'Mit "Eis"; eiskalt und lecker',
      price: 3.5,
      taxRate: 19,
      pfand: 2.5,
      iconId: 'cola-bottle',
      isAvailable: false,
      trackInventory: true,
      stockQuantity: 48,
      sortOrder: 3,
    });
    expect(burger).toMatchObject({
      category: 'Essen',
      price: 9.9,
      taxRate: 7,
      iconId: 'oe:burger',
      pfand: null,
    });
    expect(burger.options).toEqual(rows[1].options);
    expect(wasser).toMatchObject({ taxRate: 0, price: 0 });
  });

  it('neutralises spreadsheet formulas in text cells', () => {
    const csv = serializeProductCsv([{ ...base, name: '=HYPERLINK("x")' }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('product CSV export – formulas', () => {
  it('reads the protected cell back unchanged', () => {
    const csv = serializeProductCsv([{ ...base, name: '- ohne Zwiebeln' }]);
    expect(parseProductCsv(csv).rows[0].name).toBe('- ohne Zwiebeln');
  });
});

describe('product CSV import – tax rate column', () => {
  it('accepts German header names and a percent sign', () => {
    const parsed = parseProductCsv(
      'Kategorie;Produkt;Preis;Steuersatz\r\nEssen;Wurst;3,50;7 %\r\nEssen;Brot;1;\r\n',
    );
    expect(parsed.rows.map((r) => r.taxRate)).toEqual([7, null]);
  });

  it('rejects impossible rates', () => {
    const parsed = parseProductCsv('category,name,price,taxRate\nA,B,1,150\n');
    expect(parsed.rows[0].error).toBe('Ungültiger Steuersatz');
  });
});
