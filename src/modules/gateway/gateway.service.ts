import { Injectable, Logger } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import {
  GatewayEvents,
  OrderCreatedEvent,
  OrderUpdatedEvent,
  OrderItemStatusChangedEvent,
  PaymentReceivedEvent,
  PrintJobCreatedEvent,
  PrintJobStatusChangedEvent,
  BroadcastMessageEvent,
} from './dto';

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(private readonly appGateway: AppGateway) {}

  // Order Events

  notifyOrderCreated(organizationId: string, eventId: string | null, order: OrderCreatedEvent['order']) {
    const payload: OrderCreatedEvent = { order };

    this.logger.debug(`Emitting orderCreated for order ${order.id}`);

    if (eventId) {
      this.appGateway.emitToEvent(organizationId, eventId, GatewayEvents.ORDER_CREATED, payload);
    }
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.ORDER_CREATED, payload);
  }

  notifyOrderUpdated(organizationId: string, eventId: string | null, orderId: string, changes: Record<string, unknown>) {
    const payload: OrderUpdatedEvent = { orderId, changes };

    this.logger.debug(`Emitting orderUpdated for order ${orderId}`);

    if (eventId) {
      this.appGateway.emitToEvent(organizationId, eventId, GatewayEvents.ORDER_UPDATED, payload);
    }
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.ORDER_UPDATED, payload);
  }

  notifyOrderItemStatusChanged(
    organizationId: string,
    eventId: string | null,
    data: Omit<OrderItemStatusChangedEvent, 'type'>,
  ) {
    const payload: OrderItemStatusChangedEvent = data;

    this.logger.debug(`Emitting orderItemStatusChanged for item ${data.itemId}`);

    if (eventId) {
      this.appGateway.emitToEvent(organizationId, eventId, GatewayEvents.ORDER_ITEM_STATUS_CHANGED, payload);
    }
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.ORDER_ITEM_STATUS_CHANGED, payload);
  }

  // Payment Events

  notifyPaymentReceived(
    organizationId: string,
    eventId: string | null,
    data: Omit<PaymentReceivedEvent, 'type'>,
  ) {
    const payload: PaymentReceivedEvent = data;

    this.logger.debug(`Emitting paymentReceived for order ${data.orderId}`);

    if (eventId) {
      this.appGateway.emitToEvent(organizationId, eventId, GatewayEvents.PAYMENT_RECEIVED, payload);
    }
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.PAYMENT_RECEIVED, payload);
  }

  // Print Job Events

  notifyPrintJobCreated(organizationId: string, data: Omit<PrintJobCreatedEvent, 'type'>) {
    const payload: PrintJobCreatedEvent = data;

    this.logger.debug(`Emitting printJobCreated for job ${data.jobId}`);

    this.appGateway.emitToOrganization(organizationId, GatewayEvents.PRINT_JOB_CREATED, payload);
  }

  notifyPrintJobStatusChanged(organizationId: string, data: Omit<PrintJobStatusChangedEvent, 'type'>) {
    const payload: PrintJobStatusChangedEvent = data;

    this.logger.debug(`Emitting printJobStatusChanged for job ${data.jobId}`);

    this.appGateway.emitToOrganization(organizationId, GatewayEvents.PRINT_JOB_STATUS_CHANGED, payload);
  }

  // Broadcast Messages

  broadcastMessage(organizationId: string, data: Omit<BroadcastMessageEvent, 'id' | 'timestamp'>) {
    const payload: BroadcastMessageEvent = {
      ...data,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    this.logger.debug(`Broadcasting message to organization ${organizationId}: ${data.message}`);

    this.appGateway.emitToOrganization(organizationId, GatewayEvents.BROADCAST_MESSAGE, payload);

    return payload;
  }

  // Device Online Status

  getOnlineDeviceIds(organizationId: string): string[] {
    return this.appGateway.getOnlineDeviceIds(organizationId);
  }

  getAllOnlineDeviceIds(): string[] {
    return this.appGateway.getAllOnlineDeviceIds();
  }

  isDeviceOnline(deviceId: string): boolean {
    return this.appGateway.isDeviceOnline(deviceId);
  }
}
