import { monthsBefore } from '../retention.config';
import { affected } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Widerrufe von Shop-Bestellungen (§ 356a BGB): Nachweis von Inhalt und
 * Eingang fuer die Verjaehrungsfrist, danach geloescht —
 * `RETENTION_WITHDRAWAL_MONTHS` (36) Monate nach dem Eingang.
 */
export class ShopWithdrawalsJob implements RetentionJob {
  readonly category = 'shop_withdrawals' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    const cutoff = monthsBefore(ctx.now, ctx.config.withdrawalMonths);
    ctx.removed(
      'withdrawalsDeleted',
      await affected(
        ctx.manager,
        `DELETE FROM shop_withdrawals WHERE received_at < $1`,
        [cutoff],
      ),
    );
  }
}
