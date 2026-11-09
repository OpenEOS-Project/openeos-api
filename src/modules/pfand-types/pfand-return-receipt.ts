import type { EntityManager } from 'typeorm';
import {
  PfandReturn,
  type PfandReturnLine,
  type PfandReturnTaxLine,
} from '../../database/entities/pfand-return.entity';
import { Organization } from '../../database/entities/organization.entity';
import { orderDay, resolveOrderTimeZone } from '../orders/order-numbering';

/**
 * Pfand-Auszahlung als Beleg (openeos-web#116): Belegnummer und MwSt je
 * Satz. Reine Hilfen plus die Vergabe der Nummer in einer Transaktion.
 *
 * Pfand gehoert zum Entgelt (Abschn. 10.1 Abs. 8 UStAE); die Rueckgabe
 * mindert Umsatz und Umsatzsteuer zum Satz der Pfandart (§ 17 UStG). Der
 * Beleg weist die enthaltene MwSt deshalb negativ aus — bei
 * steuerbefreiten Organisationen (Kleinunternehmer, `vatExempt !== false`)
 * gar nicht.
 */

/** Namensraum der Advisory-Lock (Bestellnummern: 41_201). */
export const PFAND_RETURN_NUMBER_LOCK_NAMESPACE = 41_202;

/** Praefix der Belegnummer: `P-JJJJMMTT-NNNN`. */
export const PFAND_RETURN_NUMBER_PREFIX = 'P-';

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Satz einer Position; fehlt er (Bestand von vor 2026-11), 0 %. */
export function lineVatRate(line: Pick<PfandReturnLine, 'vatRate'>): number {
  const rate = Number(line.vatRate);
  return line.vatRate === undefined ||
    line.vatRate === null ||
    !Number.isFinite(rate)
    ? 0
    : rate;
}

/** Betrag einer Position in Cent (positiv). */
function lineCents(line: Pick<PfandReturnLine, 'unitAmount' | 'quantity'>) {
  return Math.round(Number(line.unitAmount) * 100) * Number(line.quantity);
}

/**
 * MwSt-Zeilen einer Auszahlung (Betraege negativ), je Satz eine Zeile,
 * hoechster Satz zuerst — dieselbe Rechnung wie auf dem Kassenbon
 * (brutto × Satz / (100 + Satz)). 0 % und steuerbefreite Organisationen:
 * keine Zeile.
 */
export function pfandReturnTaxLines(
  lines: Pick<PfandReturnLine, 'unitAmount' | 'quantity' | 'vatRate'>[],
  vatExempt: boolean | undefined,
): PfandReturnTaxLine[] {
  if (vatExempt !== false) return [];
  const byRate = new Map<number, number>();
  for (const line of lines) {
    const rate = lineVatRate(line);
    byRate.set(rate, (byRate.get(rate) ?? 0) + lineCents(line));
  }
  return [...byRate.entries()]
    .filter(([rate, value]) => rate > 0 && value > 0)
    .sort(([a], [b]) => b - a)
    .map(([rate, value]) => {
      const gross = value / 100;
      const tax = round2((gross * rate) / (100 + rate));
      return {
        rate,
        gross: -round2(gross),
        tax: -tax,
        net: -round2(gross - tax),
      };
    });
}

/**
 * Nummer und Insert in einer Transaktion unter einer Advisory-Lock je
 * Organisation, Tag in der Zeitzone der Organisation (wie die
 * Bestellnummer). Zaehler = hoechste vergebene Nummer des Tages + 1.
 */
export async function savePfandReturnWithNumber(
  manager: EntityManager,
  pfandReturn: PfandReturn,
  now: Date = new Date(),
): Promise<PfandReturn> {
  return manager.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      PFAND_RETURN_NUMBER_LOCK_NAMESPACE,
      pfandReturn.organizationId,
    ]);
    const organization = await tx.findOne(Organization, {
      where: { id: pfandReturn.organizationId },
      select: { id: true, settings: true },
    });
    const day = orderDay(
      now,
      resolveOrderTimeZone(organization?.settings?.timezone),
    );
    const base = `${PFAND_RETURN_NUMBER_PREFIX}${day.key}-`;
    const rows = await tx.query<{ max: number | string | null }[]>(
      `SELECT MAX(
         CASE WHEN SUBSTRING(return_number FROM $3::int) ~ '^[0-9]{1,9}$'
              THEN CAST(SUBSTRING(return_number FROM $3::int) AS integer)
         END
       ) AS max
       FROM pfand_returns
       WHERE organization_id = $1 AND return_number LIKE $2`,
      [pfandReturn.organizationId, `${base}%`, base.length + 1],
    );
    const max = Number(rows?.[0]?.max ?? 0) || 0;
    pfandReturn.returnNumber = `${base}${String(max + 1).padStart(4, '0')}`;
    return tx.save(PfandReturn, pfandReturn);
  });
}
