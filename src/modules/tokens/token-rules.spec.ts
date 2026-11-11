import { resetTseStatus, tseStatus } from '../../common/utils/tse.util';
import { operatingModeView } from '../../common/utils/operating-mode.util';
import {
  receiptTokenBlock,
  withoutSinglePurposeTax,
} from '../print-jobs/receipt-tax.util';
import { tokenTransactionPrintData } from '../print-jobs/order-print.service';
import { buildSettlementTotals } from '../waiters/waiter-settlement-math';
import {
  allocateTokens,
  assertTokensAllowed,
  effectiveKind,
  isItemEligible,
  isTokensAllowed,
  paymentTokenLines,
  singlePurposeProblem,
  tokenTaxLines,
  type TokenOrderInput,
  type TokenTypeLike,
} from './token-rules';

const multi: TokenTypeLike = {
  id: 'multi',
  name: '2-€-Marke',
  value: 2,
  kind: 'multi_purpose',
  vatRate: null,
};
const drinks: TokenTypeLike = {
  id: 'drinks',
  name: 'Getränkemarke',
  value: 3,
  kind: 'single_purpose',
  vatRate: 19,
};
const beerOnly: TokenTypeLike = {
  id: 'beer',
  name: 'Biermarke',
  value: 4,
  kind: 'multi_purpose',
  vatRate: null,
  eventId: 'event',
  allowedProductIds: ['bier'],
};

function order(
  id: string,
  items: {
    id: string;
    rate: number;
    cents: number;
    deposit?: number;
    product?: string;
  }[],
  extraCents = 0,
): TokenOrderInput {
  return {
    id,
    dueCents:
      items.reduce((s, i) => s + i.cents + (i.deposit ?? 0), 0) + extraCents,
    items: items.map((i) => ({
      id: i.id,
      productId: i.product ?? i.id,
      categoryId: null,
      taxRate: i.rate,
      status: 'delivered',
      openCents: i.cents,
      depositCents: i.deposit ?? 0,
    })),
  };
}

describe('Wertmarken: operating mode (Steuerberater Frage 13, AEAO 1.2)', () => {
  afterEach(() => resetTseStatus());

  it('only „Alle Funktionen“; Germany needs an active Cloud-TSE, also for legacy orgs', () => {
    const de = { country: 'DE', operatingMode: 'full' };
    expect(isTokensAllowed(de)).toBe(false);
    expect(isTokensAllowed({ ...de, operatingModeLegacy: true })).toBe(false);
    expect(isTokensAllowed({ country: 'AT', operatingMode: 'full' })).toBe(
      true,
    );
    expect(isTokensAllowed({ country: 'AT', operatingMode: 'cashless' })).toBe(
      false,
    );
    expect(
      isTokensAllowed({ country: 'CH', operatingMode: 'orders_only' }),
    ).toBe(false);
    tseStatus.isActive = () => true;
    expect(isTokensAllowed(de)).toBe(true);
    expect(operatingModeView(de).tokensAllowed).toBe(true);
    expect(isTokensAllowed({ ...de, operatingMode: 'cashless' })).toBe(false);
  });

  it('answers with the same codes as cash', () => {
    const code = (org: object) => {
      try {
        assertTokensAllowed(org);
        return null;
      } catch (e) {
        return (e as { response: { code: string; reason?: string } }).response;
      }
    };
    expect(code({ country: 'DE', operatingMode: 'orders_only' })).toMatchObject(
      {
        code: 'ORDER_ONLY_MODE',
      },
    );
    expect(code({ country: 'DE', operatingMode: 'cashless' })).toMatchObject({
      code: 'CASH_PAYMENTS_DISABLED',
      reason: 'PAYMENT_METHOD_NOT_ALLOWED_CASHLESS',
    });
    expect(code({ country: 'DE', operatingMode: 'full' })).toMatchObject({
      code: 'TSE_REQUIRED_FOR_TOKENS',
    });
    expect(code({ country: 'AT', operatingMode: 'full' })).toBeNull();
  });
});

describe('Wertmarken: Einzweck rules', () => {
  it('needs exactly one rate for all assigned articles; never for small businesses', () => {
    expect(
      singlePurposeProblem({
        vatRate: 19,
        vatExempt: false,
        restrictedRates: null,
      }),
    ).toBeNull();
    expect(
      singlePurposeProblem({
        vatRate: 19,
        vatExempt: false,
        restrictedRates: [19, 19],
      }),
    ).toBeNull();
    expect(
      singlePurposeProblem({
        vatRate: 19,
        vatExempt: false,
        restrictedRates: [19, 7],
      }),
    ).toMatchObject({
      reason: 'TOKEN_SINGLE_PURPOSE_MIXED_RATES',
      params: { rates: [19, 7] },
    });
    expect(
      singlePurposeProblem({
        vatRate: 7,
        vatExempt: false,
        restrictedRates: [19],
      }),
    ).toMatchObject({ reason: 'TOKEN_SINGLE_PURPOSE_MIXED_RATES' });
    expect(
      singlePurposeProblem({
        vatRate: 19,
        vatExempt: false,
        restrictedRates: [],
      }),
    ).toMatchObject({ reason: 'TOKEN_SINGLE_PURPOSE_NO_PRODUCTS' });
    expect(
      singlePurposeProblem({
        vatRate: null,
        vatExempt: false,
        restrictedRates: null,
      }),
    ).toMatchObject({ reason: 'TOKEN_SINGLE_PURPOSE_RATE_REQUIRED' });
    expect(
      singlePurposeProblem({
        vatRate: 19,
        vatExempt: true,
        restrictedRates: null,
      }),
    ).toMatchObject({ reason: 'TOKEN_SINGLE_PURPOSE_SMALL_BUSINESS' });
    // Unbekannt (Organisation ohne Angabe) gilt als steuerbefreit.
    expect(effectiveKind('single_purpose', undefined)).toBe('multi_purpose');
    expect(effectiveKind('single_purpose', false)).toBe('single_purpose');
  });

  it('eligibility: Einzweck only at its rate, article selection by product or category', () => {
    const item = (
      rate: number,
      product = 'p',
      category: string | null = null,
    ) => ({
      id: 'i',
      productId: product,
      categoryId: category,
      taxRate: rate,
      status: 'delivered',
    });
    expect(isItemEligible(drinks, item(19))).toBe(true);
    expect(isItemEligible(drinks, item(7))).toBe(false);
    expect(isItemEligible(multi, item(7))).toBe(true);
    expect(isItemEligible(beerOnly, item(19, 'bier'))).toBe(true);
    expect(isItemEligible(beerOnly, item(19, 'cola'))).toBe(false);
    expect(
      isItemEligible(
        { ...multi, eventId: 'e', allowedCategoryIds: ['cat'] },
        item(7, 'x', 'cat'),
      ),
    ).toBe(true);
    expect(isItemEligible(multi, { ...item(19), status: 'cancelled' })).toBe(
      false,
    );
  });
});

describe('Wertmarken: allocation over the orders of a checkout', () => {
  it('Mehrzweck covers goods, deposit and tip; the rest is money', () => {
    const a = order(
      'a',
      [{ id: 'bier', rate: 19, cents: 400, deposit: 200 }],
      100,
    );
    const result = allocateTokens([a], [{ type: multi, count: 3 }]);
    expect(result.totalByOrder.get('a')).toBe(600);
    expect(result.moneyDueCents).toBe(100);
    expect(result.excessCents).toBe(0);
  });

  it('restricted tokens first and only for their items; Mehrzweck takes the rest', () => {
    const a = order('a', [{ id: 'wurst', rate: 7, cents: 600 }]);
    const b = order('b', [{ id: 'bier', rate: 19, cents: 400, deposit: 200 }]);
    const result = allocateTokens(
      [a, b],
      [
        { type: multi, count: 2 },
        { type: drinks, count: 1 },
      ],
    );
    // Getraenkemarke (3 €) auf das Bier (nicht aufs Pfand), 2-€-Marken
    // zuerst auf die Wurst.
    expect(result.perOrder.get('b')?.get('drinks')).toBe(300);
    expect(result.perOrder.get('a')?.get('multi')).toBe(400);
    expect(result.moneyDueCents).toBe(200 + 300);
    expect(result.excessCents).toBe(0);
  });

  it('reports excess: overpayment vs. tokens that do not fit the articles', () => {
    const food = order('f', [{ id: 'wurst', rate: 7, cents: 300 }]);
    const notEligible = allocateTokens([food], [{ type: drinks, count: 1 }]);
    expect(notEligible.excessByType.get('drinks')).toBe(300);
    expect(notEligible.moneyDueCents).toBe(300);

    const beer = order('b', [{ id: 'bier', rate: 19, cents: 500 }]);
    const over = allocateTokens([beer], [{ type: multi, count: 3 }]);
    expect(over.excessCents).toBe(100);
    expect(over.moneyDueCents).toBe(0);

    const beerToken = allocateTokens(
      [order('c', [{ id: 'bier', rate: 19, cents: 450, product: 'bier' }])],
      [{ type: beerOnly, count: 1 }],
    );
    expect(beerToken.totalByOrder.get('c')).toBe(400);
  });

  it('snapshots per payment: fractional counts when a token spans two orders', () => {
    const types = new Map([[multi.id, multi]]);
    expect(paymentTokenLines(new Map([['multi', 300]]), types, false)).toEqual([
      {
        tokenTypeId: 'multi',
        name: '2-€-Marke',
        kind: 'multi_purpose',
        unitValue: 2,
        count: 1.5,
        amount: 3,
        vatRate: null,
      },
    ]);
    const single = new Map([[drinks.id, drinks]]);
    expect(
      paymentTokenLines(new Map([['drinks', 300]]), single, false)[0],
    ).toMatchObject({
      kind: 'single_purpose',
      vatRate: 19,
    });
    // Kleinunternehmer: immer Mehrzweck.
    expect(
      paymentTokenLines(new Map([['drinks', 300]]), single, true)[0],
    ).toMatchObject({
      kind: 'multi_purpose',
      vatRate: null,
    });
  });
});

describe('Wertmarken: VAT lines and receipts', () => {
  it('VAT lines only for Einzweck sales (and negative for Rücktausch)', () => {
    expect(
      tokenTaxLines(
        [
          { kind: 'multi_purpose', amount: 20, vatRate: null },
          { kind: 'single_purpose', amount: 30, vatRate: 19 },
        ],
        false,
      ),
    ).toEqual([{ rate: 19, gross: 30, tax: 4.79, net: 25.21 }]);
    expect(
      tokenTaxLines(
        [{ kind: 'single_purpose', amount: -6, vatRate: 19 }],
        false,
      ),
    ).toEqual([{ rate: 19, gross: -6, tax: -0.96, net: -5.04 }]);
    expect(
      tokenTaxLines(
        [{ kind: 'single_purpose', amount: 30, vatRate: 19 }],
        true,
      ),
    ).toEqual([]);
  });

  it('redemption receipt: „bezahlt mit Wertmarken“ and no second VAT on Einzweck goods', () => {
    const block = receiptTokenBlock(
      [
        {
          name: '2-€-Marke',
          kind: 'multi_purpose',
          unitValue: 2,
          count: 3,
          amount: 6,
        },
        {
          name: 'Getränkemarke',
          kind: 'single_purpose',
          unitValue: 3,
          count: 1,
          amount: 3,
          vatRate: 19,
        },
      ],
      false,
    );
    expect(block.tokens?.map((t) => t.label)).toEqual([
      '3 x 2,00 EUR 2-€-Marke',
      '1 x 3,00 EUR Getränkemarke',
    ]);
    expect(block.token_amount).toBe(9);
    expect(block.token_note).toContain('Mehrzweck');
    expect(block.token_note).toContain('Einzweck');
    const tax = withoutSinglePurposeTax(
      {
        tax_amount: 1.71,
        tax_lines: [
          { rate: 19, gross: 7, tax: 1.12, net: 5.88 },
          { rate: 7, gross: 9, tax: 0.59, net: 8.41 },
        ],
      },
      [
        {
          name: 'G',
          kind: 'single_purpose',
          unitValue: 3,
          count: 1,
          amount: 3,
          vatRate: 19,
        },
      ],
    );
    expect(tax.tax_lines?.[0]).toEqual({
      rate: 19,
      gross: 4,
      tax: 0.64,
      net: 3.36,
    });
    expect(tax.tax_amount).toBe(1.23);
    expect(receiptTokenBlock([], false)).toEqual({});
  });

  it('token receipt data: „Wertmarken (Mehrzweck-Gutschein, nicht steuerbar)“, change, negative Rücktausch', () => {
    const sale = tokenTransactionPrintData(
      {
        id: 't',
        kind: 'sale',
        transactionNumber: 'W-20261111-0001',
        createdAt: new Date(),
        lines: [
          {
            tokenTypeId: 'a',
            name: '2-€-Marke',
            kind: 'multi_purpose',
            unitValue: 2,
            count: 10,
            amount: 20,
            vatRate: null,
          },
        ],
        totalAmount: 20,
        taxLines: [],
        paymentMethod: 'cash',
        amountReceived: 50,
        reason: null,
      },
      false,
    );
    expect(sale).toMatchObject({
      token_kind: 'sale',
      total: 20,
      change: 30,
      payment_label: 'Bar',
      items: [
        expect.objectContaining({
          count: 10,
          kind_label: 'Wertmarken (Mehrzweck-Gutschein, nicht steuerbar)',
        }),
      ],
    });
    const buyback = tokenTransactionPrintData(
      {
        id: 'b',
        kind: 'buyback',
        transactionNumber: 'W-20261111-0002',
        createdAt: new Date(),
        lines: [
          {
            tokenTypeId: 'g',
            name: 'Getränkemarke',
            kind: 'single_purpose',
            unitValue: 3,
            count: -2,
            amount: -6,
            vatRate: 19,
          },
        ],
        totalAmount: -6,
        taxLines: [{ rate: 19, gross: -6, tax: -0.96, net: -5.04 }],
        paymentMethod: 'cash',
        amountReceived: null,
        reason: 'Ende',
      },
      false,
    );
    expect(buyback).toMatchObject({
      total: -6,
      tax_amount: -0.96,
      reason: 'Ende',
      items: [
        expect.objectContaining({
          count: 2,
          total: -6,
          kind_label: 'Wertmarken (Einzweck-Gutschein, 19 % USt)',
        }),
      ],
    });
    expect(buyback.change).toBeUndefined();
  });
});

describe('Wertmarken: waiter settlement', () => {
  it('counts received tokens per type (not cash), token sales and Rücktausch move the drawer', () => {
    const totals = buildSettlementTotals({
      operatingMode: 'full',
      payments: [
        {
          method: 'cash',
          isTest: false,
          deviceId: 'd1',
          deviceName: 'Theke',
          count: 2,
          amount: 4,
          tip: 0,
        },
        {
          method: 'tokens',
          isTest: false,
          deviceId: 'd1',
          deviceName: 'Theke',
          count: 3,
          amount: 0,
          tip: 2,
        },
      ],
      refunds: [],
      pfandReturns: [],
      taken: [],
      items: [],
      tokenRedemptions: [
        {
          isTest: false,
          tokenTypeId: 'a',
          name: '2-€-Marke',
          unitValue: 2,
          count: 9,
          amount: 18,
        },
        {
          isTest: false,
          tokenTypeId: 'g',
          name: 'Getränkemarke',
          unitValue: 4,
          count: 1,
          amount: 4,
        },
        {
          isTest: true,
          tokenTypeId: 'a',
          name: '2-€-Marke',
          unitValue: 2,
          count: 5,
          amount: 10,
        },
      ],
      tokenTransactions: [
        {
          kind: 'sale',
          method: 'cash',
          isTest: false,
          deviceId: 'd2',
          deviceName: 'Zentralkasse',
          count: 50,
          amount: 100,
        },
        {
          kind: 'sale',
          method: 'card',
          isTest: false,
          deviceId: 'd2',
          deviceName: 'Zentralkasse',
          count: 10,
          amount: 20,
        },
        {
          kind: 'buyback',
          method: 'cash',
          isTest: false,
          deviceId: 'd2',
          deviceName: 'Zentralkasse',
          count: 3,
          amount: -6,
        },
      ],
    });
    expect(totals.payments?.total).toEqual({ count: 2, amount: 4 });
    expect(totals.tips).toBe(2);
    expect(totals.tokens).toEqual({
      received: { count: 10, amount: 22 },
      receivedByType: [
        {
          tokenTypeId: 'a',
          name: '2-€-Marke',
          unitValue: 2,
          count: 9,
          amount: 18,
        },
        {
          tokenTypeId: 'g',
          name: 'Getränkemarke',
          unitValue: 4,
          count: 1,
          amount: 4,
        },
      ],
      sold: { count: 60, amount: 120 },
      soldCash: 100,
      boughtBack: { count: 3, amount: 6 },
    });
    // Soll bar: 4 bar kassiert + 100 Marken bar verkauft − 6 Ruecktausch.
    expect(totals.cashExpected).toBe(98);
    expect(totals.cashByDevice).toEqual([
      { deviceId: 'd2', deviceName: 'Zentralkasse', amount: 94 },
      { deviceId: 'd1', deviceName: 'Theke', amount: 4 },
    ]);
  });
});
