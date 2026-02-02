import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { GatewayEvents } from './dto';
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  DeviceHeartbeatEvent,
  PrinterHeartbeatEvent,
} from './dto';
import { DevicesService } from '../devices/devices.service';
import { PrintersService } from '../printers/printers.service';

interface AuthenticatedSocket extends Socket {
  user?: {
    id: string;
    email: string;
  };
  device?: {
    id: string;
    organizationId: string;
    type: string;
  };
}

@WebSocketGateway({
  cors: {
    origin: '*', // Configure in production
    credentials: true,
  },
  namespace: '/',
})
export class AppGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AppGateway.name);

  // Track connected devices: Map<deviceId, { socketId, organizationId }>
  private connectedDevices = new Map<string, { socketId: string; organizationId: string }>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly devicesService: DevicesService,
    private readonly printersService: PrintersService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized');
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      // Try JWT authentication first
      const token = this.extractToken(client);

      if (token) {
        const payload = await this.verifyToken(token);
        if (payload) {
          client.user = {
            id: payload.sub,
            email: payload.email,
          };
          this.logger.log(`User connected: ${client.user.email} (${client.id})`);
          client.emit(GatewayEvents.CONNECTED, { userId: client.user.id });
          return;
        }
      }

      // Try device token authentication
      const deviceToken = client.handshake.auth?.deviceToken ||
                          client.handshake.query?.deviceToken;

      if (deviceToken) {
        const device = await this.devicesService.findByToken(deviceToken as string);
        if (device && device.organizationId) {
          client.device = {
            id: device.id,
            organizationId: device.organizationId,
            type: device.type,
          };

          // Auto-join organization room
          client.join(`org:${device.organizationId}`);

          // Track connected device
          this.connectedDevices.set(device.id, {
            socketId: client.id,
            organizationId: device.organizationId,
          });

          // Update last seen
          await this.devicesService.updateLastSeen(deviceToken as string);

          this.logger.log(`Device connected: ${device.name} (${client.id}) - ${this.connectedDevices.size} devices online`);
          client.emit(GatewayEvents.CONNECTED, { deviceId: device.id });
          return;
        }
      }

      // No valid authentication
      this.logger.warn(`Unauthenticated connection attempt: ${client.id}`);
      client.emit(GatewayEvents.ERROR, { message: 'Authentication required' });
      client.disconnect();
    } catch (error) {
      this.logger.error(`Connection error: ${error.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (client.user) {
      this.logger.log(`User disconnected: ${client.user.email} (${client.id})`);
    } else if (client.device) {
      // Remove from connected devices
      this.connectedDevices.delete(client.device.id);
      this.logger.log(`Device disconnected: ${client.device.id} (${client.id}) - ${this.connectedDevices.size} devices online`);
    } else {
      this.logger.log(`Client disconnected: ${client.id}`);
    }
  }

  @SubscribeMessage(GatewayEvents.JOIN_ROOM)
  handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: JoinRoomPayload,
  ) {
    if (!this.isAuthenticated(client)) {
      return { error: 'Not authenticated' };
    }

    const roomName = payload.eventId
      ? `org:${payload.organizationId}:event:${payload.eventId}`
      : `org:${payload.organizationId}`;

    client.join(roomName);
    this.logger.debug(`Client ${client.id} joined room: ${roomName}`);

    return { success: true, room: roomName };
  }

  @SubscribeMessage(GatewayEvents.LEAVE_ROOM)
  handleLeaveRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: LeaveRoomPayload,
  ) {
    const roomName = payload.eventId
      ? `org:${payload.organizationId}:event:${payload.eventId}`
      : `org:${payload.organizationId}`;

    client.leave(roomName);
    this.logger.debug(`Client ${client.id} left room: ${roomName}`);

    return { success: true };
  }

  @SubscribeMessage(GatewayEvents.DEVICE_HEARTBEAT)
  async handleDeviceHeartbeat(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: DeviceHeartbeatEvent,
  ) {
    if (client.device) {
      await this.devicesService.updateLastSeen(payload.deviceToken);
      return { success: true };
    }
    return { error: 'Not a device connection' };
  }

  @SubscribeMessage(GatewayEvents.PRINTER_HEARTBEAT)
  async handlePrinterHeartbeat(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: PrinterHeartbeatEvent,
  ) {
    await this.printersService.updateOnlineStatus(payload.printerId, payload.isOnline);
    return { success: true };
  }

  // Public methods for other services to emit events

  emitToOrganization(organizationId: string, event: string, data: unknown) {
    this.server.to(`org:${organizationId}`).emit(event, data);
  }

  emitToEvent(organizationId: string, eventId: string, event: string, data: unknown) {
    this.server.to(`org:${organizationId}:event:${eventId}`).emit(event, data);
  }

  emitToAll(event: string, data: unknown) {
    this.server.emit(event, data);
  }

  // Get online device IDs for an organization
  getOnlineDeviceIds(organizationId: string): string[] {
    const onlineIds: string[] = [];
    for (const [deviceId, info] of this.connectedDevices) {
      if (info.organizationId === organizationId) {
        onlineIds.push(deviceId);
      }
    }
    return onlineIds;
  }

  // Get all online device IDs
  getAllOnlineDeviceIds(): string[] {
    return Array.from(this.connectedDevices.keys());
  }

  // Check if a specific device is online
  isDeviceOnline(deviceId: string): boolean {
    return this.connectedDevices.has(deviceId);
  }

  // Helper methods

  private extractToken(client: Socket): string | null {
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return client.handshake.auth?.token || client.handshake.query?.token || null;
  }

  private async verifyToken(token: string): Promise<{ sub: string; email: string } | null> {
    try {
      const secret = this.configService.get<string>('jwt.secret');
      const payload = await this.jwtService.verifyAsync<{ sub: string; email: string }>(token, { secret });
      return payload;
    } catch {
      return null;
    }
  }

  private isAuthenticated(client: AuthenticatedSocket): boolean {
    return !!(client.user || client.device);
  }
}
