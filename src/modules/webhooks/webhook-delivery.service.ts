import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  AdminAction,
  AdminAuditLog,
  Organization,
  OrganizationRole,
  SYSTEM_AUDIT_IP,
  UserOrganization,
  WebhookDelivery,
  WebhookEndpoint,
  type WebhookAttemptLogEntry,
  type WebhookDeliveryError,
} from '../../database/entities';
import { getIntegrationKeyring } from '../../common/services/integration-credentials.crypto';
import { CronLockService } from '../../common/redis/cron-lock.service';
import { EmailService } from '../email/email.service';
import { nextRetryAt } from './webhook-backoff';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { sendWebhookRequest, type WebhookResponse } from './webhook-http';
import { buildSignatureHeader } from './webhook-signature';
import { WEBHOOKS_CONFIG, type WebhooksConfig } from './webhooks.config';

export const WEBHOOK_USER_AGENT =
  'OpenEOS-Webhooks/1.0 (+https://docs.openeos.de/integrationen/webhooks)';

/** Wohin die Abschalt-Mail fuehrt (Web-App). */
export const WEBHOOK_SETTINGS_PATH = '/settings/webhooks';

const MAX_ATTEMPT_LOG = 20;

/** Zustellungen je Endpunkt und Takt (nacheinander gesendet). */
const PER_ENDPOINT = 3;

interface ClaimedRow {
  id: string;
  endpoint_id: string;
  next_attempt_at: Date;
}

type Sender = typeof sendWebhookRequest;

/**
 * Stellt Webhooks zu: holt faellige Zustellungen (auf allen Instanzen
 * gleichzeitig, `FOR UPDATE SKIP LOCKED`), sendet signiert, plant
 * Wiederholungen mit wachsendem Abstand und schaltet Endpunkte ab, die
 * lange nichts angenommen haben (Mail an die Admins).
 *
 * Kein eigener Job-Dienst — wie beim Speisekarten-Import: ein Takt je
 * Instanz (`WEBHOOKS_POLL_INTERVAL_MS`), der zuerst den Postausgang
 * verteilt und dann zustellt; `kick()` stoesst ihn nach „Test senden“
 * sofort an. Eine Zustellung, deren Instanz mitten im Versuch stirbt,
 * holt nach Ablauf von `locked_until` eine andere nach.
 */
@Injectable()
export class WebhookDeliveryService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private stopped = false;
  /** Austauschbar fuer Tests. */
  sender: Sender = sendWebhookRequest;
  random: () => number = Math.random;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(WEBHOOKS_CONFIG) private readonly config: WebhooksConfig,
    private readonly dispatcher: WebhookDispatcherService,
    private readonly cronLock: CronLockService,
    private readonly emailService: EmailService,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => this.kick(), this.config.pollIntervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Einen Takt anstossen (nie parallel zu einem laufenden). */
  kick(): void {
    if (!this.config.enabled || this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    setImmediate(() => {
      this.tick()
        .catch((error: unknown) =>
          this.logger.error(
            `Webhook tick failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => {
          this.running = false;
          if (this.again) {
            this.again = false;
            this.kick();
          }
        });
    });
  }

  async tick(now: Date = new Date()): Promise<void> {
    await this.dispatcher.dispatchBatch(now);
    await this.deliverDue(now);
  }

  /**
   * Faellige Zustellungen holen und senden; liefert die Zahl der Versuche.
   *
   * Je Endpunkt der Reihe nach (in der Reihenfolge der Ereignisse), die
   * Endpunkte nebeneinander. Je Takt hoechstens `PER_ENDPOINT` je Endpunkt,
   * damit ein langsamer Empfaenger die anderen nicht aufhaelt.
   */
  async deliverDue(now: Date = new Date()): Promise<number> {
    const batch = this.config.concurrency * 2;
    const lease = new Date(now.getTime() + this.config.timeoutMs * 4 + 60_000);
    const claimed = await this.dataSource.query<
      [ClaimedRow[], number] | ClaimedRow[]
    >(
      `UPDATE webhook_deliveries
          SET status = 'delivering', locked_until = $2, updated_at = now()
        WHERE id IN (
          SELECT id FROM webhook_deliveries
           WHERE id IN (
             SELECT id FROM (
               SELECT id, row_number() OVER (
                        PARTITION BY endpoint_id ORDER BY next_attempt_at, created_at) AS rn
                 FROM webhook_deliveries
                WHERE (status = 'pending' AND next_attempt_at <= $1)
                   OR (status = 'delivering' AND locked_until < $1)
             ) ranked
             WHERE rn <= $4)
           ORDER BY next_attempt_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
      RETURNING id, endpoint_id, next_attempt_at`,
      [now, lease, batch, PER_ENDPOINT],
    );
    const rows = (
      Array.isArray(claimed[0]) ? claimed[0] : claimed
    ) as ClaimedRow[];
    if (rows.length === 0) return 0;

    const byEndpoint = new Map<string, ClaimedRow[]>();
    for (const row of [...rows].sort(
      (a, b) =>
        new Date(a.next_attempt_at).getTime() -
        new Date(b.next_attempt_at).getTime(),
    )) {
      const list = byEndpoint.get(row.endpoint_id) ?? [];
      list.push(row);
      byEndpoint.set(row.endpoint_id, list);
    }
    const queues = [...byEndpoint.values()];
    const workers = Array.from(
      { length: Math.min(this.config.concurrency, queues.length) },
      async () => {
        for (let queue = queues.shift(); queue; queue = queues.shift()) {
          for (const { id } of queue) await this.attemptSafely(id);
        }
      },
    );
    await Promise.all(workers);
    return rows.length;
  }

  private async attemptSafely(id: string): Promise<void> {
    try {
      await this.attempt(id);
    } catch (error) {
      this.logger.error(
        `Webhook delivery ${id} failed internally: ${(error as Error).message}`,
      );
      await this.dataSource
        .getRepository(WebhookDelivery)
        .update(
          { id, status: 'delivering' },
          { status: 'failed', error: 'INTERNAL', lockedUntil: null },
        );
    }
  }

  maxAttemptsFor(delivery: Pick<WebhookDelivery, 'manual'>): number {
    return delivery.manual ? 1 : this.config.maxAttempts;
  }

  /** Ein Versuch fuer eine bereits beanspruchte Zustellung. */
  async attempt(deliveryId: string): Promise<void> {
    const deliveries = this.dataSource.getRepository(WebhookDelivery);
    const delivery = await deliveries.findOne({ where: { id: deliveryId } });
    if (!delivery || delivery.status !== 'delivering') return;

    const endpoint = await this.dataSource
      .getRepository(WebhookEndpoint)
      .createQueryBuilder('e')
      .addSelect(['e.secretEncrypted', 'e.previousSecretEncrypted'])
      .where('e.id = :id', { id: delivery.endpointId })
      .getOne();
    if (!endpoint) {
      await deliveries.update(
        { id: delivery.id },
        { status: 'failed', error: 'ENDPOINT_DELETED', lockedUntil: null },
      );
      return;
    }
    if (!endpoint.active && !delivery.manual) {
      await deliveries.update(
        { id: delivery.id },
        {
          status: 'failed',
          error: 'ENDPOINT_INACTIVE',
          nextAttemptAt: null,
          lockedUntil: null,
        },
      );
      return;
    }

    const started = new Date();
    const attemptNo = delivery.attempts + 1;
    const secrets = this.signingSecrets(endpoint, started);
    let result: WebhookResponse;
    if (secrets.length === 0) {
      result = {
        ok: false,
        responseStatus: null,
        responseBody: null,
        durationMs: 0,
        error: 'INTERNAL',
        detail: 'signing secret could not be decrypted',
      };
    } else {
      const timestamp = Math.floor(started.getTime() / 1000);
      result = await this.sender({
        url: endpoint.url,
        body: delivery.payload,
        timeoutMs: this.config.timeoutMs,
        allowHttp: this.config.allowHttp,
        allowPrivateNetworks: this.config.allowPrivateNetworks,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': WEBHOOK_USER_AGENT,
          'OpenEOS-Event-Id': delivery.eventId,
          'OpenEOS-Event-Type': delivery.eventType,
          'OpenEOS-Delivery-Id': delivery.id,
          'OpenEOS-Delivery-Attempt': String(attemptNo),
          'OpenEOS-Signature': buildSignatureHeader(
            secrets,
            timestamp,
            delivery.payload,
          ),
        },
      });
    }

    const finished = new Date();
    const entry: WebhookAttemptLogEntry = {
      at: started.toISOString(),
      responseStatus: result.responseStatus,
      durationMs: result.durationMs,
      error: result.error,
    };
    const retryAt = result.ok
      ? null
      : nextRetryAt(
          attemptNo,
          this.maxAttemptsFor(delivery),
          finished,
          this.random,
        );
    await deliveries.update(
      { id: delivery.id },
      {
        status: result.ok ? 'succeeded' : retryAt ? 'pending' : 'failed',
        attempts: attemptNo,
        lastAttemptAt: started,
        nextAttemptAt: retryAt,
        lockedUntil: null,
        responseStatus: result.responseStatus,
        responseBody: result.responseBody,
        durationMs: result.durationMs,
        error: result.error,
        attemptLog: [...(delivery.attemptLog ?? []), entry].slice(
          -MAX_ATTEMPT_LOG,
        ),
      },
    );
    if (!result.ok) {
      this.logger.warn(
        `Webhook ${delivery.eventType} → endpoint ${endpoint.id}: attempt ${attemptNo} failed (${result.error}${result.responseStatus ? ` ${result.responseStatus}` : ''}${result.detail ? `, ${result.detail}` : ''})`,
      );
    }
    await this.recordOutcome(endpoint, delivery.manual, result.ok, finished);
  }

  /** Aktuelles Geheimnis, waehrend der Uebergangszeit auch das alte. */
  private signingSecrets(endpoint: WebhookEndpoint, now: Date): string[] {
    const keyring = getIntegrationKeyring();
    const secrets: string[] = [];
    const current = keyring.decrypt(endpoint.secretEncrypted);
    if (current) secrets.push(current.plaintext);
    if (
      endpoint.previousSecretEncrypted &&
      endpoint.previousSecretExpiresAt &&
      new Date(endpoint.previousSecretExpiresAt).getTime() > now.getTime()
    ) {
      const previous = keyring.decrypt(endpoint.previousSecretEncrypted);
      if (previous) secrets.push(previous.plaintext);
    }
    return secrets;
  }

  /**
   * Zaehler am Endpunkt. Fehler von „Test senden“ und „Erneut senden“
   * zaehlen nicht zur Fehlerserie (der Verein probiert gerade aus), ein
   * Erfolg beendet sie aber.
   */
  private async recordOutcome(
    endpoint: WebhookEndpoint,
    manual: boolean,
    ok: boolean,
    now: Date,
  ): Promise<void> {
    if (ok) {
      await this.dataSource.query(
        `UPDATE webhook_endpoints
            SET last_delivery_at = $2, last_delivery_status = 'succeeded',
                last_success_at = $2, consecutive_failures = 0,
                failing_since = NULL, updated_at = now()
          WHERE id = $1`,
        [endpoint.id, now],
      );
      return;
    }
    if (manual) {
      await this.dataSource.query(
        `UPDATE webhook_endpoints
            SET last_delivery_at = $2, last_delivery_status = 'failed', updated_at = now()
          WHERE id = $1`,
        [endpoint.id, now],
      );
      return;
    }
    const result = await this.dataSource.query<
      [
        Array<{
          consecutive_failures: number;
          failing_since: Date;
          active: boolean;
        }>,
        number,
      ]
    >(
      `UPDATE webhook_endpoints
          SET last_delivery_at = $2, last_delivery_status = 'failed',
              consecutive_failures = consecutive_failures + 1,
              failing_since = COALESCE(failing_since, $2), updated_at = now()
        WHERE id = $1
      RETURNING consecutive_failures, failing_since, active`,
      [endpoint.id, now],
    );
    const row = Array.isArray(result[0]) ? result[0][0] : undefined;
    if (!row || !row.active) return;
    const failingFor = now.getTime() - new Date(row.failing_since).getTime();
    if (
      row.consecutive_failures >= this.config.disableAfterFailures &&
      failingFor >= this.config.disableAfterHours * 3_600_000
    ) {
      await this.autoDisable(
        endpoint,
        row.consecutive_failures,
        row.failing_since,
        now,
      );
    }
  }

  private async autoDisable(
    endpoint: WebhookEndpoint,
    failures: number,
    failingSince: Date,
    now: Date,
  ): Promise<void> {
    const switched = await this.dataSource.query<[unknown[], number]>(
      `UPDATE webhook_endpoints
          SET active = false, disabled_reason = 'too_many_failures',
              disabled_at = $2, updated_at = now()
        WHERE id = $1 AND active
      RETURNING id`,
      [endpoint.id, now],
    );
    const rows = Array.isArray(switched[0]) ? switched[0] : [];
    if (rows.length === 0) return; // andere Instanz war schneller

    await failPendingDeliveries(this.dataSource, endpoint.id);
    this.logger.warn(
      `Webhook endpoint ${endpoint.id} disabled after ${failures} consecutive failures`,
    );
    try {
      await this.dataSource.getRepository(AdminAuditLog).insert({
        adminUserId: null,
        organizationId: endpoint.organizationId,
        action: AdminAction.WEBHOOK_AUTO_DISABLED,
        resourceType: 'webhook',
        resourceId: endpoint.id,
        details: {
          url: endpoint.url,
          consecutiveFailures: failures,
          failingSince: new Date(failingSince).toISOString(),
        },
        ipAddress: SYSTEM_AUDIT_IP,
        userAgent: null,
      });
    } catch (error) {
      this.logger.error(
        `Audit entry webhook_auto_disabled not written: ${(error as Error).message}`,
      );
    }
    await this.mailAdmins(endpoint, failures, new Date(failingSince));
  }

  private async mailAdmins(
    endpoint: WebhookEndpoint,
    failures: number,
    failingSince: Date,
  ): Promise<void> {
    try {
      const organization = await this.dataSource
        .getRepository(Organization)
        .findOne({
          where: { id: endpoint.organizationId },
          select: { id: true, name: true },
        });
      const memberships = await this.dataSource
        .getRepository(UserOrganization)
        .find({
          where: {
            organizationId: endpoint.organizationId,
            role: OrganizationRole.ADMIN,
          },
          relations: { user: true },
        });
      const recipients = [
        ...new Set(
          memberships
            .filter((m) => m.user?.isActive !== false)
            .map((m) => m.user?.email)
            .filter((email): email is string => !!email),
        ),
      ];
      for (const to of recipients) {
        await this.emailService.sendWebhookDisabledEmail({
          to,
          organizationName: organization?.name ?? '',
          url: endpoint.url,
          failures,
          failingSince,
          settingsPath: WEBHOOK_SETTINGS_PATH,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Webhook disabled mail for ${endpoint.id} not sent: ${(error as Error).message}`,
      );
    }
  }

  /** Stuendlich: Protokoll nach der Frist loeschen (eine Instanz). */
  @Cron(CronExpression.EVERY_HOUR, { name: 'webhook-cleanup' })
  async cleanup(): Promise<void> {
    await this.cronLock.runExclusive('webhook-cleanup', async () => {
      await this.cleanupNow();
    });
  }

  async cleanupNow(
    now: Date = new Date(),
  ): Promise<{ deliveriesDeleted: number; outboxDeleted: number }> {
    const cutoff = new Date(
      now.getTime() - this.config.deliveryRetentionDays * 86_400_000,
    );
    const deleted = await this.dataSource.query<[unknown[], number]>(
      `DELETE FROM webhook_deliveries WHERE created_at < $1`,
      [cutoff],
    );
    const deliveriesDeleted = Array.isArray(deleted)
      ? Number(deleted[1] ?? 0)
      : 0;
    // Ohne Zustellung (WEBHOOKS_ENABLED=false) haeuft sich der Postausgang nicht an.
    const outboxDeleted = await this.dispatcher.purgeOutbox(
      new Date(now.getTime() - 86_400_000),
    );
    if (deliveriesDeleted > 0 || outboxDeleted > 0) {
      this.logger.log(
        `Webhook log cleaned: ${deliveriesDeleted} deliveries, ${outboxDeleted} stale outbox entries`,
      );
    }
    return { deliveriesDeleted, outboxDeleted };
  }

  get retentionDays(): number {
    return this.config.deliveryRetentionDays;
  }
}

/** Offene, nicht manuelle Zustellungen eines Endpunkts beenden. */
export async function failPendingDeliveries(
  dataSource: DataSource,
  endpointId: string,
): Promise<void> {
  const error: WebhookDeliveryError = 'ENDPOINT_INACTIVE';
  await dataSource.query(
    `UPDATE webhook_deliveries
        SET status = 'failed', error = $2, next_attempt_at = NULL,
            locked_until = NULL, updated_at = now()
      WHERE endpoint_id = $1 AND status = 'pending' AND NOT manual`,
    [endpointId, error],
  );
}
