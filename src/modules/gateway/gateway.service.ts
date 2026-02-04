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
  ProductUpdatedEvent,
  ProductDeletedEvent,
  CategoryUpdatedEvent,
  CategoryDeletedEvent,
  MenuRefreshEvent,
  KitchenNewOrderEvent,
  KitchenItemStatusEvent,
  KitchenOrderCancelledEvent,
  PickupOrderReadyEvent,
  PickupOrderCollectedEvent,
  CustomerOrderReadyEvent,
  CustomerOrderCalledEvent,
  CustomerOrderCollectedEvent,
  DeviceSettingsUpdatedEvent,
  DeviceConfigUpdatedEvent,
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

  // Menu Display Events

  notifyProductUpdated(organizationId: string, eventId: string, product: ProductUpdatedEvent['product']) {
    const payload: ProductUpdatedEvent = { product, eventId };

    this.logger.debug(`Emitting productUpdated for product ${product.id}`);

    // Emit to menu displays
    this.appGateway.emitToDisplayType(organizationId, 'menu', GatewayEvents.PRODUCT_UPDATED, payload);
    // Also emit to organization for admin dashboards
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.PRODUCT_UPDATED, payload);
  }

  notifyProductDeleted(organizationId: string, eventId: string, productId: string) {
    const payload: ProductDeletedEvent = { productId, eventId };

    this.logger.debug(`Emitting productDeleted for product ${productId}`);

    this.appGateway.emitToDisplayType(organizationId, 'menu', GatewayEvents.PRODUCT_DELETED, payload);
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.PRODUCT_DELETED, payload);
  }

  notifyCategoryUpdated(organizationId: string, eventId: string, category: CategoryUpdatedEvent['category']) {
    const payload: CategoryUpdatedEvent = { category, eventId };

    this.logger.debug(`Emitting categoryUpdated for category ${category.id}`);

    this.appGateway.emitToDisplayType(organizationId, 'menu', GatewayEvents.CATEGORY_UPDATED, payload);
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.CATEGORY_UPDATED, payload);
  }

  notifyCategoryDeleted(organizationId: string, eventId: string, categoryId: string) {
    const payload: CategoryDeletedEvent = { categoryId, eventId };

    this.logger.debug(`Emitting categoryDeleted for category ${categoryId}`);

    this.appGateway.emitToDisplayType(organizationId, 'menu', GatewayEvents.CATEGORY_DELETED, payload);
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.CATEGORY_DELETED, payload);
  }

  notifyMenuRefresh(organizationId: string, eventId: string, reason: string) {
    const payload: MenuRefreshEvent = { eventId, reason };

    this.logger.debug(`Emitting menuRefresh for event ${eventId}: ${reason}`);

    this.appGateway.emitToDisplayType(organizationId, 'menu', GatewayEvents.MENU_REFRESH, payload);
    this.appGateway.emitToOrganization(organizationId, GatewayEvents.MENU_REFRESH, payload);
  }

  // Kitchen Display Events

  notifyKitchenNewOrder(organizationId: string, order: KitchenNewOrderEvent['order'], items: KitchenNewOrderEvent['items']) {
    const payload: KitchenNewOrderEvent = { order, items };

    this.logger.debug(`Emitting kitchenNewOrder for order ${order.id}`);

    this.appGateway.emitToDisplayType(organizationId, 'kitchen', GatewayEvents.KITCHEN_NEW_ORDER, payload);
  }

  notifyKitchenItemStatus(organizationId: string, data: KitchenItemStatusEvent) {
    this.logger.debug(`Emitting kitchenItemStatus for item ${data.itemId}`);

    this.appGateway.emitToDisplayType(organizationId, 'kitchen', GatewayEvents.KITCHEN_ITEM_STATUS, data);
  }

  notifyKitchenOrderCancelled(organizationId: string, orderId: string, orderNumber: string) {
    const payload: KitchenOrderCancelledEvent = { orderId, orderNumber };

    this.logger.debug(`Emitting kitchenOrderCancelled for order ${orderId}`);

    this.appGateway.emitToDisplayType(organizationId, 'kitchen', GatewayEvents.KITCHEN_ORDER_CANCELLED, payload);
  }

  // Pickup Display Events (Personal)

  notifyPickupOrderReady(organizationId: string, data: Omit<PickupOrderReadyEvent, 'type'>) {
    const payload: PickupOrderReadyEvent = data;

    this.logger.debug(`Emitting pickupOrderReady for order ${data.orderId}`);

    this.appGateway.emitToDisplayType(organizationId, 'pickup', GatewayEvents.PICKUP_ORDER_READY, payload);
  }

  notifyPickupOrderCollected(organizationId: string, orderId: string, orderNumber: string) {
    const payload: PickupOrderCollectedEvent = { orderId, orderNumber };

    this.logger.debug(`Emitting pickupOrderCollected for order ${orderId}`);

    this.appGateway.emitToDisplayType(organizationId, 'pickup', GatewayEvents.PICKUP_ORDER_COLLECTED, payload);
  }

  // Customer Display Events (public)

  notifyCustomerOrderReady(organizationId: string, orderNumber: string, dailyNumber: number) {
    const payload: CustomerOrderReadyEvent = { orderNumber, dailyNumber };

    this.logger.debug(`Emitting customerOrderReady for order ${orderNumber}`);

    this.appGateway.emitToDisplayType(organizationId, 'customer', GatewayEvents.CUSTOMER_ORDER_READY, payload);
  }

  notifyCustomerOrderCalled(organizationId: string, orderNumber: string, dailyNumber: number) {
    const payload: CustomerOrderCalledEvent = { orderNumber, dailyNumber };

    this.logger.debug(`Emitting customerOrderCalled for order ${orderNumber}`);

    this.appGateway.emitToDisplayType(organizationId, 'customer', GatewayEvents.CUSTOMER_ORDER_CALLED, payload);
  }

  notifyCustomerOrderCollected(organizationId: string, orderNumber: string) {
    const payload: CustomerOrderCollectedEvent = { orderNumber };

    this.logger.debug(`Emitting customerOrderCollected for order ${orderNumber}`);

    this.appGateway.emitToDisplayType(organizationId, 'customer', GatewayEvents.CUSTOMER_ORDER_COLLECTED, payload);
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
