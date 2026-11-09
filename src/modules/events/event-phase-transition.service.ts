import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';
import {
  EVENT_UNLOCKED_BILLING_STATUSES,
  Event,
  EventStatus,
} from '../../database/entities/event.entity';
import { CronLockService } from '../../common/redis/cron-lock.service';
import { DeploymentService } from '../../common/services/deployment.service';
import { GatewayService } from '../gateway/gateway.service';
import { EventPhaseService } from './event-phase.service';
import {
  TestOrderCleanupService,
  TestOrderPurgeResult,
} from './test-order-cleanup.service';

/**
 * Beginn des Verkaufsfensters (Phasen, 2026-11-08): aus „Geplant“ wird
 * „Aktiv“. Die Kasse bucht ab dann von selbst echt — die Phase ist
 * abgeleitet —, hier bleibt nur das Aufraeumen: die Testbestellungen und
 * Test-Pfandrueckgaben aus „Geplant“ werden geloescht, genau wie beim
 * Aktivieren (TestOrderCleanupService). Echte Bestellungen (Vorverkauf im
 * Shop, Bestand) bleiben unberuehrt; TSE-Trainingsbuchungen auch (sie
 * haengen nicht per Fremdschluessel an der Bestellung und bleiben im
 * Fiskalarchiv).
 *
 * `events.sales_started_at` haelt fest, dass es geschehen ist. Jede Minute,
 * eine Instanz (CronLockService); je Veranstaltung in einer Transaktion mit
 * exklusiver Zeilensperre, wie beim Aktivieren.
 */
@Injectable()
export class EventPhaseTransitionService {
  private readonly logger = new Logger(EventPhaseTransitionService.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    private readonly eventPhase: EventPhaseService,
    private readonly testOrderCleanupService: TestOrderCleanupService,
    private readonly cronLock: CronLockService,
    private readonly deployment: DeploymentService,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
  ) {}

  @Cron('15 * * * * *', { name: 'event-phase-transition' })
  async transitionJob(): Promise<void> {
    if (!this.eventPhase.settings.enabled) return;
    await this.cronLock.runExclusive('event-phase-transition', async () => {
      await this.run();
    });
  }

  /** Alle faelligen Veranstaltungen; liefert die bearbeiteten IDs. */
  async run(now: Date = new Date()): Promise<string[]> {
    // Vorfilter: aktiv, noch nicht begonnen, Beginn spaetestens in drei
    // Tagen (der Vorlauf liegt davor, nie mehr als zwei Tage). Die genaue
    // Entscheidung trifft die Phase.
    const horizon = new Date(now.getTime() + 3 * 24 * 3600_000);
    const candidates = await this.eventRepository.find({
      where: {
        status: EventStatus.ACTIVE,
        salesStartedAt: IsNull(),
        startDate: LessThanOrEqual(horizon),
      },
    });

    const done: string[] = [];
    for (const event of candidates) {
      if (
        this.deployment.billingEnabled &&
        !EVENT_UNLOCKED_BILLING_STATUSES.includes(event.billingStatus)
      ) {
        continue;
      }
      try {
        const info = await this.eventPhase.resolve(event, undefined, now);
        if (!info.datePhases) continue;
        if (info.phase !== 'active' && info.phase !== 'ended') continue;
        if (await this.startSales(event.id, now)) done.push(event.id);
      } catch (error) {
        this.logger.error(
          `Sales start for event ${event.id} failed: ${(error as Error).message}`,
        );
      }
    }
    return done;
  }

  /** Aufraeumen und festhalten; `false`, wenn schon erledigt. */
  async startSales(eventId: string, now: Date = new Date()): Promise<boolean> {
    const outcome = await this.eventRepository.manager.transaction(
      async (manager) => {
        const rows = await manager.query<
          { id: string; status: EventStatus; sales_started_at: Date | null }[]
        >(
          `SELECT id, status, sales_started_at FROM events
            WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [eventId],
        );
        const row = rows[0];
        if (!row || row.sales_started_at || row.status !== EventStatus.ACTIVE) {
          return null;
        }
        const event = await manager.findOneOrFail(Event, {
          where: { id: eventId },
        });
        const purge = await this.testOrderCleanupService.purge(
          manager,
          event.organizationId,
          event.id,
        );
        await manager.update(Event, { id: event.id }, { salesStartedAt: now });
        event.salesStartedAt = now;
        return { event, purge };
      },
    );
    if (!outcome) return false;

    const { event, purge } = outcome;
    this.notify(event, purge);
    return true;
  }

  private notify(event: Event, purge: TestOrderPurgeResult): void {
    this.testOrderCleanupService.notify(purge);
    // Kassen und Verwaltung: Phase hat gewechselt (Hinweis „Testbetrieb“ weg).
    void this.eventPhase
      .decorate(event)
      .then((decorated) => {
        this.gatewayService.notifyEventStatusChanged(event.organizationId, {
          eventId: event.id,
          organizationId: event.organizationId,
          status: event.status,
          name: event.name,
          phase: decorated.phase,
        });
      })
      .catch(() => undefined);
    this.logger.log(
      `Sales window started for event ${event.id}: ${purge.deletedOrderIds.length} test orders and ${purge.deletedPfandReturns} test deposit returns removed`,
    );
  }
}
