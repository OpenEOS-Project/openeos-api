import {
  BUILTIN_PRINT_TEMPLATES,
  RECEIPT_TEMPLATE,
  REFUND_RECEIPT_TEMPLATE,
  TSE_PRINT_BLOCK,
  TSE_RECEIPT_TEMPLATES,
  withTseBlock,
} from './builtin-templates';

describe('builtin print templates and the Cloud-TSE block', () => {
  it('serves receipt and refund receipt with the TSE block', () => {
    expect(TSE_RECEIPT_TEMPLATES).toEqual([
      RECEIPT_TEMPLATE,
      REFUND_RECEIPT_TEMPLATE,
    ]);
    for (const name of TSE_RECEIPT_TEMPLATES) {
      const source = BUILTIN_PRINT_TEMPLATES[name];
      expect(source).toContain(TSE_PRINT_BLOCK);
      expect(source.trimEnd().endsWith('<<CUT>>')).toBe(true);
    }
  });

  it('prints every field the contract requires (§8.6)', () => {
    for (const field of [
      'tse.client_id',
      'tse.bon_number',
      'tse.serial_number',
      'tse.transaction_number',
      'tse.signature_counter',
      'tse.start_time',
      'tse.finish_time',
      'tse.signature_algorithm',
      'tse.log_time_format',
      'tse.signature',
      'tse.qr_code',
    ]) {
      expect(TSE_PRINT_BLOCK).toContain(field);
    }
    expect(TSE_PRINT_BLOCK).toContain('TSE ausgefallen');
    expect(TSE_PRINT_BLOCK).toContain('TRAININGSBUCHUNG - KEIN VERKAUF');
    expect(TSE_PRINT_BLOCK).toContain('<<QRCODE:{{ tse.qr_code }}>>');
    // Jinja bekommt "\n" als Escape, keinen echten Zeilenumbruch.
    expect(TSE_PRINT_BLOCK).toContain('wordwrap(tse_cols, true, "\\n")');
  });

  it('prints the Beleg-Nr. with and without TSE signature', () => {
    expect(TSE_PRINT_BLOCK.match(/^Beleg-Nr\.: /gm) ?? []).toHaveLength(0);
    expect(
      TSE_PRINT_BLOCK.match(/\("Beleg-Nr\.: " ~ tse\.bon_number\)/g),
    ).toHaveLength(2);
  });

  it('derives the line width from the printer columns or paper width', () => {
    for (const source of Object.values(BUILTIN_PRINT_TEMPLATES)) {
      expect(source).toContain(
        '{% set cols = columns|default(42 if paper_width|default(80) == 80 else 32, true)|int %}',
      );
      // Feste Spaltenbreiten (ljust(cols - 14) + rjust(10)) ergaben 43
      // Zeichen auf 42-Zeichen-Druckern.
      expect(source).not.toMatch(/ljust\(cols - \d+\)/);
    }
    expect(TSE_PRINT_BLOCK).toContain(
      'columns|default(42 if paper_width|default(80) == 80 else 32, true)|int',
    );
  });

  it('adds the block to a custom receipt before feed and cut', () => {
    const custom = [
      '{% set cols = 42 %}',
      '{{ organization.name }}',
      'GESAMT {{ total }}',
      '<<FEED:3>>',
      '<<CUT>>',
    ].join('\n');
    const result = withTseBlock(custom);
    const blockAt = result.indexOf(TSE_PRINT_BLOCK);
    expect(blockAt).toBeGreaterThan(result.indexOf('GESAMT'));
    expect(blockAt).toBeLessThan(result.indexOf('<<FEED:3>>'));
    expect(result.endsWith('<<CUT>>')).toBe(true);
  });

  it('appends the block when a custom template has no cut', () => {
    const result = withTseBlock('Hallo {{ total }}\n');
    expect(result.startsWith('Hallo {{ total }}\n')).toBe(true);
    expect(result.endsWith(TSE_PRINT_BLOCK)).toBe(true);
  });

  it('leaves templates that already print the TSE data alone', () => {
    const own = 'Kasse {{ tse.client_id }}\n<<CUT>>';
    expect(withTseBlock(own)).toBe(own);
    expect(withTseBlock(BUILTIN_PRINT_TEMPLATES[RECEIPT_TEMPLATE])).toBe(
      BUILTIN_PRINT_TEMPLATES[RECEIPT_TEMPLATE],
    );
  });
});
