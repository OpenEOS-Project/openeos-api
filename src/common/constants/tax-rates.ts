/**
 * Umsatzsteuersaetze je Land.
 *
 * Bewusst nur Deutschland. Ein Satz, den niemand geprueft hat, ist
 * schlimmer als kein Satz: er sieht richtig aus und landet auf einem
 * Beleg. Weitere Laender kommen, wenn es dort Nutzer gibt.
 */
export interface TaxRateOption {
  /** Prozentsatz. */
  rate: number;
  /** Schluessel fuer die Beschriftung in der Oberflaeche. */
  labelKey: 'standard' | 'reduced' | 'zero';
}

export const TAX_RATES_BY_COUNTRY: Record<string, TaxRateOption[]> = {
  DE: [
    { rate: 19, labelKey: 'standard' },
    { rate: 7, labelKey: 'reduced' },
    { rate: 0, labelKey: 'zero' },
  ],
};

/** Der einzige Satz, der fuer eine steuerbefreite Organisation infrage kommt. */
export const TAX_RATE_EXEMPT: TaxRateOption[] = [{ rate: 0, labelKey: 'zero' }];

/**
 * Welche Saetze darf diese Organisation waehlen?
 *
 * Ist sie steuerbefreit, bleibt es bei 0 — unabhaengig vom Land. Kennen
 * wir das Land nicht, gilt dasselbe: lieber keine Auswahl anbieten als
 * eine falsche.
 */
export function taxRatesFor(country: string | undefined, vatExempt: boolean | undefined): TaxRateOption[] {
  if (vatExempt !== false) return TAX_RATE_EXEMPT;
  return TAX_RATES_BY_COUNTRY[(country || '').toUpperCase()] ?? TAX_RATE_EXEMPT;
}
