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
    fulfillmentType: string;
    source: string;
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

// Printer Agent Events (Server -> Agent)
export interface PrinterJobEvent {
  jobId: string;
  printerId: string;
  templateName: string;
  copies: number;
  payload: Record<string, unknown>;
}

// Printer Agent Events (Agent -> Server)
export interface PrinterJobCompleteEvent {
  jobId: string;
  agentId: string;
}

export interface PrinterJobFailedEvent {
  jobId: string;
  agentId: string;
  errorCode: string;
  errorMessage: string;
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

// Menu Events
export interface ProductUpdatedEvent {
  product: {
    id: string;
    name: string;
    categoryId: string | null;
    price: number;
    isAvailable: boolean;
    isActive: boolean;
    stockQuantity?: number;
    trackInventory: boolean;
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

// Event lifecycle
export interface EventStatusChangedEvent {
  eventId: string;
  organizationId: string;
  status: 'active' | 'inactive' | 'test';
  name: string;
}

export interface KitchenOrderCancelledEvent {
  orderId: string;
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

export interface DeviceStatusChangedEvent {
  deviceId: string;
  status: 'pending' | 'verified' | 'blocked';
}

// Cash Drawer Events
export interface OpenCashDrawerEvent {
  printerId: string;
}

// Printer Agent Events (Config)
export interface PrinterConfigUpdateEvent {
  deviceId: string;
}

// Event names as constants
export const GatewayEvents = {
  // Client to Server
  JOIN_ROOM: 'joinRoom',
  LEAVE_ROOM: 'leaveRoom',
  DEVICE_HEARTBEAT: 'deviceHeartbeat',
  PRINTER_HEARTBEAT: 'printerHeartbeat',
  PRINTER_JOB_COMPLETE: 'printerJobComplete',
  PRINTER_JOB_FAILED: 'printerJobFailed',

  // Server to Client
  ORDER_CREATED: 'orderCreated',
  ORDER_UPDATED: 'orderUpdated',
  ORDER_ITEM_STATUS_CHANGED: 'orderItemStatusChanged',
  PAYMENT_RECEIVED: 'paymentReceived',
  PRINT_JOB_CREATED: 'printJobCreated',
  PRINT_JOB_STATUS_CHANGED: 'printJobStatusChanged',
  PRINTER_JOB: 'printerJob',
  BROADCAST_MESSAGE: 'broadcastMessage',

  // Menu Events
  PRODUCT_UPDATED: 'productUpdated',
  PRODUCT_DELETED: 'productDeleted',
  CATEGORY_UPDATED: 'categoryUpdated',
  CATEGORY_DELETED: 'categoryDeleted',
  MENU_REFRESH: 'menuRefresh',
  EVENT_STATUS_CHANGED: 'eventStatusChanged',

  // Kitchen (fallback for items without station)
  KITCHEN_ORDER_CANCELLED: 'kitchenOrderCancelled',

  // Print template push (agent listener: 'templateUpdate')
  TEMPLATE_UPDATE: 'templateUpdate',

  // Device Events
  DEVICE_SETTINGS_UPDATED: 'deviceSettingsUpdated',
  DEVICE_CONFIG_UPDATED: 'deviceConfigUpdated',
  DEVICE_STATUS_CHANGED: 'deviceStatusChanged',

  // Cash Drawer Events
  OPEN_CASH_DRAWER: 'openCashDrawer',

  // Printer Agent Config Events
  PRINTER_CONFIG_UPDATE: 'printerConfigUpdate',

  // Connection events
  CONNECTED: 'connected',
  ERROR: 'error',
} as const;
