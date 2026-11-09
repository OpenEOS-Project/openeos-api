import type { WebhookDeliveryService } from '../../webhooks/webhook-delivery.service';
import { select } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Zustellprotokoll der Webhooks: 30 Tage (`WEBHOOKS_DELIVERY_RETENTION_DAYS`).
 * Es kann Gaesteangaben enthalten (Endpunkte mit „Gästedaten mitsenden“).
 * Geloescht wird stuendlich vom Zustelldienst — wie beim Speisekarten-
 * Import; dieser naechtliche Lauf stoesst dieselbe Aufraeumfunktion an,
 * damit die Datenart im Protokoll der Loeschlaeufe steht. Im Probelauf wird
 * nur gezaehlt.
 */
export class WebhookDeliveriesJob implements RetentionJob {
  readonly category = 'webhook_deliveries' as const;

  constructor(
    private readonly deliveries: Pick<
      WebhookDeliveryService,
      'cleanupNow' | 'retentionDays'
    >,
  ) {}

  async run(ctx: RetentionRunContext): Promise<void> {
    if (ctx.dryRun) {
      const cutoff = new Date(
        ctx.now.getTime() - this.deliveries.retentionDays * 86_400_000,
      );
      const [row] = await select<{ deliveries: number; outbox: number }>(
        ctx.manager,
        `SELECT (SELECT count(*) FROM webhook_deliveries WHERE created_at < $1)::int AS deliveries,
                (SELECT count(*) FROM webhook_outbox WHERE created_at < $2)::int AS outbox`,
        [cutoff, new Date(ctx.now.getTime() - 86_400_000)],
      );
      ctx.removed('deliveriesDeleted', row?.deliveries ?? 0);
      ctx.removed('outboxDeleted', row?.outbox ?? 0);
      return;
    }
    const result = await this.deliveries.cleanupNow(ctx.now);
    ctx.removed('deliveriesDeleted', result.deliveriesDeleted);
    ctx.removed('outboxDeleted', result.outboxDeleted);
  }
}
