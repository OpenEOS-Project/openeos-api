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
  PrinterJobEvent,
  BroadcastMessageEvent,
  ProductUpdatedEvent,
  ProductDeletedEvent,
  CategoryUpdatedEvent,
  CategoryDeletedEvent,
  MenuRefreshEvent,
  DeviceSettingsUpdatedEvent,
  DeviceConfigUpdatedEvent,
  PrinterConfigUpdateEvent,
  OpenCashDrawerEvent,
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

  sendPrintJobToAgent(organizationId: string, data: PrinterJobEvent) {
    this.logger.debug(`Sending print job ${data.jobId} to agent via organization ${organizationId}`);

    // Send to all devices in the organization (the agent will filter by printerId)
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.PRINTER_JOB, data);
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

  // Menu Events (used by admin dashboard / POS)

  notifyProductUpdated(organizationId: string, eventId: string, product: ProductUpdatedEvent['product']) {
    const payload: ProductUpdatedEvent = { product, eventId };

    this.logger.debug(`Emitting productUpdated for product ${product.id}`);

    this.appGateway.emitToOrganization(organizationId, GatewayEvents.PRODUCT_UPDATED, payload);
  }

  notifyProductDeleted(organizationId: string, eventId: string, productId: string) {
    const payload: ProductDeletedEvent = { productId, eventId };

    this.logger.debug(`Emitting productDeleted for product ${productId}`);

    this.appGateway.emitToOrganization(organizationId, GatewayEvents.PRODUCT_DELETED, payload);
  }

  notifyCategoryUpdated(organizationId: string, eventId: string, category: CategoryUpdatedEvent['category']) {
    const payload: CategoryUpdatedEvent = { category, eventId };

    this.logger.debug(`Emitting categoryUpdated for category ${category.id}`);

    this.appGateway.emitToOrganization(organizationId, GatewayEvents.CATEGORY_UPDATED, payload);
  }

  notifyCategoryDeleted(organizationId: string, eventId: string, categoryId: string) {
    const payload: CategoryDeletedEvent = { categoryId, eventId };

    this.logger.debug(`Emitting categoryDeleted for category ${categoryId}`);

    this.appGateway.emitToOrganization(organizationId, GatewayEvents.CATEGORY_DELETED, payload);
  }

  notifyMenuRefresh(organizationId: string, eventId: string, reason: string) {
    const payload: MenuRefreshEvent = { eventId, reason };

    this.logger.debug(`Emitting menuRefresh for event ${eventId}: ${reason}`);

    this.appGateway.emitToOrganization(organizationId, GatewayEvents.MENU_REFRESH, payload);
  }

  // Kitchen notifications (fallback for items without station)

  notifyKitchenOrderCancelled(organizationId: string, orderId: string, orderNumber: string) {
    this.logger.debug(`Emitting kitchenOrderCancelled for order ${orderId}`);
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.KITCHEN_ORDER_CANCELLED, { orderId, orderNumber });
  }

  // Device Events

  notifyDeviceSettingsUpdated(organizationId: string, deviceId: string, settings: Record<string, unknown>) {
    const payload: DeviceSettingsUpdatedEvent = { deviceId, settings };

    this.logger.debug(`Emitting deviceSettingsUpdated for device ${deviceId}`);

    // Send only to the specific device
    this.appGateway.emitToDevice(organizationId, deviceId, GatewayEvents.DEVICE_SETTINGS_UPDATED, payload);
  }

  notifyDeviceConfigUpdated(organizationId: string, deviceId: string, name?: string, type?: string) {
    const payload: DeviceConfigUpdatedEvent = { deviceId, name, type };

    this.logger.debug(`Emitting deviceConfigUpdated for device ${deviceId}`);

    // Send only to the specific device
    this.appGateway.emitToDevice(organizationId, deviceId, GatewayEvents.DEVICE_CONFIG_UPDATED, payload);
  }

  // Printer Agent Config Events

  notifyPrinterConfigUpdate(organizationId: string, deviceId: string) {
    const payload: PrinterConfigUpdateEvent = { deviceId };

    this.logger.debug(`Emitting printerConfigUpdate for device ${deviceId}`);

    this.appGateway.emitToDevice(organizationId, deviceId, GatewayEvents.PRINTER_CONFIG_UPDATE, payload);
  }

  // Cash Drawer Events

  sendOpenCashDrawer(organizationId: string, printerId: string) {
    const payload: OpenCashDrawerEvent = { printerId };

    this.logger.debug(`Emitting openCashDrawer for printer ${printerId}`);

    this.appGateway.emitToOrganization(organizationId, GatewayEvents.OPEN_CASH_DRAWER, payload);
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
