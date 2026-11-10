import type { EntityManager } from 'typeorm';

import type { PfandReturnLine } from '../../database/entities/pfand-return.entity';
import { rowsOf } from '../tse/tse-sql.util';

/**
 * Pfand-Altsaldo (Steuerberater 2026-11-10, Frage 2 — Uebergangsregel).
 *
 * Bis zur Umstellung (openeos-api#125, Migration `1840800000000`) wurde
 * Pfand ohne Umsatzsteuer verkauft (`order_items.deposit_tax_rate IS
 * NULL`). Seitdem mindert eine Rueckgabe Umsatz und Umsatzsteuer zum Satz
 * der Pfandart (§ 17 UStG). Die Minderung setzt aber eine zuvor geschuldete
 * Steuer voraus: Becher, die vor der Umstellung ohne USt ausgegeben wurden,
 * duerfen bei Rueckgabe keine Steuer mindern.
 *
 * Deshalb fuehrt OpenEOS je Organisation einen **Altsaldo**:
 *
 *   ohne Satz verkauftes Pfand (bezahlt, nicht storniert/erstattet, ohne Test)
 *   − Rueckgaben ohne Satz (Auszahlungen von vor der Umstellung)
 *   − bereits gegen den Altsaldo gebuchte Rueckgaben (`lines[].legacyCents`)
 *
 * Neue Rueckgaben werden zuerst gegen den Altsaldo gebucht — als
 * `PfandRueckzahlung` mit USt-Schluessel 5 (ohne Steuerminderung), bis er
 * aufgebraucht ist — erst danach mit dem Satz der Pfandart. Kleinunternehmer:
 * keine Auswirkung (ohnehin keine Steuer), deshalb wird dort nichts
 * verbraucht. Naeherung: Erstattungen von Pfand nach Betrag (ohne Menge)
 * mindern den Altsaldo nicht.
 */
export interface PfandLegacyBalance {
  /** Ohne Satz verkauftes Pfand (Cent). */
  chargedCents: number;
  /** Davon schon zurueckgegeben (alte Auszahlungen + Altsaldo-Anteile, Cent). */
  returnedCents: number;
  /** Offener Altsaldo (Cent, nie negativ). */
  remainingCents: number;
}

export async function pfandLegacyBalance(
  manager: Pick<EntityManager, 'query'>,
  organizationId: string,
): Promise<PfandLegacyBalance> {
  const [row] = rowsOf<{ charged: string | null; returned: string | null }>(
    await manager.query(
      `SELECT
         COALESCE((
           SELECT SUM(ROUND(oi.deposit_amount * 100) * GREATEST(oi.quantity - COALESCE(oi.refunded_quantity, 0), 0))
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
            WHERE o.organization_id = $1
              AND oi.deposit_tax_rate IS NULL
              AND oi.deposit_amount > 0
              AND oi.status <> 'cancelled'
              AND o.status <> 'cancelled'
              AND o.is_test = false
              AND o.payment_status IN ('paid', 'partly_paid')
         ), 0) AS charged,
         COALESCE((
           SELECT SUM(
                    CASE WHEN l->>'vatRate' IS NULL
                         THEN ROUND((l->>'unitAmount')::numeric * 100) * (l->>'quantity')::numeric
                         ELSE COALESCE((l->>'legacyCents')::numeric, 0)
                    END)
             FROM pfand_returns pr
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pr.lines, '[]'::jsonb)) l
            WHERE pr.organization_id = $1 AND pr.is_test = false
         ), 0) AS returned`,
      [organizationId],
    ),
  );
  const chargedCents = Math.round(Number(row?.charged ?? 0));
  const returnedCents = Math.round(Number(row?.returned ?? 0));
  return {
    chargedCents,
    returnedCents,
    remainingCents: Math.max(0, chargedCents - returnedCents),
  };
}

/** Betrag einer Position in Cent (positiv). */
export function returnLineCents(
  line: Pick<PfandReturnLine, 'unitAmount' | 'quantity'>,
): number {
  return Math.round(Number(line.unitAmount) * 100) * Number(line.quantity);
}

/**
 * Verteilt den offenen Altsaldo auf die Positionen einer Rueckgabe (in
 * Reihenfolge): `legacyCents` = Anteil ohne Steuerminderung. Rein.
 */
export function allocateLegacyBalance(
  lines: PfandReturnLine[],
  remainingCents: number,
): PfandReturnLine[] {
  let left = Math.max(0, Math.round(remainingCents));
  return lines.map((line) => {
    const amount = returnLineCents(line);
    const legacy = Math.min(left, amount);
    left -= legacy;
    const { legacyCents: _previous, ...rest } = line;
    return legacy > 0 ? { ...rest, legacyCents: legacy } : rest;
  });
}

/** Anteil ohne Satz einer Position (Cent) — Altsaldo oder Bestand ohne Satz. */
export function legacyCentsOf(
  line: Pick<
    PfandReturnLine,
    'unitAmount' | 'quantity' | 'vatRate' | 'legacyCents'
  >,
): number {
  if (line.vatRate === undefined || line.vatRate === null)
    return returnLineCents(line);
  return Math.min(
    Math.max(0, Math.round(Number(line.legacyCents) || 0)),
    returnLineCents(line),
  );
}
