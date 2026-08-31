import type { ValueTransformer } from 'typeorm';

/**
 * Dezimalspalten als Zahlen statt als Strings.
 *
 * TypeORM gibt `decimal`/`numeric` als String zurück, weil JavaScript
 * keine beliebige Genauigkeit kennt. Die Entities deklarieren die
 * Felder aber als `number` — die Typangabe war damit schlicht falsch,
 * und wer damit rechnete, verkettete Text:
 *
 *   orders.reduce((sum, o) => sum + o.paidAmount, 0)
 *   // 0 + '9.60' + '11.20'  ->  '09.6011.20'
 *
 * Genau so hat die Kachel "Umsatz heute" den Betrag der ersten
 * Bestellung gezeigt statt der Tagessumme.
 *
 * Bei Geldbeträgen dieser Größenordnung ist doppelte Genauigkeit
 * unkritisch — 2^53 Cent reichen weit über jeden Festzelt-Umsatz.
 */
export const numericTransformer: ValueTransformer = {
  /** In die Datenbank: unverändert, TypeORM formatiert selbst. */
  to: (value: number | null | undefined) => value,
  /** Aus der Datenbank: String zu Zahl, null bleibt null. */
  from: (value: string | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};
