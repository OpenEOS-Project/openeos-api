import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  Device,
  DiscoveredPrinter,
  Printer,
  User,
  UserOrganization,
} from '../../database/entities';
import {
  DeviceType,
  DeviceStatus,
  type PrinterAgentInfo,
} from '../../database/entities/device.entity';
import {
  PrinterConnectionType,
  type PrinterConnectionConfig,
} from '../../database/entities/printer.entity';
import type { DiscoveredPrinterDetails } from '../../database/entities/discovered-printer.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { GatewayService } from '../gateway/gateway.service';
import type { AgentHeartbeatEvent } from '../gateway/dto';
import { PrintersService } from './printers.service';
import {
  AdoptDiscoveredPrinterDto,
  DiscoverPrintersDto,
  ReportDiscoveredPrintersDto,
} from './dto';

/** Eintrag der Agent-Liste (`GET organizations/:orgId/printer-agents`). */
export interface PrinterAgentListItem {
  deviceId: string;
  name: string;
  status: DeviceStatus;
  isOnline: boolean;
  lastSeenAt: Date | null;
  agentInfo: PrinterAgentInfo | null;
  discoveredCount: number;
  printerCount: number;
}

/** Antwort auf `POST /device-api/printers/discovered`. */
export interface DiscoveredPrinterAck {
  id: string;
  fingerprint: string;
  printerId: string | null;
}

/**
 * Drucker-Agenten einer Organisation: was sie gefunden haben, was davon
 * uebernommen wurde, und ihr Lebenszeichen.
 */
@Injectable()
export class PrinterAgentsService {
  private readonly logger = new Logger(PrinterAgentsService.name);

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(DiscoveredPrinter)
    private readonly discoveredRepository: Repository<DiscoveredPrinter>,
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    @Inject(forwardRef(() => PrintersService))
    private readonly printersService: PrintersService,
  ) {}

  // ---------------------------------------------------------------------
  // Agent-facing
  // ---------------------------------------------------------------------

  /**
   * Upsert nach (deviceId, fingerprint). `full = true` heisst: der Agent
   * hat komplett gescannt — trotzdem wird nichts geloescht, nicht gemeldete
   * Eintraege behalten nur ihr altes `lastSeenAt` (Web zeigt „zuletzt
   * gesehen vor …“).
   */
  async reportDiscovered(
    deviceId: string,
    organizationId: string,
    dto: ReportDiscoveredPrintersDto,
  ): Promise<DiscoveredPrinterAck[]> {
    // Doppelte Fingerprints in einer Meldung: der letzte gewinnt.
    const byFingerprint = new Map<
      string,
      ReportDiscoveredPrintersDto['printers'][number]
    >();
    for (const input of dto.printers ?? []) {
      byFingerprint.set(input.fingerprint, input);
    }
    if (byFingerprint.size === 0) return [];

    const fingerprints = [...byFingerprint.keys()];
    const existing = await this.discoveredRepository.find({
      where: { deviceId, fingerprint: In(fingerprints) },
    });
    const existingByFingerprint = new Map(
      existing.map((row) => [row.fingerprint, row]),
    );

    // Bereits uebernommene Drucker dieses Agents wiederfinden, falls die
    // Erkennungszeile neu entsteht (z. B. nach Neuinstallation des Agents).
    const adopted = await this.printerRepository.find({
      where: { deviceId, fingerprint: In(fingerprints) },
      select: { id: true, fingerprint: true },
    });
    const adoptedByFingerprint = new Map(
      adopted.map((p) => [p.fingerprint as string, p.id]),
    );

    const now = new Date();
    const rows: DiscoveredPrinter[] = [];
    for (const [fingerprint, input] of byFingerprint) {
      const details = (input.details ?? {}) as DiscoveredPrinterDetails;
      const current = existingByFingerprint.get(fingerprint);
      if (current) {
        current.connectionType = input.connectionType;
        current.displayName = input.displayName;
        current.details = details;
        current.discoveredVia = input.discoveredVia;
        current.lastSeenAt = now;
        if (!current.printerId && adoptedByFingerprint.has(fingerprint)) {
          current.printerId = adoptedByFingerprint.get(fingerprint)!;
        }
        rows.push(current);
      } else {
        rows.push(
          this.discoveredRepository.create({
            deviceId,
            organizationId,
            fingerprint,
            connectionType: input.connectionType,
            displayName: input.displayName,
            details,
            discoveredVia: input.discoveredVia,
            firstSeenAt: now,
            lastSeenAt: now,
            printerId: adoptedByFingerprint.get(fingerprint) ?? null,
          }),
        );
      }
    }

    const saved = await this.discoveredRepository.save(rows);
    this.logger.debug(
      `Agent ${deviceId} reported ${saved.length} discovered printer(s)${
        dto.full ? ' (full scan)' : ''
      }`,
    );

    return saved.map((row) => ({
      id: row.id,
      fingerprint: row.fingerprint,
      printerId: row.printerId ?? null,
    }));
  }

  /**
   * `agentHeartbeat`: Agent-Info am Geraet ablegen und die uebernommenen
   * Drucker online/offline setzen. Gefundene Drucker werden ueber den
   * Fingerprint zugeordnet, manuell angelegte (ohne Fingerprint) ueber
   * `printerId` — in beiden Faellen nur Drucker dieses Agenten. Nur Wechsel
   * werden als `printerStatusChanged` an die Kassen gemeldet.
   */
  async handleAgentHeartbeat(
    deviceId: string,
    organizationId: string,
    payload: AgentHeartbeatEvent,
  ): Promise<void> {
    const now = new Date();
    const agentInfo: PrinterAgentInfo = {
      version: payload?.version,
      os: payload?.os,
      arch: payload?.arch,
      hostname: payload?.hostname,
      pythonVersion: payload?.pythonVersion,
      capabilities: payload?.capabilities,
    };
    await this.deviceRepository.update(
      { id: deviceId },
      { agentInfo, lastSeenAt: now },
    );

    const reported = (payload?.printers ?? []).filter(
      (p) =>
        p &&
        (typeof p.fingerprint === 'string' || typeof p.printerId === 'string'),
    );
    if (reported.length === 0) return;

    const fingerprints = reported
      .map((p) => p.fingerprint)
      .filter((f): f is string => typeof f === 'string');
    const printerIds = reported
      .map((p) => p.printerId)
      .filter((id): id is string => typeof id === 'string');

    // Beide Lookups sind auf den Agenten und seine Organisation beschraenkt:
    // eine fremde `printerId` im Heartbeat trifft nichts.
    const printers = await this.printerRepository.find({
      where: [
        ...(fingerprints.length > 0
          ? [{ deviceId, organizationId, fingerprint: In(fingerprints) }]
          : []),
        ...(printerIds.length > 0
          ? [{ deviceId, organizationId, id: In(printerIds) }]
          : []),
      ],
      select: { id: true, fingerprint: true, isOnline: true },
    });
    const byFingerprint = new Map(
      printers
        .filter((p) => typeof p.fingerprint === 'string')
        .map((p) => [p.fingerprint as string, p]),
    );
    const byId = new Map(printers.map((p) => [p.id, p]));

    // Derselbe Drucker mehrfach gemeldet: der letzte Eintrag gewinnt.
    const updates = new Map<
      string,
      { printer: (typeof printers)[number]; entry: (typeof reported)[number] }
    >();
    for (const entry of reported) {
      const printer =
        (typeof entry.fingerprint === 'string'
          ? byFingerprint.get(entry.fingerprint)
          : undefined) ??
        (typeof entry.printerId === 'string'
          ? byId.get(entry.printerId)
          : undefined);
      if (!printer) continue;
      updates.set(printer.id, { printer, entry });
    }

    for (const { printer, entry } of updates.values()) {
      const isOnline = Boolean(entry.online);
      await this.printerRepository.update(
        { id: printer.id },
        { isOnline, lastSeenAt: now },
      );
      if (printer.isOnline !== isOnline) {
        this.gatewayService.notifyPrinterStatusChanged(organizationId, {
          printerId: printer.id,
          isOnline,
          lastSeenAt: now.toISOString(),
        });
      }
      if (!isOnline && entry.lastError) {
        this.logger.debug(
          `Printer ${printer.id} offline on agent ${deviceId}: ${entry.lastError}`,
        );
      }
    }
  }

  /**
   * Der Agent ist weg (Socket getrennt, Geraet gesperrt oder entfernt):
   * alle seine Drucker gelten als offline. `lastSeenAt` bleibt stehen —
   * es sagt, wann der Drucker zuletzt wirklich erreichbar war. Gemeldet
   * wird nur, was vorher online war.
   */
  async markAgentOffline(
    deviceId: string,
    organizationId: string,
  ): Promise<void> {
    const printers = await this.printerRepository.find({
      where: { deviceId, organizationId, isOnline: true },
      select: { id: true, lastSeenAt: true },
    });
    if (printers.length === 0) return;

    await this.printerRepository.update(
      { id: In(printers.map((p) => p.id)) },
      { isOnline: false },
    );
    for (const printer of printers) {
      this.gatewayService.notifyPrinterStatusChanged(organizationId, {
        printerId: printer.id,
        isOnline: false,
        lastSeenAt: (printer.lastSeenAt ?? new Date()).toISOString(),
      });
    }
    this.logger.debug(
      `Agent ${deviceId} offline: ${printers.length} printer(s) marked offline`,
    );
  }

  // ---------------------------------------------------------------------
  // Org-facing
  // ---------------------------------------------------------------------

  async listAgents(
    organizationId: string,
    user: User,
  ): Promise<PrinterAgentListItem[]> {
    await this.checkMembership(organizationId, user.id);

    const devices = await this.deviceRepository.find({
      where: { organizationId, type: DeviceType.PRINTER_AGENT },
      order: { name: 'ASC' },
    });
    if (devices.length === 0) return [];

    const deviceIds = devices.map((d) => d.id);
    const [onlineIds, discoveredCounts, printerCounts] = await Promise.all([
      this.gatewayService.getOnlineDeviceIds(organizationId),
      this.countByDevice(this.discoveredRepository, 'discovered', deviceIds),
      this.countByDevice(this.printerRepository, 'printer', deviceIds),
    ]);
    const online = new Set(onlineIds);

    return devices.map((device) => ({
      deviceId: device.id,
      name: device.name,
      status: device.status,
      isOnline: online.has(device.id),
      lastSeenAt: device.lastSeenAt,
      agentInfo: device.agentInfo ?? null,
      discoveredCount: discoveredCounts.get(device.id) ?? 0,
      printerCount: printerCounts.get(device.id) ?? 0,
    }));
  }

  /** Agent samt Druckern entfernen; Zuordnungen werden vorher geloest. */
  async removeAgent(
    organizationId: string,
    deviceId: string,
    user: User,
  ): Promise<void> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const device = await this.findAgent(organizationId, deviceId);
    await this.removeAgentDevice(device);
  }

  /**
   * Ohne Berechtigungspruefung — fuer den Geraete-Endpunkt und den
   * Super-Admin, die den Agenten bereits geladen haben.
   */
  async removeAgentDevice(device: Device): Promise<void> {
    const printers = await this.printerRepository.find({
      where: { deviceId: device.id },
      select: { id: true },
    });
    const printerIds = printers.map((p) => p.id);

    if (device.organizationId && printerIds.length > 0) {
      // Kassen sehen die Drucker sofort als offline, bevor sie verschwinden.
      await this.markAgentOffline(device.id, device.organizationId);
      await this.printersService.clearPrinterReferences(
        device.organizationId,
        printerIds,
      );
    }
    if (printerIds.length > 0) {
      await this.printerRepository.delete({ id: In(printerIds) });
    }
    // discovered_printers haengen per ON DELETE CASCADE am Geraet.
    await this.deviceRepository.delete({ id: device.id });

    // Offene Socket-Verbindung des Agenten kappen; beim Neuverbinden
    // scheitert die Authentifizierung, weil das Geraet weg ist.
    this.gatewayService.reassignDeviceRoom(device.id, null);

    this.logger.log(
      `Printer agent removed: ${device.name} (${device.id}), ${printerIds.length} printer(s)`,
    );
  }

  async requestDiscovery(
    organizationId: string,
    deviceId: string,
    dto: DiscoverPrintersDto,
    user: User,
  ): Promise<{ deviceId: string; subnetScan: boolean }> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const device = await this.findAgent(organizationId, deviceId);

    const online = await this.gatewayService.isDeviceOnline(device.id);
    if (!online) {
      throw new ConflictException({
        code: ErrorCodes.PRINTER_AGENT_OFFLINE,
        reason: ErrorReasons.PRINTER_AGENT_OFFLINE,
        message:
          'Drucker-Agent ist nicht verbunden — bitte prüfen, ob der Agent läuft',
      });
    }

    const subnetScan = Boolean(dto?.subnetScan);
    this.gatewayService.sendPrinterDiscover(organizationId, device.id, {
      subnetScan,
    });
    return { deviceId: device.id, subnetScan };
  }

  async listDiscovered(
    organizationId: string,
    deviceId: string,
    user: User,
  ): Promise<DiscoveredPrinter[]> {
    await this.checkMembership(organizationId, user.id);
    const device = await this.findAgent(organizationId, deviceId);
    return this.discoveredRepository.find({
      where: { deviceId: device.id },
      order: { lastSeenAt: 'DESC', displayName: 'ASC' },
    });
  }

  /**
   * Gefundenen Drucker uebernehmen: `printers`-Zeile aus den Details
   * anlegen, verknuepfen, Agent per `printerConfigUpdate` nachladen lassen.
   */
  async adopt(
    organizationId: string,
    deviceId: string,
    discoveredId: string,
    dto: AdoptDiscoveredPrinterDto,
    user: User,
  ): Promise<Printer> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const device = await this.findAgent(organizationId, deviceId);

    const discovered = await this.discoveredRepository.findOne({
      where: { id: discoveredId, deviceId: device.id },
    });
    if (!discovered) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.DISCOVERED_PRINTER_NOT_FOUND,
        message: 'Gefundener Drucker nicht gefunden',
      });
    }

    // Schon uebernommen? Entweder ueber die Verknuepfung oder ueber einen
    // Drucker mit demselben Fingerprint an diesem Agenten.
    const alreadyAdopted =
      (discovered.printerId &&
        (await this.printerRepository.findOne({
          where: { id: discovered.printerId },
          select: { id: true },
        }))) ||
      (await this.printerRepository.findOne({
        where: { deviceId: device.id, fingerprint: discovered.fingerprint },
        select: { id: true },
      }));
    if (alreadyAdopted) {
      if (discovered.printerId !== alreadyAdopted.id) {
        discovered.printerId = alreadyAdopted.id;
        await this.discoveredRepository.save(discovered);
      }
      throw new ConflictException({
        code: ErrorCodes.PRINTER_ALREADY_ADOPTED,
        reason: ErrorReasons.PRINTER_ALREADY_ADOPTED,
        message: 'Drucker wurde bereits übernommen',
        params: { printerId: alreadyAdopted.id },
      });
    }

    const printer = this.printerRepository.create({
      organizationId,
      deviceId: device.id,
      name: dto.name,
      type: dto.type,
      connectionType: discovered.connectionType,
      connectionConfig: this.connectionConfigFromDetails(discovered),
      fingerprint: discovered.fingerprint,
      paperWidth: dto.paperWidth,
      hasCashDrawer: dto.hasCashDrawer,
      isActive: true,
      isOnline: false,
    });
    const saved = await this.printerRepository.save(printer);

    discovered.printerId = saved.id;
    await this.discoveredRepository.save(discovered);

    this.gatewayService.notifyPrinterConfigUpdate(organizationId, device.id);
    this.logger.log(
      `Printer adopted: ${saved.name} (${saved.id}) from ${discovered.fingerprint} on agent ${device.id}`,
    );
    return saved;
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private connectionConfigFromDetails(
    discovered: DiscoveredPrinter,
  ): PrinterConnectionConfig {
    const details = discovered.details ?? {};
    switch (discovered.connectionType) {
      case PrinterConnectionType.USB:
        return {
          ...(details.usbVendorId ? { usbVendorId: details.usbVendorId } : {}),
          ...(details.usbProductId
            ? { usbProductId: details.usbProductId }
            : {}),
          ...(details.serialNumber
            ? { usbSerialNumber: details.serialNumber }
            : {}),
        };
      case PrinterConnectionType.NETWORK: {
        if (!details.ipAddress) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.PRINTER_IP_ADDRESS_REQUIRED,
            message: 'Der gefundene Netzwerkdrucker hat keine IP-Adresse',
          });
        }
        return { ipAddress: details.ipAddress, port: details.port ?? 9100 };
      }
      case PrinterConnectionType.WINDOWS:
        return {
          windowsPrinterName:
            details.windowsPrinterName ?? discovered.displayName,
        };
      default:
        return {};
    }
  }

  private async findAgent(
    organizationId: string,
    deviceId: string,
  ): Promise<Device> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, organizationId, type: DeviceType.PRINTER_AGENT },
    });
    if (!device) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.PRINTER_AGENT_NOT_FOUND,
        message: 'Drucker-Agent nicht gefunden',
      });
    }
    return device;
  }

  private async countByDevice(
    repository: Repository<DiscoveredPrinter | Printer>,
    alias: string,
    deviceIds: string[],
  ): Promise<Map<string, number>> {
    const rows = await repository
      .createQueryBuilder(alias)
      .select(`${alias}.deviceId`, 'deviceId')
      .addSelect('COUNT(*)', 'count')
      .where(`${alias}.deviceId IN (:...deviceIds)`, { deviceIds })
      .groupBy(`${alias}.deviceId`)
      .getRawMany<{ deviceId: string; count: string }>();
    return new Map(rows.map((r) => [r.deviceId, Number(r.count)]));
  }

  private async checkMembership(
    organizationId: string,
    userId: string,
  ): Promise<UserOrganization> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
    return membership;
  }

  private async checkPermission(
    organizationId: string,
    userId: string,
    permission: 'devices',
  ): Promise<void> {
    const membership = await this.checkMembership(organizationId, userId);
    if (membership.role === OrganizationRole.ADMIN) return;
    if (!membership.permissions?.[permission]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
