import type { ProductOptions } from '../../database/entities/product.entity';
import {
  orderProductWhere,
  priceSelectedOptions,
} from './product-option-pricing';

const product = {
  name: 'Pommes',
  options: {
    groups: [
      {
        name: 'Größe',
        type: 'single',
        required: true,
        options: [
          { name: 'Klein', priceModifier: 0 },
          { name: 'Groß', priceModifier: 1.2 },
        ],
      },
      {
        name: 'Soßen',
        type: 'multiple',
        required: false,
        options: [
          { name: 'Ketchup', priceModifier: 0.3 },
          { name: 'Mayo', priceModifier: 0.3 },
        ],
      },
      {
        name: 'Zutaten',
        type: 'ingredients',
        required: false,
        options: [{ name: 'Salz', priceModifier: 0.1 }],
      },
    ],
  } as ProductOptions,
};

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { response?: { reason?: string } }).response?.reason;
  }
  return undefined;
};

describe('priceSelectedOptions', () => {
  it('takes every price from the definition', () => {
    const result = priceSelectedOptions(product, [
      { group: 'Größe', option: 'Groß', priceModifier: 0 },
      { group: 'Soßen', option: 'Ketchup', priceModifier: -10 },
      { group: 'Soßen', option: 'Mayo' },
    ]);
    expect(result.optionsPrice).toBe(1.8);
    expect(result.selected).toEqual([
      { group: 'Größe', option: 'Groß', priceModifier: 1.2 },
      { group: 'Soßen', option: 'Ketchup', priceModifier: 0.3 },
      { group: 'Soßen', option: 'Mayo', priceModifier: 0.3 },
    ]);
  });

  it('charges nothing for an excluded ingredient', () => {
    const result = priceSelectedOptions(product, [
      { group: 'Zutaten', option: 'Salz', priceModifier: -3, excluded: true },
    ]);
    expect(result).toEqual({
      optionsPrice: 0,
      selected: [
        { group: 'Zutaten', option: 'Salz', priceModifier: 0, excluded: true },
      ],
    });
  });

  it('accepts no options', () => {
    expect(priceSelectedOptions(product, undefined)).toEqual({
      selected: [],
      optionsPrice: 0,
    });
    expect(priceSelectedOptions({ name: 'X', options: null }, [])).toEqual({
      selected: [],
      optionsPrice: 0,
    });
  });

  it.each([
    ['an unknown option', [{ group: 'Größe', option: 'Riesig' }]],
    ['an unknown group', [{ group: 'Rabatt', option: 'Groß' }]],
    [
      'the same option twice',
      [
        { group: 'Soßen', option: 'Mayo' },
        { group: 'Soßen', option: 'Mayo' },
      ],
    ],
    [
      'two choices in a single-choice group',
      [
        { group: 'Größe', option: 'Klein' },
        { group: 'Größe', option: 'Groß' },
      ],
    ],
    [
      'an exclusion outside an ingredients group',
      [{ group: 'Soßen', option: 'Mayo', excluded: true }],
    ],
    [
      'a malformed entry',
      [
        { group: 42, option: null } as unknown as {
          group: string;
          option: string;
        },
      ],
    ],
  ])('rejects %s', (_label, options) => {
    expect(reason(() => priceSelectedOptions(product, options))).toBe(
      'PRODUCT_OPTION_INVALID',
    );
  });
});

describe('orderProductWhere', () => {
  it('scopes to the organization and the event of the order', () => {
    expect(
      orderProductWhere({ organizationId: 'org', eventId: 'ev' }, 'p'),
    ).toEqual({ id: 'p', eventId: 'ev', event: { organizationId: 'org' } });
  });

  it('scopes to the organization when the order has no event', () => {
    expect(
      orderProductWhere({ organizationId: 'org', eventId: null }, 'p'),
    ).toEqual({ id: 'p', event: { organizationId: 'org' } });
  });
});
