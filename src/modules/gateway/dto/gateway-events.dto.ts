// Client to Server Events
export interface JoinRoomPayload {
  organizationId: string;
  eventId?: string;
}

export interface LeaveRoomPayload {
  organizationId: string;
  eventId?: string;
}

// Server to Client Events
export interface OrderCreatedEvent {
  order: {
    id: string;
    orderNumber: string;
    dailyNumber: number;
    tableNumber?: string;
    customerName?: string;
    status: string;
    items: {
      id: string;
      productName: string;
      quantity: number;
      status: string;
      notes?: string;
      kitchenNotes?: string;
    }[];
  };
}

export interface OrderUpdatedEvent {
  orderId: string;
  changes: Record<string, unknown>;
}

export interface OrderItemStatusChangedEvent {
  orderId: string;
  orderNumber: string;
  itemId: string;
  productName: string;
  status: string;
  previousStatus: string;
}

export interface PaymentReceivedEvent {
  orderId: string;
  orderNumber: string;
  paymentId: string;
  amount: number;
  paymentMethod: string;
  paidAmount: number;
  totalAmount: number;
  paymentStatus: string;
}

export interface PrintJobCreatedEvent {
  jobId: string;
  printerId: string;
  printerName: string;
  status: string;
}

export interface PrintJobStatusChangedEvent {
  jobId: string;
  printerId: string;
  status: string;
  error?: string;
}

export interface DeviceHeartbeatEvent {
  deviceId: string;
  deviceToken: string;
}

export interface PrinterHeartbeatEvent {
  printerId: string;
  agentId: string;
  isOnline: boolean;
}

export interface BroadcastMessageEvent {
  id: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error';
  title?: string;
  duration?: number; // ms, 0 = persistent
  senderId?: string;
  senderName?: string;
  timestamp: string;
}

// Menu Display Events
export interface ProductUpdatedEvent {
  product: {
    id: string;
    name: string;
    categoryId: string | null;
    price: number;
    isAvailable: boolean;
    isActive: boolean;
    stockQuantity?: number;
  };
  eventId: string;
}

export interface ProductDeletedEvent {
  productId: string;
  eventId: string;
}

export interface CategoryUpdatedEvent {
  category: {
    id: string;
    name: string;
    sortOrder: number;
    isActive: boolean;
  };
  eventId: string;
}

export interface CategoryDeletedEvent {
  categoryId: string;
  eventId: string;
}

export interface MenuRefreshEvent {
  eventId: string;
  reason: string;
}

// Kitchen Display Events
export interface KitchenNewOrderEvent {
  order: {
    id: string;
    orderNumber: string;
    dailyNumber: number;
    tableNumber?: string;
    customerName?: string;
    priority: string;
    createdAt: string;
  };
  items: {
    id: string;
    productName: string;
    categoryName: string;
    quantity: number;
    status: string;
    notes?: string;
    kitchenNotes?: string;
    options?: unknown;
  }[];
}

export interface KitchenItemStatusEvent {
  orderId: string;
  orderNumber: string;
  itemId: string;
  productName: string;
  status: string;
  previousStatus: string;
}

export interface KitchenOrderCancelledEvent {
  orderId: string;
  orderNumber: string;
}

// Pickup Display Events (Personal)
export interface PickupOrderReadyEvent {
  orderId: string;
  orderNumber: string;
  dailyNumber: number;
  customerName?: string;
  tableNumber?: string;
  itemCount: number;
}

export interface PickupOrderCollectedEvent {
  orderId: string;
  orderNumber: string;
}

// Customer Display Events (public)
export interface CustomerOrderReadyEvent {
  orderNumber: string;
  dailyNumber: number;
}

export interface CustomerOrderCalledEvent {
  orderNumber: string;
  dailyNumber: number;
}

export interface CustomerOrderCollectedEvent {
  orderNumber: string;
}

// Device Events
export interface DeviceSettingsUpdatedEvent {
  deviceId: string;
  settings: Record<string, unknown>;
}

export interface DeviceConfigUpdatedEvent {
  deviceId: string;
  name?: string;
  type?: string;
}

// Event names as constants
export const GatewayEvents = {
  // Client to Server
  JOIN_ROOM: 'joinRoom',
  LEAVE_ROOM: 'leaveRoom',
  DEVICE_HEARTBEAT: 'deviceHeartbeat',
  PRINTER_HEARTBEAT: 'printerHeartbeat',

  // Server to Client
  ORDER_CREATED: 'orderCreated',
  ORDER_UPDATED: 'orderUpdated',
  ORDER_ITEM_STATUS_CHANGED: 'orderItemStatusChanged',
  PAYMENT_RECEIVED: 'paymentReceived',
  PRINT_JOB_CREATED: 'printJobCreated',
  PRINT_JOB_STATUS_CHANGED: 'printJobStatusChanged',
  BROADCAST_MESSAGE: 'broadcastMessage',

  // Menu Display Events
  PRODUCT_UPDATED: 'productUpdated',
  PRODUCT_DELETED: 'productDeleted',
  CATEGORY_UPDATED: 'categoryUpdated',
  CATEGORY_DELETED: 'categoryDeleted',
  MENU_REFRESH: 'menuRefresh',

  // Kitchen Display Events
  KITCHEN_NEW_ORDER: 'kitchenNewOrder',
  KITCHEN_ITEM_STATUS: 'kitchenItemStatus',
  KITCHEN_ORDER_CANCELLED: 'kitchenOrderCancelled',

  // Pickup Display Events (Personal)
  PICKUP_ORDER_READY: 'pickupOrderReady',
  PICKUP_ORDER_COLLECTED: 'pickupOrderCollected',

  // Customer Display Events (public)
  CUSTOMER_ORDER_READY: 'customerOrderReady',
  CUSTOMER_ORDER_CALLED: 'customerOrderCalled',
  CUSTOMER_ORDER_COLLECTED: 'customerOrderCollected',

  // Device Events
  DEVICE_SETTINGS_UPDATED: 'deviceSettingsUpdated',
  DEVICE_CONFIG_UPDATED: 'deviceConfigUpdated',

  // Connection events
  CONNECTED: 'connected',
  ERROR: 'error',
} as const;
