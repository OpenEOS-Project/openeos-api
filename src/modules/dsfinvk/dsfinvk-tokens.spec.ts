import * as fs from 'fs';
import * as path from 'path';
import { buildClosing } from './dsfinvk-builder';
import { buildExportZip, mergeRows } from './dsfinvk-export';
import { parseCsv } from './dsfinvk-format';
import type { DsfinvkClosingInput } from './dsfinvk-types';
import { validateZip, type ValidationResult } from './dsfinvk-validator';
import { readZip } from './dsfinvk-zip';
import {
  Sequence,
  VAT_EXEMPT,
  VAT_LIABLE,
  closingInput,
  sale,
  tokenRefund,
  tokenTransaction,
} from './testing/dsfinvk-fixtures';

/**
 * Wertmarken in der DSFinV-K (Steuerberater 2026-11-10, Frage 13 und
 * Zusammenfassung Zeile 1): MehrzweckgutscheinKauf im 0-%-Slot,
 * MehrzweckgutscheinEinloesung negativ im 0-%-Slot plus Umsatz je Satz,
 * Einzweckgutschein mit dem Satz beim Kauf, Zahlart „Keine“ bei
 * vollstaendiger Gutscheinzahlung. `DSFINVK_SPEC_ZIP_DIR=<ordner>` legt die
 * Exporte fuer `pnpm dsfinvk:validate` ab.
 */

const SUPPLIER = { name: 'TSV Musterdorf e. V.', location: 'Musterdorf' };
const Z1 = new Date('2026-11-04T05:20:00Z');
const Z2 = new Date('2026-11-05T05:20:00Z');

function exportOf(
  name: string,
  inputs: DsfinvkClosingInput[],
): { zip: Buffer; result: ValidationResult } {
  const rows = mergeRows(inputs.map((i) => buildClosing(i).rows));
  const zip = buildExportZip(rows, SUPPLIER, Z2);
  const dir = process.env.DSFINVK_SPEC_ZIP_DIR;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `wertmarken-${name}.zip`), zip);
  }
  return { zip, result: validateZip(zip) };
}

function expectValid(result: ValidationResult) {
  expect(
    result.errors.map(
      (e) => `${e.code} ${e.file ?? ''}:${e.line ?? ''} ${e.message}`,
    ),
  ).toEqual([]);
  expect(result.ok).toBe(true);
}

function rowsOf(zip: Buffer, file: string): Record<string, string>[] {
  const entry = readZip(zip).find((e) => e.name === file)!;
  const [header, ...records] = parseCsv(entry.data.toString('utf8')).records;
  return records.map((r) =>
    Object.fromEntries(header.values.map((h, i) => [h, r.values[i]])),
  );
}

/** Positionen eines Bons: GV_TYP, Schluessel, Brutto. */
function bonLines(zip: Buffer, bonId: string): [string, string, string][] {
  const vat = rowsOf(zip, 'lines_vat.csv');
  return rowsOf(zip, 'lines.csv')
    .filter((l) => l.BON_ID === bonId)
    .map((l) => {
      const v = vat.find(
        (x) => x.BON_ID === l.BON_ID && x.POS_ZEILE === l.POS_ZEILE,
      )!;
      return [l.GV_TYP, v.UST_SCHLUESSEL, v.POS_BRUTTO];
    });
}

function tseData(zip: Buffer): string[] {
  return rowsOf(zip, 'transactions_tse.csv').map((r) => r.TSE_VORGANGSDATEN);
}

const MARKE = { name: '2-€-Marke', unitValue: 2 };

describe('DSFinV-K: Wertmarken', () => {
  it('Mehrzweck sale: MehrzweckgutscheinKauf, key 5, cash in (example from the tax review)', () => {
    const seq = new Sequence();
    const tx = tokenTransaction(seq, VAT_LIABLE, {
      tokens: [{ ...MARKE, count: 50 }],
    });
    const { zip, result } = exportOf('mehrzweck-verkauf', [
      closingInput(1, Z1, [tx]),
    ]);
    expectValid(result);
    expect(tseData(zip)).toEqual([
      'Beleg^0.00_0.00_0.00_0.00_100.00^100.00:Bar',
    ]);
    expect(bonLines(zip, '1')).toEqual([
      ['MehrzweckgutscheinKauf', '5', '100,00'],
    ]);
    expect(rowsOf(zip, 'transactions.csv')[0]).toMatchObject({
      BON_TYP: 'Beleg',
      BON_NAME: 'Wertmarkenverkauf',
    });
    expect(rowsOf(zip, 'businesscases.csv')).toEqual([
      expect.objectContaining({
        GV_TYP: 'MehrzweckgutscheinKauf',
        UST_SCHLUESSEL: '5',
        Z_UMS_BRUTTO: '100,00',
        Z_UMS_NETTO: '100,00',
        Z_UST: '0,00',
      }),
    ]);
    expect(rowsOf(zip, 'payment.csv')).toEqual([
      expect.objectContaining({
        ZAHLART_TYP: 'Bar',
        Z_ZAHLART_BETRAG: '100,00',
      }),
    ]);
  });

  it('Mehrzweck redemption with mixed rates and cash for the rest (example from the tax review)', () => {
    const seq = new Sequence();
    const tx = sale(seq, VAT_LIABLE, {
      items: [
        { name: 'Bier 0,5 l', quantity: 12, price: 5, rate: 19 },
        {
          name: 'Bratwurst',
          quantity: 15,
          price: 4,
          rate: 7,
          category: 'Speisen',
        },
      ],
      tokens: [{ ...MARKE, count: 50 }],
    });
    const { zip, result } = exportOf('mehrzweck-einloesung-split-bar', [
      closingInput(1, Z1, [tx]),
    ]);
    expectValid(result);
    expect(tseData(zip)).toEqual([
      'Beleg^60.00_60.00_0.00_0.00_-100.00^20.00:Bar',
    ]);
    expect(bonLines(zip, '1')).toEqual([
      ['Umsatz', '1', '60,00'],
      ['Umsatz', '2', '60,00'],
      ['MehrzweckgutscheinEinloesung', '5', '-100,00'],
    ]);
    const vat = rowsOf(zip, 'transactions_vat.csv');
    expect(vat).toEqual([
      expect.objectContaining({
        UST_SCHLUESSEL: '1',
        BON_BRUTTO: '60,00',
        BON_UST: '9,58',
      }),
      expect.objectContaining({
        UST_SCHLUESSEL: '2',
        BON_BRUTTO: '60,00',
        BON_UST: '3,93',
      }),
      expect.objectContaining({
        UST_SCHLUESSEL: '5',
        BON_BRUTTO: '-100,00',
        BON_UST: '0,00',
      }),
    ]);
    expect(rowsOf(zip, 'datapayment.csv')).toEqual([
      expect.objectContaining({
        ZAHLART_TYP: 'Bar',
        BASISWAEH_BETRAG: '20,00',
      }),
    ]);
  });

  it('fully paid with Mehrzweck tokens: Zahlart „Keine“, VAT from the goods', () => {
    const seq = new Sequence();
    const tx = sale(seq, VAT_LIABLE, {
      items: [
        { name: 'Bier 0,5 l', quantity: 1, price: 4, rate: 19 },
        { name: 'Pommes', quantity: 1, price: 4, rate: 7, category: 'Speisen' },
      ],
      tokens: [{ ...MARKE, count: 4 }],
    });
    const { zip, result } = exportOf('mehrzweck-voll', [
      closingInput(1, Z1, [tx]),
    ]);
    expectValid(result);
    expect(tseData(zip)).toEqual(['Beleg^4.00_4.00_0.00_0.00_-8.00^0.00:Bar']);
    expect(rowsOf(zip, 'datapayment.csv')).toEqual([
      expect.objectContaining({
        ZAHLART_TYP: 'Keine',
        BASISWAEH_BETRAG: '0,00',
      }),
    ]);
    // Abschluss: Umsatz je Satz, Einloesung negativ, kein Geld.
    const z = rowsOf(zip, 'businesscases.csv');
    expect(z).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          GV_TYP: 'Umsatz',
          UST_SCHLUESSEL: '1',
          Z_UST: '0,64',
        }),
        expect.objectContaining({
          GV_TYP: 'Umsatz',
          UST_SCHLUESSEL: '2',
          Z_UST: '0,26',
        }),
        expect.objectContaining({
          GV_TYP: 'MehrzweckgutscheinEinloesung',
          UST_SCHLUESSEL: '5',
          Z_UMS_BRUTTO: '-8,00',
        }),
      ]),
    );
  });

  it('Mehrzweck tokens with card for the rest: Unbar for the money only', () => {
    const seq = new Sequence();
    const tx = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Cocktail', quantity: 1, price: 9, rate: 19 }],
      tokens: [{ ...MARKE, count: 2 }],
      method: 'sumup_terminal',
    });
    const { zip, result } = exportOf('mehrzweck-split-karte', [
      closingInput(1, Z1, [tx]),
    ]);
    expectValid(result);
    expect(tseData(zip)).toEqual([
      'Beleg^9.00_0.00_0.00_0.00_-4.00^5.00:Unbar',
    ]);
  });

  it('Einzweck sale at 19 % and redemption without VAT', () => {
    const seq = new Sequence();
    const getraenkemarke = {
      name: 'Getränkemarke',
      unitValue: 3,
      kind: 'single_purpose' as const,
      vatRate: 19,
    };
    const sold = tokenTransaction(seq, VAT_LIABLE, {
      tokens: [{ ...getraenkemarke, count: 10 }],
    });
    const redeemed = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Bier 0,5 l', quantity: 2, price: 3, rate: 19 }],
      tokens: [{ ...getraenkemarke, count: 2 }],
    });
    const { zip, result } = exportOf('einzweck-verkauf-einloesung', [
      closingInput(1, Z1, [sold, redeemed]),
    ]);
    expectValid(result);
    expect(tseData(zip)).toEqual([
      'Beleg^30.00_0.00_0.00_0.00_0.00^30.00:Bar',
      'Beleg^0.00_0.00_0.00_0.00_0.00^0.00:Bar',
    ]);
    expect(bonLines(zip, '1')).toEqual([
      ['EinzweckgutscheinKauf', '1', '30,00'],
    ]);
    expect(bonLines(zip, '2')).toEqual([
      ['Umsatz', '1', '6,00'],
      ['EinzweckgutscheinEinloesung', '1', '-6,00'],
    ]);
    // Steuer nur beim Verkauf.
    const vat = rowsOf(zip, 'transactions_vat.csv');
    expect(vat.filter((v) => v.BON_ID === '1')).toEqual([
      expect.objectContaining({
        UST_SCHLUESSEL: '1',
        BON_BRUTTO: '30,00',
        BON_UST: '4,79',
      }),
    ]);
    expect(vat.filter((v) => v.BON_ID === '2')).toEqual([
      expect.objectContaining({
        UST_SCHLUESSEL: '1',
        BON_BRUTTO: '0,00',
        BON_UST: '0,00',
      }),
    ]);
  });

  it('Rücktausch: Mehrzweck as negative MehrzweckgutscheinKauf (payment means), Einzweck as § 17 reduction', () => {
    const seq = new Sequence();
    const buyback = tokenTransaction(seq, VAT_LIABLE, {
      kind: 'buyback',
      tokens: [
        { ...MARKE, count: 3 },
        {
          name: 'Getränkemarke',
          unitValue: 3,
          kind: 'single_purpose',
          vatRate: 19,
          count: 2,
        },
      ],
      number: 'W-20261103-0002',
    });
    const { zip, result } = exportOf('ruecktausch', [
      closingInput(1, Z1, [buyback]),
    ]);
    expectValid(result);
    expect(tseData(zip)).toEqual([
      'Beleg^-6.00_0.00_0.00_0.00_-6.00^-12.00:Bar',
    ]);
    expect(bonLines(zip, '1')).toEqual([
      ['MehrzweckgutscheinKauf', '5', '-6,00'],
      ['EinzweckgutscheinKauf', '1', '-6,00'],
    ]);
    expect(rowsOf(zip, 'transactions.csv')[0]).toMatchObject({
      BON_NAME: 'Wertmarken-Rücktausch',
    });
  });

  it('Storno of an order paid with tokens: goods back, redemption reversed, no money', () => {
    const seq = new Sequence();
    const original = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Bier 0,5 l', quantity: 1, price: 4, rate: 19 }],
      tokens: [{ ...MARKE, count: 2 }],
    });
    const z1 = closingInput(1, Z1, [original]);
    const storno = tokenRefund(seq, VAT_LIABLE, {
      items: [
        {
          name: 'Bier 0,5 l',
          quantity: 1,
          unitPrice: 4,
          taxRate: 19,
          amount: 4,
        },
      ],
      tokens: [{ ...MARKE, count: 2 }],
      original,
      closing: { zNr: 1, createdAt: Z1 },
    });
    const { zip, result } = exportOf('storno-mit-marken', [
      z1,
      closingInput(2, Z2, [storno]),
    ]);
    expectValid(result);
    expect(tseData(zip)[1]).toBe('Beleg^-4.00_0.00_0.00_0.00_4.00^0.00:Bar');
    expect(bonLines(zip, '2')).toEqual([
      ['Umsatz', '1', '-4,00'],
      ['MehrzweckgutscheinEinloesung', '5', '4,00'],
    ]);
  });

  it('Kleinunternehmer: tokens are always Mehrzweck, goods key 6, voucher lines key 5', () => {
    const seq = new Sequence();
    const sold = tokenTransaction(seq, VAT_EXEMPT, {
      tokens: [
        {
          name: 'Getränkemarke',
          unitValue: 3,
          kind: 'single_purpose',
          vatRate: 19,
          count: 4,
        },
      ],
    });
    const redeemed = sale(seq, VAT_EXEMPT, {
      items: [
        { name: 'Bier 0,5 l', quantity: 1, price: 4, rate: 19 },
        { name: 'Pommes', quantity: 1, price: 3, rate: 7, category: 'Speisen' },
      ],
      tokens: [{ ...MARKE, count: 3 }],
    });
    const { zip, result } = exportOf('kleinunternehmer', [
      closingInput(1, Z1, [sold, redeemed], { settings: VAT_EXEMPT }),
    ]);
    expectValid(result);
    expect(tseData(zip)).toEqual([
      'Beleg^0.00_0.00_0.00_0.00_12.00^12.00:Bar',
      'Beleg^0.00_0.00_0.00_0.00_1.00^1.00:Bar',
    ]);
    expect(bonLines(zip, '1')).toEqual([
      ['MehrzweckgutscheinKauf', '5', '12,00'],
    ]);
    expect(bonLines(zip, '2')).toEqual([
      ['Umsatz', '6', '4,00'],
      ['Umsatz', '6', '3,00'],
      ['MehrzweckgutscheinEinloesung', '5', '-6,00'],
    ]);
    const vat = rowsOf(zip, 'transactions_vat.csv').filter(
      (v) => v.BON_ID === '2',
    );
    expect(vat).toEqual([
      expect.objectContaining({ UST_SCHLUESSEL: '5', BON_BRUTTO: '-6,00' }),
      expect.objectContaining({
        UST_SCHLUESSEL: '6',
        BON_BRUTTO: '7,00',
        BON_UST: '0,00',
      }),
    ]);
  });

  it('training: token sales in test mode are AVTraining and stay out of the closing', () => {
    const seq = new Sequence();
    const tx = tokenTransaction(seq, VAT_LIABLE, {
      tokens: [{ ...MARKE, count: 5 }],
      training: true,
    });
    const { zip, result } = exportOf('training', [closingInput(1, Z1, [tx])]);
    expectValid(result);
    expect(tseData(zip)).toEqual([
      'AVTraining^0.00_0.00_0.00_0.00_10.00^10.00:Bar',
    ]);
    expect(rowsOf(zip, 'businesscases.csv')).toEqual([]);
  });
});
