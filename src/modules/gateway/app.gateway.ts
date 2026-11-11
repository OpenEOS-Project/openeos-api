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
import { Inject, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER, type Cache } from '@nestjs/cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server, Socket, type DefaultEventsMap } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Device, User, UserOrganization } from '../../database/entities';
import {
  DeviceStatus,
  DeviceType,
} from '../../database/entities/device.entity';
import { isFullSessionToken } from '../auth/access-token-claims';
import { gesperrterTokenSchluessel } from '../auth/token-blocklist';
import { GatewayEvents } from './dto';
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  PrinterHeartbeatEvent,
  AgentHeartbeatEvent,
  PrinterJobCompleteEvent,
  PrinterJobFailedEvent,
  CartUpdatePayload,
  WatchPosCartPayload,
  PosCartUpdatedEvent,
} from './dto';
import { DevicesService } from '../devices/devices.service';
import { PrintersService } from '../printers/printers.service';
import { PrinterAgentsService } from '../printers/printer-agents.service';
import { PrintJobsService } from '../print-jobs/print-jobs.service';
import { PrintJobStatus } from '../../database/entities/print-job.entity';

/**
 * Was ein Socket in `socket.data` traegt. Dieses Feld teilt der
 * Redis-Adapter replikaweit (fetchSockets), darauf beruht die Anwesenheit.
 */
interface SocketData {
  deviceId?: string;
  organizationId?: string;
  deviceType?: string;
}

type GatewayServer = Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

interface AuthenticatedSocket extends Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
> {
  user?: {
    id: string;
    email: string;
  };
  device?: {
    id: string;
    organizationId: string;
    type: string;
  };
  /** Blocklist key of the JWT the user socket connected with. */
  sessionTokenKey?: string;
  /** Periodic re-check of the socket's identity, cleared on disconnect. */
  revalidationTimer?: ReturnType<typeof setInterval>;
}

/**
 * How often a connected socket's identity is checked again: a signed-out
 * session, a deactivated account, a removed membership or a blocked device
 * must not keep receiving live data until the client reconnects.
 */
export const SOCKET_REVALIDATION_INTERVAL_MS = 30_000;

/** Device types allowed to send each device-originated event. */
const PRINTER_EVENT_SENDERS: string[] = [DeviceType.PRINTER_AGENT];
const CART_SENDERS: string[] = [DeviceType.POS, DeviceType.ADMIN];
const CART_WATCHERS: string[] = [DeviceType.DISPLAY];

/* Die Erlaubnisliste fuer Socket-Verbindungen.
 *
 * Hier stand ein Stern zusammen mit credentials: true. Diese Kombination
 * ist im Browser ungueltig: eine Antwort mit "Access-Control-Allow-Origin: *"
 * wird verworfen, sobald die Anfrage Anmeldedaten mitfuehrt. Die Folge war,
 * dass sich ueberhaupt kein Browser verbinden konnte — Kassen und Anzeigen
 * liefen ueber HTTP weiter und blieben dabei dauerhaft "offline", weil die
 * Live-Verbindung nie zustande kam. Ein Client ausserhalb des Browsers
 * (Drucker-Agent, Testskript) war nie betroffen, weshalb es lange niemandem
 * auffiel.
 *
 * Dieselbe Quelle wie fuer HTTP, damit nicht zwei Listen auseinanderlaufen.
 */
const erlaubteUrspruenge = (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
  .split(',')
  .map((eintrag) => eintrag.trim())
  .filter(Boolean);

@WebSocketGateway({
  cors: {
    // In der Entwicklung jeden Ursprung spiegeln — wie auf der HTTP-Seite.
    origin: process.env.NODE_ENV !== 'production' ? true : erlaubteUrspruenge,
    credentials: true,
  },
  namespace: '/',
})
export class AppGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: GatewayServer;

  private readonly logger = new Logger(AppGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly devicesService: DevicesService,
    private readonly printersService: PrintersService,
    private readonly printerAgentsService: PrinterAgentsService,
    private readonly printJobsService: PrintJobsService,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @Optional()
    @Inject(CACHE_MANAGER)
    private readonly cacheManager?: Cache,
  ) {}

  afterInit(_server: Server) {
    this.logger.log('WebSocket Gateway initialized');
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      // Try JWT authentication first
      const token = this.extractToken(client);

      if (token) {
        const user = await this.authenticateUser(token);
        if (user) {
          client.user = {
            id: user.id,
            email: user.email,
          };
          client.sessionTokenKey = gesperrterTokenSchluessel(token);
          this.startRevalidation(client);
          this.logger.log(
            `User connected: ${client.user.email} (${client.id})`,
          );
          client.emit(GatewayEvents.CONNECTED, { userId: client.user.id });
          return;
        }
      }

      // Try device token authentication
      // `auth` ist frei belegbares JSON des Clients, daher ungetypt.
      const deviceToken =
        (client.handshake.auth?.deviceToken as string | undefined) ||
        client.handshake.query?.deviceToken;

      if (deviceToken && typeof deviceToken === 'string') {
        const device = await this.devicesService.findByToken(deviceToken);
        if (device && this.isConnectableDevice(device)) {
          // A verified device without organization (e.g. a printer agent
          // waiting for its assignment) only gets its own device room.
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
          // join()/leave() sind nur dem Typ nach asynchron (Adapter-Vertrag);
          // die Adapter hier fuehren sie lokal sofort aus — daher `void`.
          void client.join(`device:${device.id}`);

          if (hasOrg) {
            // Auto-join organization room
            void client.join(`org:${device.organizationId}`);

            // Join device-specific room for targeted settings/config updates
            void client.join(
              `org:${device.organizationId}:device:${device.id}`,
            );
          }

          this.startRevalidation(client);

          // Update last seen
          await this.devicesService.updateLastSeen(deviceToken);

          this.logger.log(`Device connected: ${device.name} (${client.id})`);
          client.emit(GatewayEvents.CONNECTED, {
            deviceId: device.id,
            hasOrganization: hasOrg,
          });

          // Re-deliver print jobs that were queued while the agent was offline
          if (device.type === DeviceType.PRINTER_AGENT && hasOrg) {
            void this.pushAgentTemplates(client, device.organizationId!).then(
              () => this.replayQueuedPrintJobs(client, device.id),
            );
          }
          return;
        }
      }

      /* Ohne Herkunft ist so eine Zeile wertlos: bei einem Kunden mit
         vier Geraeten liess sich nicht sagen, welches abgewiesen wurde. */
      const herkunft = client.handshake.headers.origin ?? 'ohne Origin';
      const adresse = client.handshake.address;
      this.logger.warn(
        `Unauthenticated connection attempt: ${client.id} — Origin: ${herkunft}, IP: ${adresse}`,
      );
      client.emit(GatewayEvents.ERROR, { message: 'Authentication required' });
      client.disconnect();
    } catch (error) {
      this.logger.error(`Connection error: ${(error as Error).message}`);
      client.disconnect();
    }
  }

  /**
   * Only devices an organization has approved may use the socket: the
   * device must be active and verified, and its organization (if any)
   * must still exist. Devices waiting for approval follow their pairing
   * state over HTTP (`GET /devices/status`).
   */
  private isConnectableDevice(
    device: Pick<Device, 'isActive' | 'status' | 'organizationId'> & {
      organization?: { deletedAt?: Date | null } | null;
    },
  ): boolean {
    if (!device.isActive) return false;
    if (device.status !== DeviceStatus.VERIFIED) return false;
    if (device.organizationId) {
      if (!device.organization || device.organization.deletedAt) return false;
    }
    return true;
  }

  /**
   * The user behind a JWT, if the token stands for a completed sign-in
   * that is still valid: signature and expiry, no intermediate sign-in
   * token, not signed out, account active and not locked.
   */
  private async authenticateUser(
    token: string,
  ): Promise<Pick<User, 'id' | 'email'> | null> {
    const payload = await this.verifyToken(token);
    if (!payload || !isFullSessionToken(payload)) return null;
    if (await this.isSessionRevoked(gesperrterTokenSchluessel(token))) {
      return null;
    }
    return this.findActiveUser(payload.sub);
  }

  private async isSessionRevoked(tokenKey: string): Promise<boolean> {
    if (!this.cacheManager) return false;
    return !!(await this.cacheManager.get(tokenKey));
  }

  private async findActiveUser(
    userId: string,
  ): Promise<Pick<User, 'id' | 'email'> | null> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: { id: true, email: true, isActive: true, lockedUntil: true },
    });
    if (!user || !user.isActive) return null;
    if (user.lockedUntil && user.lockedUntil > new Date()) return null;
    return user;
  }

  private startRevalidation(client: AuthenticatedSocket): void {
    this.stopRevalidation(client);
    const timer = setInterval(() => {
      void this.revalidate(client);
    }, SOCKET_REVALIDATION_INTERVAL_MS);
    timer.unref?.();
    client.revalidationTimer = timer;
  }

  private stopRevalidation(client: AuthenticatedSocket): void {
    if (client.revalidationTimer) {
      clearInterval(client.revalidationTimer);
      client.revalidationTimer = undefined;
    }
  }

  /**
   * Checks a connected socket's identity again. Returns false (and
   * disconnects the socket) when it may no longer stay connected.
   */
  async revalidate(client: AuthenticatedSocket): Promise<boolean> {
    try {
      const ok = client.user
        ? await this.revalidateUser(client)
        : client.device
          ? await this.revalidateDevice(client)
          : false;
      if (!ok) {
        this.stopRevalidation(client);
        client.emit(GatewayEvents.ERROR, { message: 'Session ended' });
        client.disconnect(true);
      }
      return ok;
    } catch (error) {
      // A failing lookup (database briefly away) keeps the socket; the
      // next round checks again.
      this.logger.warn(
        `Socket revalidation failed for ${client.id}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return true;
    }
  }

  private async revalidateUser(client: AuthenticatedSocket): Promise<boolean> {
    const user = client.user!;
    if (
      client.sessionTokenKey &&
      (await this.isSessionRevoked(client.sessionTokenKey))
    ) {
      return false;
    }
    if (!(await this.findActiveUser(user.id))) return false;

    // Leave rooms of organizations the user no longer belongs to.
    const orgRooms = [...(client.rooms ?? [])].filter((room) =>
      room.startsWith('org:'),
    );
    if (orgRooms.length > 0) {
      const memberships = await this.userOrganizationRepository.find({
        where: { userId: user.id },
        select: { organizationId: true },
      });
      const allowed = new Set(memberships.map((m) => m.organizationId));
      for (const room of orgRooms) {
        const organizationId = room.split(':')[1];
        if (!allowed.has(organizationId)) void client.leave(room);
      }
    }
    return true;
  }

  private async revalidateDevice(
    client: AuthenticatedSocket,
  ): Promise<boolean> {
    const current = client.device!;
    const device = await this.deviceRepository.findOne({
      where: { id: current.id },
      relations: ['organization'],
    });
    if (!device || !this.isConnectableDevice(device)) return false;
    // A changed assignment re-resolves rooms on the next connection.
    if ((device.organizationId || '') !== current.organizationId) return false;
    if ((device.type as string) !== current.type) {
      current.type = device.type;
      client.data.deviceType = device.type;
    }
    return true;
  }

  /** Is this socket a device of one of the given types with an organization? */
  private isDeviceOfType(
    client: AuthenticatedSocket,
    types: string[],
  ): boolean {
    return (
      !!client.device &&
      !!client.device.organizationId &&
      types.includes(client.device.type)
    );
  }

  async handleDisconnect(client: AuthenticatedSocket) {
    this.stopRevalidation(client);
    if (client.user) {
      this.logger.log(`User disconnected: ${client.user.email} (${client.id})`);
    } else if (client.device) {
      this.logger.log(
        `Device disconnected: ${client.device.id} (${client.id})`,
      );
      await this.markPrinterAgentOffline(client);
    } else {
      this.logger.log(`Client disconnected: ${client.id}`);
    }
  }

  /**
   * Ein Drucker-Agent ohne Verbindung kann nicht drucken — seine Drucker
   * gelten ab sofort als offline (wie beim Heartbeat per
   * `printerStatusChanged` gemeldet). Der eigene Online-Zustand des
   * Agenten kommt aus den verbundenen Sockets, dafuer ist nichts zu tun.
   *
   * Beim Reconnect kann der neue Socket vor dem Ende des alten stehen;
   * dann haengt der Agent noch und die Drucker bleiben, wie sie sind.
   */
  private async markPrinterAgentOffline(
    client: AuthenticatedSocket,
  ): Promise<void> {
    const device = client.device;
    if (
      !device ||
      !device.organizationId ||
      device.type !== (DeviceType.PRINTER_AGENT as string)
    ) {
      return;
    }
    try {
      // Der getrennte Socket hat seine Raeume bereits verlassen.
      if (await this.isDeviceOnline(device.id)) return;
      await this.printerAgentsService.markAgentOffline(
        device.id,
        device.organizationId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to mark printers of agent ${device.id} offline: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  /**
   * A socket may only enter rooms of an organization it belongs to:
   * devices their own org, users any org they are a member of.
   */
  private async canAccessOrganization(
    client: AuthenticatedSocket,
    organizationId: string | undefined,
  ): Promise<boolean> {
    if (!organizationId || typeof organizationId !== 'string') return false;
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

    // Cheap re-check before handing out a new room.
    if (client.user && !(await this.revalidate(client))) {
      return { error: 'Not authenticated' };
    }

    if (!(await this.canAccessOrganization(client, payload?.organizationId))) {
      this.logger.warn(
        `Client ${client.id} denied joinRoom for org ${payload.organizationId}`,
      );
      return { error: 'Forbidden' };
    }

    const roomName = payload.eventId
      ? `org:${payload.organizationId}:event:${payload.eventId}`
      : `org:${payload.organizationId}`;

    void client.join(roomName);
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

    void client.leave(roomName);
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
    if (!this.isDeviceOfType(client, CART_SENDERS)) {
      return { error: 'Not a POS device' };
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
    if (!this.isDeviceOfType(client, CART_WATCHERS)) {
      return { error: 'Not a display device' };
    }
    if (!payload?.posDeviceId) {
      return { error: 'posDeviceId required' };
    }

    const room = this.posCartRoom(
      client.device.organizationId,
      payload.posDeviceId,
    );
    void client.join(room);
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
    if (!this.isDeviceOfType(client, CART_WATCHERS)) {
      return { error: 'Not a display device' };
    }
    if (!payload?.posDeviceId) {
      return { error: 'posDeviceId required' };
    }

    void client.leave(
      this.posCartRoom(client.device.organizationId, payload.posDeviceId),
    );
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
    if (!this.isDeviceOfType(client, PRINTER_EVENT_SENDERS)) {
      return { error: 'Not a printer agent' };
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

  /**
   * Drucker-Agent alle 30 s: Version/OS/Faehigkeiten und welche seiner
   * uebernommenen Drucker (nach Fingerprint) erreichbar sind.
   */
  @SubscribeMessage(GatewayEvents.AGENT_HEARTBEAT)
  async handleAgentHeartbeat(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: AgentHeartbeatEvent,
  ) {
    if (!client.device || !client.device.organizationId) {
      return { error: 'Not a device connection' };
    }
    if (client.device.type !== (DeviceType.PRINTER_AGENT as string)) {
      return { error: 'Not a printer agent' };
    }
    await this.printerAgentsService.handleAgentHeartbeat(
      client.device.id,
      client.device.organizationId,
      payload ?? {},
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
    if (!this.isDeviceOfType(client, PRINTER_EVENT_SENDERS)) {
      return { error: 'Not a printer agent' };
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
      this.logger.log(
        `Print job completed: ${payload.jobId} (agent: ${payload.agentId})`,
      );

      // Notify organization about status change
      this.emitToOrganization(
        client.device.organizationId,
        GatewayEvents.PRINT_JOB_STATUS_CHANGED,
        {
          jobId: payload.jobId,
          printerId: job.printerId,
          status: PrintJobStatus.COMPLETED,
        },
      );

      return { success: true };
    } catch (error) {
      this.logger.error(
        `Failed to update job ${payload.jobId}: ${(error as Error).message}`,
      );
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
    if (!this.isDeviceOfType(client, PRINTER_EVENT_SENDERS)) {
      return { error: 'Not a printer agent' };
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
      this.logger.warn(
        `Print job failed: ${payload.jobId} - ${payload.errorCode}: ${payload.errorMessage}`,
      );

      // Notify organization about status change
      this.emitToOrganization(
        client.device.organizationId,
        GatewayEvents.PRINT_JOB_STATUS_CHANGED,
        {
          jobId: payload.jobId,
          printerId: job.printerId,
          status: PrintJobStatus.FAILED,
          error: `${payload.errorCode}: ${payload.errorMessage}`,
        },
      );

      return { success: true };
    } catch (error) {
      this.logger.error(
        `Failed to update job ${payload.jobId}: ${(error as Error).message}`,
      );
      return { error: 'Failed to update job status' };
    }
  }

  // Public methods for other services to emit events

  emitToOrganization(organizationId: string, event: string, data: unknown) {
    this.server.to(`org:${organizationId}`).emit(event, data);
  }

  emitToEvent(
    organizationId: string,
    eventId: string,
    event: string,
    data: unknown,
  ) {
    this.server.to(`org:${organizationId}:event:${eventId}`).emit(event, data);
  }

  emitToAll(event: string, data: unknown) {
    this.server.emit(event, data);
  }

  emitToDevice(
    organizationId: string,
    deviceId: string,
    event: string,
    data: unknown,
  ) {
    const roomName = `org:${organizationId}:device:${deviceId}`;
    this.server.to(roomName).emit(event, data);
    this.logger.debug(`Emitted ${event} to device room ${roomName}`);
  }

  /**
   * Emit to a device room and wait for at least one acknowledgement.
   * Resolves false when no socket acked within the timeout (device offline
   * or unresponsive) — never rejects.
   */
  emitToDeviceWithAck(
    organizationId: string,
    deviceId: string,
    event: string,
    data: unknown,
    timeoutMs = 10000,
  ): Promise<boolean> {
    const roomName = `org:${organizationId}:device:${deviceId}`;
    return new Promise((resolve) => {
      this.server
        .to(roomName)
        .timeout(timeoutMs)
        .emit(event, data, (_err: Error | null, responses: unknown[]) => {
          resolve(Array.isArray(responses) && responses.length > 0);
        });
    });
  }

  // Presence is derived from connected sockets via fetchSockets(), which the
  // Redis adapter resolves across all replicas — no in-process state.

  async getOnlineDeviceIds(organizationId: string): Promise<string[]> {
    const sockets = await this.server
      .in(`org:${organizationId}`)
      .fetchSockets();
    const ids = new Set<string>();
    for (const socket of sockets) {
      const deviceId = socket.data?.deviceId;
      if (deviceId) ids.add(deviceId);
    }
    return [...ids];
  }

  async getAllOnlineDeviceIds(): Promise<string[]> {
    const sockets = await this.server.fetchSockets();
    const ids = new Set<string>();
    for (const socket of sockets) {
      const deviceId = socket.data?.deviceId;
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

  /**
   * End all live connections of a device (on any replica), e.g. after it
   * was blocked, deleted or got a new token. Its next connection attempt
   * is checked from scratch.
   */
  disconnectDevice(deviceId: string): void {
    this.server.in(`device:${deviceId}`).disconnectSockets(true);
  }

  async isDeviceOnline(deviceId: string): Promise<boolean> {
    const sockets = await this.server.in(`device:${deviceId}`).fetchSockets();
    return sockets.length > 0;
  }

  /**
   * Aktuelle Vorlagen an einen (wieder) verbundenen Agenten: Der Agent holt
   * sie sonst nur beim Start. Nach einem Update der API (neue mitgelieferte
   * Vorlage wie `pfand_return_receipt`) verbindet er sich neu und kennt sie
   * so ohne eigenes Update und ohne Neustart.
   */
  private async pushAgentTemplates(
    client: AuthenticatedSocket,
    organizationId: string,
  ): Promise<void> {
    try {
      const templates =
        await this.printJobsService.agentTemplates(organizationId);
      client.emit(GatewayEvents.TEMPLATE_UPDATE, { templates });
    } catch (error) {
      this.logger.warn(
        `Failed to push templates to agent in org ${organizationId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
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
        client
          .timeout(10000)
          .emit(
            GatewayEvents.PRINTER_JOB,
            this.printJobsService.buildAgentJobEvent(job),
            (err: Error | null) => {
              if (!err) {
                void this.printJobsService.markJobPrinting(job.id);
              }
            },
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
    return (
      (client.handshake.auth?.token as string | undefined) ||
      (client.handshake.query?.token as string | undefined) ||
      null
    );
  }

  private async verifyToken(
    token: string,
  ): Promise<{ sub: string; email: string } | null> {
    try {
      const secret = this.configService.get<string>('jwt.secret');
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        email: string;
      }>(token, { secret });
      return payload;
    } catch {
      return null;
    }
  }

  private isAuthenticated(client: AuthenticatedSocket): boolean {
    return !!(client.user || client.device);
  }
}
