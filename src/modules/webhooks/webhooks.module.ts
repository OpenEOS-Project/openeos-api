import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebhookDelivery, WebhookEndpoint } from '../../database/entities';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookPhaseTrackerService } from './webhook-phase-tracker.service';
import { WebhooksController } from './webhooks.controller';
import { WEBHOOKS_CONFIG, loadWebhooksConfig } from './webhooks.config';
import { WebhooksService } from './webhooks.service';

/**
 * Ausgehende Webhooks (AGB Ziffer 10.2). Siehe README „Webhooks“:
 * Datenbank-Trigger fuellen `webhook_outbox`, der Dispatcher verteilt auf
 * die Endpunkte, der Zustelldienst sendet signiert mit Wiederholungen.
 */
@Module({
  imports: [TypeOrmModule.forFeature([WebhookEndpoint, WebhookDelivery])],
  controllers: [WebhooksController],
  providers: [
    { provide: WEBHOOKS_CONFIG, useFactory: () => loadWebhooksConfig() },
    WebhookDispatcherService,
    WebhookDeliveryService,
    WebhookPhaseTrackerService,
    WebhooksService,
  ],
  exports: [WebhookDeliveryService, WebhooksService],
})
export class WebhooksModule {}
