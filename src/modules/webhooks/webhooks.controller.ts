import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { ApiTokenAccess, CurrentUser, Roles } from '../../common/decorators';
import { OrganizationGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../common/constants/roles.enum';
import { assertOrganizationRole } from '../../common/utils/organization-access.util';
import { User } from '../../database/entities';
import { TokenScope } from '../api-tokens/api-scopes';
import {
  CreateWebhookDto,
  ListWebhookDeliveriesDto,
  UpdateWebhookDto,
} from './dto';
import { WebhooksService } from './webhooks.service';

const client = (request: Request) => ({
  ipAddress: request.ip ?? null,
  userAgent: request.headers['user-agent'] ?? null,
});

const ENDPOINT_EXAMPLE = {
  id: '0d2f6a4e-5b8c-4d0e-9a51-3c7e2b9f1a10',
  organizationId: 'b1e7c9d2-4f3a-4e8b-9c6d-2a5f8e1b7c30',
  url: 'https://example.org/openeos/webhook',
  description: 'Buchhaltung',
  eventTypes: ['order.paid', 'refund.created'],
  active: true,
  includeGuestData: false,
  includeTestOrders: false,
  secretHint: 'whsec_3fA9…',
  previousSecretExpiresAt: null,
  consecutiveFailures: 0,
  failingSince: null,
  disabledReason: null,
  disabledAt: null,
  lastDeliveryAt: '2026-11-10T18:04:13.511Z',
  lastDeliveryStatus: 'succeeded',
  lastSuccessAt: '2026-11-10T18:04:13.511Z',
  createdBy: { id: '7c4e…', firstName: 'Alex', lastName: 'Muster' },
  createdAt: '2026-11-10T17:55:02.000Z',
  updatedAt: '2026-11-10T18:04:13.511Z',
};

const DELIVERY_EXAMPLE = {
  id: '5a0f3c1e-2d4b-4b7a-8e9f-1c2d3e4f5a6b',
  webhookId: ENDPOINT_EXAMPLE.id,
  eventId: '6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b',
  eventType: 'order.paid',
  status: 'succeeded',
  attempts: 1,
  maxAttempts: 8,
  nextAttemptAt: null,
  lastAttemptAt: '2026-11-10T18:04:13.300Z',
  responseStatus: 200,
  durationMs: 211,
  error: null,
  manual: false,
  redeliveryOf: null,
  createdAt: '2026-11-10T18:04:13.250Z',
};

/**
 * Ausgehende Webhooks einer Organisation (AGB Ziffer 10.2): OpenEOS meldet
 * Bestellungen, Zahlungen, Erstattungen usw. an eine Adresse des Vereins.
 *
 * Nur Organisations-Admins — ein Webhook kann Gästedaten an Dritte senden.
 * Per API-Token mit `webhooks:read` bzw. `webhooks:write` (Besitzer Admin);
 * Löschen nur mit Anmeldung, wie überall bei Tokens.
 */
@ApiTags('Webhooks')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/webhooks')
@UseGuards(OrganizationGuard, RolesGuard)
@Roles(Role.ADMIN)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @ApiTokenAccess(TokenScope.WEBHOOKS_READ)
  @Get('info')
  @ApiOperation({
    operationId: 'getWebhookInfo',
    summary: 'Webhook-Einstellungen des Servers',
    description:
      'Ob Webhooks auf diesem Server eingeschaltet sind, Grenzen (Endpunkte je Organisation, Versuche, Aufbewahrung des Protokolls), die aktuelle `apiVersion` der Nutzlast und alle abonnierbaren Ereignisse mit Beschreibung. Scope `webhooks:read`.',
  })
  info() {
    return { data: this.webhooks.info() };
  }

  @ApiTokenAccess(TokenScope.WEBHOOKS_READ)
  @Get()
  @ApiOperation({
    operationId: 'listWebhooks',
    summary: 'Webhooks auflisten',
    description:
      'Alle Webhook-Endpunkte der Organisation, neueste zuerst, mit Zustand der letzten Zustellung und Fehlerserie. Vom Signatur-Geheimnis ist nur `secretHint` sichtbar. Scope `webhooks:read`, Besitzer Administrator.',
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook-Endpunkte',
    example: { data: [ENDPOINT_EXAMPLE] },
  })
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    assertOrganizationRole(user, organizationId, Role.ADMIN);
    return { data: await this.webhooks.list(organizationId) };
  }

  @ApiTokenAccess(TokenScope.WEBHOOKS_WRITE)
  @Post()
  @ApiOperation({
    operationId: 'createWebhook',
    summary: 'Webhook anlegen',
    description:
      'Legt einen Endpunkt an. Die Adresse muss mit `https://` beginnen und auf öffentliche Adressen zeigen (`400 WEBHOOK_URL_INVALID`, `params.reason`). Das Signatur-Geheimnis (`data.secret`, `whsec_…`) kommt genau einmal in dieser Antwort. Höchstens 10 Endpunkte je Organisation (`409 WEBHOOK_LIMIT_REACHED`). Scope `webhooks:write`.',
  })
  @ApiResponse({
    status: 201,
    description: 'Angelegt; `data.secret` ist das Geheimnis',
    example: {
      data: {
        ...ENDPOINT_EXAMPLE,
        lastDeliveryAt: null,
        lastDeliveryStatus: null,
        lastSuccessAt: null,
        secret: 'whsec_3fA9pQ…',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'WEBHOOK_URL_INVALID, WEBHOOK_EVENT_TYPE_INVALID',
  })
  @ApiResponse({ status: 409, description: 'WEBHOOK_LIMIT_REACHED' })
  @ApiResponse({ status: 503, description: 'WEBHOOKS_DISABLED' })
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateWebhookDto,
    @Req() request: Request,
  ) {
    assertOrganizationRole(user, organizationId, Role.ADMIN);
    return {
      data: await this.webhooks.create(
        organizationId,
        user,
        dto,
        client(request),
      ),
    };
  }

  @ApiTokenAccess(TokenScope.WEBHOOKS_READ)
  @Get(':webhookId')
  @ApiParam({
    name: 'webhookId',
    format: 'uuid',
    description: 'ID des Webhooks',
  })
  @ApiOperation({
    operationId: 'getWebhook',
    summary: 'Webhook abrufen',
    description: 'Ein Endpunkt der Organisation. Scope `webhooks:read`.',
  })
  async get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @CurrentUser() user: User,
  ) {
    assertOrganizationRole(user, organizationId, Role.ADMIN);
    return { data: await this.webhooks.get(organizationId, webhookId) };
  }

  @ApiTokenAccess(TokenScope.WEBHOOKS_WRITE)
  @Patch(':webhookId')
  @ApiParam({
    name: 'webhookId',
    format: 'uuid',
    description: 'ID des Webhooks',
  })
  @ApiOperation({
    operationId: 'updateWebhook',
    summary: 'Webhook ändern',
    description:
      'Ändert Adresse, Beschreibung, Ereignisse oder Schalter. `active: true` schaltet einen automatisch abgeschalteten Endpunkt wieder ein und setzt die Fehlerserie zurück; `active: false` beendet offene Zustellungen. Scope `webhooks:write`.',
  })
  async update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateWebhookDto,
    @Req() request: Request,
  ) {
    assertOrganizationRole(user, organizationId, Role.ADMIN);
    return {
      data: await this.webhooks.update(
        organizationId,
        webhookId,
        user,
        dto,
        client(request),
      ),
    };
  }

  @Delete(':webhookId')
  @ApiParam({
    name: 'webhookId',
    format: 'uuid',
    description: 'ID des Webhooks',
  })
  @ApiOperation({
    operationId: 'deleteWebhook',
    summary: 'Webhook löschen',
    description:
      'Löscht den Endpunkt samt Zustellprotokoll. Nur mit Anmeldung (JWT) als Administrator — nicht per Token.',
  })
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    assertOrganizationRole(user, organizationId, Role.ADMIN);
    return {
      data: await this.webhooks.remove(
        organizationId,
        webhookId,
        user,
        client(request),
      ),
    };
  }

  @ApiTokenAccess(TokenScope.WEBHOOKS_WRITE)
  @Post(':webhookId/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiParam({
    name: 'webhookId',
    format: 'uuid',
    description: 'ID des Webhooks',
  })
  @ApiOperation({
    operationId: 'rotateWebhookSecret',
    summary: 'Signatur-Geheimnis erneuern',
    description:
      'Erzeugt ein neues Geheimnis (`data.secret`, genau einmal). Das alte signiert noch 24 Stunden mit (zweites `v1=` in `OpenEOS-Signature`, bis `previousSecretExpiresAt`), damit du den Empfänger ohne Ausfall umstellen kannst. Scope `webhooks:write`.',
  })
  async rotate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    assertOrganizationRole(user, organizationId, Role.ADMIN);
    return {
      data: await this.webhooks.rotateSecret(
        organizationId,
        webhookId,
        user,
        client(request),
      ),
    };
  }

  @ApiTokenAccess(TokenScope.WEBHOOKS_WRITE)
  @Post(':webhookId/test')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiParam({
    name: 'webhookId',
    format: 'uuid',
    description: 'ID des Webhooks',
  })
  @ApiOperation({
    operationId: 'testWebhook',
    summary: 'Test senden',
    description:
      'Sendet ein Ereignis `ping` (ein Versuch, auch an ausgeschaltete Endpunkte). Das Ergebnis steht nach wenigen Sekunden im Zustellprotokoll. Scope `webhooks:write`.',
  })
  @ApiResponse({
    status: 202,
    description: 'Zustellung angelegt',
    example: {
      data: {
        ...DELIVERY_EXAMPLE,
        eventType: 'ping',
        status: 'pending',
        attempts: 0,
        maxAttempts: 1,
        lastAttemptAt: null,
        responseStatus: null,
        durationMs: null,
        manual: true,
      },
    },
  })
  async test(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @CurrentUser() user: User,
  ) {
    assertOrganizationRole(user, organizationId, Role.ADMIN);
    return { data: await this.webhooks.sendTest(organizationId, webhookId) };
  }

  @ApiTokenAccess(TokenScope.WEBHOOKS_READ)
  @Get(':webhookId/deliveries')
  @ApiParam({
    name: 'webhookId',
    format: 'uuid',
    description: 'ID des Webhooks',
  })
  @ApiOperation({
    operationId: 'listWebhookDeliveries',
    summary: 'Zustellprotokoll',
    description:
      'Zustellungen des Endpunkts, neueste zuerst, seitenweise (`page`, `limit` ≤ 100), optional nach `status` und `eventType` gefiltert. Das Protokoll wird nach 30 Tagen gelöscht. Scope `webhooks:read`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Zustellungen',
    example: {
      data: [DELIVERY_EXAMPLE],
      meta: {
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
  })
  async deliveries(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @CurrentUser() user: User,
    @Query() query: ListWebhookDeliveriesDto,
  ) {
    assertOrganizationRole(user, organizationId, Role.ADMIN);
    return this.webhooks.listDeliveries(organizationId, webhookId, query);
  }

  @ApiTokenAccess(TokenScope.WEBHOOKS_READ)
  @Get(':webhookId/deliveries/:deliveryId')
  @ApiParam({
    name: 'webhookId',
    format: 'uuid',
    description: 'ID des Webhooks',
  })
  @ApiParam({
    name: 'deliveryId',
    format: 'uuid',
    description: 'ID der Zustellung',
  })
  @ApiOperation({
    operationId: 'getWebhookDelivery',
    summary: 'Zustellung abrufen',
    description:
      'Eine Zustellung mit dem gesendeten Inhalt (`payload`), den ersten 1 024 Zeichen der Antwort (`responseBody`) und allen Versuchen (`attemptLog`). Scope `webhooks:read`.',
  })
  async delivery(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @CurrentUser() user: User,
  ) {
    assertOrganizationRole(user, organizationId, Role.ADMIN);
    return {
      data: await this.webhooks.getDelivery(
        organizationId,
        webhookId,
        deliveryId,
      ),
    };
  }

  @ApiTokenAccess(TokenScope.WEBHOOKS_WRITE)
  @Post(':webhookId/deliveries/:deliveryId/redeliver')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiParam({
    name: 'webhookId',
    format: 'uuid',
    description: 'ID des Webhooks',
  })
  @ApiParam({
    name: 'deliveryId',
    format: 'uuid',
    description: 'ID der Zustellung',
  })
  @ApiOperation({
    operationId: 'redeliverWebhook',
    summary: 'Erneut senden',
    description:
      'Sendet eine Zustellung noch einmal (ein Versuch) — mit derselben Ereignis-ID und demselben Inhalt, damit der Empfänger Doppelte erkennt. Scope `webhooks:write`.',
  })
  async redeliver(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @CurrentUser() user: User,
  ) {
    assertOrganizationRole(user, organizationId, Role.ADMIN);
    return {
      data: await this.webhooks.redeliver(
        organizationId,
        webhookId,
        deliveryId,
      ),
    };
  }
}
