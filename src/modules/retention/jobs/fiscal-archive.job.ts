import { select } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Steuerarchiv (TSE-Exporte, Kassenabschluesse mit DSFinV-K-Export,
 * signierte Kassenvorgaenge einschliesslich Training, Kassenbuch,
 * Bewirtungsbelege):
 * aufbewahrt `RETENTION_FISCAL_ARCHIVE_YEARS` (10) Jahre ab dem Schluss des
 * Kalenderjahres der Entstehung, auch nach dem Ende der Organisation.
 *
 * Dieser Lauf loescht nie etwas. Er zaehlt nur, was die Frist ueberschritten
 * hat, damit die Loeschung bewusst und von Hand entschieden werden kann
 * (Kassenabschluesse sind per Datenbank-Trigger gegen Loeschen gesperrt).
 */
export class FiscalArchiveJob implements RetentionJob {
  readonly category = 'fiscal_archive' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    // Entstanden im Jahr J, aufzubewahren bis Ende J + Frist: faellig ab
    // dem 1. Januar J + Frist + 1, also alles mit J <= aktuelles Jahr - Frist - 1.
    const lastDueYear =
      ctx.now.getUTCFullYear() - ctx.config.fiscalArchiveYears - 1;
    const [row] = await select<Record<string, number>>(
      ctx.manager,
      `SELECT
         (SELECT count(*)::int FROM tse_transactions WHERE extract(year FROM created_at) <= $1) AS "tseTransactions",
         (SELECT count(*)::int FROM tse_exports WHERE extract(year FROM created_at) <= $1) AS "tseExports",
         (SELECT count(*)::int FROM cash_point_closings WHERE extract(year FROM business_date) <= $1) AS "cashPointClosings",
         (SELECT count(*)::int FROM cashbook_entries WHERE extract(year FROM business_date) <= $1) AS "cashbookEntries",
         (SELECT count(*)::int FROM hospitality_receipts WHERE NOT is_test AND year <= $1) AS "hospitalityReceipts"`,
      [lastDueYear],
    );
    for (const [key, value] of Object.entries(row ?? {})) {
      ctx.note(`pastRetention.${key}`, Number(value) || 0);
    }
  }
}
