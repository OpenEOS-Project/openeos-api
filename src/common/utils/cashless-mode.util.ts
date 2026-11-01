/**
 * Bargeldloser Modus der Organisation (`settings.payments.cashless`).
 *
 * Hintergrund: Eine elektronische Kasse braucht eine zertifizierte TSE nur,
 * wenn sie Bargeld erfassen kann (AEAO zu § 146a AO). Ein Verein ohne TSE
 * kann OpenEOS deshalb rein bargeldlos betreiben — dann muss der Ausschluss
 * aber technisch durchgesetzt sein, nicht nur in der Oberflaeche. Jeder
 * Einstieg, der Bargeld bucht oder auszahlt, ruft deshalb
 * `assertCashAllowed` (cash-policy.util.ts) auf: Zahlung mit Bestellung, Einzel-, Teil- und
 * Sammelzahlung (Kasse und Verwaltung), Erstattung auf eine Barzahlung,
 * Pfand-Auszahlung und die Kassenlade.
 *
 * Nur ein ausdrueckliches `true` zaehlt; ohne Eintrag bleibt alles wie
 * bisher (Bargeld erlaubt).
 */
export function isCashlessMode(settings: object | null | undefined): boolean {
  const payments = (settings as { payments?: unknown } | null)?.payments;
  if (!payments || typeof payments !== 'object') return false;
  return (payments as { cashless?: unknown }).cashless === true;
}
