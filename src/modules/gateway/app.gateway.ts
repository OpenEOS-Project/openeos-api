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
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserOrganization } from '../../database/entities';
import { DeviceType } from '../../database/entities/device.entity';
import { GatewayEvents } from './dto';
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  DeviceHeartbeatEvent,
  PrinterHeartbeatEvent,
  PrinterJobCompleteEvent,
  PrinterJobFailedEvent,
  CartUpdatePayload,
  WatchPosCartPayload,
  PosCartUpdatedEvent,
} from './dto';
import { DevicesService } from '../devices/devices.service';
import { PrintersService } from '../printers/printers.service';
import { PrintJobsService } from '../print-jobs/print-jobs.service';
import { PrintJobStatus } from '../../database/entities/print-job.entity';

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

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly devicesService: DevicesService,
    private readonly printersService: PrintersService,
    private readonly printJobsService: PrintJobsService,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
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
        if (device) {
          // Printer agents can connect without an organization (waiting for assignment)
          const hasOrg = !!device.organizationId;

          client.device = {
            id: device.id,
            organizationId: device.organizationId || '',
            type: device.type,
          };

          // socket.data is shared across replicas via the Redis adapter
          // (fetchSockets) and is the basis for online-presence queries.
          client.data.deviceId = device.id;
          client.data.organizationId = device.organizationId || '';
          client.data.deviceType = device.type;

          // Global per-device room: presence lookups and cross-replica
          // room operations (reassign/disconnect) target this room.
          client.join(`device:${device.id}`);

          if (hasOrg) {
            // Auto-join organization room
            client.join(`org:${device.organizationId}`);

            // Join device-specific room for targeted settings/config updates
            client.join(`org:${device.organizationId}:device:${device.id}`);
          }

          // Update last seen
          await this.devicesService.updateLastSeen(deviceToken as string);

          this.logger.log(`Device connected: ${device.name} (${client.id})`);
          client.emit(GatewayEvents.CONNECTED, { deviceId: device.id, hasOrganization: hasOrg });

          // Re-deliver print jobs that were queued while the agent was offline
          if (device.type === DeviceType.PRINTER_AGENT && hasOrg) {
            void this.replayQueuedPrintJobs(client, device.id);
          }
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
      this.logger.log(`Device disconnected: ${client.device.id} (${client.id})`);
    } else {
      this.logger.log(`Client disconnected: ${client.id}`);
    }
  }

  /**
   * A socket may only enter rooms of an organization it belongs to:
   * devices their own org, users any org they are a member of.
   */
  private async canAccessOrganization(
    client: AuthenticatedSocket,
    organizationId: string,
  ): Promise<boolean> {
    if (!organizationId) return false;
    if (client.device) {
      return client.device.organizationId === organizationId;
    }
    if (client.user) {
      const membership = await this.userOrganizationRepository.findOne({
        where: { userId: client.user.id, organizationId },
      });
      return !!membership;
    }
    return false;
  }

  @SubscribeMessage(GatewayEvents.JOIN_ROOM)
  async handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: JoinRoomPayload,
  ) {
    if (!this.isAuthenticated(client)) {
      return { error: 'Not authenticated' };
    }

    if (!(await this.canAccessOrganization(client, payload.organizationId))) {
      this.logger.warn(
        `Client ${client.id} denied joinRoom for org ${payload.organizationId}`,
      );
      return { error: 'Forbidden' };
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
    if (!this.isAuthenticated(client)) {
      return { error: 'Not authenticated' };
    }

    const roomName = payload.eventId
      ? `org:${payload.organizationId}:event:${payload.eventId}`
      : `org:${payload.organizationId}`;

    client.leave(roomName);
    this.logger.debug(`Client ${client.id} left room: ${roomName}`);

    return { success: true };
  }

  // ── Customer display: live cart relay ──────────────────────────────────
  // Rooms are scoped to the sender's/watcher's own organization, so a display
  // can never subscribe to a POS device of another organization.

  private posCartRoom(organizationId: string, posDeviceId: string): string {
    return `org:${organizationId}:pos:${posDeviceId}:cart`;
  }

  @SubscribeMessage(GatewayEvents.CART_UPDATE)
  handleCartUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: CartUpdatePayload,
  ) {
    if (!client.device || !client.device.organizationId) {
      return { error: 'Not a device connection' };
    }

    const event: PosCartUpdatedEvent = {
      ...payload,
      posDeviceId: client.device.id,
    };
    this.server
      .to(this.posCartRoom(client.device.organizationId, client.device.id))
      .emit(GatewayEvents.POS_CART_UPDATED, event);

    return { success: true };
  }

  @SubscribeMessage(GatewayEvents.WATCH_POS_CART)
  handleWatchPosCart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: WatchPosCartPayload,
  ) {
    if (!client.device || !client.device.organizationId) {
      return { error: 'Not a device connection' };
    }
    if (!payload?.posDeviceId) {
      return { error: 'posDeviceId required' };
    }

    const room = this.posCartRoom(client.device.organizationId, payload.posDeviceId);
    client.join(room);
    this.logger.debug(`Device ${client.device.id} watches POS cart: ${room}`);

    // Ask the POS to re-broadcast its current cart so the display is not
    // blank until the next cart mutation (e.g. after a display reconnect).
    this.emitToDevice(
      client.device.organizationId,
      payload.posDeviceId,
      GatewayEvents.CART_SNAPSHOT_REQUESTED,
      { requestedBy: client.device.id },
    );

    return { success: true, room };
  }

  @SubscribeMessage(GatewayEvents.UNWATCH_POS_CART)
  handleUnwatchPosCart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: WatchPosCartPayload,
  ) {
    if (!client.device || !client.device.organizationId) {
      return { error: 'Not a device connection' };
    }
    if (!payload?.posDeviceId) {
      return { error: 'posDeviceId required' };
    }

    client.leave(this.posCartRoom(client.device.organizationId, payload.posDeviceId));
    return { success: true };
  }

  @SubscribeMessage(GatewayEvents.DEVICE_HEARTBEAT)
  async handleDeviceHeartbeat(@ConnectedSocket() client: AuthenticatedSocket) {
    if (client.device) {
      // The socket's authenticated identity is the source of truth — the
      // payload token is ignored so a device can only refresh itself.
      await this.devicesService.updateLastSeenById(client.device.id);
      return { success: true };
    }
    return { error: 'Not a device connection' };
  }

  @SubscribeMessage(GatewayEvents.PRINTER_HEARTBEAT)
  async handlePrinterHeartbeat(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: PrinterHeartbeatEvent,
  ) {
    if (!client.device || !client.device.organizationId) {
      return { error: 'Not a device connection' };
    }
    // Scoped to the caller's organization — a device cannot flip the
    // online status of printers belonging to another tenant.
    await this.printersService.updateOnlineStatus(
      payload.printerId,
      payload.isOnline,
      client.device.organizationId,
    );
    return { success: true };
  }

  @SubscribeMessage(GatewayEvents.PRINTER_JOB_COMPLETE)
  async handlePrinterJobComplete(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: PrinterJobCompleteEvent,
  ) {
    if (!client.device || !client.device.organizationId) {
      return { error: 'Not a device connection' };
    }
    try {
      // Scoped to the agent's organization — returns null for foreign jobs.
      const job = await this.printJobsService.updateJobStatus(
        payload.jobId,
        PrintJobStatus.COMPLETED,
        undefined,
        client.device.organizationId,
      );
      if (!job) {
        this.logger.warn(
          `Agent ${client.device.id} reported completion for unknown/foreign job ${payload.jobId}`,
        );
        return { error: 'Job not found' };
      }
      this.logger.log(`Print job completed: ${payload.jobId} (agent: ${payload.agentId})`);

      // Notify organization about status change
      this.emitToOrganization(client.device.organizationId, GatewayEvents.PRINT_JOB_STATUS_CHANGED, {
        jobId: payload.jobId,
        printerId: job.printerId,
        status: PrintJobStatus.COMPLETED,
      });

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to update job ${payload.jobId}: ${error.message}`);
      return { error: 'Failed to update job status' };
    }
  }

  @SubscribeMessage(GatewayEvents.PRINTER_JOB_FAILED)
  async handlePrinterJobFailed(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: PrinterJobFailedEvent,
  ) {
    if (!client.device || !client.device.organizationId) {
      return { error: 'Not a device connection' };
    }
    try {
      // Scoped to the agent's organization — returns null for foreign jobs.
      const job = await this.printJobsService.updateJobStatus(
        payload.jobId,
        PrintJobStatus.FAILED,
        `${payload.errorCode}: ${payload.errorMessage}`,
        client.device.organizationId,
      );
      if (!job) {
        this.logger.warn(
          `Agent ${client.device.id} reported failure for unknown/foreign job ${payload.jobId}`,
        );
        return { error: 'Job not found' };
      }
      this.logger.warn(`Print job failed: ${payload.jobId} - ${payload.errorCode}: ${payload.errorMessage}`);

      // Notify organization about status change
      this.emitToOrganization(client.device.organizationId, GatewayEvents.PRINT_JOB_STATUS_CHANGED, {
        jobId: payload.jobId,
        printerId: job.printerId,
        status: PrintJobStatus.FAILED,
        error: `${payload.errorCode}: ${payload.errorMessage}`,
      });

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to update job ${payload.jobId}: ${error.message}`);
      return { error: 'Failed to update job status' };
    }
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

  emitToDevice(organizationId: string, deviceId: string, event: string, data: unknown) {
    const roomName = `org:${organizationId}:device:${deviceId}`;
    this.server.to(roomName).emit(event, data);
    this.logger.debug(`Emitted ${event} to device room ${roomName}`);
  }

  // Presence is derived from connected sockets via fetchSockets(), which the
  // Redis adapter resolves across all replicas — no in-process state.

  async getOnlineDeviceIds(organizationId: string): Promise<string[]> {
    const sockets = await this.server.in(`org:${organizationId}`).fetchSockets();
    const ids = new Set<string>();
    for (const socket of sockets) {
      const deviceId = socket.data?.deviceId as string | undefined;
      if (deviceId) ids.add(deviceId);
    }
    return [...ids];
  }

  async getAllOnlineDeviceIds(): Promise<string[]> {
    const sockets = await this.server.fetchSockets();
    const ids = new Set<string>();
    for (const socket of sockets) {
      const deviceId = socket.data?.deviceId as string | undefined;
      if (deviceId) ids.add(deviceId);
    }
    return [...ids];
  }

  /**
   * A device's organization assignment changed: force its sockets (on any
   * replica) to reconnect — handleConnection re-resolves rooms and identity
   * from the database, so the device lands in the correct org rooms.
   */
  reassignDeviceRoom(deviceId: string, newOrganizationId: string | null): void {
    this.server.in(`device:${deviceId}`).disconnectSockets();
    this.logger.log(
      `Device ${deviceId} reassigned to org ${newOrganizationId || '(none)'} — forcing reconnect`,
    );
  }

  async isDeviceOnline(deviceId: string): Promise<boolean> {
    const sockets = await this.server.in(`device:${deviceId}`).fetchSockets();
    return sockets.length > 0;
  }

  /**
   * Re-deliver jobs that were queued while the printer agent was offline.
   * Called fire-and-forget from handleConnection.
   */
  private async replayQueuedPrintJobs(
    client: AuthenticatedSocket,
    deviceId: string,
  ): Promise<void> {
    try {
      const jobs = await this.printJobsService.getQueuedJobsForDevice(deviceId);
      for (const job of jobs) {
        client.emit(
          GatewayEvents.PRINTER_JOB,
          this.printJobsService.buildAgentJobEvent(job),
        );
      }
      if (jobs.length > 0) {
        this.logger.log(
          `Replayed ${jobs.length} queued print job(s) to agent device ${deviceId}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to replay queued print jobs for device ${deviceId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
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
