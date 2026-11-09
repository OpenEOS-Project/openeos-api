import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Event } from '../../database/entities';
import { CronLockService } from '../../common/redis/cron-lock.service';
import { EventPhaseService } from '../events/event-phase.service';
import { WEBHOOKS_CONFIG, type WebhooksConfig } from './webhooks.config';

/**
 * `event.phase_changed`: Die Phase einer Veranstaltung (inactive, test,
 * planned, active, ended) wird nicht gespeichert, sondern aus Status,
 * Freischaltung, Datum und Uhrzeit abgeleitet (event-phase.util.ts) — kein
 * Trigger sieht den Wechsel. Darum schaut dieser Job jede Minute nach,
 * allerdings nur bei Organisationen, die das Ereignis abonniert haben, und
 * merkt sich die zuletzt gesehene Phase in `webhook_event_phases`.
 *
 * Die erste Beobachtung einer Veranstaltung meldet nichts (sonst kaeme
 * beim Anlegen eines Endpunkts fuer jede Veranstaltung ein Ereignis).
 */
@Injectable()
export class WebhookPhaseTrackerService {
  private readonly logger = new Logger(WebhookPhaseTrackerService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(WEBHOOKS_CONFIG) private readonly config: WebhooksConfig,
    private readonly eventPhase: EventPhaseService,
    private readonly cronLock: CronLockService,
  ) {}

  @Cron('40 * * * * *', { name: 'webhook-event-phases' })
  async track(): Promise<void> {
    if (!this.config.enabled) return;
    await this.cronLock.runExclusive('webhook-event-phases', async () => {
      await this.run();
    });
  }

  /** Liefert die Zahl gemeldeter Wechsel. */
  async run(now: Date = new Date()): Promise<number> {
    const events = await this.dataSource
      .getRepository(Event)
      .createQueryBuilder('e')
      .where(
        `e.organizationId IN (
          SELECT organization_id FROM webhook_endpoints
           WHERE active AND event_types @> '["event.phase_changed"]'::jsonb)`,
      )
      .andWhere('(e.endDate IS NULL OR e.endDate > :horizon)', {
        horizon: new Date(now.getTime() - 7 * 86_400_000),
      })
      .getMany();
    if (events.length === 0) return 0;

    const known = new Map<string, string>(
      (
        await this.dataSource.query<{ event_id: string; phase: string }[]>(
          `SELECT event_id, phase FROM webhook_event_phases WHERE event_id = ANY($1::uuid[])`,
          [events.map((e) => e.id)],
        )
      ).map((row) => [row.event_id, row.phase]),
    );

    let changed = 0;
    for (const event of events) {
      let phase: string;
      try {
        phase = (await this.eventPhase.resolve(event, undefined, now)).phase;
      } catch (error) {
        this.logger.warn(
          `Phase of event ${event.id} not resolved: ${(error as Error).message}`,
        );
        continue;
      }
      const previous = known.get(event.id);
      if (previous === phase) continue;

      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO webhook_event_phases (event_id, organization_id, phase, updated_at)
                VALUES ($1, $2, $3, now())
           ON CONFLICT (event_id) DO UPDATE SET phase = EXCLUDED.phase, updated_at = now()`,
          [event.id, event.organizationId, phase],
        );
        if (previous !== undefined) {
          await manager.query(
            `SELECT webhook_enqueue($1, 'event.phase_changed', $2, $3::jsonb)`,
            [
              event.organizationId,
              event.id,
              JSON.stringify({ previousPhase: previous, phase }),
            ],
          );
        }
      });
      if (previous !== undefined) changed += 1;
    }
    return changed;
  }
}
