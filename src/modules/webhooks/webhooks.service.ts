import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  createPaginationMeta,
  type PaginatedResponse,
} from '../../common/dto/pagination.dto';
import { getIntegrationKeyring } from '../../common/services/integration-credentials.crypto';
import {
  AdminAction,
  AdminAuditLog,
  WebhookDelivery,
  WebhookEndpoint,
  type User,
} from '../../database/entities';
import type {
  CreateWebhookDto,
  ListWebhookDeliveriesDto,
  UpdateWebhookDto,
} from './dto';
import {
  failPendingDeliveries,
  WebhookDeliveryService,
} from './webhook-delivery.service';
import {
  WEBHOOK_API_VERSION,
  WEBHOOK_EVENT_TYPE_INFO,
  WEBHOOK_PING,
  isWebhookEventType,
  type WebhookEventTypeInfo,
} from './webhook-event-types';
import { envelope } from './webhook-payloads';
import { generateWebhookSecret, webhookSecretHint } from './webhook-signature';
import { validateWebhookUrl, type LookupAll } from './webhook-url-guard';
import {
  PREVIOUS_SECRET_GRACE_HOURS,
  SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOKS_CONFIG,
  type WebhooksConfig,
} from './webhooks.config';

export interface WebhookInfo {
  enabled: boolean;
  maxEndpoints: number;
  apiVersion: string;
  signatureToleranceSeconds: number;
  maxAttempts: number;
  retentionDays: number;
  /** `http://` erlaubt (eigene Installation, `WEBHOOKS_ALLOW_HTTP`). */
  allowHttp: boolean;
  /** Private Netze als Ziel erlaubt (`WEBHOOKS_ALLOW_PRIVATE_NETWORKS`). */
  allowPrivateNetworks: boolean;
  eventTypes: readonly WebhookEventTypeInfo[];
}

export type WebhookEndpointView = Omit<
  WebhookEndpoint,
  | 'secretEncrypted'
  | 'previousSecretEncrypted'
  | 'organization'
  | 'createdBy'
  | 'createdByUserId'
> & {
  createdBy: { id: string; firstName: string; lastName: string } | null;
};

export type WebhookDeliveryView = Omit<
  WebhookDelivery,
  | 'payload'
  | 'responseBody'
  | 'attemptLog'
  | 'endpoint'
  | 'endpointId'
  | 'lockedUntil'
  | 'updatedAt'
  | 'organizationId'
> & { webhookId: string; maxAttempts: number };

export type WebhookDeliveryDetailView = WebhookDeliveryView & {
  payload: unknown;
  responseBody: string | null;
  attemptLog: WebhookDelivery['attemptLog'];
};

export interface AuditClient {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function endpointView(endpoint: WebhookEndpoint): WebhookEndpointView {
  const {
    secretEncrypted: _secret,
    previousSecretEncrypted: _previous,
    organization: _organization,
    createdBy,
    createdByUserId: _createdByUserId,
    ...rest
  } = endpoint;
  return {
    ...rest,
    createdBy: createdBy
      ? {
          id: createdBy.id,
          firstName: createdBy.firstName,
          lastName: createdBy.lastName,
        }
      : null,
  };
}

/**
 * Verwaltung der Webhooks einer Organisation (nur Admins, siehe Controller):
 * anlegen, aendern, loeschen, Geheimnis erneuern, testen, Protokoll,
 * erneut senden. Jede Aenderung steht im Admin-Protokoll.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  /** Austauschbar fuer Tests (DNS). */
  lookup: LookupAll | undefined;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(WEBHOOKS_CONFIG) private readonly config: WebhooksConfig,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  info(): WebhookInfo {
    return {
      enabled: this.config.enabled,
      maxEndpoints: this.config.maxEndpointsPerOrganization,
      apiVersion: WEBHOOK_API_VERSION,
      signatureToleranceSeconds: SIGNATURE_TOLERANCE_SECONDS,
      maxAttempts: this.config.maxAttempts,
      retentionDays: this.config.deliveryRetentionDays,
      allowHttp: this.config.allowHttp,
      allowPrivateNetworks: this.config.allowPrivateNetworks,
      eventTypes: WEBHOOK_EVENT_TYPE_INFO,
    };
  }

  private get endpoints() {
    return this.dataSource.getRepository(WebhookEndpoint);
  }

  private get deliveries() {
    return this.dataSource.getRepository(WebhookDelivery);
  }

  async list(organizationId: string): Promise<WebhookEndpointView[]> {
    const rows = await this.endpoints.find({
      where: { organizationId },
      relations: { createdBy: true },
      order: { createdAt: 'DESC' },
    });
    return rows.map(endpointView);
  }

  async get(organizationId: string, id: string): Promise<WebhookEndpointView> {
    return endpointView(await this.load(organizationId, id));
  }

  private async load(
    organizationId: string,
    id: string,
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.endpoints.findOne({
      where: { id, organizationId },
      relations: { createdBy: true },
    });
    if (!endpoint) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.WEBHOOK_NOT_FOUND,
        message: 'Webhook nicht gefunden',
      });
    }
    return endpoint;
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new ServiceUnavailableException({
        code: ErrorCodes.WEBHOOKS_DISABLED,
        reason: ErrorReasons.WEBHOOKS_DISABLED,
        message: 'Webhooks sind auf diesem Server ausgeschaltet',
      });
    }
  }

  private assertEventTypes(types: string[]): void {
    const unknown = types.filter((t) => !isWebhookEventType(t));
    if (unknown.length > 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.WEBHOOK_EVENT_TYPE_INVALID,
        message: `Unbekannte Ereignisse: ${unknown.join(', ')}`,
        params: { eventTypes: unknown },
      });
    }
  }

  private async checkedUrl(raw: string): Promise<string> {
    const result = await validateWebhookUrl(raw, this.config, this.lookup);
    if (!result.ok) {
      const messages: Record<typeof result.problem, string> = {
        invalid: 'Bitte gib eine gültige Adresse an',
        not_https: 'Die Adresse muss mit https:// beginnen',
        credentials: 'Die Adresse darf keine Zugangsdaten enthalten',
        private_address:
          'Die Adresse zeigt auf ein privates oder internes Netz – das ist nicht erlaubt',
        unresolvable: 'Der Rechnername der Adresse lässt sich nicht auflösen',
      };
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.WEBHOOK_URL_INVALID,
        message: messages[result.problem],
        params: { reason: result.problem },
      });
    }
    return result.url;
  }

  async create(
    organizationId: string,
    user: Pick<User, 'id'>,
    dto: CreateWebhookDto,
    client: AuditClient = {},
  ): Promise<WebhookEndpointView & { secret: string }> {
    this.assertEnabled();
    this.assertEventTypes(dto.eventTypes);
    const count = await this.endpoints.count({ where: { organizationId } });
    const limit = this.config.maxEndpointsPerOrganization;
    if (count >= limit) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.WEBHOOK_LIMIT_REACHED,
        message: `Höchstens ${limit} Webhooks je Organisation`,
        params: { limit },
      });
    }
    const url = await this.checkedUrl(dto.url);
    const secret = generateWebhookSecret();
    const saved = await this.endpoints.save(
      this.endpoints.create({
        organizationId,
        url,
        description: dto.description?.trim() || null,
        eventTypes: dto.eventTypes,
        active: dto.active ?? true,
        includeGuestData: dto.includeGuestData ?? false,
        includeTestOrders: dto.includeTestOrders ?? false,
        secretEncrypted: getIntegrationKeyring().encrypt(secret),
        secretHint: webhookSecretHint(secret),
        createdByUserId: user.id,
      }),
    );
    const endpoint = await this.load(organizationId, saved.id);
    await this.audit(AdminAction.WEBHOOK_CREATED, endpoint, user, client, {
      eventTypes: endpoint.eventTypes,
      active: endpoint.active,
      includeGuestData: endpoint.includeGuestData,
      includeTestOrders: endpoint.includeTestOrders,
    });
    return { ...endpointView(endpoint), secret };
  }

  async update(
    organizationId: string,
    id: string,
    user: Pick<User, 'id'>,
    dto: UpdateWebhookDto,
    client: AuditClient = {},
  ): Promise<WebhookEndpointView> {
    const endpoint = await this.load(organizationId, id);
    const changed: string[] = [];
    if (dto.eventTypes !== undefined) {
      this.assertEventTypes(dto.eventTypes);
      endpoint.eventTypes = dto.eventTypes;
      changed.push('eventTypes');
    }
    if (dto.url !== undefined && dto.url.trim() !== endpoint.url) {
      endpoint.url = await this.checkedUrl(dto.url);
      changed.push('url');
    }
    if (dto.description !== undefined) {
      endpoint.description = dto.description?.trim() || null;
      changed.push('description');
    }
    if (dto.includeGuestData !== undefined) {
      endpoint.includeGuestData = dto.includeGuestData;
      changed.push('includeGuestData');
    }
    if (dto.includeTestOrders !== undefined) {
      endpoint.includeTestOrders = dto.includeTestOrders;
      changed.push('includeTestOrders');
    }
    let deactivated = false;
    if (dto.active !== undefined && dto.active !== endpoint.active) {
      changed.push('active');
      endpoint.active = dto.active;
      if (dto.active) {
        endpoint.disabledReason = null;
        endpoint.disabledAt = null;
        endpoint.consecutiveFailures = 0;
        endpoint.failingSince = null;
      } else {
        deactivated = true;
      }
    }
    if (changed.length === 0) return endpointView(endpoint);

    const { createdBy: _createdBy, ...columns } = endpoint;
    await this.endpoints.save(columns);
    if (deactivated) await failPendingDeliveries(this.dataSource, endpoint.id);
    await this.audit(AdminAction.WEBHOOK_UPDATED, endpoint, user, client, {
      changed,
      ...(changed.includes('url') ? { url: endpoint.url } : {}),
      active: endpoint.active,
      eventTypes: endpoint.eventTypes,
      includeGuestData: endpoint.includeGuestData,
      includeTestOrders: endpoint.includeTestOrders,
    });
    return endpointView(await this.load(organizationId, id));
  }

  async remove(
    organizationId: string,
    id: string,
    user: Pick<User, 'id'>,
    client: AuditClient = {},
  ): Promise<{ id: string; deleted: true }> {
    const endpoint = await this.load(organizationId, id);
    await this.endpoints.delete({ id: endpoint.id, organizationId });
    await this.audit(AdminAction.WEBHOOK_DELETED, endpoint, user, client, {});
    return { id: endpoint.id, deleted: true };
  }

  async rotateSecret(
    organizationId: string,
    id: string,
    user: Pick<User, 'id'>,
    client: AuditClient = {},
    now: Date = new Date(),
  ): Promise<WebhookEndpointView & { secret: string }> {
    await this.load(organizationId, id);
    const current = await this.endpoints
      .createQueryBuilder('e')
      .addSelect('e.secretEncrypted')
      .where('e.id = :id', { id })
      .getOneOrFail();
    const secret = generateWebhookSecret();
    const expires = new Date(
      now.getTime() + PREVIOUS_SECRET_GRACE_HOURS * 3_600_000,
    );
    await this.endpoints.update(
      { id, organizationId },
      {
        previousSecretEncrypted: current.secretEncrypted,
        previousSecretExpiresAt: expires,
        secretEncrypted: getIntegrationKeyring().encrypt(secret),
        secretHint: webhookSecretHint(secret),
      },
    );
    const endpoint = await this.load(organizationId, id);
    await this.audit(
      AdminAction.WEBHOOK_SECRET_ROTATED,
      endpoint,
      user,
      client,
      {
        previousSecretExpiresAt: expires.toISOString(),
      },
    );
    return { ...endpointView(endpoint), secret };
  }

  /** „Test senden“: ein `ping`, auch an ausgeschaltete Endpunkte. */
  async sendTest(
    organizationId: string,
    id: string,
    now: Date = new Date(),
  ): Promise<WebhookDeliveryView> {
    this.assertEnabled();
    const endpoint = await this.load(organizationId, id);
    const eventId = randomUUID();
    const payload = JSON.stringify(
      envelope(eventId, WEBHOOK_PING, organizationId, now, {
        webhookId: endpoint.id,
        message: 'Test von OpenEOS',
      }),
    );
    const saved = await this.deliveries.save(
      this.deliveries.create({
        endpointId: endpoint.id,
        organizationId,
        eventId,
        eventType: WEBHOOK_PING,
        payload,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        manual: true,
      }),
    );
    this.delivery.kick();
    return this.deliveryView(saved);
  }

  async listDeliveries(
    organizationId: string,
    webhookId: string,
    query: ListWebhookDeliveriesDto,
  ): Promise<PaginatedResponse<WebhookDeliveryView>> {
    await this.load(organizationId, webhookId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const qb = this.deliveries
      .createQueryBuilder('d')
      .where('d.endpointId = :webhookId', { webhookId })
      .andWhere('d.organizationId = :organizationId', { organizationId })
      .orderBy('d.createdAt', 'DESC')
      .addOrderBy('d.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.status)
      qb.andWhere('d.status = :status', { status: query.status });
    if (query.eventType) {
      qb.andWhere('d.eventType = :eventType', { eventType: query.eventType });
    }
    const [rows, total] = await qb.getManyAndCount();
    return {
      data: rows.map((row) => this.deliveryView(row)),
      meta: createPaginationMeta(total, page, limit),
    };
  }

  private async loadDelivery(
    organizationId: string,
    webhookId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery> {
    const delivery = await this.deliveries.findOne({
      where: { id: deliveryId, endpointId: webhookId, organizationId },
    });
    if (!delivery) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.WEBHOOK_DELIVERY_NOT_FOUND,
        message: 'Zustellung nicht gefunden',
      });
    }
    return delivery;
  }

  async getDelivery(
    organizationId: string,
    webhookId: string,
    deliveryId: string,
  ): Promise<WebhookDeliveryDetailView> {
    await this.load(organizationId, webhookId);
    const delivery = await this.loadDelivery(
      organizationId,
      webhookId,
      deliveryId,
    );
    let payload: unknown = delivery.payload;
    try {
      payload = JSON.parse(delivery.payload);
    } catch {
      // bleibt Text
    }
    return {
      ...this.deliveryView(delivery),
      payload,
      responseBody: delivery.responseBody,
      attemptLog: delivery.attemptLog ?? [],
    };
  }

  /** „Erneut senden“: neue Zustellung, dieselbe Ereignis-ID, derselbe Text. */
  async redeliver(
    organizationId: string,
    webhookId: string,
    deliveryId: string,
    now: Date = new Date(),
  ): Promise<WebhookDeliveryView> {
    this.assertEnabled();
    await this.load(organizationId, webhookId);
    const original = await this.loadDelivery(
      organizationId,
      webhookId,
      deliveryId,
    );
    const saved = await this.deliveries.save(
      this.deliveries.create({
        endpointId: original.endpointId,
        organizationId,
        eventId: original.eventId,
        eventType: original.eventType,
        payload: original.payload,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        manual: true,
        redeliveryOf: original.redeliveryOf ?? original.id,
      }),
    );
    this.delivery.kick();
    return this.deliveryView(saved);
  }

  deliveryView(delivery: WebhookDelivery): WebhookDeliveryView {
    return {
      id: delivery.id,
      webhookId: delivery.endpointId,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      status: delivery.status,
      attempts: delivery.attempts,
      maxAttempts: this.delivery.maxAttemptsFor(delivery),
      nextAttemptAt: delivery.nextAttemptAt,
      lastAttemptAt: delivery.lastAttemptAt,
      responseStatus: delivery.responseStatus,
      durationMs: delivery.durationMs,
      error: delivery.error,
      manual: delivery.manual,
      redeliveryOf: delivery.redeliveryOf,
      createdAt: delivery.createdAt,
    };
  }

  private async audit(
    action: AdminAction,
    endpoint: WebhookEndpoint,
    actor: Pick<User, 'id'>,
    client: AuditClient,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.dataSource.getRepository(AdminAuditLog).insert({
        adminUserId: actor.id,
        organizationId: endpoint.organizationId,
        action,
        resourceType: 'webhook',
        resourceId: endpoint.id,
        details: { url: endpoint.url, ...details },
        ipAddress: (client.ipAddress || 'unknown').slice(0, 45),
        userAgent: client.userAgent?.slice(0, 500) ?? null,
      });
    } catch (error) {
      this.logger.error(
        `Audit entry ${action} not written: ${(error as Error).message}`,
      );
    }
  }
}
