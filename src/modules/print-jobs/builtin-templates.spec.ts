import {
  BUILTIN_PRINT_TEMPLATES,
  PFAND_RETURN_RECEIPT_TEMPLATE,
  RECEIPT_TEMPLATE,
  REFUND_RECEIPT_TEMPLATE,
  TSE_PRINT_BLOCK,
  TSE_RECEIPT_TEMPLATES,
  WAITER_SETTLEMENT_TEMPLATE,
  agentTemplateMap,
  withTseBlock,
} from './builtin-templates';

describe('builtin print templates and the Cloud-TSE block', () => {
  it('serves receipt and refund receipt with the TSE block', () => {
    expect(TSE_RECEIPT_TEMPLATES).toEqual([
      RECEIPT_TEMPLATE,
      REFUND_RECEIPT_TEMPLATE,
      PFAND_RETURN_RECEIPT_TEMPLATE,
    ]);
    for (const name of TSE_RECEIPT_TEMPLATES) {
      const source = BUILTIN_PRINT_TEMPLATES[name];
      expect(source).toContain(TSE_PRINT_BLOCK);
      expect(source.trimEnd().endsWith('<<CUT>>')).toBe(true);
    }
  });

  it('serves the waiter settlement without TSE block, with signature lines', () => {
    const source = BUILTIN_PRINT_TEMPLATES[WAITER_SETTLEMENT_TEMPLATE];
    expect(TSE_RECEIPT_TEMPLATES).not.toContain(WAITER_SETTLEMENT_TEMPLATE);
    expect(source).not.toContain('tse.');
    expect(source).toContain('Kasse / Schichtleitung');
    expect(source).toContain('{% if signatures|default(true) %}');
    expect(source.trimEnd().endsWith('<<CUT>>')).toBe(true);
    expect(agentTemplateMap([])[WAITER_SETTLEMENT_TEMPLATE]).toBe(source);
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
    expect(TSE_PRINT_BLOCK).toContain('TSE nicht erreichbar');
    expect(TSE_PRINT_BLOCK).toContain('Beleg ohne Signatur');
    // Signatur nach Belegausgabe nur gekennzeichnet, ohne QR-Code.
    expect(TSE_PRINT_BLOCK).toContain('Signatur nach Belegausgabe:');
    expect(TSE_PRINT_BLOCK).toContain('tse.late_signature.signature_counter');
    expect(TSE_PRINT_BLOCK).not.toContain('late_signature.qr');
    // Beginn der ersten Bestellung (DSFinV-K Tz. 2.7.3), signiert und bei Ausfall.
    expect(
      TSE_PRINT_BLOCK.match(/\("Bestellbeginn: " ~ tse\.order_start_time\)/g),
    ).toHaveLength(2);
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

  it('prints the deposit return receipt with number, lines, VAT and cash', () => {
    const source = BUILTIN_PRINT_TEMPLATES[PFAND_RETURN_RECEIPT_TEMPLATE];
    for (const part of [
      'return_number',
      'item.unit_amount|currency',
      'tax_lines',
      '"AUSGEZAHLT:"',
      'payment_label|default("Bar")',
      'device_name',
      'actor_name',
      '-- NACHDRUCK --',
      '** TESTMODUS **',
    ]) {
      expect(source).toContain(part);
    }
  });

  it('shows the deposit on the sales receipt (part of GESAMT and VAT)', () => {
    const source = BUILTIN_PRINT_TEMPLATES[RECEIPT_TEMPLATE];
    expect(source).toContain('{{ row("Pfand:", pfand_total|float|currency) }}');
    expect(source).toContain(
      '{{ row("Rabatt:", (0 - discount_amount|float)|currency) }}',
    );
  });

  it('serves builtin templates to agents unless the org has its own', () => {
    const map = agentTemplateMap([
      {
        type: RECEIPT_TEMPLATE,
        template: { generatedTemplate: 'Bon {{ payment_method }}\n<<CUT>>' },
      },
    ]);
    expect(map[PFAND_RETURN_RECEIPT_TEMPLATE]).toBe(
      BUILTIN_PRINT_TEMPLATES[PFAND_RETURN_RECEIPT_TEMPLATE],
    );
    expect(map[RECEIPT_TEMPLATE]).toContain(
      '{{ payment_label|default(payment_method) }}',
    );
    expect(map[RECEIPT_TEMPLATE]).toContain(TSE_PRINT_BLOCK);
  });
});
