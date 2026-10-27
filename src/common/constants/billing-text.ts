/**
 * Der Hinweis nach § 19 UStG auf jeder Rechnung. Derselbe Wortlaut wie in
 * der Oberflaeche (events.checkout.noVat) — der Betreiber weist keine
 * Umsatzsteuer aus, deshalb traegt die Rechnung keine Steuersaetze.
 *
 * Eigene Datei ohne Abhaengigkeiten: Mail- und Rechnungsdienst brauchen den
 * Text beide, duerfen sich aber nicht gegenseitig importieren — sonst ist
 * beim Start einer der beiden noch undefined, und Nest kann die
 * Abhaengigkeiten nicht aufloesen.
 */
export const VAT_EXEMPT_NOTE =
  'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.';
