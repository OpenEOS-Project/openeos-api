import { affected, select } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Links auf digitale Belege (QR-Code, Beleg-Mail): nach Ablauf
 * (`expires_at`, Standard 90 Tage, `RECEIPT_LINK_DAYS`) loeschen. Sie
 * enthalten keine Gaesteangaben (nur Verweise auf Bestellungen und den
 * Pruefwert des Tokens); der Beleg selbst bleibt als Kassendatum im
 * Steuerarchiv.
 */
export class ReceiptLinksJob implements RetentionJob {
  readonly category = 'receipt_links' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    if (ctx.dryRun) {
      const [row] = await select<{ n: number }>(
        ctx.manager,
        `SELECT count(*)::int AS n FROM receipt_links WHERE expires_at <= $1`,
        [ctx.now],
      );
      ctx.removed('receiptLinksDeleted', row?.n ?? 0);
      return;
    }
    ctx.removed(
      'receiptLinksDeleted',
      await affected(
        ctx.manager,
        `DELETE FROM receipt_links WHERE expires_at <= $1`,
        [ctx.now],
      ),
    );
  }
}
