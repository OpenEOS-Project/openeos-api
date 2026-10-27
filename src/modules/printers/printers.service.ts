import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  Printer,
  Device,
  User,
  UserOrganization,
  Organization,
  ProductionStation,
} from '../../database/entities';
import { PrinterConnectionType } from '../../database/entities/printer.entity';
import type { OrganizationSettings } from '../../database/entities/organization.entity';
import { DeviceType } from '../../database/entities/device.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  PaginationDto,
  PaginatedResult,
  createPaginatedResult,
} from '../../common/dto/pagination.dto';
import { CreatePrinterDto, UpdatePrinterDto } from './dto';
import { GatewayService } from '../gateway/gateway.service';

const ORDER_FLOW_PRINTER_KEYS = [
  'receiptPrinting',
  'kitchenTicketPrinting',
  'orderTicketPrinting',
] as const;

const DEVICE_PRINTER_SETTING_KEYS = [
  'defaultPrinterId',
  'cashDrawerPrinterId',
] as const;

@Injectable()
export class PrintersService {
  private readonly logger = new Logger(PrintersService.name);

  constructor(
    @InjectRepository(Printer)
    private readonly printerRepository: Repository<Printer>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(ProductionStation)
    private readonly productionStationRepository: Repository<ProductionStation>,
  ) {}

  /**
   * Manuell angelegter Netzwerkdrucker fuer Geraete, die die Erkennung des
   * Agents nicht findet. USB- und Windows-Drucker kommen nur ueber die
   * Uebernahme aus `discovered_printers` (PrinterAgentsService.adopt).
   */
  async create(
    organizationId: string,
    createDto: CreatePrinterDto,
    user: User,
  ): Promise<Printer> {
    await this.checkPermission(organizationId, user.id, 'devices');

    const connectionType =
      createDto.connectionType ?? PrinterConnectionType.NETWORK;
    if (connectionType !== PrinterConnectionType.NETWORK) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PRINTER_CONNECTION_TYPE_NOT_ALLOWED,
        message:
          'Manuell lassen sich nur Netzwerkdrucker anlegen — USB- und Windows-Drucker über „Gefundene Drucker“ übernehmen',
      });
    }

    await this.validateDeviceForOrg(createDto.deviceId, organizationId);

    const printer = this.printerRepository.create({
      organizationId,
      name: createDto.name,
      type: createDto.type,
      connectionType,
      connectionConfig: {
        ipAddress: createDto.connectionConfig.ipAddress,
        port: createDto.connectionConfig.port ?? 9100,
      },
      deviceId: createDto.deviceId,
      fingerprint: null,
      paperWidth: createDto.paperWidth ?? 80,
      hasCashDrawer: createDto.hasCashDrawer ?? false,
      isActive: true,
      isOnline: false,
    });

    await this.printerRepository.save(printer);
    this.logger.log(`Printer created: ${printer.name} (${printer.id})`);

    this.notifyDeviceConfigUpdate(organizationId, printer.deviceId!);

    return printer;
  }

  async findAll(
    organizationId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<Printer>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.printerRepository.findAndCount({
      where: { organizationId },
      skip,
      take: limit,
      order: { name: 'ASC' },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(
    organizationId: string,
    printerId: string,
    user: User,
  ): Promise<Printer> {
    await this.checkMembership(organizationId, user.id);

    const printer = await this.printerRepository.findOne({
      where: { id: printerId, organizationId },
    });

    if (!printer) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.PRINTER_NOT_FOUND,
        message: 'Drucker nicht gefunden',
      });
    }

    return printer;
  }

  async update(
    organizationId: string,
    printerId: string,
    updateDto: UpdatePrinterDto,
    user: User,
  ): Promise<Printer> {
    await this.checkPermission(organizationId, user.id, 'devices');

    const printer = await this.findOne(organizationId, printerId, user);

    const { connectionConfig, ...fields } = updateDto;
    if (connectionConfig) {
      if (printer.connectionType !== PrinterConnectionType.NETWORK) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.PRINTER_CONNECTION_TYPE_NOT_ALLOWED,
          message:
            'IP-Adresse und Port lassen sich nur bei Netzwerkdruckern ändern',
        });
      }
      printer.connectionConfig = {
        ...printer.connectionConfig,
        ...(connectionConfig.ipAddress !== undefined
          ? { ipAddress: connectionConfig.ipAddress }
          : {}),
        ...(connectionConfig.port !== undefined
          ? { port: connectionConfig.port }
          : {}),
      };
    }

    Object.assign(printer, fields);
    await this.printerRepository.save(printer);

    this.logger.log(`Printer updated: ${printer.name} (${printer.id})`);

    if (printer.deviceId) {
      this.notifyDeviceConfigUpdate(organizationId, printer.deviceId);
    }

    return printer;
  }

  async remove(
    organizationId: string,
    printerId: string,
    user: User,
  ): Promise<void> {
    await this.checkPermission(organizationId, user.id, 'devices');

    const printer = await this.findOne(organizationId, printerId, user);
    const deviceId = printer.deviceId;

    await this.clearPrinterReferences(organizationId, [printer.id]);
    await this.printerRepository.remove(printer);

    this.logger.log(`Printer deleted: ${printer.name} (${printer.id})`);

    if (deviceId) {
      this.notifyDeviceConfigUpdate(organizationId, deviceId);
    }
  }

  /**
   * Zuordnungen auf die Drucker aufraeumen, bevor sie geloescht werden:
   * Stationen, Bon-Workflow der Organisation, Standard-/Kassenladen-Drucker
   * der Geraete sowie Druckeinstellungen von Kategorien und Produkten.
   */
  async clearPrinterReferences(
    organizationId: string,
    printerIds: string[],
  ): Promise<void> {
    if (printerIds.length === 0) return;
    const ids = new Set(printerIds);

    await this.productionStationRepository.update(
      { printerId: In(printerIds) },
      { printerId: null },
    );

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (organization?.settings?.orderFlow) {
      let changed = false;
      const orderFlow: Record<string, unknown> = {
        ...organization.settings.orderFlow,
      };
      for (const key of ORDER_FLOW_PRINTER_KEYS) {
        const section = orderFlow[key] as
          | { printerId?: string | null }
          | undefined;
        if (section?.printerId && ids.has(section.printerId)) {
          orderFlow[key] = { ...section, printerId: null };
          changed = true;
        }
      }
      if (changed) {
        organization.settings = {
          ...organization.settings,
          orderFlow: orderFlow as OrganizationSettings['orderFlow'],
        };
        await this.organizationRepository.save(organization);
        this.gatewayService.notifyOrganizationSettingsUpdated(organizationId);
      }
    }

    const devices = await this.deviceRepository.find({
      where: { organizationId },
    });
    for (const device of devices) {
      const settings = { ...(device.settings ?? {}) };
      let changed = false;
      for (const key of DEVICE_PRINTER_SETTING_KEYS) {
        const value = settings[key];
        if (typeof value === 'string' && ids.has(value)) {
          delete settings[key];
          changed = true;
        }
      }
      if (changed) {
        device.settings = settings;
        await this.deviceRepository.save(device);
        this.gatewayService.notifyDeviceSettingsUpdated(
          organizationId,
          device.id,
          settings,
        );
      }
    }

    // Kategorien/Produkte halten den Drucker in `print_settings` (jsonb).
    const manager = this.printerRepository.manager;
    for (const table of ['categories', 'products']) {
      await manager.query(
        `UPDATE "${table}" SET "print_settings" = "print_settings" - 'printerId'
           WHERE "print_settings"->>'printerId' = ANY($1::text[])`,
        [printerIds],
      );
    }
  }

  async findByDeviceId(deviceId: string): Promise<Printer[]> {
    return this.printerRepository.find({
      where: { deviceId, isActive: true },
      order: { name: 'ASC' },
    });
  }

  async updateOnlineStatus(
    printerId: string,
    isOnline: boolean,
    organizationId: string,
  ): Promise<void> {
    // Always refresh last_seen_at so the admin UI knows the agent is reachable,
    // even if the underlying USB printer reports offline (e.g. cable unplugged).
    // Scoped to the reporting agent's organization.
    const previous = await this.printerRepository.findOne({
      where: { id: printerId, organizationId },
      select: { id: true, isOnline: true },
    });
    if (!previous) return;

    const lastSeenAt = new Date();
    await this.printerRepository.update(
      { id: printerId, organizationId },
      { isOnline, lastSeenAt },
    );

    // Kassen zeigen den Bondrucker als Status-Pille; nur Wechsel melden,
    // nicht jeden Heartbeat.
    if (previous.isOnline !== isOnline) {
      this.gatewayService.notifyPrinterStatusChanged(organizationId, {
        printerId,
        isOnline,
        lastSeenAt: lastSeenAt.toISOString(),
      });
    }
  }

  async testPrint(
    organizationId: string,
    printerId: string,
    user: User,
  ): Promise<{ success: boolean; message: string }> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const printer = await this.findOne(organizationId, printerId, user);
    return this.dispatchTestPrint(printer);
  }

  /** Super-admin variant: bypasses org-membership check. */
  async testPrintAsAdmin(
    printerId: string,
  ): Promise<{ success: boolean; message: string }> {
    const printer = await this.printerRepository.findOne({
      where: { id: printerId },
    });
    if (!printer) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.PRINTER_NOT_FOUND,
        message: 'Drucker nicht gefunden',
      });
    }
    // Admin test prints check agent reachability via last_seen_at instead of the
    // strict isOnline flag, so we can also send test jobs when the underlying
    // USB device isn't fully connected — the agent will report the failure back.
    return this.dispatchTestPrint(printer, { requireOnline: false });
  }

  private dispatchTestPrint(
    printer: Printer,
    options: { requireOnline?: boolean } = { requireOnline: true },
  ): { success: boolean; message: string } {
    if (!printer.isActive) {
      return { success: false, message: 'Drucker ist deaktiviert' };
    }
    if (options.requireOnline && !printer.isOnline) {
      return { success: false, message: 'Drucker ist offline' };
    }
    if (!options.requireOnline) {
      const lastSeen = printer.lastSeenAt
        ? new Date(printer.lastSeenAt).getTime()
        : 0;
      if (!lastSeen || Date.now() - lastSeen > 60_000) {
        return {
          success: false,
          message: 'Drucker-Agent ist nicht erreichbar',
        };
      }
    }
    if (!printer.organizationId) {
      return {
        success: false,
        message: 'Drucker ist keiner Organisation zugeordnet',
      };
    }

    // Emit a real PRINTER_JOB event so the agent renders + prints the bundled
    // "receipt" template with a small test payload.
    const jobId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Test jobs are not persisted — fire-and-forget, no ack handling needed.
    void this.gatewayService.sendPrintJobToAgent(
      printer.organizationId,
      printer.deviceId,
      {
        jobId,
        printerId: printer.id,
        templateName: '_admin_test',
        copies: 1,
        payload: {
          printerName: printer.name,
          jobId,
          timestamp: new Date().toLocaleString('de-DE', {
            dateStyle: 'short',
            timeStyle: 'short',
          }),
          body: 'Testdruck aus OpenEOS.',
        },
      },
    );

    this.logger.log(
      `Test print dispatched for printer ${printer.name} (${printer.id}) job=${jobId}`,
    );
    return {
      success: true,
      message: 'Testdruck wurde an den Drucker gesendet',
    };
  }

  private async validateDeviceForOrg(
    deviceId: string,
    organizationId: string,
  ): Promise<void> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });

    if (!device) {
      throw new BadRequestException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.DEVICE_NOT_FOUND,
        message: 'Gerät nicht gefunden',
      });
    }

    if (device.type !== DeviceType.PRINTER_AGENT) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.DEVICE_NOT_PRINTER_AGENT,
        message: 'Gerät ist kein Drucker-Agent',
      });
    }

    if (device.organizationId !== organizationId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.DEVICE_WRONG_ORGANIZATION,
        message: 'Gerät gehört nicht zu dieser Organisation',
      });
    }
  }

  private notifyDeviceConfigUpdate(
    organizationId: string,
    deviceId: string,
  ): void {
    try {
      this.gatewayService.notifyPrinterConfigUpdate(organizationId, deviceId);
    } catch (error) {
      this.logger.warn(
        `Failed to notify device ${deviceId} about config update: ${error}`,
      );
    }
  }

  private async checkMembership(
    organizationId: string,
    userId: string,
  ): Promise<void> {
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
  }

  private async checkPermission(
    organizationId: string,
    userId: string,
    permission: 'products' | 'events' | 'devices' | 'members' | 'shiftPlans',
  ): Promise<void> {
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

    if (membership.role === OrganizationRole.ADMIN) {
      return;
    }

    if (!membership.permissions?.[permission]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
