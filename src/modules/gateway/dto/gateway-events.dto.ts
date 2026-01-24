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

  // Connection events
  CONNECTED: 'connected',
  ERROR: 'error',
} as const;
