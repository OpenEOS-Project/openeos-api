import {
  BUILTIN_PRINT_TEMPLATES,
  ORDER_TICKET_TEMPLATE,
  RECEIPT_TEMPLATE,
  REFUND_RECEIPT_TEMPLATE,
  withPaymentLabel,
} from './builtin-templates';
import {
  formatOrganizationAddress,
  organizationPrintBlock,
  paymentMethodLabel,
} from './receipt-labels';

describe('receipt header address', () => {
  it('joins street, zip and city', () => {
    expect(
      formatOrganizationAddress({
        street: 'Hauptstr. 1',
        zip: '12345',
        city: 'Musterstadt',
        country: 'DE',
      }),
    ).toBe('Hauptstr. 1, 12345 Musterstadt');
  });

  it.each([
    [undefined],
    [null],
    [{}],
    [{ street: '', zip: '', city: '' }],
    [{ street: '  ', zip: undefined, city: null }],
  ])('returns undefined for an empty address (%j)', (address) => {
    expect(formatOrganizationAddress(address as never)).toBeUndefined();
  });

  it('drops missing parts without stray commas', () => {
    expect(formatOrganizationAddress({ street: 'Hauptstr. 1' })).toBe(
      'Hauptstr. 1',
    );
    expect(formatOrganizationAddress({ city: 'Musterstadt' })).toBe(
      'Musterstadt',
    );
    expect(
      formatOrganizationAddress({ street: 'Hauptstr. 1', city: 'Musterstadt' }),
    ).toBe('Hauptstr. 1, Musterstadt');
  });

  it('never carries undefined into the print payload', () => {
    const block = organizationPrintBlock({
      name: 'Verein',
      settings: { address: {} as never, contact: { email: 'x@y.de' } },
    });
    expect(JSON.parse(JSON.stringify(block))).toEqual({ name: 'Verein' });
  });
});

describe('payment labels', () => {
  it.each([
    ['cash', 'Bar'],
    ['card', 'Karte'],
    ['sumup_terminal', 'Karte (SumUp)'],
    ['sumup_online', 'Online (SumUp)'],
    ['paypal', 'PayPal'],
    ['google_pay', 'Google Pay'],
    ['apple_pay', 'Apple Pay'],
  ])('%s → %s', (method, label) => {
    expect(paymentMethodLabel(method)).toBe(label);
  });

  it('keeps unknown values and skips empty ones', () => {
    expect(paymentMethodLabel('voucher')).toBe('voucher');
    expect(paymentMethodLabel(null)).toBeUndefined();
  });
});

describe('templates print the payment label and a clean header', () => {
  it.each([RECEIPT_TEMPLATE, ORDER_TICKET_TEMPLATE, REFUND_RECEIPT_TEMPLATE])(
    '%s never prints the raw payment method',
    (name) => {
      const source = BUILTIN_PRINT_TEMPLATES[name];
      expect(source).not.toMatch(/\{\{\s*payment_method\s*\}\}/);
      expect(source).toContain('payment_label|default(payment_method)');
    },
  );

  it.each([RECEIPT_TEMPLATE, REFUND_RECEIPT_TEMPLATE])(
    '%s skips empty address and phone',
    (name) => {
      const source = BUILTIN_PRINT_TEMPLATES[name];
      expect(source).toContain(
        '{% if organization.address is defined and organization.address %}',
      );
      expect(source).toContain(
        '{% if organization.phone is defined and organization.phone %}',
      );
    },
  );

  it('rewrites the raw output in custom templates, not conditions', () => {
    const custom = [
      '{% if payment_method is defined %}',
      'Zahlungsart: {{ payment_method }}',
      'Art: {{payment_method}}',
      '{% if payment_method == "cash" %}Bar!{% endif %}',
      '{% endif %}',
    ].join('\n');
    expect(withPaymentLabel(custom)).toBe(
      [
        '{% if payment_method is defined %}',
        'Zahlungsart: {{ payment_label|default(payment_method) }}',
        'Art: {{ payment_label|default(payment_method) }}',
        '{% if payment_method == "cash" %}Bar!{% endif %}',
        '{% endif %}',
      ].join('\n'),
    );
    // Idempotent: schon umgestellte Vorlagen bleiben gleich.
    expect(withPaymentLabel(withPaymentLabel(custom))).toBe(
      withPaymentLabel(custom),
    );
  });
});
