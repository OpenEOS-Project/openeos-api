import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CronLockService } from '../../common/redis/cron-lock.service';
import { DeploymentService } from '../../common/services/deployment.service';
import {
  salesWindow,
  usesDatePhases,
  type EventPhaseInfo,
  type SalesWindow,
} from '../../common/utils/event-phase.util';
import { hasActiveTse } from '../../common/utils/tse.util';
import { shiftCalendarDaysInZone } from '../../common/utils/event-schedule.util';
import { getOperatingMode } from '../../common/utils/operating-mode.util';
import type { EventSettings } from '../../database/entities/event.entity';
import type { EventNotificationKind } from '../../database/entities/event-notification.entity';
import { Organization } from '../../database/entities/organization.entity';
import { missingMasterData } from '../dsfinvk/dsfinvk-master';
import { EmailService } from '../email/email.service';
import { EventPhaseService } from '../events/event-phase.service';
import { cancellationDeadline } from '../events/event-unlock-cancellation.service';
import { isIntegrationEnabled } from '../integrations/integration-catalog';
import { toPublicLegalInfo } from '../organizations/legal/legal-settings.util';
import { loadRetentionConfig } from '../retention/retention.config';
import {
  isEmergencySupportEvent,
  normalizeEmergencyPhone,
  emergencyPhoneTelUri,
} from '../support/emergency-support';
import { TseConfig } from '../tse/tse.config';
import {
  buildChecklist,
  needsCloudTse,
  TEST_PRINT_RECENT_DAYS,
  type ChecklistFacts,
} from './event-checklist';
import {
  afterEventMail,
  dayBeforeMail,
  notBookedMail,
  weekBeforeMail,
  type AfterEventStats,
  type DayBeforeTse,
  type EventMail,
} from './event-notification-mails';
import { dueReminders, type PlanEvent } from './event-notification-plan';
import type { ReminderSchedule } from './event-notification-schedule';
import { userWantsEventReminders } from './event-notification-settings';

/** Eine Veranstaltung, wie der Lauf sie liest. */
export interface ReminderEventRow {
  id: string;
  organizationId: string;
  name: string;
  status: string;
  billingStatus: string;
  startDate: Date;
  endDate: Date | null;
  settings: EventSettings | null;
  createdAt: Date;
  hadCancellation: boolean;
}

type ReminderOrganization = Pick<
  Organization,
  | 'id'
  | 'name'
  | 'settings'
  | 'country'
  | 'operatingMode'
  | 'operatingModeLegacy'
  | 'tseActive'
>;

export interface ReminderRunSummary {
  checked: number;
  sent: Partial<Record<EventNotificationKind, number>>;
  skipped: number;
  failed: number;
}

/**
 * Wie weit der Lauf um heute herum nach Veranstaltungen sucht: nach vorn
 * mit Luft fuer die frueheste Mail (`not_booked`, 10 Tage vor dem ersten
 * Festtag, der vor `start_date` beginnen kann), zurueck fuer den Rueckblick.
 */
const SEARCH_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Erinnerungen zu Veranstaltungen an die Admins einer Organisation:
 *
 * 1. `week_before` „Dein Fest rückt näher“ mit Checkliste (gebucht),
 * 2. `day_before` „Morgen geht's los“ (gebucht),
 * 3. `after_event` „Danke! So lief dein Fest“ (gebucht, mit echten Bestellungen),
 * 4. `not_booked` „… ist noch nicht freigeschaltet“ (Testmodus, nur mit Abrechnung).
 *
 * Wann welche Mail faellig ist: event-notification-schedule.ts; wer sie
 * bekommt: event-notification-plan.ts. Stuendlich, eine API-Instanz
 * (CronLockService). Jede Mail wird vor dem Versand in
 * `event_notifications` beansprucht (eindeutig je Veranstaltung, Art und
 * Termin) — so geht sie hoechstens einmal raus, auch wenn zwei Laeufe sich
 * ueberschneiden. Scheitert der Versand an alle Empfaenger, wird der
 * Anspruch zurueckgegeben und der naechste Lauf versucht es, solange die
 * Mail noch nicht veraltet ist.
 *
 * Empfaenger: Admins der Organisation mit aktivem Konto, ausser sie haben
 * E-Mail-Benachrichtigungen oder die Erinnerungen in ihren Einstellungen
 * ausgeschaltet. Ohne eingerichteten Mailversand (`EMAIL_ENABLED`) laeuft
 * nichts; dann bleibt auch nichts als „verschickt“ stehen.
 */
@Injectable()
export class EventNotificationsService {
  private readonly logger = new Logger(EventNotificationsService.name);
  private readonly tseConfig: TseConfig;
  private readonly enabled: boolean;
  private readonly emergencyPhone: string | null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
    private readonly eventPhase: EventPhaseService,
    private readonly deployment: DeploymentService,
    private readonly cronLock: CronLockService,
    configService: ConfigService,
  ) {
    this.tseConfig = new TseConfig(configService);
    const raw = configService.get<string | boolean>('EVENT_REMINDERS_ENABLED');
    this.enabled =
      String(raw ?? 'true')
        .trim()
        .toLowerCase() !== 'false';
    this.emergencyPhone = normalizeEmergencyPhone(
      configService.get<string>('OPERATOR_EMERGENCY_PHONE'),
    );
  }

  @Cron('0 20 * * * *', { name: 'event-notifications' })
  async job(): Promise<void> {
    if (!this.enabled || !this.emailService.enabled) return;
    await this.cronLock.runExclusive('event-notifications', async () => {
      try {
        const summary = await this.run();
        const sent = Object.values(summary.sent).reduce((a, b) => a + b, 0);
        if (sent > 0 || summary.failed > 0) {
          this.logger.log(
            `Event reminders: ${sent} sent, ${summary.skipped} skipped, ${summary.failed} failed (${summary.checked} events)`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Event reminder run failed: ${(error as Error).message}`,
        );
      }
    });
  }

  /** Ein Lauf: alle Veranstaltungen um `now` herum. */
  async run(now: Date = new Date()): Promise<ReminderRunSummary> {
    const summary: ReminderRunSummary = {
      checked: 0,
      sent: {},
      skipped: 0,
      failed: 0,
    };
    const events = await this.candidates(now);
    const organizations = new Map<string, ReminderOrganization | null>();

    for (const event of events) {
      summary.checked += 1;
      try {
        if (!organizations.has(event.organizationId)) {
          organizations.set(
            event.organizationId,
            await this.loadOrganization(event.organizationId),
          );
        }
        const organization = organizations.get(event.organizationId);
        if (!organization) continue;

        const context = EventPhaseService.organizationContext(organization);
        const timeZone = context.timezone || 'Europe/Berlin';
        const window = salesWindow(event, context, this.eventPhase.settings);
        if (!window) continue;

        const due = dueReminders(event satisfies PlanEvent, window, {
          billingEnabled: this.deployment.billingEnabled,
          timeZone,
          organizationSettings: organization.settings,
          now,
        });
        for (const schedule of due) {
          const outcome = await this.deliver(
            event,
            organization,
            window,
            schedule,
            timeZone,
            now,
          );
          if (outcome === 'sent') {
            summary.sent[schedule.kind] =
              (summary.sent[schedule.kind] ?? 0) + 1;
          } else if (outcome === 'skipped') summary.skipped += 1;
          else if (outcome === 'failed') summary.failed += 1;
        }
      } catch (error) {
        summary.failed += 1;
        this.logger.error(
          `Event reminders for event ${event.id} failed: ${(error as Error).message}`,
        );
      }
    }
    return summary;
  }

  // ------------------------------------------------------------ Versand

  private async deliver(
    event: ReminderEventRow,
    organization: ReminderOrganization,
    window: SalesWindow,
    schedule: ReminderSchedule,
    timeZone: string,
    now: Date,
  ): Promise<'sent' | 'skipped' | 'failed' | 'taken'> {
    const claim = await this.claim(event, schedule);
    if (!claim) return 'taken';

    try {
      const recipients = await this.recipients(event.organizationId);
      if (recipients.length === 0) {
        await this.finish(claim, 'skipped', 0, 'no_recipients', now);
        return 'skipped';
      }

      const compose = await this.composer(
        event,
        organization,
        window,
        schedule,
        timeZone,
        now,
      );
      if (!compose) {
        await this.finish(claim, 'skipped', 0, 'no_orders', now);
        return 'skipped';
      }

      let delivered = 0;
      for (const to of recipients) {
        const mail = compose(to);
        const ok = await this.emailService.sendEmail({
          to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
        if (ok) delivered += 1;
      }
      if (delivered === 0) {
        await this.release(claim);
        return 'failed';
      }
      await this.finish(claim, 'sent', delivered, null, now);
      this.logger.log(
        `Event reminder ${schedule.kind} for event ${event.id} (${schedule.scheduleKey}) sent to ${delivered} admin(s)`,
      );
      return 'sent';
    } catch (error) {
      await this.release(claim).catch(() => undefined);
      throw error;
    }
  }

  /** Baut die Mail je Empfaenger; `null`: nichts zu berichten (kein Rueckblick ohne Bestellungen). */
  private async composer(
    event: ReminderEventRow,
    organization: ReminderOrganization,
    window: SalesWindow,
    schedule: ReminderSchedule,
    timeZone: string,
    now: Date,
  ): Promise<((to: string) => EventMail) | null> {
    const appUrl = this.emailService.appUrl;
    const base = {
      appUrl,
      organizationName: organization.name,
      eventName: event.name,
      timeZone,
      firstDay: window.businessDaysFrom,
      now,
    };
    const datePhases = usesDatePhases(event, this.eventPhase.settings);

    switch (schedule.kind) {
      case 'week_before': {
        const checklist = buildChecklist(
          await this.checklistFacts(event, organization, now),
        );
        return (to) =>
          weekBeforeMail({
            ...base,
            to,
            checklist,
            realSalesFrom: datePhases ? window.realSalesFrom : null,
            presaleEnabled: event.settings?.sales?.presale === true,
          });
      }
      case 'day_before': {
        const phase = this.eventPhase.resolveWith(
          event as never,
          organization,
          now,
        );
        const emergencyPhone = this.emergencyFor(event, phase, now);
        const tse = this.dayBeforeTse(organization);
        return (to) =>
          dayBeforeMail({
            ...base,
            to,
            realSalesFrom: window.realSalesFrom,
            realSalesUntil: window.realSalesUntil,
            datePhases,
            emergencyPhone,
            tse,
          });
      }
      case 'after_event': {
        const stats = await this.eventStats(event.id);
        if (stats.orders === 0) return null;
        const retention = loadRetentionConfig();
        return (to) =>
          afterEventMail({
            ...base,
            to,
            lastDay: shiftCalendarDaysInZone(
              window.businessDaysUntil,
              -1,
              timeZone,
            ),
            ordersOnly: getOperatingMode(organization) === 'orders_only',
            currency: organization.settings?.currency || 'EUR',
            stats,
            waitersUsed: stats.waiterOrders > 0,
            tseUsed: stats.tseUsed,
            guestDataDays: retention.enabled ? retention.guestDataDays : null,
          });
      }
      case 'not_booked': {
        const deadline = cancellationDeadline(
          { startDate: event.startDate, unlockedStartDate: null },
          timeZone,
        );
        return (to) =>
          notBookedMail({
            ...base,
            to,
            eventId: event.id,
            testMaxOrders: this.eventPhase.testEventMaxOrders,
            realSalesFrom: window.realSalesFrom,
            cancellationDeadline: deadline,
            emergencySupport: !!this.emergencyPhone,
            tseIncluded:
              needsCloudTse(this.modeOf(organization)) &&
              this.tseConfig.availability === 'available',
          });
      }
    }
  }

  private emergencyFor(
    event: ReminderEventRow,
    phase: EventPhaseInfo,
    now: Date,
  ): { phone: string; telUri: string } | null {
    if (!this.emergencyPhone) return null;
    const applies = isEmergencySupportEvent(
      event as never,
      phase,
      { billingEnabled: this.deployment.billingEnabled },
      now,
    );
    return applies
      ? {
          phone: this.emergencyPhone,
          telUri: emergencyPhoneTelUri(this.emergencyPhone),
        }
      : null;
  }

  private dayBeforeTse(organization: ReminderOrganization): DayBeforeTse {
    if (hasActiveTse(organization)) return 'active';
    if (!needsCloudTse(this.modeOf(organization))) return null;
    return this.tseConfig.availability === 'available' &&
      isIntegrationEnabled(organization.settings, 'tse') &&
      missingMasterData(organization).length === 0
      ? 'pending'
      : 'blocked';
  }

  private modeOf(organization: ReminderOrganization) {
    return {
      country: organization.country,
      operatingMode: getOperatingMode(organization),
      operatingModeLegacy: organization.operatingModeLegacy === true,
    };
  }

  // ------------------------------------------------------------ Daten

  private async candidates(now: Date): Promise<ReminderEventRow[]> {
    const rows = await this.dataSource.query<
      {
        id: string;
        organization_id: string;
        name: string;
        status: string;
        billing_status: string;
        start_date: Date;
        end_date: Date | null;
        settings: EventSettings | null;
        created_at: Date;
        had_cancellation: boolean;
      }[]
    >(
      `SELECT e.id, e.organization_id, e.name, e.status, e.billing_status,
              e.start_date, e.end_date, e.settings, e.created_at,
              EXISTS (SELECT 1 FROM event_billing_cancellations c
                       WHERE c.event_id = e.id AND c.kind = 'cancellation') AS had_cancellation
         FROM events e
         JOIN organizations o ON o.id = e.organization_id AND o.deleted_at IS NULL
        WHERE e.deleted_at IS NULL
          AND e.start_date IS NOT NULL
          AND e.start_date <= $2
          AND COALESCE(e.end_date, e.start_date) >= $1
        ORDER BY e.start_date`,
      [
        new Date(now.getTime() - SEARCH_DAYS * DAY_MS),
        new Date(now.getTime() + SEARCH_DAYS * DAY_MS),
      ],
    );
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      status: r.status,
      billingStatus: r.billing_status,
      startDate: new Date(r.start_date),
      endDate: r.end_date ? new Date(r.end_date) : null,
      settings: r.settings,
      createdAt: new Date(r.created_at),
      hadCancellation: r.had_cancellation === true,
    }));
  }

  private loadOrganization(id: string): Promise<ReminderOrganization | null> {
    return this.dataSource.getRepository(Organization).findOne({
      where: { id },
      select: {
        id: true,
        name: true,
        settings: true,
        country: true,
        operatingMode: true,
        operatingModeLegacy: true,
        tseActive: true,
      },
    });
  }

  /** Admins mit aktivem Konto, die Erinnerungen wollen (Adressen ohne Dubletten). */
  async recipients(organizationId: string): Promise<string[]> {
    const rows = await this.dataSource.query<
      { email: string | null; preferences: Record<string, unknown> | null }[]
    >(
      `SELECT u.email, u.preferences
         FROM user_organizations uo
         JOIN users u ON u.id = uo.user_id
        WHERE uo.organization_id = $1 AND uo.role = 'admin'
          AND u.deleted_at IS NULL AND u.is_active = true
          AND u.deletion_due_at IS NULL
        ORDER BY u.created_at`,
      [organizationId],
    );
    const seen = new Set<string>();
    const result: string[] = [];
    for (const row of rows) {
      if (!row.email) continue;
      if (!userWantsEventReminders(row.preferences as never)) continue;
      const key = row.email.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(row.email.trim());
    }
    return result;
  }

  async checklistFacts(
    event: Pick<
      ReminderEventRow,
      'id' | 'organizationId' | 'status' | 'settings'
    >,
    organization: ReminderOrganization,
    now: Date,
  ): Promise<ChecklistFacts> {
    const q = <T>(sql: string, params: unknown[]) =>
      this.dataSource.query<T[]>(sql, params).then((rows) => rows[0]);
    const orgId = event.organizationId;
    const since = new Date(now.getTime() - TEST_PRINT_RECENT_DAYS * DAY_MS);

    const devices = await q<{ pos: number; waiter_mode: number }>(
      `SELECT COUNT(*)::int AS pos,
              COUNT(*) FILTER (WHERE settings->>'waiterMode' IN ('shared', 'personal'))::int AS waiter_mode
         FROM devices
        WHERE organization_id = $1 AND type = 'pos' AND status = 'verified' AND is_active = true`,
      [orgId],
    );
    const waiters = await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM waiters
        WHERE organization_id = $1 AND is_active = true AND anonymized_at IS NULL
          AND (event_id IS NULL OR event_id = $2)`,
      [orgId, event.id],
    );
    const printers = await q<{
      total: number;
      online: number;
      printed: number;
    }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE p.is_online)::int AS online,
              COUNT(*) FILTER (WHERE p.last_test_print_at >= $2
                OR EXISTS (SELECT 1 FROM print_jobs j
                            WHERE j.printer_id = p.id AND j.status = 'completed'
                              AND j.printed_at >= $2))::int AS printed
         FROM printers p
        WHERE p.organization_id = $1 AND p.is_active = true`,
      [orgId, since],
    );
    const products = await q<{ total: number; free: number }>(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE price = 0)::int AS free
         FROM products
        WHERE event_id = $1 AND deleted_at IS NULL AND is_active = true`,
      [event.id],
    );
    const qr = await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM qr_codes
        WHERE organization_id = $1 AND is_active = true
          AND type IN ('table', 'takeaway')
          AND (event_id IS NULL OR event_id = $2)`,
      [orgId, event.id],
    );

    return {
      appUrl: this.emailService.appUrl,
      eventId: event.id,
      eventActive: event.status === 'active',
      shopEnabled: event.settings?.shop?.enabled === true,
      qrCodes: qr?.n ?? 0,
      organization: {
        country: organization.country,
        operatingMode: getOperatingMode(organization),
        operatingModeLegacy: organization.operatingModeLegacy === true,
        legalComplete: toPublicLegalInfo(organization, {
          imprintUrl: null,
          privacyUrl: null,
        }).complete,
      },
      posDevices: devices?.pos ?? 0,
      waiterModeDevices: devices?.waiter_mode ?? 0,
      waiters: waiters?.n ?? 0,
      printers: {
        total: printers?.total ?? 0,
        online: printers?.online ?? 0,
        printedRecently: printers?.printed ?? 0,
      },
      products: {
        total: products?.total ?? 0,
        withoutPrice: products?.free ?? 0,
      },
      tse: {
        availability: this.tseConfig.availability,
        active: hasActiveTse(organization),
        integrationEnabled: isIntegrationEnabled(organization.settings, 'tse'),
        missingMasterData: missingMasterData(organization),
      },
    };
  }

  /** Zahlen nach dem Fest: ohne Testbestellungen und Stornos, wie die Berichte. */
  async eventStats(
    eventId: string,
  ): Promise<AfterEventStats & { waiterOrders: number; tseUsed: boolean }> {
    const [totals] = await this.dataSource.query<
      { orders: number; revenue: string | null; waiter_orders: number }[]
    >(
      `SELECT COUNT(*)::int AS orders,
              SUM(o.total - o.pfand_total
                  + COALESCE((SELECT SUM(rf.amount - rf.pfand_amount) FROM refunds rf
                               WHERE rf.order_id = o.id AND rf.kind = 'refund'), 0)) AS revenue,
              COUNT(*) FILTER (WHERE o.waiter_id IS NOT NULL OR o.created_by_waiter_id IS NOT NULL)::int AS waiter_orders
         FROM orders o
        WHERE o.event_id = $1 AND NOT o.is_test AND o.status <> 'cancelled'`,
      [eventId],
    );
    const items = await this.dataSource.query<
      { name: string; quantity: string | null; revenue: string | null }[]
    >(
      `SELECT i.product_name AS name,
              SUM(i.quantity - i.refunded_quantity) AS quantity,
              SUM(i.total_price
                  * (CASE WHEN i.quantity > 0 THEN CAST(i.quantity - i.refunded_quantity AS numeric) / i.quantity ELSE 0 END)
                  * (CASE WHEN o.subtotal > 0 THEN (o.total - o.pfand_total - o.tip_amount) / o.subtotal ELSE 0 END)) AS revenue
         FROM order_items i
         JOIN orders o ON o.id = i.order_id
        WHERE o.event_id = $1 AND NOT o.is_test AND o.status <> 'cancelled'
          AND i.status <> 'cancelled'
        GROUP BY i.product_name
        ORDER BY SUM(i.quantity - i.refunded_quantity) DESC, revenue DESC NULLS LAST, i.product_name`,
      [eventId],
    );
    const [tse] = await this.dataSource.query<{ used: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM tse_transactions WHERE event_id = $1) AS used`,
      [eventId],
    );
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const all = items
      .map((r) => ({
        name: r.name,
        quantity: Number(r.quantity ?? 0),
        revenue: round2(Number(r.revenue ?? 0)),
      }))
      .filter((r) => r.quantity > 0);
    return {
      orders: totals?.orders ?? 0,
      revenue: round2(Number(totals?.revenue ?? 0)),
      itemsSold: all.reduce((sum, r) => sum + r.quantity, 0),
      topProducts: all.slice(0, 3),
      waiterOrders: totals?.waiter_orders ?? 0,
      tseUsed: tse?.used === true,
    };
  }

  // ------------------------------------------------------------ Merker

  private async claim(
    event: ReminderEventRow,
    schedule: ReminderSchedule,
  ): Promise<string | null> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `INSERT INTO event_notifications (event_id, organization_id, kind, schedule_key, status)
       VALUES ($1, $2, $3, $4, 'sending')
       ON CONFLICT (event_id, kind, schedule_key) DO NOTHING
       RETURNING id`,
      [event.id, event.organizationId, schedule.kind, schedule.scheduleKey],
    );
    return rows[0]?.id ?? null;
  }

  private async finish(
    id: string,
    status: 'sent' | 'skipped',
    recipients: number,
    skipReason: string | null,
    now: Date,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE event_notifications
          SET status = $2, recipients = $3, skip_reason = $4, sent_at = $5
        WHERE id = $1`,
      [id, status, recipients, skipReason, now],
    );
  }

  private async release(id: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM event_notifications WHERE id = $1`,
      [id],
    );
  }
}
