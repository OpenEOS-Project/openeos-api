import {
  CSV_BOM,
  csvHeader,
  csvLine,
  csvMoney,
  csvNumber,
  csvText,
} from './csv.util';

describe('csv.util (Excel DE)', () => {
  it('BOM is the UTF-8 byte order mark', () => {
    expect(Buffer.from(CSV_BOM, 'utf8')).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
  });

  it('joins cells with semicolons and ends lines with CRLF', () => {
    expect(csvLine(['a', 'b', ''])).toBe('a;b;\r\n');
    expect(csvHeader(['Gerät', 'MwSt-Satz (%)'])).toBe(
      'Gerät;MwSt-Satz (%)\r\n',
    );
  });

  it('quotes fields with separator, quotes or line breaks', () => {
    expect(csvText('Pommes; groß')).toBe('"Pommes; groß"');
    expect(csvText('Der "Große"')).toBe('"Der ""Große"""');
    expect(csvText('Zeile 1\nZeile 2')).toBe('"Zeile 1\nZeile 2"');
    expect(csvText('a\r\nb')).toBe('"a\r\nb"');
    // Komma ist bei Semikolon-CSV kein Sonderzeichen.
    expect(csvText('Bratwurst, scharf')).toBe('Bratwurst, scharf');
  });

  it('leaves empty values empty', () => {
    expect(csvText(null)).toBe('');
    expect(csvText(undefined)).toBe('');
    expect(csvNumber(null)).toBe('');
    expect(csvMoney(undefined)).toBe('');
    expect(csvMoney('')).toBe('');
  });

  it('neutralises formulas in text cells', () => {
    expect(csvText('=HYPERLINK("http://x")')).toBe(
      `"'=HYPERLINK(""http://x"")"`,
    );
    expect(csvText('+49 170')).toBe("'+49 170");
    expect(csvText('-Tisch')).toBe("'-Tisch");
    expect(csvText('@SUMME(A1)')).toBe("'@SUMME(A1)");
    expect(csvText('\tx')).toBe("'\tx");
  });

  it('formats money with a decimal comma and two places, no thousands separator', () => {
    expect(csvMoney(12.5)).toBe('12,50');
    expect(csvMoney('1234.5')).toBe('1234,50');
    expect(csvMoney(0)).toBe('0,00');
    expect(csvMoney(-3.2)).toBe('-3,20');
    expect(csvMoney(-0.001)).toBe('0,00');
  });

  it('formats plain numbers with as many decimals as needed', () => {
    expect(csvNumber('19.00')).toBe('19');
    expect(csvNumber(7)).toBe('7');
    expect(csvNumber('10.70')).toBe('10,7');
    expect(csvNumber(3)).toBe('3');
    expect(csvNumber('abc')).toBe('');
  });
});
