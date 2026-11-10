import { buildClosing } from './dsfinvk-builder';
import {
  buildExportFiles,
  buildExportZip,
  contentHash,
  mergeRows,
} from './dsfinvk-export';
import { parseCsv } from './dsfinvk-format';
import { DSFINVK_TABLES } from './dsfinvk-schema';
import type { DsfinvkClosingInput } from './dsfinvk-types';
import {
  validateFiles,
  validateZip,
  type ValidationResult,
} from './dsfinvk-validator';
import { readZip } from './dsfinvk-zip';
import {
  REGISTER_ID,
  Sequence,
  TERMINAL_2,
  TSE_B,
  VAT_EXEMPT,
  VAT_LIABLE,
  abort,
  cashbook,
  closingInput,
  failed,
  lateSigned,
  master,
  pfandReturn,
  refund,
  sale,
  tableOrder,
  zeroReceipt,
} from './testing/dsfinvk-fixtures';

const SUPPLIER = { name: 'TSV Musterdorf e. V.', location: 'Musterdorf' };
const Z1 = new Date('2026-11-04T05:20:00Z');
const Z2 = new Date('2026-11-05T05:20:00Z');

function exportOf(inputs: DsfinvkClosingInput[]): {
  zip: Buffer;
  result: ValidationResult;
} {
  const rows = mergeRows(inputs.map((i) => buildClosing(i).rows));
  const zip = buildExportZip(rows, SUPPLIER, Z2);
  return { zip, result: validateZip(zip) };
}

function expectValid(result: ValidationResult) {
  // Fehler im Klartext zeigen, falls etwas nicht stimmt.
  expect(
    result.errors.map(
      (e) => `${e.code} ${e.file ?? ''}:${e.line ?? ''} ${e.message}`,
    ),
  ).toEqual([]);
  expect(result.ok).toBe(true);
}

/** Positionen mit ihrem USt-Schluessel (lines.csv + lines_vat.csv). */
function linesWithVat(zip: Buffer, gvTyp: string): [string, string][] {
  const vat = rowsOf(zip, 'lines_vat.csv');
  return rowsOf(zip, 'lines.csv')
    .filter((l) => l.GV_TYP === gvTyp)
    .map((l) => {
      const v = vat.find(
        (x) => x.BON_ID === l.BON_ID && x.POS_ZEILE === l.POS_ZEILE,
      )!;
      return [v.UST_SCHLUESSEL, v.POS_BRUTTO];
    });
}

function rowsOf(zip: Buffer, file: string): Record<string, string>[] {
  const entry = readZip(zip).find((e) => e.name === file)!;
  const [header, ...records] = parseCsv(entry.data.toString('utf8')).records;
  return records.map((r) =>
    Object.fromEntries(header.values.map((h, i) => [h, r.values[i]])),
  );
}

describe('DSFinV-K export (own validator)', () => {
  it('contains index.xml, the DTD and all 20 tables with header rows', () => {
    const files = buildExportFiles(
      buildClosing(closingInput(1, Z1, [])).rows,
      SUPPLIER,
    );
    expect(files.map((f) => f.name).sort()).toEqual(
      [
        'gdpdu-01-09-2004.dtd',
        'index.xml',
        ...DSFINVK_TABLES.map((t) => t.file),
      ].sort(),
    );
    expect(files).toHaveLength(22);
    const index = files
      .find((f) => f.name === 'index.xml')!
      .data.toString('utf8');
    expect(index).toContain('<Name>TSV Musterdorf e. V.</Name>');
    expect(index).toContain('<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">');
  });

  it('empty day: a closing without transactions is valid', () => {
    const { zip, result } = exportOf([closingInput(1, Z1, [])]);
    expectValid(result);
    const closing = rowsOf(zip, 'cashpointclosing.csv')[0];
    expect(closing).toMatchObject({
      Z_NR: '1',
      Z_SE_ZAHLUNGEN: '0,00',
      Z_SE_BARZAHLUNGEN: '0,00',
      Z_START_ID: '',
      TAXONOMIE_VERSION: '2.4',
    });
    expect(rowsOf(zip, 'cash_per_currency.csv')).toEqual([
      expect.objectContaining({
        ZAHLART_WAEH: 'EUR',
        ZAHLART_BETRAG_WAEH: '0,00',
      }),
    ]);
  });

  it('multiple tax rates: 19 % and 7 % are split per VAT key and summed in the closing', () => {
    const seq = new Sequence();
    const tx = sale(seq, VAT_LIABLE, {
      items: [
        { name: 'Bier 0,5 l', quantity: 2, price: 4.5, rate: 19 },
        { name: 'Bratwurst', quantity: 1, price: 3.8, rate: 7 },
      ],
    });
    const { zip, result } = exportOf([closingInput(1, Z1, [tx])]);
    expectValid(result);
    const vat = rowsOf(zip, 'transactions_vat.csv');
    expect(vat).toEqual([
      expect.objectContaining({
        UST_SCHLUESSEL: '1',
        BON_BRUTTO: '9,00',
        BON_NETTO: '7,56',
        BON_UST: '1,44',
      }),
      expect.objectContaining({
        UST_SCHLUESSEL: '2',
        BON_BRUTTO: '3,80',
        BON_NETTO: '3,55',
        BON_UST: '0,25',
      }),
    ]);
    const z = rowsOf(zip, 'businesscases.csv');
    expect(z).toEqual([
      expect.objectContaining({
        GV_TYP: 'Umsatz',
        UST_SCHLUESSEL: '1',
        Z_UMS_BRUTTO: '9,00',
      }),
      expect.objectContaining({
        GV_TYP: 'Umsatz',
        UST_SCHLUESSEL: '2',
        Z_UMS_BRUTTO: '3,80',
      }),
    ]);
    expect(rowsOf(zip, 'transactions_tse.csv')[0]).toMatchObject({
      TSE_TA_VORGANGSART: 'Kassenbeleg-V1',
      TSE_VORGANGSDATEN: 'Beleg^9.00_3.80_0.00_0.00_0.00^12.80:Bar',
    });
    // Das Terminal steht an der Position, nicht im Bonkopf (Client-ID = Kasse).
    expect(rowsOf(zip, 'transactions.csv')[0].TERMINAL_ID).toBe('');
    expect(rowsOf(zip, 'lines.csv')[0].POS_TERMINAL_ID).not.toBe('');
  });

  it('discounts: order discount becomes negative Rabatt lines per VAT key', () => {
    const seq = new Sequence();
    const tx = sale(seq, VAT_LIABLE, {
      items: [
        { name: 'Cola', quantity: 3, price: 3.0, rate: 19 },
        { name: 'Pommes', quantity: 2, price: 4.0, rate: 7 },
      ],
      discount: 1.7,
      method: 'sumup_terminal',
    });
    const { zip, result } = exportOf([closingInput(1, Z1, [tx])]);
    expectValid(result);
    const lines = rowsOf(zip, 'lines.csv');
    expect(lines.filter((l) => l.GV_TYP === 'Rabatt')).toHaveLength(2);
    expect(rowsOf(zip, 'datapayment.csv')[0]).toMatchObject({
      ZAHLART_TYP: 'Unbar',
      ZAHLART_NAME: 'Kartenzahlung',
      BASISWAEH_BETRAG: '15,30',
    });
    expect(rowsOf(zip, 'cashpointclosing.csv')[0]).toMatchObject({
      Z_SE_ZAHLUNGEN: '15,30',
      Z_SE_BARZAHLUNGEN: '0,00',
    });
  });

  it('variants: options are listed in Bonpos_Zusatzinfo', () => {
    const seq = new Sequence();
    const tx = sale(seq, VAT_LIABLE, {
      items: [
        {
          name: 'Burger',
          quantity: 2,
          price: 8,
          rate: 7,
          category: 'Essen',
          options: [
            { group: 'Beilage', option: 'Pommes', priceModifier: 1.5 },
            { group: 'Extra', option: 'Käse', priceModifier: 0.5 },
          ],
        },
      ],
    });
    const { zip, result } = exportOf([closingInput(1, Z1, [tx])]);
    expectValid(result);
    expect(rowsOf(zip, 'subitems.csv')).toEqual([
      expect.objectContaining({
        POS_ZEILE: '1',
        ZI_NAME: 'Beilage: Pommes',
        ZI_MENGE: '2,000',
        ZI_BASISPREIS_BRUTTO: '1,50',
      }),
      expect.objectContaining({
        POS_ZEILE: '1',
        ZI_NAME: 'Extra: Käse',
        ZI_BASISPREIS_BRUTTO: '0,50',
      }),
    ]);
    expect(rowsOf(zip, 'lines.csv')[0]).toMatchObject({
      STK_BR: '10,00',
      MENGE: '2,000',
      WARENGR: 'Essen',
    });
  });

  it('Pfand and Pfand return before 2026-11 (no rate stored): 0 % key as signed back then', () => {
    const seq = new Sequence();
    const s = sale(seq, VAT_LIABLE, {
      items: [
        { name: 'Apfelschorle', quantity: 2, price: 3, rate: 19, deposit: 2 },
      ],
    });
    const r = pfandReturn(seq, [
      { name: 'Becher', unitAmount: 2, quantity: 3 },
    ]);
    const { zip, result } = exportOf([closingInput(1, Z1, [s, r])]);
    expectValid(result);
    const z = rowsOf(zip, 'businesscases.csv');
    expect(z).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          GV_TYP: 'Pfand',
          UST_SCHLUESSEL: '5',
          Z_UMS_BRUTTO: '4,00',
        }),
        expect.objectContaining({
          GV_TYP: 'PfandRueckzahlung',
          UST_SCHLUESSEL: '5',
          Z_UMS_BRUTTO: '-6,00',
        }),
      ]),
    );
    expect(rowsOf(zip, 'cash_per_currency.csv')[0].ZAHLART_BETRAG_WAEH).toBe(
      '4,00',
    );
  });

  it('Pfand with VAT (2026-11): deposit and Pfand return at the rate of the Pfand type', () => {
    const seq = new Sequence();
    const s1 = sale(seq, VAT_LIABLE, {
      items: [
        {
          name: 'Apfelschorle',
          quantity: 2,
          price: 3,
          rate: 19,
          deposit: 2,
          depositRate: 19,
        },
        {
          name: 'Suppe',
          quantity: 1,
          price: 5,
          rate: 7,
          deposit: 1,
          depositRate: 7,
        },
      ],
    });
    // TSE: Pfand im Slot seines Satzes (19 % → 1, 7 % → 2).
    expect(s1.processData).toBe('Beleg^10.00_6.00_0.00_0.00_0.00^16.00:Bar');
    const r = pfandReturn(seq, [
      { name: 'Becher', unitAmount: 2, quantity: 3, vatRate: 19 },
      { name: 'Teller', unitAmount: 1, quantity: 1, vatRate: 7 },
    ]);
    expect(r.processData).toBe('Beleg^-6.00_-1.00_0.00_0.00_0.00^-7.00:Bar');
    const { zip, result } = exportOf([closingInput(1, Z1, [s1, r])]);
    expectValid(result);
    const z = rowsOf(zip, 'businesscases.csv');
    expect(z).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          GV_TYP: 'Pfand',
          UST_SCHLUESSEL: '1',
          Z_UMS_BRUTTO: '4,00',
          Z_UST: '0,64',
        }),
        expect.objectContaining({
          GV_TYP: 'Pfand',
          UST_SCHLUESSEL: '2',
          Z_UMS_BRUTTO: '1,00',
        }),
        expect.objectContaining({
          GV_TYP: 'PfandRueckzahlung',
          UST_SCHLUESSEL: '1',
          Z_UMS_BRUTTO: '-6,00',
          Z_UST: '-0,96',
        }),
        expect.objectContaining({
          GV_TYP: 'PfandRueckzahlung',
          UST_SCHLUESSEL: '2',
          Z_UMS_BRUTTO: '-1,00',
        }),
      ]),
    );
    // Kein Pfand mehr im 0-%-Schluessel.
    expect(
      z.filter(
        (row) => row.GV_TYP.startsWith('Pfand') && row.UST_SCHLUESSEL === '5',
      ),
    ).toEqual([]);
    expect(linesWithVat(zip, 'PfandRueckzahlung')).toEqual([
      ['1', '-6,00'],
      ['2', '-1,00'],
    ]);
  });

  it('Pfand with VAT in a refund: deposit lines keep the rate of the sale', () => {
    const seq = new Sequence();
    const original = sale(seq, VAT_LIABLE, {
      items: [
        {
          name: 'Bier',
          quantity: 2,
          price: 4,
          rate: 19,
          deposit: 2,
          depositRate: 19,
        },
      ],
    });
    const closing1 = closingInput(1, Z1, [original]);
    const storno = refund(seq, VAT_LIABLE, {
      original,
      closing: { zNr: 1, createdAt: Z1 },
      items: [
        {
          name: 'Bier',
          quantity: 2,
          unitPrice: 4,
          taxRate: 19,
          amount: 8,
          deposit: 2,
          depositRate: 19,
        },
      ],
    });
    // Ware und Pfand zusammen im 19-%-Slot.
    expect(storno.processData).toBe(
      'Beleg^-12.00_0.00_0.00_0.00_0.00^-12.00:Bar',
    );
    const goodwill = refund(seq, VAT_LIABLE, {
      original,
      closing: { zNr: 1, createdAt: Z1 },
      pfand: 2,
      pfandRate: 19,
      kind: 'refund',
    });
    const closing2 = closingInput(2, Z2, [storno, goodwill]);
    const { zip, result } = exportOf([closing1, closing2]);
    expectValid(result);
    expect(linesWithVat(zip, 'Pfand')).toEqual([
      ['1', '4,00'],
      ['1', '-4,00'],
      ['1', '-2,00'],
    ]);
  });

  it('Pfand for a VAT-exempt organization (Kleinunternehmer): key 6, no VAT', () => {
    const seq = new Sequence();
    const s1 = sale(seq, VAT_EXEMPT, {
      items: [
        {
          name: 'Apfelschorle',
          quantity: 1,
          price: 3,
          rate: 0,
          deposit: 2,
          depositRate: 19,
        },
      ],
    });
    expect(s1.processData).toBe('Beleg^0.00_0.00_0.00_0.00_5.00^5.00:Bar');
    const r = pfandReturn(
      seq,
      [{ name: 'Becher', unitAmount: 2, quantity: 1, vatRate: 19 }],
      TERMINAL_2,
      true,
    );
    expect(r.processData).toBe('Beleg^0.00_0.00_0.00_0.00_-2.00^-2.00:Bar');
    const { zip, result } = exportOf([
      closingInput(1, Z1, [s1, r], { settings: VAT_EXEMPT }),
    ]);
    expectValid(result);
    const z = rowsOf(zip, 'businesscases.csv').filter((row) =>
      row.GV_TYP.startsWith('Pfand'),
    );
    expect(z.map((row) => [row.GV_TYP, row.UST_SCHLUESSEL, row.Z_UST])).toEqual(
      expect.arrayContaining([
        ['Pfand', '6', '0,00'],
        ['PfandRueckzahlung', '6', '0,00'],
      ]),
    );
  });

  it('tips: TrinkgeldAG by default, TrinkgeldAN when tips go to the helpers', () => {
    const run = (settings: typeof VAT_LIABLE) => {
      const seq = new Sequence();
      const tx = sale(seq, settings, {
        items: [{ name: 'Wein', quantity: 1, price: 6, rate: 19 }],
        tip: 1.5,
        method: 'card',
      });
      const { zip, result } = exportOf([
        closingInput(1, Z1, [tx], { settings }),
      ]);
      expectValid(result);
      return rowsOf(zip, 'lines.csv').find(
        (l) => l.ARTIKELTEXT === 'Trinkgeld',
      )!;
    };
    expect(run(VAT_LIABLE).GV_TYP).toBe('TrinkgeldAG');
    expect(run({ ...VAT_LIABLE, tipRecipient: 'employee' }).GV_TYP).toBe(
      'TrinkgeldAN',
    );
  });

  it('refunds and storno: full storno sets BON_STORNO and references the original across closings', () => {
    const seq = new Sequence();
    const original = sale(seq, VAT_LIABLE, {
      items: [
        { name: 'Bier', quantity: 2, price: 4, rate: 19 },
        { name: 'Brezel', quantity: 1, price: 2.5, rate: 7 },
      ],
    });
    const closing1 = closingInput(1, Z1, [original]);
    const storno = refund(seq, VAT_LIABLE, {
      original,
      closing: { zNr: 1, createdAt: Z1 },
      items: [
        { name: 'Bier', quantity: 2, unitPrice: 4, taxRate: 19, amount: 8 },
        {
          name: 'Brezel',
          quantity: 1,
          unitPrice: 2.5,
          taxRate: 7,
          amount: 2.5,
        },
      ],
    });
    const second = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Bier', quantity: 3, price: 4, rate: 19 }],
      discount: 1.2,
    });
    const partial = refund(seq, VAT_LIABLE, {
      original: second,
      closing: { zNr: 2, createdAt: Z2 },
      items: [
        { name: 'Bier', quantity: 1, unitPrice: 4, taxRate: 19, amount: 3.6 },
      ],
      kind: 'refund',
    });
    const goodwill = refund(seq, VAT_LIABLE, {
      original: second,
      closing: { zNr: 2, createdAt: Z2 },
      goods: { 19: 1.0 },
      kind: 'refund',
    });
    const closing2 = closingInput(2, Z2, [storno, second, partial, goodwill]);
    const { zip, result } = exportOf([closing1, closing2]);
    expectValid(result);
    const heads = rowsOf(zip, 'transactions.csv');
    expect(heads.find((h) => h.BON_ID === String(storno.bonId))).toMatchObject({
      BON_STORNO: '1',
      UMS_BRUTTO: '-10,50',
      BON_TYP: 'Beleg',
    });
    expect(heads.find((h) => h.BON_ID === String(partial.bonId))).toMatchObject(
      { BON_STORNO: '0', UMS_BRUTTO: '-3,60' },
    );
    const refs = rowsOf(zip, 'references.csv');
    expect(refs.find((r) => r.BON_ID === String(storno.bonId))).toMatchObject({
      REF_TYP: 'Transaktion',
      REF_Z_NR: '1',
      REF_Z_KASSE_ID: REGISTER_ID,
      REF_BON_ID: String(original.bonId),
      REF_DATUM: '2026-11-04T06:20:00+01:00',
    });
    // Rabattierter Stueckpreis mit Entstehung in Bonpos_Preisfindung.
    const prices = rowsOf(zip, 'itemamounts.csv');
    expect(prices).toEqual([
      expect.objectContaining({ TYP: 'base_amount', PF_BRUTTO: '-4,00' }),
      expect.objectContaining({ TYP: 'discount', PF_BRUTTO: '0,40' }),
    ]);
    const kulanz = rowsOf(zip, 'lines.csv').filter(
      (l) => l.BON_ID === String(goodwill.bonId),
    );
    expect(kulanz).toEqual([
      expect.objectContaining({
        GV_TYP: 'Rabatt',
        ARTIKELTEXT: 'Erstattung (Kulanz)',
      }),
    ]);
  });

  it('training: AVTraining bons are signed but stay out of the closing totals', () => {
    const seq = new Sequence();
    const real = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Bier', quantity: 1, price: 4, rate: 19 }],
    });
    const training = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Bier', quantity: 5, price: 4, rate: 19 }],
      training: true,
    });
    const trainingOrder = tableOrder(seq, {
      items: [{ name: 'Schnitzel', quantity: 1, price: 12, rate: 7 }],
      orderNumber: '9',
      orderId: 'order-9-training',
      tableNumber: '3',
      training: true,
    });
    const { zip, result } = exportOf([
      closingInput(1, Z1, [real, training, trainingOrder]),
    ]);
    expectValid(result);
    const heads = rowsOf(zip, 'transactions.csv');
    expect(heads.map((h) => h.BON_TYP)).toEqual([
      'Beleg',
      'AVTraining',
      'AVTraining',
    ]);
    expect(rowsOf(zip, 'cashpointclosing.csv')[0].Z_SE_ZAHLUNGEN).toBe('4,00');
    expect(rowsOf(zip, 'transactions_tse.csv')[1].TSE_VORGANGSDATEN).toMatch(
      /^AVTraining\^/,
    );
  });

  it('TSE outage: unsigned bons carry TSE_TA_FEHLER, the dangling transaction is closed by AVBelegabbruch', () => {
    const seq = new Sequence();
    const ok = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Bier', quantity: 1, price: 4, rate: 19 }],
    });
    const lost = failed(
      sale(seq, VAT_LIABLE, {
        items: [{ name: 'Wasser', quantity: 2, price: 2, rate: 19 }],
      }),
    );
    const noStart = failed(
      sale(seq, VAT_LIABLE, {
        items: [{ name: 'Wein', quantity: 1, price: 5, rate: 19 }],
      }),
      false,
    );
    const closeIt = abort(seq, lost, { zNr: 1, createdAt: Z1 });
    const { zip, result } = exportOf([
      closingInput(1, Z1, [ok, lost, noStart, closeIt]),
    ]);
    expectValid(result);
    expect(result.stats.tseFailures).toBe(2);
    const tse = rowsOf(zip, 'transactions_tse.csv');
    expect(tse[1]).toMatchObject({
      TSE_TA_SIG: '',
      TSE_TA_FEHLER: expect.stringContaining('E_TIMEOUT') as unknown,
    });
    expect(tse[2]).toMatchObject({
      TSE_TANR: '',
      TSE_TA_FEHLER: expect.stringContaining('TSE ausgefallen') as unknown,
    });
    expect(tse[3]).toMatchObject({
      TSE_TANR: String(lost.transactionNumber),
      TSE_VORGANGSDATEN: 'AVBelegabbruch^0.00_0.00_0.00_0.00_0.00^',
    });
    const heads = rowsOf(zip, 'transactions.csv');
    expect(heads[1].BON_NOTIZ).toBe('TSE ausgefallen');
    expect(heads[3]).toMatchObject({
      BON_TYP: 'AVBelegabbruch',
      UMS_BRUTTO: '0,00',
    });
    expect(
      rowsOf(zip, 'datapayment.csv').find((p) => p.BON_ID === heads[3].BON_ID),
    ).toMatchObject({ ZAHLART_TYP: 'Keine' });
  });

  it('late signature (Frage 16): stays an outage receipt, signature stored with TSE_TA_FEHLER „Signatur nach Belegausgabe“', () => {
    const seq = new Sequence();
    const late = lateSigned(
      sale(seq, VAT_LIABLE, {
        items: [{ name: 'Bier', quantity: 2, price: 4, rate: 19 }],
      }),
    );
    const { zip, result } = exportOf([closingInput(1, Z1, [late])]);
    expectValid(result);
    expect(result.stats.tseFailures).toBe(1);
    const [tse] = rowsOf(zip, 'transactions_tse.csv');
    expect(tse.TSE_TA_FEHLER).toMatch(
      /^Signatur nach Belegausgabe \(TSE nicht erreichbar: E_TIMEOUT/,
    );
    // Signaturdaten der TSE vollstaendig (spaet, aber echt) — kein Nachsignieren.
    expect(tse).toMatchObject({
      TSE_TANR: String(late.transactionNumber),
      TSE_TA_SIGZ: String(late.signatureCounter),
      TSE_TA_SIG: late.signatureValue,
      TSE_TA_VORGANGSART: 'Kassenbeleg-V1',
      TSE_VORGANGSDATEN: late.processData,
    });
    expect(tse.TSE_TA_ENDE).not.toBe('');
    const [head] = rowsOf(zip, 'transactions.csv');
    expect(head.BON_TYP).toBe('Beleg');
    expect(head.BON_NOTIZ).toBe('TSE ausgefallen; Signatur nach Belegausgabe');
    expect(head.UMS_BRUTTO).toBe('8,00');
  });

  it('table service: AVBestellung + cancellation, payment references the orders, Abrechnungskreis = table/order', () => {
    const seq = new Sequence();
    const orderId = '7f3e2a10-1111-4000-8000-000000000001';
    const o1 = tableOrder(seq, {
      items: [
        { name: 'Bier', quantity: 2, price: 4, rate: 19 },
        { name: 'Schnitzel "Wiener Art"', quantity: 1, price: 14, rate: 7 },
      ],
      orderNumber: '17',
      orderId,
      tableNumber: '12',
    });
    const ref = {
      zNr: 1,
      closingCreatedAt: Z1,
      registerId: REGISTER_ID,
      bonId: o1.bonId,
    };
    const cancel = tableOrder(seq, {
      items: [{ name: 'Bier', quantity: -1, price: 4, rate: 19 }],
      orderNumber: '17',
      orderId,
      tableNumber: '12',
      cancellation: true,
      references: [ref],
    });
    const pay = sale(seq, VAT_LIABLE, {
      items: [
        { name: 'Bier', quantity: 1, price: 4, rate: 19 },
        { name: 'Schnitzel "Wiener Art"', quantity: 1, price: 14, rate: 7 },
      ],
      orderNumber: '17',
      orderId,
      tableNumber: '12',
      references: [ref, { ...ref, bonId: cancel.bonId }],
    });
    const { zip, result } = exportOf([closingInput(1, Z1, [o1, cancel, pay])]);
    expectValid(result);
    const heads = rowsOf(zip, 'transactions.csv');
    expect(heads.map((h) => [h.BON_TYP, h.BON_NAME, h.UMS_BRUTTO])).toEqual([
      ['AVBestellung', 'Bestellung', '22,00'],
      ['AVBestellung', 'Bestellstorno', '-4,00'],
      ['Beleg', 'Verkauf', '18,00'],
    ]);
    const kreis = rowsOf(zip, 'allocation_groups.csv');
    expect(new Set(kreis.map((k) => k.ABRECHNUNGSKREIS))).toEqual(
      new Set(['Tisch 12 / Bestellung 17 (7f3e2a10)']),
    );
    expect(rowsOf(zip, 'references.csv')).toHaveLength(3);
    // Bestellungen wirken nicht auf den Kassenabschluss.
    expect(rowsOf(zip, 'cashpointclosing.csv')[0].Z_SE_ZAHLUNGEN).toBe('18,00');
  });

  it('Kassenbuch: Anfangsbestand, Einlage, Entnahme (Geldtransit) and DifferenzSollIst', () => {
    const seq = new Sequence();
    const txs = [
      cashbook(
        seq,
        'opening_balance',
        15000,
        'Wechselgeld aus der Vereinskasse',
      ),
      sale(seq, VAT_EXEMPT, {
        items: [{ name: 'Kuchen', quantity: 4, price: 2.5, rate: 0 }],
      }),
      cashbook(seq, 'deposit', 5000),
      cashbook(seq, 'withdrawal', -12000, 'Abschöpfung in den Tresor'),
      cashbook(seq, 'cash_count', -150, 'Kassensturz: gezählt 52,50 €'),
    ];
    const { zip, result } = exportOf([
      closingInput(1, Z1, txs, { settings: VAT_EXEMPT }),
    ]);
    expectValid(result);
    const z = rowsOf(zip, 'businesscases.csv');
    expect(
      z.map((r) => [r.GV_TYP, r.GV_NAME, r.UST_SCHLUESSEL, r.Z_UMS_BRUTTO]),
    ).toEqual([
      ['Umsatz', '', '6', '10,00'],
      ['Anfangsbestand', 'Wechselgeld', '5', '150,00'],
      ['Geldtransit', 'Einlage', '5', '50,00'],
      ['Geldtransit', 'Entnahme', '5', '-120,00'],
      ['DifferenzSollIst', 'Kassensturz', '5', '-1,50'],
    ]);
    expect(rowsOf(zip, 'cashpointclosing.csv')[0].Z_SE_BARZAHLUNGEN).toBe(
      '88,50',
    );
    const totals = buildClosing(
      closingInput(1, Z1, txs, { settings: VAT_EXEMPT }),
    ).totals;
    expect(totals).toMatchObject({
      grossCents: 8850,
      salesGrossCents: 1000,
      cashCents: 8850,
    });
    expect(rowsOf(zip, 'transactions_tse.csv')[0].TSE_VORGANGSDATEN).toBe(
      'Beleg^0.00_0.00_0.00_0.00_150.00^150.00:Bar',
    );
  });

  it('multiple terminals and a TSE change within one closing', () => {
    const seq = new Sequence();
    const a = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Bier', quantity: 1, price: 4, rate: 19 }],
    });
    const b = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Cola', quantity: 1, price: 3, rate: 19 }],
      terminal: TERMINAL_2,
      unit: TSE_B,
    });
    const web = sale(seq, VAT_LIABLE, {
      items: [{ name: 'Wasser', quantity: 1, price: 2, rate: 19 }],
      terminal: null,
      unit: TSE_B,
    });
    const m = master();
    m.tseUnits = [m.tseUnits[0], TSE_B];
    const { zip, result } = exportOf([
      closingInput(1, Z1, [a, b, web], { master: m }),
    ]);
    expectValid(result);
    expect(rowsOf(zip, 'tse.csv').map((t) => t.TSE_ID)).toEqual(['1', '2']);
    expect(rowsOf(zip, 'transactions_tse.csv').map((t) => t.TSE_ID)).toEqual([
      '1',
      '2',
      '2',
    ]);
    expect(rowsOf(zip, 'slaves.csv')).toHaveLength(2);
    // Ohne Zertifikat nur ein Hinweis, kein Fehler.
    expect(result.warnings.map((w) => w.code)).toContain('MASTER_TSE_CERT');
  });

  it('split payments, partial amounts and zero receipts reconcile to the signed amounts', () => {
    const seq = new Sequence();
    const items = [
      { name: 'Bier', quantity: 3, price: 4, rate: 19 },
      { name: 'Pizza', quantity: 2, price: 9.5, rate: 7 },
    ];
    const split = sale(seq, VAT_LIABLE, {
      items,
      split: [
        { index: 0, quantity: 1 },
        { index: 1, quantity: 1 },
      ],
      discount: 2,
    });
    const part = sale(seq, VAT_LIABLE, {
      items,
      amount: 10,
      tip: 1,
      method: 'paypal',
    });
    const zero = zeroReceipt(seq, {
      items: [{ name: 'Freigetränk', quantity: 1, price: 3, rate: 19 }],
    });
    const { zip, result } = exportOf([
      closingInput(1, Z1, [split, part, zero]),
    ]);
    expectValid(result);
    expect(rowsOf(zip, 'datapayment.csv').map((p) => p.ZAHLART_TYP)).toEqual([
      'Bar',
      'ElZahlungsdienstleister',
      'Bar',
    ]);
  });

  it('is deterministic: same input → same content hash and same ZIP bytes', () => {
    const seq = new Sequence();
    const input = closingInput(1, Z1, [
      sale(seq, VAT_LIABLE, {
        items: [{ name: 'Bier', quantity: 1, price: 4, rate: 19 }],
      }),
    ]);
    const a = buildClosing(input).rows;
    const b = buildClosing(structuredClone(input)).rows;
    expect(contentHash(a)).toBe(contentHash(b));
    expect(
      buildExportZip(a, SUPPLIER, Z1).equals(buildExportZip(b, SUPPLIER, Z1)),
    ).toBe(true);
  });
});

describe('DSFinV-K validator catches broken exports', () => {
  function validExportFiles() {
    const seq = new Sequence();
    const txs = [
      sale(seq, VAT_LIABLE, {
        items: [{ name: 'Bier', quantity: 2, price: 4, rate: 19 }],
      }),
      sale(seq, VAT_LIABLE, {
        items: [{ name: 'Brezel', quantity: 1, price: 2.5, rate: 7 }],
      }),
    ];
    return buildExportFiles(
      buildClosing(closingInput(1, Z1, txs)).rows,
      SUPPLIER,
    );
  }
  function mutate(file: string, fn: (text: string) => string) {
    return validExportFiles().map((f) =>
      f.name === file
        ? { ...f, data: Buffer.from(fn(f.data.toString('utf8'))) }
        : f,
    );
  }
  const codes = (r: ValidationResult) => r.errors.map((e) => e.code);

  it('accepts the untouched export', () => {
    expectValid(validateFiles(validExportFiles()));
  });
  it('missing file', () => {
    expect(
      codes(
        validateFiles(validExportFiles().filter((f) => f.name !== 'lines.csv')),
      ),
    ).toContain('FILE_MISSING');
  });
  it('wrong header / column order', () => {
    expect(
      codes(
        validateFiles(
          mutate('lines.csv', (t) =>
            t.replace(
              'ARTIKELTEXT;POS_TERMINAL_ID',
              'POS_TERMINAL_ID;ARTIKELTEXT',
            ),
          ),
        ),
      ),
    ).toContain('CSV_HEADER');
  });
  it('decimal point instead of comma', () => {
    expect(
      codes(
        validateFiles(
          mutate('transactions.csv', (t) => t.replace(';8,00;', ';8.00;')),
        ),
      ),
    ).toContain('FIELD_NUMBER');
  });
  it('Bonkopf ≠ Σ Bonkopf_USt and Bonpos', () => {
    const r = validateFiles(
      mutate('transactions_vat.csv', (t) => t.replace(';8,00;', ';8,01;')),
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining(['SUM_BON_VAT', 'SUM_BON_LINES']),
    );
  });
  it('closing totals ≠ Σ Belege', () => {
    expect(
      codes(
        validateFiles(
          mutate('payment.csv', (t) => t.replace(';10,50', ';10,40')),
        ),
      ),
    ).toContain('SUM_Z_PAYMENT');
  });
  it('gap in BON_ID', () => {
    const r = validateFiles(
      validExportFiles().map((f) =>
        f.name.endsWith('.csv')
          ? {
              ...f,
              data: Buffer.from(
                f.data
                  .toString('utf8')
                  .replace(/;"2";/g, ';"3";')
                  .replace(/;2;"Beleg"/, ';3;"Beleg"'),
              ),
            }
          : f,
      ),
    );
    expect(codes(r)).toContain('BON_ID_GAP');
  });
  it('signed bon without TSE row', () => {
    expect(
      codes(
        validateFiles(
          mutate(
            'transactions_tse.csv',
            (t) => t.split('\r\n').slice(0, 2).join('\r\n') + '\r\n',
          ),
        ),
      ),
    ).toContain('TSE_MISSING');
  });
  it('TSE process data that does not match the bon', () => {
    expect(
      codes(
        validateFiles(
          mutate('transactions_tse.csv', (t) =>
            t.replace('Beleg^8.00', 'Beleg^9.00'),
          ),
        ),
      ),
    ).toContain('TSE_VAT_SLOTS');
  });
  it('missing Steuernummer and USt-IdNr', () => {
    const files = buildExportFiles(
      buildClosing(
        closingInput(1, Z1, [], {
          master: master({
            company: { ...master().company, taxNumber: '', vatId: '' },
          }),
        }),
      ).rows,
      SUPPLIER,
    );
    expect(codes(validateFiles(files))).toContain('COMPANY_TAX_ID');
  });
  it('not a ZIP', () => {
    expect(codes(validateZip(Buffer.from('hello')))).toEqual(['ZIP']);
  });
});
